#ifndef TYPES_HPP
#define TYPES_HPP

#include <optional>
#include <string>
#include <vector>

struct Vec2 { float x; float y; };

// Back and forth between `from` and `to` (any direction, diagonals included) at a constant `speed` in units/s.
struct PlatformPatrol {
    Vec2 from;
    Vec2 to;
    float speed;
};

// A solid box. Goals and checkpoints reuse it as a plain trigger box and ignore `oneWay` and `patrol`.
// `oneWay`: only the top face is solid, and only for a body that was at or above it and is not rising.
// `patrol`: a moving platform; Simulation::loadLevel keeps it static unless the path and speed are usable.
struct Platform {
    Vec2 position;
    Vec2 size;
    bool oneWay = false;
    std::optional<PlatformPatrol> patrol = std::nullopt;
};

// Trigger (strict overlap, never solid). Entering one replaces the player's velocity with `velocity`; it re-arms once
// the player has left.
struct Launcher {
    Vec2 position;
    Vec2 size;
    Vec2 velocity;
};

// Overlap respawns the player at the respawn point (the level spawn, or the latest checkpoint). With speed > 0 it patrols x in [x0, x1] at a constant speed
// (`direction` is +1 or -1); speed 0 is a static hazard (x0 == x1 == position.x). Disabled by a terminal.
struct Hazard {
    Vec2 position;
    Vec2 size;
    float x0;
    float x1;
    float speed;
    bool enabled;
    float direction;
};

// The one pickup. Overlap parents it to the player (sitting on top of the collision box); a level with a payload
// only completes while it is carried. Respawn (or a reload) puts it back at `origin`.
struct Payload {
    Vec2 position;
    Vec2 size;
    Vec2 origin;
    bool carried;
};

// Volts pressing the ability key while overlapping an unused terminal disables hazard `targetHazard` (index into
// the level's hazards; -1 or out of range: nothing). One use per level load.
struct Terminal {
    Vec2 position;
    Vec2 size;
    int targetHazard;
    bool used;
};

struct InputState { bool left; bool right; bool jump; bool abilityKey; };

// Crosses the JS boundary as an int (FrameLayout header slot ANIM_STATE); keep values in sync with
// `AnimState` in src/game/snapshot.ts.
enum class PlayerState {
    Idle = 0,
    Run = 1,
    Jump = 2,
    Fall = 3
};

// Character identity for Bolts & Volts (additive, non-breaking groundwork)
enum class CharacterType {
    Bolts = 0,   // Physical / armored / heavy lifting feel
    Volts = 1    // Tech / hologram / agile feel
};

// Ability state for character-specific moves
enum class AbilityState {
    Ready,       // Ability can be used
    Active,      // Ability is currently in use
    Cooldown     // Ability is on cooldown
};

struct AnimationState {
    PlayerState currentState;
    int currentFrame;
    bool facingLeft;
};

// Float layout of the per-frame snapshot written by Game::captureFrame(). Mirrored in
// src/game/snapshot.ts (FRAME) — change both together. Only what moves or changes state is in it: platforms, goals
// and launchers are static for the life of a loadLevel, so the TypeScript side keeps the arrays it passed in; a
// moving platform's current centre comes in the movers block, keyed by its platform index.
namespace FrameLayout {
    constexpr int PLAYER_X = 0;
    constexpr int PLAYER_Y = 1;
    constexpr int PLAYER_W = 2;
    constexpr int PLAYER_H = 3;
    constexpr int CAMERA_X = 4;
    constexpr int CAMERA_Y = 5;
    constexpr int ANIM_STATE = 6;      // PlayerState as int
    constexpr int ANIM_FRAME = 7;
    constexpr int FACING_LEFT = 8;     // 0 or 1
    constexpr int CHARACTER = 9;       // CharacterType as int
    constexpr int ABILITY_STATE = 10;  // AbilityState as int
    constexpr int ABILITY_COOLDOWN = 11; // 0..1
    // Slots 12-13 are reserved and written as 0 (they held the platform and goal counts).
    constexpr int PARTICLE_COUNT = 14;
    constexpr int HAZARD_COUNT = 15;
    constexpr int PAYLOAD_COUNT = 16;  // 0 or 1
    constexpr int TERMINAL_COUNT = 17;
    constexpr int MOVER_COUNT = 18;    // moving platforms
    constexpr int HEADER_SIZE = 20;    // slots 12-13 and 19 reserved
    // Body order: hazards, payload, terminals (ENTITY_STRIDE), movers (MOVER_STRIDE), particles.
    constexpr int ENTITY_STRIDE = 5;   // x, y, w, h, flag (hazard enabled / payload carried / terminal used)
    constexpr int MOVER_STRIDE = 3;    // platform index (into the level's platforms), x, y (current centre)
    constexpr int PARTICLE_STRIDE = 4; // x, y, size, life / maxLife
}

// Physics tuning constants (extracted for clarity and easy iteration)
namespace Physics {
    constexpr float GRAVITY = -9.8f * 2.5f;           // Base gravity
    constexpr float APEX_GRAVITY_MULT = 0.45f;        // Reduced gravity near jump apex for hang time
    constexpr float APEX_VELOCITY_THRESHOLD = 1.8f;   // Y velocity below which apex gravity kicks in
    constexpr float COYOTE_TIME = 0.12f;              // Grace period after leaving platform
    constexpr float JUMP_BUFFER_TIME = 0.10f;         // Input buffer for jump presses
    constexpr float JUMP_CUT_MULTIPLIER = 0.45f;      // Velocity cut when releasing jump early
    constexpr float GROUND_ACCEL = 18.0f;             // Horizontal acceleration on ground
    constexpr float AIR_ACCEL = 12.0f;                // Horizontal acceleration in air
    constexpr float GROUND_DECEL = 22.0f;             // Horizontal deceleration on ground
    constexpr float AIR_DECEL = 4.0f;                 // Horizontal deceleration in air (drift)
    constexpr float CAMERA_LERP_SPEED = 5.0f;        // Camera follow smoothing
    constexpr float CAMERA_LOOKAHEAD = 1.2f;          // Camera look-ahead distance in move direction
}

// Character-specific tuning
namespace CharacterStats {
    // Bolts: strong, deliberate, physical
    constexpr float BOLTS_MOVE_SPEED = 2.8f;
    constexpr float BOLTS_JUMP_STRENGTH = 6.2f;
    constexpr float BOLTS_GROUND_POUND_SPEED = -12.0f;
    constexpr float BOLTS_GROUND_POUND_COOLDOWN = 0.8f;
    constexpr float BOLTS_GROUND_POUND_DURATION = 0.4f;  // ends earlier on landing
    constexpr float BOLTS_GROUND_POUND_KEEP_VX = 0.2f;   // share of horizontal speed kept when the pound starts

    // Volts: agile, tech-focused, floaty
    constexpr float VOLTS_MOVE_SPEED = 3.2f;
    constexpr float VOLTS_JUMP_STRENGTH = 7.0f;
    constexpr float VOLTS_HOVER_GRAVITY_MULT = 0.15f;
    constexpr float VOLTS_HOVER_DURATION = 1.2f;
    constexpr float VOLTS_HOVER_COOLDOWN = 2.0f;
    constexpr float VOLTS_HOVER_KEEP_FALL = 0.3f;        // share of fall speed kept when hover starts

    constexpr float SWITCH_KEEP_VX = 0.3f;               // share of horizontal speed kept on a character switch
}

#endif // TYPES_HPP
