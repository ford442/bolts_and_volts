#ifndef SIMULATION_HPP
#define SIMULATION_HPP

// Deterministic platformer core: player body, platforms, goals, character + ability, camera follow. No
// emscripten, no RNG, no JSON. Game (cpp/src/Game.cpp) adapts it to embind; tests/native drive it directly.

#include <optional>
#include <vector>

#include "../Types.hpp"
#include "SimEvent.hpp"

struct LevelBounds { Vec2 min; Vec2 max; };

struct CameraTuning {
    bool followY = false;           // false: the camera only follows X (y stays 0)
    float verticalDeadzone = 0.75f;
    float lookAheadY = 0.8f;
};

// A level as already-parsed numbers (JSON stays on the TypeScript side; Game::loadLevel copies these out of the
// embind value).
struct LevelSpec {
    std::optional<Vec2> spawn;      // absent: the player keeps its current position and velocity
    std::vector<Platform> platforms;
    std::vector<Platform> goals;
    std::optional<LevelBounds> bounds;  // clamps the camera centre
    CameraTuning camera;
};

struct PlayerBody {
    Vec2 position{0.0f, 0.0f};
    Vec2 velocity{0.0f, 0.0f};
    Vec2 size{0.5f, 0.8f};
    bool grounded = false;  // the last update's vertical move ended resting on a platform top
};

class Simulation {
public:
    // Longest step update() will take; the game always passes exactly 1/60 s.
    static constexpr float MAX_STEP = 0.033f;

    void loadLevel(const LevelSpec& level);

    // Latch the held keys for the next update(): horizontal target and facing, jump press (buffered) and release
    // (jump cut), ability press (fires useAbility immediately).
    void handleInput(const InputState& input);

    // One fixed tick. Order: buffered/coyote jump, horizontal acceleration, ability and buffer timers, gravity,
    // vertical move + resolve (sets grounded, subdivided for fast moves), horizontal move + resolve, landing and
    // coyote bookkeeping, animation, camera, goals.
    void update(float deltaTime);

    void useAbility();
    void switchCharacter();

    // Move the events produced since the last drain into `out` (cleared first). Game drains after every call.
    void drainEvents(std::vector<SimEvent>& out);

    const PlayerBody& player() const { return player_; }
    const Vec2& camera() const { return camera_; }
    const AnimationState& animation() const { return animation_; }
    const std::vector<Platform>& platforms() const { return platforms_; }
    const std::vector<Platform>& goals() const { return goals_; }
    float coyoteTimer() const { return coyoteTimer_; }
    CharacterType character() const { return character_; }
    AbilityState abilityState() const { return abilityState_; }
    float abilityCooldownPercent() const;  // 0..1 while cooling down, 1 while active, 0 when ready
    float moveSpeed() const;
    float jumpStrength() const;

private:
    void emit(SimEventType type);
    bool tryBufferedJump();
    void applyHorizontalAcceleration(float dt);
    void updateAbilityTimers(float dt);
    void decayJumpBuffer(float dt);
    void applyGravity(float dt);
    void moveVertical(float dt);
    bool resolveVertical();
    int verticalSubsteps(float move) const;
    void moveHorizontal(float dt);
    void updateGroundState(bool wasGrounded, float dt);
    void updateAnimation(float dt);
    void updateCamera(float dt);
    void clampCamera();
    void checkGoals();
    void startCooldown();

    PlayerBody player_;
    Vec2 camera_{0.0f, 0.0f};
    CameraTuning cameraTuning_;
    std::optional<LevelBounds> bounds_;

    std::vector<Platform> platforms_;
    std::vector<Platform> goals_;
    std::vector<bool> goalReached_;
    float minPlatformHalfHeight_ = 0.0f;

    AnimationState animation_{PlayerState::Idle, 0, false};
    float animationTimer_ = 0.0f;

    float targetVelocityX_ = 0.0f;
    float coyoteTimer_ = 0.0f;
    float jumpBufferTimer_ = 0.0f;
    bool jumpBuffered_ = false;  // pressed within the last JUMP_BUFFER_TIME and not yet used
    bool jumpHeld_ = false;

    CharacterType character_ = CharacterType::Bolts;
    AbilityState abilityState_ = AbilityState::Ready;
    float abilityActiveTimer_ = 0.0f;
    float abilityCooldownTimer_ = 0.0f;
    bool abilityKeyHeld_ = false;

    std::vector<SimEvent> events_;
};

#endif // SIMULATION_HPP
