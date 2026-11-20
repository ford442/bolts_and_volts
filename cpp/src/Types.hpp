#ifndef TYPES_HPP
#define TYPES_HPP

#include <string>
#include <vector>

struct Vec2 { float x; float y; };

struct Platform { Vec2 position; Vec2 size; };

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
// src/game/snapshot.ts (FRAME_HEADER etc.) — change both together.
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
    constexpr int PLATFORM_COUNT = 12;
    constexpr int GOAL_COUNT = 13;
    constexpr int PARTICLE_COUNT = 14;
    constexpr int HEADER_SIZE = 16;    // slot 15 reserved
    constexpr int BOX_STRIDE = 4;      // platforms and goals: x, y, w, h
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

    // Volts: agile, tech-focused, floaty
    constexpr float VOLTS_MOVE_SPEED = 3.2f;
    constexpr float VOLTS_JUMP_STRENGTH = 7.0f;
    constexpr float VOLTS_HOVER_GRAVITY_MULT = 0.15f;
    constexpr float VOLTS_HOVER_DURATION = 1.2f;
    constexpr float VOLTS_HOVER_COOLDOWN = 2.0f;
}

#endif // TYPES_HPP
