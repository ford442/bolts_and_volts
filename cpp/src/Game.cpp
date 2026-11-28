#include "Game.hpp"
#include <algorithm>
#include <cmath>

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

bool readBox(const val& entry, Vec2& position, Vec2& size) {
    return hasField(entry, "position") && hasField(entry, "size") &&
        readVec2(entry["position"], position) && readVec2(entry["size"], size);
}

bool readFiniteNumber(const val& object, const char* key, float& out) {
    if (!hasField(object, key) || !object[key].isNumber()) return false;
    out = object[key].as<float>();
    return std::isfinite(out);
}

// `[{ position, size, oneWay?, patrol?: { x0, y0, x1, y1, speed } }, ...]`. Entries missing either vector are skipped
// (like readBoxes, so indices match the TypeScript side). Without all five finite patrol numbers the platform is static.
void readPlatforms(const val& list, std::vector<Platform>& out) {
    if (list.isNull() || list.isUndefined()) return;
    const unsigned length = list["length"].as<unsigned>();
    for (unsigned i = 0; i < length; ++i) {
        const val entry = list[i];
        Platform platform{};
        if (!readBox(entry, platform.position, platform.size)) continue;
        platform.oneWay = hasField(entry, "oneWay") && entry["oneWay"].isTrue();
        if (hasField(entry, "patrol")) {
            const val patrol = entry["patrol"];
            PlatformPatrol parsed{};
            if (readFiniteNumber(patrol, "x0", parsed.from.x) && readFiniteNumber(patrol, "y0", parsed.from.y) &&
                readFiniteNumber(patrol, "x1", parsed.to.x) && readFiniteNumber(patrol, "y1", parsed.to.y) &&
                readFiniteNumber(patrol, "speed", parsed.speed)) {
                platform.patrol = parsed;
            }
        }
        out.push_back(platform);
    }
}

// `[{ position, size, velocity: {x, y} }, ...]`; entries missing any of the three are skipped.
void readLaunchers(const val& list, std::vector<Launcher>& out) {
    if (list.isNull() || list.isUndefined()) return;
    const unsigned length = list["length"].as<unsigned>();
    for (unsigned i = 0; i < length; ++i) {
        const val entry = list[i];
        Launcher launcher{};
        if (!readBox(entry, launcher.position, launcher.size)) continue;
        if (!hasField(entry, "velocity") || !readVec2(entry["velocity"], launcher.velocity)) continue;
        out.push_back(launcher);
    }
}

// `[{ position, size, patrol?: { x0, x1, speed } }, ...]`. Without a complete patrol the hazard is static. Entries
// missing position or size are skipped, so terminal `disablesHazard` indices count only the kept ones (the
// TypeScript normalizer has already dropped bad entries the same way).
void readHazards(const val& list, std::vector<Hazard>& out) {
    if (list.isNull() || list.isUndefined()) return;
    const unsigned length = list["length"].as<unsigned>();
    for (unsigned i = 0; i < length; ++i) {
        const val entry = list[i];
        Hazard hazard{};
        if (!readBox(entry, hazard.position, hazard.size)) continue;
        hazard.x0 = hazard.x1 = hazard.position.x;
        if (hasField(entry, "patrol")) {
            const val patrol = entry["patrol"];
            if (hasField(patrol, "x0") && hasField(patrol, "x1") && hasField(patrol, "speed")) {
                hazard.x0 = patrol["x0"].as<float>();
                hazard.x1 = patrol["x1"].as<float>();
                hazard.speed = patrol["speed"].as<float>();
            }
        }
        out.push_back(hazard);
    }
}

void readTerminals(const val& list, std::vector<Terminal>& out) {
    if (list.isNull() || list.isUndefined()) return;
    const unsigned length = list["length"].as<unsigned>();
    for (unsigned i = 0; i < length; ++i) {
        const val entry = list[i];
        Terminal terminal{};
        if (!readBox(entry, terminal.position, terminal.size)) continue;
        terminal.targetHazard = hasField(entry, "disablesHazard") ? entry["disablesHazard"].as<int>() : -1;
        out.push_back(terminal);
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

void Game::setCheckpointCallback(val callback) {
    checkpointCallback = callback;
}

bool Game::restoreCheckpoint(int index) {
    const bool restored = sim.restoreCheckpoint(index);
    dispatchEvents();
    return restored;
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
    if (hasField(level, "platforms")) readPlatforms(level["platforms"], spec.platforms);
    if (hasField(level, "goals")) readBoxes(level["goals"], spec.goals);
    if (hasField(level, "checkpoints")) readBoxes(level["checkpoints"], spec.checkpoints);
    if (hasField(level, "hazards")) readHazards(level["hazards"], spec.hazards);
    if (hasField(level, "terminals")) readTerminals(level["terminals"], spec.terminals);
    if (hasField(level, "launchers")) readLaunchers(level["launchers"], spec.launchers);
    if (hasField(level, "payload")) {
        Payload payload{};
        if (readBox(level["payload"], payload.position, payload.size)) spec.payload = payload;
    }

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
            case SimEventType::Jumped:
            case SimEventType::Launched: playSound("jump"); break;
            case SimEventType::Landed: playSound("land"); break;
            case SimEventType::PoundStarted: playSound("ground_pound"); break;
            case SimEventType::HoverStarted: playSound("hover"); break;
            case SimEventType::CharacterSwitched: playSound("switch"); break;
            case SimEventType::GoalReached:
                if (!levelCompleteCallback.isNull()) levelCompleteCallback();
                break;
            case SimEventType::CheckpointReached:
                if (!checkpointCallback.isNull()) checkpointCallback(event.index);
                break;
            case SimEventType::PoundImpact:
            case SimEventType::HoverTick:
            case SimEventType::Running:
            case SimEventType::Respawned:
            case SimEventType::PayloadPickedUp:
            case SimEventType::TerminalUsed:
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
    const std::vector<Hazard>& hazards = sim.hazards();
    const std::optional<Payload>& payload = sim.payload();
    const std::vector<Terminal>& terminals = sim.terminals();
    const std::vector<Mover>& movers = sim.movers();
    const std::vector<Platform>& platforms = sim.platforms();
    const std::vector<Particle>& particles = particleSystem.getParticles();
    const PlayerBody& player = sim.player();
    const AnimationState& animation = sim.animation();
    const size_t payloadCount = payload ? 1 : 0;
    const size_t length = HEADER_SIZE
        + (hazards.size() + payloadCount + terminals.size()) * ENTITY_STRIDE
        + movers.size() * MOVER_STRIDE
        + particles.size() * PARTICLE_STRIDE;
    frameBuffer.resize(length);
    float* out = frameBuffer.data();
    std::fill(out, out + HEADER_SIZE, 0.0f);  // reserved slots stay 0

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
    out[PARTICLE_COUNT] = static_cast<float>(particles.size());
    out[HAZARD_COUNT] = static_cast<float>(hazards.size());
    out[PAYLOAD_COUNT] = static_cast<float>(payloadCount);
    out[TERMINAL_COUNT] = static_cast<float>(terminals.size());
    out[MOVER_COUNT] = static_cast<float>(movers.size());

    // Platforms and goals are not in the snapshot: they cannot change after loadLevel, and the renderer draws the
    // arrays src/game/loop.ts kept from the level it passed in. Movers are the exception: their current centre is in
    // the movers block, keyed by platform index, and the loop writes it into that array.
    float* cursor = out + HEADER_SIZE;
    const auto writeEntity = [&cursor](const Vec2& position, const Vec2& size, bool flag) {
        cursor[0] = position.x;
        cursor[1] = position.y;
        cursor[2] = size.x;
        cursor[3] = size.y;
        cursor[4] = flag ? 1.0f : 0.0f;
        cursor += ENTITY_STRIDE;
    };
    for (const Hazard& h : hazards) writeEntity(h.position, h.size, h.enabled);
    if (payload) writeEntity(payload->position, payload->size, payload->carried);
    for (const Terminal& t : terminals) writeEntity(t.position, t.size, t.used);
    for (const Mover& m : movers) {
        const Vec2& position = platforms[static_cast<size_t>(m.platform)].position;
        cursor[0] = static_cast<float>(m.platform);
        cursor[1] = position.x;
        cursor[2] = position.y;
        cursor += MOVER_STRIDE;
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
