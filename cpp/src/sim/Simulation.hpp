#ifndef SIMULATION_HPP
#define SIMULATION_HPP

// Deterministic platformer core: player body, platforms, goals, checkpoints, hazards, payload, terminals, character +
// ability, camera follow. No emscripten, no RNG, no JSON. Game (cpp/src/Game.cpp) adapts it to embind; tests/native drive it directly.

#include <optional>
#include <vector>

#include "../Types.hpp"
#include "PlatformGrid.hpp"
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
    std::vector<Platform> checkpoints;  // triggers: entering one makes its centre the respawn point
    std::optional<LevelBounds> bounds;  // clamps the camera centre
    CameraTuning camera;
    // Runtime fields (enabled, direction, carried, origin, used) are reset by Simulation::loadLevel.
    std::vector<Hazard> hazards;
    std::optional<Payload> payload;     // present: goals only complete while it is carried
    std::vector<Terminal> terminals;
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
    // (jump cut), ability press (immediately: uses a terminal if Volts overlaps an unused one, else useAbility).
    void handleInput(const InputState& input);

    // One fixed tick. Order: buffered/coyote jump, horizontal acceleration, ability and buffer timers, gravity,
    // vertical move + resolve (sets grounded, subdivided for fast moves), horizontal move + resolve, landing and
    // coyote bookkeeping, hazard patrol + hazard overlap (respawn), checkpoints, payload pickup/carry, animation,
    // camera, goals.
    void update(float deltaTime);

    void useAbility();
    void switchCharacter();

    // Make checkpoint `index` the respawn point and put the player on it, at rest, with the camera snapped there. For
    // the shell to re-apply a saved checkpoint right after loadLevel (which itself always resets to the spawn).
    // Emits nothing. Returns false and changes nothing when `index` is not a checkpoint of the loaded level.
    bool restoreCheckpoint(int index);

    // Move the events produced since the last drain into `out` (cleared first). Game drains after every call.
    void drainEvents(std::vector<SimEvent>& out);

    const PlayerBody& player() const { return player_; }
    const Vec2& camera() const { return camera_; }
    const AnimationState& animation() const { return animation_; }
    const std::vector<Platform>& platforms() const { return platforms_; }
    const PlatformGrid& platformGrid() const { return platformGrid_; }
    const std::vector<Platform>& goals() const { return goals_; }
    const std::vector<Platform>& checkpoints() const { return checkpoints_; }
    int activeCheckpoint() const { return activeCheckpoint_; }  // -1: none reached, respawn is the level spawn
    const std::vector<Hazard>& hazards() const { return hazards_; }
    const std::optional<Payload>& payload() const { return payload_; }
    const std::vector<Terminal>& terminals() const { return terminals_; }
    const Vec2& respawnPoint() const { return respawnPoint_; }
    float coyoteTimer() const { return coyoteTimer_; }
    CharacterType character() const { return character_; }
    AbilityState abilityState() const { return abilityState_; }
    float abilityCooldownPercent() const;  // 0..1 while cooling down, 1 while active, 0 when ready
    float moveSpeed() const;
    float jumpStrength() const;

private:
    void emit(SimEventType type, int index = -1);
    bool tryBufferedJump();
    void applyHorizontalAcceleration(float dt);
    void updateAbilityTimers(float dt);
    void decayJumpBuffer(float dt);
    void applyGravity(float dt);
    void moveVertical(float dt);
    bool resolveVertical();
    int verticalSubsteps(float move) const;
    void moveHorizontal(float dt);
    template <typename Push> bool resolvePlatforms(Push push);
    void updateGroundState(bool wasGrounded, float dt);
    void updateAnimation(float dt);
    void updateCamera(float dt);
    void clampCamera();
    void checkGoals();
    void updateCheckpoints();
    void syncCheckpointContact();
    void snapCamera();
    void startCooldown();
    bool tryUseTerminal();
    void moveHazards(float dt);
    bool touchingHazard() const;
    void respawn();
    void updatePayload();

    PlayerBody player_;
    Vec2 camera_{0.0f, 0.0f};
    CameraTuning cameraTuning_;
    std::optional<LevelBounds> bounds_;

    std::vector<Platform> platforms_;
    PlatformGrid platformGrid_;       // broadphase over platforms_, built in loadLevel
    std::vector<int> candidates_;     // scratch for platformGrid_ queries
    std::vector<Platform> goals_;
    std::vector<bool> goalReached_;
    std::vector<Platform> checkpoints_;
    std::vector<bool> checkpointInside_;  // the player overlapped it on the last check: it fires again only after a gap
    int activeCheckpoint_ = -1;
    float minPlatformHalfHeight_ = 0.0f;
    std::vector<Hazard> hazards_;
    std::optional<Payload> payload_;
    std::vector<Terminal> terminals_;
    Vec2 respawnPoint_{0.0f, 0.0f};  // the level spawn (or where the player stood when a spawn-less level loaded), then the latest checkpoint

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
