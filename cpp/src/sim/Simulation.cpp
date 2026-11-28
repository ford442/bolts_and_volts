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

// A rider's feet within this of a static platform's top (and over it) are standing on it too: see hasStaticFooting().
constexpr float FOOTING_TOLERANCE = 1e-3f;

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

// Where a mover is at its current distance along the path; exactly `from` / `to` at the ends.
Vec2 pointOnPath(const Mover& mover) {
    if (mover.distance <= 0.0f) return mover.from;
    if (mover.distance >= mover.length) return mover.to;
    const float t = mover.distance / mover.length;
    return {mover.from.x + (mover.to.x - mover.from.x) * t, mover.from.y + (mover.to.y - mover.from.y) * t};
}

bool isFinite(const Vec2& v) { return std::isfinite(v.x) && std::isfinite(v.y); }

float cooldownFor(CharacterType character) {
    return character == CharacterType::Bolts
        ? CharacterStats::BOLTS_GROUND_POUND_COOLDOWN
        : CharacterStats::VOLTS_HOVER_COOLDOWN;
}

} // namespace

void Simulation::loadLevel(const LevelSpec& level) {
    platforms_ = level.platforms;
    // A patrol with a usable path and speed makes a mover; anything else stays a static platform. Movers stay out of
    // the grid and are merged into every resolve by index.
    movers_.clear();
    moverIndices_.clear();
    std::vector<bool> moving(platforms_.size(), false);
    for (std::size_t i = 0; i < platforms_.size(); ++i) {
        Platform& platform = platforms_[i];
        if (!platform.patrol) continue;
        const PlatformPatrol& patrol = *platform.patrol;
        const float dx = patrol.to.x - patrol.from.x;
        const float dy = patrol.to.y - patrol.from.y;
        const float length = std::sqrt(dx * dx + dy * dy);
        const float speed = std::abs(patrol.speed);
        if (!isFinite(patrol.from) || !isFinite(patrol.to) || !std::isfinite(length) || !(length > 0.0f) ||
            !std::isfinite(speed) || !(speed > 0.0f)) {
            continue;
        }
        // Start at the point of the path nearest the authored centre (the centre itself when it is on the path).
        float t = ((platform.position.x - patrol.from.x) * dx + (platform.position.y - patrol.from.y) * dy) / (length * length);
        t = std::isfinite(t) ? std::min(std::max(t, 0.0f), 1.0f) : 0.0f;
        Mover mover{static_cast<int>(i), patrol.from, patrol.to, length, speed, t * length, 1.0f};
        platform.position = pointOnPath(mover);
        movers_.push_back(mover);
        moverIndices_.push_back(static_cast<int>(i));
        moving[i] = true;
    }
    platformGrid_.build(platforms_, moving);
    moverGhost_.assign(platforms_.size(), false);
    groundPlatform_ = -1;
    goals_ = level.goals;
    goalReached_.assign(goals_.size(), false);
    checkpoints_ = level.checkpoints;
    checkpointInside_.assign(checkpoints_.size(), false);
    activeCheckpoint_ = -1;
    bounds_ = level.bounds;
    cameraTuning_ = level.camera;
    cameraTuning_.verticalDeadzone = std::max(0.0f, cameraTuning_.verticalDeadzone);

    minPlatformHalfHeight_ = 0.0f;
    minPlatformHalfWidth_ = 0.0f;
    for (std::size_t i = 0; i < platforms_.size(); ++i) {
        const float halfHeight = std::max(0.0f, platforms_[i].size.y * 0.5f);
        const float halfWidth = std::max(0.0f, platforms_[i].size.x * 0.5f);
        minPlatformHalfHeight_ = (i == 0) ? halfHeight : std::min(minPlatformHalfHeight_, halfHeight);
        minPlatformHalfWidth_ = (i == 0) ? halfWidth : std::min(minPlatformHalfWidth_, halfWidth);
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
    launchers_ = level.launchers;
    launcherInside_.assign(launchers_.size(), false);

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
    jumpCutArmed_ = false;

    snapCamera();
}

// Camera on the player, no lerp.
void Simulation::snapCamera() {
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
    // Release while a jump is rising: shorter hop. Only on the release edge, so it applies once per press. A launch
    // disarms it: letting go of a key held through a launcher does not cut the launch.
    if (!input.jump && jumpHeld_ && jumpCutArmed_ && player_.velocity.y > 0.0f) {
        player_.velocity.y *= Physics::JUMP_CUT_MULTIPLIER;
        jumpCutArmed_ = false;
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
    moveMovers(dt);
    updateLaunchers();
    updateGroundState(wasGrounded, dt);
    moveHazards(dt);
    if (touchingHazard()) respawn();
    updateCheckpoints();
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

bool Simulation::restoreCheckpoint(int index) {
    if (index < 0 || static_cast<std::size_t>(index) >= checkpoints_.size()) return false;
    activeCheckpoint_ = index;
    respawnPoint_ = checkpoints_[static_cast<std::size_t>(index)].position;
    player_.position = respawnPoint_;
    player_.velocity = {0.0f, 0.0f};
    player_.grounded = false;
    coyoteTimer_ = 0.0f;
    jumpBuffered_ = false;
    jumpBufferTimer_ = 0.0f;
    jumpCutArmed_ = false;
    clearContacts();
    syncTriggerContact();  // standing in it already: not an arrival
    snapCamera();
    return true;
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

void Simulation::emit(SimEventType type, int index) {
    events_.push_back({type, player_.position, player_.velocity, index});
}

bool Simulation::tryBufferedJump() {
    if (!jumpBuffered_) return false;
    if (!player_.grounded && coyoteTimer_ <= 0.0f) return false;
    player_.velocity.y = jumpStrength();
    player_.grounded = false;
    coyoteTimer_ = 0.0f;
    jumpBuffered_ = false;
    jumpBufferTimer_ = 0.0f;
    jumpCutArmed_ = true;
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
    groundPlatform_ = -1;
    const float move = player_.velocity.y * dt;
    const int steps = verticalSubsteps(move);
    const float stepMove = move / static_cast<float>(steps);
    for (int i = 0; i < steps; ++i) {
        const float previousBottom = player_.position.y - player_.size.y * 0.5f;
        player_.position.y += stepMove;
        if (resolveVertical(previousBottom, true)) break;  // stopped by a platform: the rest of this tick's move is cancelled
    }
}

// Call `push(index, platform)` for every platform the body overlaps, in ascending index order, exactly as a walk over
// platforms_ would: each push moves the body, and later platforms are tested against the moved box. The grid only
// narrows the walk; movers are not in it, so with `includeMovers` their indices are merged in (a ghosted mover is
// skipped). After a push the old candidates may miss platforms the moved box now reaches, so query again and carry on
// past the index that pushed. `push` returns false when it lets the body through (a one-way it is not landing on);
// that is not a hit. Returns whether anything was hit.
template <typename Push>
bool Simulation::resolvePlatforms(bool includeMovers, Push push) {
    bool hit = false;
    int tested = -1;  // every platform up to this index has had its turn
    for (bool requery = true; requery;) {
        requery = false;
        platformGrid_.query(player_.position, player_.size, candidates_);
        if (includeMovers && !moverIndices_.empty()) {
            candidates_.insert(candidates_.end(), moverIndices_.begin(), moverIndices_.end());
            std::sort(candidates_.begin(), candidates_.end());
        }
        for (const int index : candidates_) {
            if (index <= tested) continue;
            tested = index;
            if (moverGhost_[static_cast<std::size_t>(index)]) continue;
            const Platform& platform = platforms_[static_cast<std::size_t>(index)];
            if (!boxesOverlap(player_.position, player_.size, platform.position, platform.size, CONTACT_EPSILON)) continue;
            if (!push(index, platform)) continue;
            hit = true;
            requery = true;
            break;
        }
    }
    return hit;
}

// Push the body out of every platform it overlaps, along Y. `previousBottom` is where its feet were before this move
// (one-ways only stop a body that started at or above their top). With `includeMovers` false only static platforms
// count (a rider being carried). Returns whether anything was hit.
bool Simulation::resolveVertical(float previousBottom, bool includeMovers) {
    return resolvePlatforms(includeMovers, [this, previousBottom](int index, const Platform& platform) {
        return pushOutVertical(index, platform, previousBottom);
    });
}

// A solid platform pushes the body back towards the side its centre is on; landing on a top sets grounded and the
// platform stood on. A one-way only has a top, and only for a body that was at or above it and is not rising: from
// anywhere else it lets the body through (returns false).
bool Simulation::pushOutVertical(int index, const Platform& platform, float previousBottom) {
    const float reach = (player_.size.y + platform.size.y) * 0.5f;
    const bool above = platform.oneWay || player_.position.y > platform.position.y;
    if (platform.oneWay) {
        const float top = platform.position.y + platform.size.y * 0.5f;
        if (!(player_.velocity.y <= 0.0f && previousBottom >= top - CONTACT_EPSILON)) return false;
    }
    if (above) {
        player_.position.y = platform.position.y + reach;
        if (player_.velocity.y <= 0.0f) {
            player_.velocity.y = 0.0f;
            player_.grounded = true;
            groundPlatform_ = index;
        }
    } else {
        player_.position.y = platform.position.y - reach;
        if (player_.velocity.y > 0.0f) player_.velocity.y = 0.0f;
    }
    return true;
}

// Out of the side the body's centre is on. One-ways have no sides.
bool Simulation::pushOutHorizontal(const Platform& platform) {
    if (platform.oneWay) return false;
    const float reach = (player_.size.x + platform.size.x) * 0.5f;
    player_.position.x = (player_.position.x > platform.position.x)
        ? platform.position.x + reach
        : platform.position.x - reach;
    player_.velocity.x = 0.0f;
    return true;
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

// The same rule for one tick of a mover, on both axes (half-width + thinnest half-width for x), so neither the
// mover nor a rider it carries can skip across a thin platform or the player.
int Simulation::carrySubsteps(const Vec2& move) const {
    const float maxY = 0.5f * (0.5f * player_.size.y + minPlatformHalfHeight_);
    const float maxX = 0.5f * (0.5f * player_.size.x + minPlatformHalfWidth_);
    const float steps = std::max(maxX > 0.0f ? std::abs(move.x) / maxX : 0.0f,
                                 maxY > 0.0f ? std::abs(move.y) / maxY : 0.0f);
    if (!(steps > 1.0f)) return 1;
    return std::min(MAX_VERTICAL_SUBSTEPS, static_cast<int>(std::ceil(steps)));
}

void Simulation::moveHorizontal(float dt) {
    player_.position.x += player_.velocity.x * dt;
    resolvePlatforms(true, [this](int, const Platform& platform) { return pushOutHorizontal(platform); });
}

bool Simulation::overlapsPlatform(const Platform& platform) const {
    return boxesOverlap(player_.position, player_.size, platform.position, platform.size, CONTACT_EPSILON);
}

// Each mover advances along its patrol (turning at both ends), in substeps. A player grounded on it this tick rides:
// every substep moves them by the same delta, then resolves them against static platforms only, so a wall or ceiling
// stops them at its surface (that axis then stops carrying for the tick). A rider whose feet also rest on a static
// platform is carried up and down but not sideways. Anyone else it runs into is pushed out
// along its motion (see pushPlayer). A solid mover that ends its move still overlapping the player is ghosted, so the
// squeeze is never resolved by popping the player across a platform: movers do not crush.
void Simulation::moveMovers(float dt) {
    for (Mover& mover : movers_) {
        const std::size_t index = static_cast<std::size_t>(mover.platform);
        mover.distance += mover.direction * mover.speed * dt;
        if (mover.distance >= mover.length) {
            mover.distance = mover.length;
            mover.direction = -1.0f;
        } else if (mover.distance <= 0.0f) {
            mover.distance = 0.0f;
            mover.direction = 1.0f;
        }
        const Vec2 start = platforms_[index].position;
        const Vec2 end = pointOnPath(mover);
        const Vec2 delta{end.x - start.x, end.y - start.y};
        const int steps = carrySubsteps(delta);
        bool blockedX = false;
        bool blockedY = false;
        for (int i = 1; i <= steps; ++i) {
            const Vec2 previous = platforms_[index].position;
            const float t = static_cast<float>(i) / static_cast<float>(steps);
            platforms_[index].position = (i == steps) ? end : Vec2{start.x + delta.x * t, start.y + delta.y * t};
            const Vec2 step{platforms_[index].position.x - previous.x, platforms_[index].position.y - previous.y};
            if (player_.grounded && groundPlatform_ == mover.platform) {
                carryRider(step, blockedX, blockedY);
            } else {
                pushPlayer(mover.platform, previous, step);
            }
        }
        const Platform& platform = platforms_[index];
        moverGhost_[index] = !platform.oneWay && overlapsPlatform(platform);
    }
}

// Whether the player's feet also rest on a static platform (solid or one-way): the dock a mover slid into, the end of
// a floor. Such a rider is not dragged sideways by the mover; they are standing on solid ground as well.
bool Simulation::hasStaticFooting() {
    const float bottom = player_.position.y - player_.size.y * 0.5f;
    platformGrid_.query(player_.position, player_.size, candidates_);
    for (const int index : candidates_) {
        const Platform& platform = platforms_[static_cast<std::size_t>(index)];
        const float top = platform.position.y + platform.size.y * 0.5f;
        const float overlapX = (player_.size.x + platform.size.x) * 0.5f - std::abs(player_.position.x - platform.position.x);
        if (overlapX > CONTACT_EPSILON && std::abs(bottom - top) <= FOOTING_TOLERANCE) return true;
    }
    return false;
}

void Simulation::carryRider(const Vec2& step, bool& blockedX, bool& blockedY) {
    if (!blockedX && step.x != 0.0f && !hasStaticFooting()) {
        player_.position.x += step.x;
        if (resolvePlatforms(false, [this](int, const Platform& platform) { return pushOutHorizontal(platform); })) {
            blockedX = true;
        }
    }
    if (!blockedY && step.y != 0.0f) {
        const float previousBottom = player_.position.y - player_.size.y * 0.5f;
        player_.position.y += step.y;
        if (resolveVertical(previousBottom, false)) blockedY = true;
    }
}

// Mover `index` just moved by `step` (from `previous`) and may now overlap a player who is not riding it. A solid one
// pushes them out along its larger motion axis (up: onto its top, grounded unless they are rising), then static
// platforms resolve them; whatever overlap is left is the ghost's business. A one-way only picks up a player whose
// feet were at or above its top before this step.
void Simulation::pushPlayer(int index, const Vec2& previous, const Vec2& step) {
    const Platform& platform = platforms_[static_cast<std::size_t>(index)];
    if (moverGhost_[static_cast<std::size_t>(index)] || !overlapsPlatform(platform)) return;
    if (step.x == 0.0f && step.y == 0.0f) return;
    const float bottom = player_.position.y - player_.size.y * 0.5f;
    const float reachY = (player_.size.y + platform.size.y) * 0.5f;
    const auto putOnTop = [&]() {
        player_.position.y = platform.position.y + reachY;
        if (player_.velocity.y <= 0.0f) {
            player_.velocity.y = 0.0f;
            player_.grounded = true;
            groundPlatform_ = index;
        }
    };
    if (platform.oneWay) {
        const float previousTop = previous.y + platform.size.y * 0.5f;
        if (step.y > 0.0f && bottom >= previousTop - CONTACT_EPSILON) putOnTop();
        return;
    }
    if (std::abs(step.y) >= std::abs(step.x)) {
        if (step.y > 0.0f) {
            putOnTop();
        } else {
            player_.position.y = platform.position.y - reachY;
            if (player_.velocity.y > 0.0f) player_.velocity.y = 0.0f;
        }
        resolveVertical(bottom, false);
    } else {
        const float reachX = (player_.size.x + platform.size.x) * 0.5f;
        player_.position.x = platform.position.x + (step.x > 0.0f ? reachX : -reachX);
        resolvePlatforms(false, [this](int, const Platform& p) { return pushOutHorizontal(p); });
    }
}

// Entering a launcher replaces the velocity with its own (both axes, whatever was there: a jump, a pound, a hover's
// fall) and leaves the ground, like a jump without the jump cut. It fires again only after the player has left it.
// Several entered on one tick fire in index order, so the last one's velocity stands.
void Simulation::updateLaunchers() {
    for (std::size_t i = 0; i < launchers_.size(); ++i) {
        const Launcher& launcher = launchers_[i];
        const bool inside = boxesOverlap(player_.position, player_.size, launcher.position, launcher.size, 0.0f);
        if (inside && !launcherInside_[i]) {
            player_.velocity = launcher.velocity;
            player_.grounded = false;
            groundPlatform_ = -1;
            coyoteTimer_ = 0.0f;
            jumpCutArmed_ = false;
            emit(SimEventType::Launched, static_cast<int>(i));
        }
        launcherInside_[i] = inside;
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

// A checkpoint fires when the player starts overlapping it and re-arms once they have left, so standing in one (or
// being respawned onto one) does not repeat. Several entered on one tick fire in index order; the last is the active one.
void Simulation::updateCheckpoints() {
    for (std::size_t i = 0; i < checkpoints_.size(); ++i) {
        const bool inside = boxesOverlap(player_.position, player_.size, checkpoints_[i].position, checkpoints_[i].size, 0.0f);
        if (inside && !checkpointInside_[i]) {
            activeCheckpoint_ = static_cast<int>(i);
            respawnPoint_ = checkpoints_[i].position;
            emit(SimEventType::CheckpointReached, activeCheckpoint_);
        }
        checkpointInside_[i] = inside;
    }
}

// Record which checkpoints and launchers the player overlaps right now without firing anything (after a teleport
// onto the respawn point).
void Simulation::syncTriggerContact() {
    for (std::size_t i = 0; i < checkpoints_.size(); ++i) {
        checkpointInside_[i] = boxesOverlap(player_.position, player_.size, checkpoints_[i].position, checkpoints_[i].size, 0.0f);
    }
    for (std::size_t i = 0; i < launchers_.size(); ++i) {
        launcherInside_[i] = boxesOverlap(player_.position, player_.size, launchers_[i].position, launchers_[i].size, 0.0f);
    }
}

// After a teleport: no platform stood on, no mover ghosted (the next moves re-detect both).
void Simulation::clearContacts() {
    groundPlatform_ = -1;
    std::fill(moverGhost_.begin(), moverGhost_.end(), false);
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

// Back to the respawn point (the level spawn, or the latest checkpoint), at rest, with the payload on its pad. Hazards,
// terminals, goals, movers and the checkpoint keep their state; only a level load resets those.
void Simulation::respawn() {
    emit(SimEventType::Respawned);  // where it happened
    player_.position = respawnPoint_;
    player_.velocity = {0.0f, 0.0f};
    player_.grounded = false;
    coyoteTimer_ = 0.0f;
    jumpBuffered_ = false;
    jumpBufferTimer_ = 0.0f;
    jumpCutArmed_ = false;
    abilityState_ = AbilityState::Ready;
    abilityActiveTimer_ = 0.0f;
    abilityCooldownTimer_ = 0.0f;
    if (payload_) {
        payload_->position = payload_->origin;
        payload_->carried = false;
    }
    clearContacts();
    syncTriggerContact();
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
