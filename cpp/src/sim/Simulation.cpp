#include "Simulation.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <utility>

namespace {

// Overlap of at most this much on an axis is contact, not penetration. A body resting exactly on a floor (or
// flush against a wall) can otherwise test as inside it after float rounding, and the other axis's resolution
// would shove it sideways or onto the wall's top. Float spacing stays below this for coordinates under ~1000.
constexpr float CONTACT_EPSILON = 1e-4f;

// Cap for verticalSubsteps(). At the minimum safe substep (0.2 units) this covers falls up to ~380 u/s.
constexpr int MAX_VERTICAL_SUBSTEPS = 32;

constexpr float ANIMATION_FRAME_TIME = 0.25f;
constexpr float RUN_SPEED_THRESHOLD = 0.01f;
constexpr float CAMERA_LOOKAHEAD_SPEED = 0.5f;  // |v| above which the camera leads the player

// `margin` 0 is a strict overlap test (goals, hazards, payload, terminals); CONTACT_EPSILON for solid platforms.
bool boxesOverlap(const Vec2& posA, const Vec2& sizeA, const Vec2& posB, const Vec2& sizeB, float margin) {
    const float overlapX = (sizeA.x + sizeB.x) * 0.5f - std::abs(posA.x - posB.x);
    const float overlapY = (sizeA.y + sizeB.y) * 0.5f - std::abs(posA.y - posB.y);
    return overlapX > margin && overlapY > margin;
}

float cooldownFor(CharacterType character) {
    return character == CharacterType::Bolts
        ? CharacterStats::BOLTS_GROUND_POUND_COOLDOWN
        : CharacterStats::VOLTS_HOVER_COOLDOWN;
}

} // namespace

void Simulation::loadLevel(const LevelSpec& level) {
    platforms_ = level.platforms;
    goals_ = level.goals;
    goalReached_.assign(goals_.size(), false);
    bounds_ = level.bounds;
    cameraTuning_ = level.camera;
    cameraTuning_.verticalDeadzone = std::max(0.0f, cameraTuning_.verticalDeadzone);

    minPlatformHalfHeight_ = 0.0f;
    for (std::size_t i = 0; i < platforms_.size(); ++i) {
        const float half = std::max(0.0f, platforms_[i].size.y * 0.5f);
        minPlatformHalfHeight_ = (i == 0) ? half : std::min(minPlatformHalfHeight_, half);
    }

    hazards_ = level.hazards;
    for (Hazard& hazard : hazards_) {
        if (hazard.x0 > hazard.x1) std::swap(hazard.x0, hazard.x1);
        hazard.speed = std::abs(hazard.speed);
        if (hazard.speed > 0.0f) {
            hazard.position.x = std::min(std::max(hazard.position.x, hazard.x0), hazard.x1);
        } else {
            hazard.x0 = hazard.x1 = hazard.position.x;
        }
        hazard.enabled = true;
        hazard.direction = 1.0f;
    }
    payload_ = level.payload;
    if (payload_) {
        payload_->origin = payload_->position;
        payload_->carried = false;
    }
    terminals_ = level.terminals;
    for (Terminal& terminal : terminals_) terminal.used = false;

    abilityState_ = AbilityState::Ready;
    abilityActiveTimer_ = 0.0f;
    abilityCooldownTimer_ = 0.0f;

    if (level.spawn) {
        player_.position = *level.spawn;
        player_.velocity = {0.0f, 0.0f};
    }
    respawnPoint_ = player_.position;
    // Contact state belongs to the old platforms; the next update re-detects ground.
    player_.grounded = false;
    coyoteTimer_ = 0.0f;
    jumpBuffered_ = false;
    jumpBufferTimer_ = 0.0f;

    // Camera starts on the player (no lerp).
    camera_.x = player_.position.x;
    camera_.y = cameraTuning_.followY ? player_.position.y : 0.0f;
    clampCamera();
}

void Simulation::handleInput(const InputState& input) {
    const float speed = moveSpeed();
    targetVelocityX_ = 0.0f;
    if (input.left) {
        targetVelocityX_ = -speed;
        animation_.facingLeft = true;
    } else if (input.right) {
        targetVelocityX_ = speed;
        animation_.facingLeft = false;
    }

    // Press: buffer it; update() fires it while grounded or inside the coyote window.
    if (input.jump && !jumpHeld_) {
        jumpBuffered_ = true;
        jumpBufferTimer_ = Physics::JUMP_BUFFER_TIME;
    }
    // Release while rising: shorter hop. Only on the release edge, so it applies once per press.
    if (!input.jump && jumpHeld_ && player_.velocity.y > 0.0f) {
        player_.velocity.y *= Physics::JUMP_CUT_MULTIPLIER;
    }
    jumpHeld_ = input.jump;

    // One key, two uses: a terminal under Volts takes the press (ready or not, grounded or not); anywhere else it
    // is the ability.
    if (input.abilityKey && !abilityKeyHeld_ && !tryUseTerminal()) {
        useAbility();
    }
    abilityKeyHeld_ = input.abilityKey;
}

void Simulation::update(float deltaTime) {
    // The JS loop calls Game::update with a fixed 1/60 step (src/game/loop.ts). The clamp only guards against a
    // caller passing wall-clock time; it should never trigger.
    const float dt = std::min(deltaTime, MAX_STEP);
    if (!(dt > 0.0f)) return;

    const bool wasGrounded = player_.grounded;
    const bool jumped = tryBufferedJump();
    applyHorizontalAcceleration(dt);
    updateAbilityTimers(dt);
    decayJumpBuffer(dt);

    // The takeoff tick moves at full jump strength and gravity starts on the next one; the tuned jump heights
    // assume this.
    if (!jumped) applyGravity(dt);
    moveVertical(dt);
    moveHorizontal(dt);
    updateGroundState(wasGrounded, dt);
    moveHazards(dt);
    if (touchingHazard()) respawn();
    updatePayload();
    updateAnimation(dt);
    updateCamera(dt);
    checkGoals();
}

void Simulation::useAbility() {
    if (abilityState_ != AbilityState::Ready || player_.grounded) return;

    abilityState_ = AbilityState::Active;
    if (character_ == CharacterType::Bolts) {
        // Ground pound: slam down, killing most horizontal momentum.
        player_.velocity.y = CharacterStats::BOLTS_GROUND_POUND_SPEED;
        player_.velocity.x *= CharacterStats::BOLTS_GROUND_POUND_KEEP_VX;
        abilityActiveTimer_ = CharacterStats::BOLTS_GROUND_POUND_DURATION;
        emit(SimEventType::PoundStarted);
    } else {
        // Hover: low gravity for a while (applyGravity); soften an ongoing fall.
        abilityActiveTimer_ = CharacterStats::VOLTS_HOVER_DURATION;
        if (player_.velocity.y < 0.0f) {
            player_.velocity.y *= CharacterStats::VOLTS_HOVER_KEEP_FALL;
        }
        emit(SimEventType::HoverStarted);
    }
}

void Simulation::switchCharacter() {
    character_ = (character_ == CharacterType::Bolts) ? CharacterType::Volts : CharacterType::Bolts;
    abilityState_ = AbilityState::Ready;
    abilityActiveTimer_ = 0.0f;
    abilityCooldownTimer_ = 0.0f;
    player_.velocity.x *= CharacterStats::SWITCH_KEEP_VX;
    emit(SimEventType::CharacterSwitched);
}

void Simulation::drainEvents(std::vector<SimEvent>& out) {
    out.clear();
    out.swap(events_);
}

float Simulation::abilityCooldownPercent() const {
    if (abilityState_ == AbilityState::Cooldown) {
        const float maxCooldown = cooldownFor(character_);
        return maxCooldown > 0.0f ? abilityCooldownTimer_ / maxCooldown : 0.0f;
    }
    return abilityState_ == AbilityState::Active ? 1.0f : 0.0f;
}

float Simulation::moveSpeed() const {
    return character_ == CharacterType::Bolts ? CharacterStats::BOLTS_MOVE_SPEED : CharacterStats::VOLTS_MOVE_SPEED;
}

float Simulation::jumpStrength() const {
    return character_ == CharacterType::Bolts ? CharacterStats::BOLTS_JUMP_STRENGTH : CharacterStats::VOLTS_JUMP_STRENGTH;
}

void Simulation::emit(SimEventType type) {
    events_.push_back({type, player_.position, player_.velocity});
}

bool Simulation::tryBufferedJump() {
    if (!jumpBuffered_) return false;
    if (!player_.grounded && coyoteTimer_ <= 0.0f) return false;
    player_.velocity.y = jumpStrength();
    player_.grounded = false;
    coyoteTimer_ = 0.0f;
    jumpBuffered_ = false;
    jumpBufferTimer_ = 0.0f;
    emit(SimEventType::Jumped);
    return true;
}

void Simulation::applyHorizontalAcceleration(float dt) {
    const float maxSpeed = moveSpeed();
    float& vx = player_.velocity.x;
    if (std::abs(targetVelocityX_) > 0.01f) {
        const float accel = player_.grounded ? Physics::GROUND_ACCEL : Physics::AIR_ACCEL;
        const float diff = targetVelocityX_ - vx;
        const float change = accel * dt;
        if (std::abs(diff) < change) {
            vx = targetVelocityX_;
        } else {
            vx += (diff > 0.0f ? change : -change);
        }
        vx = std::max(-maxSpeed, std::min(maxSpeed, vx));
    } else {
        const float decel = player_.grounded ? Physics::GROUND_DECEL : Physics::AIR_DECEL;
        const float change = decel * dt;
        if (std::abs(vx) < change) {
            vx = 0.0f;
        } else {
            vx -= (vx > 0.0f ? change : -change);
        }
    }
}

void Simulation::updateAbilityTimers(float dt) {
    switch (abilityState_) {
        case AbilityState::Active:
            abilityActiveTimer_ -= dt;
            if (abilityActiveTimer_ <= 0.0f) startCooldown();
            break;
        case AbilityState::Cooldown:
            abilityCooldownTimer_ -= dt;
            if (abilityCooldownTimer_ <= 0.0f) {
                abilityState_ = AbilityState::Ready;
                abilityCooldownTimer_ = 0.0f;
            }
            break;
        case AbilityState::Ready:
            break;
    }
}

void Simulation::decayJumpBuffer(float dt) {
    if (jumpBufferTimer_ <= 0.0f) return;
    jumpBufferTimer_ -= dt;
    if (jumpBufferTimer_ <= 0.0f) jumpBuffered_ = false;
}

void Simulation::applyGravity(float dt) {
    // Apex hang time: lighter gravity near the top of an arc.
    float gravityMult = (std::abs(player_.velocity.y) < Physics::APEX_VELOCITY_THRESHOLD)
        ? Physics::APEX_GRAVITY_MULT
        : 1.0f;
    if (!player_.grounded && character_ == CharacterType::Volts && abilityState_ == AbilityState::Active) {
        gravityMult = CharacterStats::VOLTS_HOVER_GRAVITY_MULT;
        emit(SimEventType::HoverTick);
    }
    // Also applied while grounded: the small step down is what re-detects the floor (or its absence) each tick.
    player_.velocity.y += Physics::GRAVITY * gravityMult * dt;
}

void Simulation::moveVertical(float dt) {
    player_.grounded = false;
    const float move = player_.velocity.y * dt;
    const int steps = verticalSubsteps(move);
    const float stepMove = move / static_cast<float>(steps);
    for (int i = 0; i < steps; ++i) {
        player_.position.y += stepMove;
        if (resolveVertical()) break;  // stopped by a platform: the rest of this tick's move is cancelled
    }
}

// Push the body out of every platform it overlaps, along Y, back towards the side its centre is on. Landing on a
// top sets grounded. Returns whether anything was hit.
bool Simulation::resolveVertical() {
    bool hit = false;
    for (const Platform& platform : platforms_) {
        if (!boxesOverlap(player_.position, player_.size, platform.position, platform.size, CONTACT_EPSILON)) continue;
        hit = true;
        const float reach = (player_.size.y + platform.size.y) * 0.5f;
        if (player_.position.y > platform.position.y) {
            player_.position.y = platform.position.y + reach;
            if (player_.velocity.y <= 0.0f) {
                player_.velocity.y = 0.0f;
                player_.grounded = true;
            }
        } else {
            player_.position.y = platform.position.y - reach;
            if (player_.velocity.y > 0.0f) player_.velocity.y = 0.0f;
        }
    }
    return hit;
}

// resolveVertical pushes towards the side of the platform's centre line the body's centre is on. Starting clear
// of a platform, the centre cannot cross that line in a move shorter than (player half-height + platform
// half-height), so we keep each substep under half of that for the thinnest platform. With the current sizes
// that is 0.25 units, i.e. a single step up to 15 u/s (jumps, walking, a ground pound); only long falls split.
int Simulation::verticalSubsteps(float move) const {
    const float maxMove = 0.5f * (0.5f * player_.size.y + minPlatformHalfHeight_);
    const float distance = std::abs(move);
    if (!(distance > maxMove)) return 1;
    return std::min(MAX_VERTICAL_SUBSTEPS, static_cast<int>(std::ceil(distance / maxMove)));
}

void Simulation::moveHorizontal(float dt) {
    player_.position.x += player_.velocity.x * dt;
    for (const Platform& platform : platforms_) {
        if (!boxesOverlap(player_.position, player_.size, platform.position, platform.size, CONTACT_EPSILON)) continue;
        const float reach = (player_.size.x + platform.size.x) * 0.5f;
        player_.position.x = (player_.position.x > platform.position.x)
            ? platform.position.x + reach
            : platform.position.x - reach;
        player_.velocity.x = 0.0f;
    }
}

void Simulation::updateGroundState(bool wasGrounded, float dt) {
    if (!player_.grounded) {
        if (coyoteTimer_ > 0.0f) coyoteTimer_ -= dt;
        return;
    }
    coyoteTimer_ = Physics::COYOTE_TIME;
    const bool justLanded = !wasGrounded;
    if (justLanded) emit(SimEventType::Landed);
    // Both abilities end on the ground; a pound still active when it lands is an impact.
    if (abilityState_ == AbilityState::Active) {
        if (justLanded && character_ == CharacterType::Bolts) emit(SimEventType::PoundImpact);
        startCooldown();
    }
}

void Simulation::updateAnimation(float dt) {
    PlayerState state = PlayerState::Idle;
    if (!player_.grounded) {
        state = player_.velocity.y > 0.0f ? PlayerState::Jump : PlayerState::Fall;
    } else if (std::abs(player_.velocity.x) > RUN_SPEED_THRESHOLD) {
        state = PlayerState::Run;
        emit(SimEventType::Running);
    }

    // Fall may share the jump row; that mapping lives in the renderer.
    if (state != animation_.currentState) {
        animation_.currentState = state;
        animation_.currentFrame = 0;
        animationTimer_ = 0.0f;
    }
    animationTimer_ += dt;
    while (animationTimer_ >= ANIMATION_FRAME_TIME) {
        animationTimer_ -= ANIMATION_FRAME_TIME;
        ++animation_.currentFrame;
    }
}

void Simulation::updateCamera(float dt) {
    float lookAheadX = 0.0f;
    if (std::abs(player_.velocity.x) > CAMERA_LOOKAHEAD_SPEED) {
        lookAheadX = (player_.velocity.x > 0.0f ? 1.0f : -1.0f) * Physics::CAMERA_LOOKAHEAD;
    }
    const float targetX = player_.position.x + lookAheadX;
    camera_.x += (targetX - camera_.x) * Physics::CAMERA_LERP_SPEED * dt;

    if (cameraTuning_.followY) {
        float lookAheadY = 0.0f;
        if (std::abs(player_.velocity.y) > CAMERA_LOOKAHEAD_SPEED) {
            lookAheadY = (player_.velocity.y > 0.0f ? 1.0f : -1.0f) * cameraTuning_.lookAheadY;
        }
        const float desiredY = player_.position.y + lookAheadY;
        const float deltaY = desiredY - camera_.y;
        const float deadzone = cameraTuning_.verticalDeadzone;
        const float targetY = (std::abs(deltaY) > deadzone)
            ? desiredY - (deltaY > 0.0f ? deadzone : -deadzone)
            : camera_.y;
        camera_.y += (targetY - camera_.y) * Physics::CAMERA_LERP_SPEED * dt;
    }
    clampCamera();
}

void Simulation::clampCamera() {
    if (!bounds_) return;
    camera_.x = std::min(std::max(camera_.x, bounds_->min.x), bounds_->max.x);
    camera_.y = std::min(std::max(camera_.y, bounds_->min.y), bounds_->max.y);
}

void Simulation::checkGoals() {
    if (payload_ && !payload_->carried) return;  // a courier level needs the package delivered
    for (std::size_t i = 0; i < goals_.size(); ++i) {
        if (goalReached_[i]) continue;
        if (boxesOverlap(player_.position, player_.size, goals_[i].position, goals_[i].size, 0.0f)) {
            goalReached_[i] = true;
            emit(SimEventType::GoalReached);
        }
    }
}

void Simulation::startCooldown() {
    abilityState_ = AbilityState::Cooldown;
    abilityCooldownTimer_ = cooldownFor(character_);
}

bool Simulation::tryUseTerminal() {
    if (character_ != CharacterType::Volts) return false;
    for (Terminal& terminal : terminals_) {
        if (terminal.used) continue;
        if (!boxesOverlap(player_.position, player_.size, terminal.position, terminal.size, 0.0f)) continue;
        terminal.used = true;
        if (terminal.targetHazard >= 0 && static_cast<std::size_t>(terminal.targetHazard) < hazards_.size()) {
            hazards_[static_cast<std::size_t>(terminal.targetHazard)].enabled = false;
        }
        emit(SimEventType::TerminalUsed);
        return true;
    }
    return false;
}

// Patrols run at a constant speed and turn around at x0 / x1. A disabled hazard stops where it is.
void Simulation::moveHazards(float dt) {
    for (Hazard& hazard : hazards_) {
        if (!hazard.enabled || !(hazard.speed > 0.0f)) continue;
        hazard.position.x += hazard.direction * hazard.speed * dt;
        if (hazard.position.x >= hazard.x1) {
            hazard.position.x = hazard.x1;
            hazard.direction = -1.0f;
        } else if (hazard.position.x <= hazard.x0) {
            hazard.position.x = hazard.x0;
            hazard.direction = 1.0f;
        }
    }
}

bool Simulation::touchingHazard() const {
    for (const Hazard& hazard : hazards_) {
        if (hazard.enabled && boxesOverlap(player_.position, player_.size, hazard.position, hazard.size, 0.0f)) return true;
    }
    return false;
}

// Back to the spawn, at rest, with the payload on its pad. Hazards, terminals and goals keep their state; only a
// level load resets those.
void Simulation::respawn() {
    emit(SimEventType::Respawned);  // where it happened
    player_.position = respawnPoint_;
    player_.velocity = {0.0f, 0.0f};
    player_.grounded = false;
    coyoteTimer_ = 0.0f;
    jumpBuffered_ = false;
    jumpBufferTimer_ = 0.0f;
    abilityState_ = AbilityState::Ready;
    abilityActiveTimer_ = 0.0f;
    abilityCooldownTimer_ = 0.0f;
    if (payload_) {
        payload_->position = payload_->origin;
        payload_->carried = false;
    }
}

void Simulation::updatePayload() {
    if (!payload_) return;
    Payload& payload = *payload_;
    if (!payload.carried && boxesOverlap(player_.position, player_.size, payload.position, payload.size, 0.0f)) {
        payload.carried = true;
        emit(SimEventType::PayloadPickedUp);
    }
    if (payload.carried) {
        // Resting on top of the collision box, centred. Cosmetic only: a carried payload collides with nothing.
        payload.position.x = player_.position.x;
        payload.position.y = player_.position.y + (player_.size.y + payload.size.y) * 0.5f;
    }
}
