#ifndef SIMULATION_HPP
#define SIMULATION_HPP

// Deterministic platformer core: player body, platforms (solid, one-way, moving), goals, checkpoints, hazards, payload,
// terminals, launchers, character + ability, camera follow. No emscripten, no RNG, no JSON. Game (cpp/src/Game.cpp) adapts it to embind; tests/native drive it directly.

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
    std::vector<Platform> platforms;  // index order is resolve order; `oneWay` / `patrol` per platform
    std::vector<Platform> goals;
    std::vector<Platform> checkpoints;  // triggers: entering one makes its centre the respawn point
    std::optional<LevelBounds> bounds;  // clamps the camera centre
    CameraTuning camera;
    // Runtime fields (enabled, direction, carried, origin, used) are reset by Simulation::loadLevel.
    std::vector<Hazard> hazards;
    std::optional<Payload> payload;     // present: goals only complete while it is carried
    std::vector<Terminal> terminals;
    std::vector<Launcher> launchers;
};

// Runtime state of a platform with a usable patrol (built by loadLevel). Its live box is platforms()[platform].
struct Mover {
    int platform;       // index into the level's platforms
    Vec2 from;
    Vec2 to;
    float length;       // |to - from|, > 0
    float speed;        // > 0
    float distance;     // along the path from `from`, in [0, length]
    float direction;    // +1 towards `to`, -1 back
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
    // vertical move + resolve (sets grounded and the platform stood on, subdivided for fast moves), horizontal move +
    // resolve, moving platforms (each moves along its patrol and carries a rider standing on it, or pushes the player
    // it runs into; substepped), launcher overlap (replaces the velocity), landing and coyote bookkeeping, hazard
    // patrol + hazard overlap (respawn), checkpoints, payload pickup/carry, animation, camera, goals.
    // Launchers run after collision so a pad fires from a resolved position, and before hazards so a pad and a
    // hazard in the same box have a defined winner: the launch happens, then the hazard still respawns the player
    // if they still overlap.
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
    const std::vector<Platform>& platforms() const { return platforms_; }  // movers at their current position
    const std::vector<Mover>& movers() const { return movers_; }            // ascending platform index
    int groundPlatform() const { return groundPlatform_; }  // platform the last vertical resolve landed on, or -1
    const PlatformGrid& platformGrid() const { return platformGrid_; }
    const std::vector<Platform>& goals() const { return goals_; }
    const std::vector<Platform>& checkpoints() const { return checkpoints_; }
    int activeCheckpoint() const { return activeCheckpoint_; }  // -1: none reached, respawn is the level spawn
    const std::vector<Hazard>& hazards() const { return hazards_; }
    const std::optional<Payload>& payload() const { return payload_; }
    const std::vector<Terminal>& terminals() const { return terminals_; }
    const std::vector<Launcher>& launchers() const { return launchers_; }
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
    bool resolveVertical(float previousBottom, bool includeMovers);
    bool pushOutVertical(int index, const Platform& platform, float previousBottom);
    bool pushOutHorizontal(const Platform& platform);
    int verticalSubsteps(float move) const;
    int carrySubsteps(const Vec2& move) const;
    void moveHorizontal(float dt);
    template <typename Push> bool resolvePlatforms(bool includeMovers, Push push);
    void moveMovers(float dt);
    void carryRider(const Vec2& step, bool& blockedX, bool& blockedY);
    bool hasStaticFooting();
    void pushPlayer(int index, const Vec2& previousPosition, const Vec2& step);
    bool overlapsPlatform(const Platform& platform) const;
    void updateLaunchers();
    void syncTriggerContact();
    void clearContacts();
    void updateGroundState(bool wasGrounded, float dt);
    void updateAnimation(float dt);
    void updateCamera(float dt);
    void clampCamera();
    void checkGoals();
    void updateCheckpoints();
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
    PlatformGrid platformGrid_;       // broadphase over the static platforms_, built in loadLevel (movers left out)
    std::vector<int> candidates_;     // scratch for platformGrid_ queries
    std::vector<Mover> movers_;
    std::vector<int> moverIndices_;   // movers_[i].platform, ascending: merged into every query that includes movers
    // A mover that ended its move still overlapping the player (it pushed them into something static, or a blocked
    // rider): ignored by the player's own resolves until the overlap ends, so a squeeze never pops them across a
    // platform. Indexed like platforms_.
    std::vector<bool> moverGhost_;
    int groundPlatform_ = -1;
    std::vector<Platform> goals_;
    std::vector<bool> goalReached_;
    std::vector<Platform> checkpoints_;
    std::vector<bool> checkpointInside_;  // the player overlapped it on the last check: it fires again only after a gap
    int activeCheckpoint_ = -1;
    float minPlatformHalfHeight_ = 0.0f;
    float minPlatformHalfWidth_ = 0.0f;
    std::vector<Hazard> hazards_;
    std::optional<Payload> payload_;
    std::vector<Terminal> terminals_;
    std::vector<Launcher> launchers_;
    std::vector<bool> launcherInside_;  // like checkpointInside_: fires again only after the player has left
    Vec2 respawnPoint_{0.0f, 0.0f};  // the level spawn (or where the player stood when a spawn-less level loaded), then the latest checkpoint

    AnimationState animation_{PlayerState::Idle, 0, false};
    float animationTimer_ = 0.0f;

    float targetVelocityX_ = 0.0f;
    float coyoteTimer_ = 0.0f;
    float jumpBufferTimer_ = 0.0f;
    bool jumpBuffered_ = false;  // pressed within the last JUMP_BUFFER_TIME and not yet used
    bool jumpHeld_ = false;
    bool jumpCutArmed_ = false;  // a jump is rising: releasing the key cuts it. A launch disarms it.

    CharacterType character_ = CharacterType::Bolts;
    AbilityState abilityState_ = AbilityState::Ready;
    float abilityActiveTimer_ = 0.0f;
    float abilityCooldownTimer_ = 0.0f;
    bool abilityKeyHeld_ = false;

    std::vector<SimEvent> events_;
};

#endif // SIMULATION_HPP
