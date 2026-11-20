#include "Game.hpp"
#include <algorithm>
#include <initializer_list>

using emscripten::val;

namespace {

bool hasField(const val& object, const char* key) {
    return !object.isNull() && !object.isUndefined() && object.hasOwnProperty(key);
}

bool readVec2(const val& object, Vec2& out) {
    if (!hasField(object, "x") || !hasField(object, "y")) return false;
    out = { object["x"].as<float>(), object["y"].as<float>() };
    return true;
}

// `[{ position: {x, y}, size: {x, y} }, ...]`; entries missing either vector are skipped.
void readBoxes(const val& list, std::vector<Platform>& out) {
    if (list.isNull() || list.isUndefined()) return;
    const unsigned length = list["length"].as<unsigned>();
    for (unsigned i = 0; i < length; ++i) {
        const val entry = list[i];
        Platform box{};
        if (hasField(entry, "position") && hasField(entry, "size") &&
            readVec2(entry["position"], box.position) && readVec2(entry["size"], box.size)) {
            out.push_back(box);
        }
    }
}

std::string readString(const val& object, const char* key, const char* fallback) {
    if (hasField(object, key)) {
        const val value = object[key];
        if (!value.isNull() && !value.isUndefined()) return value.as<std::string>();
    }
    return fallback;
}

// Shown until the first level JSON loads.
LevelSpec defaultLevel() {
    LevelSpec level;
    level.spawn = Vec2{0.0f, -1.5f};
    level.platforms = {
        { {-12.25f, -2.0f}, {110.0f, 0.2f} },
        { {0.0f, -0.8f}, {2.0f, 0.2f} },
        { {2.0f, -0.6f}, {1.0f, 0.2f} },
        { {4.0f, -0.4f}, {1.0f, 0.2f} },
        { {6.0f, -0.2f}, {1.5f, 0.2f} },
        { {8.0f, 0.2f}, {1.0f, 0.2f} },
        { {10.0f, 0.6f}, {1.0f, 0.2f} },
    };
    return level;
}

} // namespace


Game::Game() {
    sim.loadLevel(defaultLevel());
}

void Game::setSoundCallback(val callback) {
    soundCallback = callback;
}

void Game::setLevelCompleteCallback(val callback) {
    levelCompleteCallback = callback;
}

void Game::playSound(const std::string& soundName) {
    if (!soundCallback.isNull()) {
        soundCallback(soundName);
    }
}

void Game::loadLevel(const val& level) {
    if (level.isNull() || level.isUndefined()) return;

    LevelSpec spec;
    Vec2 spawn{};
    if (hasField(level, "spawn") && readVec2(level["spawn"], spawn)) spec.spawn = spawn;
    if (hasField(level, "platforms")) readBoxes(level["platforms"], spec.platforms);
    if (hasField(level, "goals")) readBoxes(level["goals"], spec.goals);

    if (hasField(level, "bounds")) {
        const val bounds = level["bounds"];
        LevelBounds parsed{};
        if (hasField(bounds, "min") && hasField(bounds, "max") &&
            readVec2(bounds["min"], parsed.min) && readVec2(bounds["max"], parsed.max)) {
            spec.bounds = parsed;
        }
    }

    // Optional camera tuning (backward compatible: default is X-only follow)
    if (hasField(level, "camera")) {
        const val camera = level["camera"];
        if (hasField(camera, "followY")) spec.camera.followY = camera["followY"].as<bool>();
        if (hasField(camera, "verticalDeadzone")) spec.camera.verticalDeadzone = camera["verticalDeadzone"].as<float>();
        if (hasField(camera, "lookAheadY")) spec.camera.lookAheadY = camera["lookAheadY"].as<float>();
    }

    levelName = readString(level, "name", "untitled-level");
    levelDescription = readString(level, "description", "");
    sim.loadLevel(spec);
}

void Game::handleInput(const InputState& input) {
    sim.handleInput(input);
    dispatchEvents();
}

void Game::update(float deltaTime) {
    const float dt = std::min(deltaTime, Simulation::MAX_STEP);
    if (!(dt > 0.0f)) return;
    // Age existing particles before this tick's events spawn new ones.
    particleSystem.update(dt);
    sim.update(dt);
    dispatchEvents();
}

void Game::useAbility() {
    sim.useAbility();
    dispatchEvents();
}

void Game::switchCharacter() {
    sim.switchCharacter();
    dispatchEvents();
}

void Game::dispatchEvents() {
    sim.drainEvents(pendingEvents);
    const Vec2 playerSize = sim.player().size;
    // Index loop over copies: a JS callback that re-enters the game would drain into pendingEvents again.
    for (std::size_t i = 0; i < pendingEvents.size(); ++i) {
        const SimEvent event = pendingEvents[i];
        particleSystem.onEvent(event, playerSize);
        switch (event.type) {
            case SimEventType::Jumped: playSound("jump"); break;
            case SimEventType::Landed: playSound("land"); break;
            case SimEventType::PoundStarted: playSound("ground_pound"); break;
            case SimEventType::HoverStarted: playSound("hover"); break;
            case SimEventType::CharacterSwitched: playSound("switch"); break;
            case SimEventType::GoalReached:
                if (!levelCompleteCallback.isNull()) levelCompleteCallback();
                break;
            case SimEventType::PoundImpact:
            case SimEventType::HoverTick:
            case SimEventType::Running:
                break;
        }
    }
}


Vec2 Game::getPlayerPosition() const { return sim.player().position; }

Vec2 Game::getPlayerSize() const { return sim.player().size; }

Vec2 Game::getCameraPosition() const { return sim.camera(); }

std::string Game::getLevelName() const { return levelName; }

std::string Game::getLevelDescription() const { return levelDescription; }

int Game::captureFrame() {
    using namespace FrameLayout;
    const std::vector<Platform>& platforms = sim.platforms();
    const std::vector<Platform>& goals = sim.goals();
    const std::vector<Particle>& particles = particleSystem.getParticles();
    const PlayerBody& player = sim.player();
    const AnimationState& animation = sim.animation();
    const size_t length = HEADER_SIZE
        + (platforms.size() + goals.size()) * BOX_STRIDE
        + particles.size() * PARTICLE_STRIDE;
    frameBuffer.resize(length);
    float* out = frameBuffer.data();

    out[PLAYER_X] = player.position.x;
    out[PLAYER_Y] = player.position.y;
    out[PLAYER_W] = player.size.x;
    out[PLAYER_H] = player.size.y;
    out[CAMERA_X] = sim.camera().x;
    out[CAMERA_Y] = sim.camera().y;
    out[ANIM_STATE] = static_cast<float>(static_cast<int>(animation.currentState));
    out[ANIM_FRAME] = static_cast<float>(animation.currentFrame);
    out[FACING_LEFT] = animation.facingLeft ? 1.0f : 0.0f;
    out[CHARACTER] = static_cast<float>(getCurrentCharacter());
    out[ABILITY_STATE] = static_cast<float>(getAbilityState());
    out[ABILITY_COOLDOWN] = getAbilityCooldownPercent();
    out[PLATFORM_COUNT] = static_cast<float>(platforms.size());
    out[GOAL_COUNT] = static_cast<float>(goals.size());
    out[PARTICLE_COUNT] = static_cast<float>(particles.size());
    out[15] = 0.0f;

    float* cursor = out + HEADER_SIZE;
    for (const std::vector<Platform>* boxes : { &platforms, &goals }) {
        for (const Platform& b : *boxes) {
            cursor[0] = b.position.x;
            cursor[1] = b.position.y;
            cursor[2] = b.size.x;
            cursor[3] = b.size.y;
            cursor += BOX_STRIDE;
        }
    }
    for (const Particle& p : particles) {
        cursor[0] = p.position.x;
        cursor[1] = p.position.y;
        cursor[2] = p.size;
        cursor[3] = p.maxLife > 0.0f ? p.life / p.maxLife : 0.0f;
        cursor += PARTICLE_STRIDE;
    }
    return static_cast<int>(length);
}

uintptr_t Game::framePtr() const {
    return reinterpret_cast<uintptr_t>(frameBuffer.data());
}

// === Bolts & Volts character system ===

float Game::getMoveSpeed() const { return sim.moveSpeed(); }

float Game::getJumpStrength() const { return sim.jumpStrength(); }

int Game::getCurrentCharacter() const { return static_cast<int>(sim.character()); }

int Game::getAbilityState() const { return static_cast<int>(sim.abilityState()); }

float Game::getAbilityCooldownPercent() const { return sim.abilityCooldownPercent(); }
