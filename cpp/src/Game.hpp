#ifndef GAME_HPP
#define GAME_HPP

#include <vector>
#include <string>
#include <cstdint>
#include <emscripten/val.h>
#include "Types.hpp"
#include "ParticleSystem.hpp"
#include "sim/Simulation.hpp"


// embind adapter around Simulation (cpp/src/sim): parses level values into a LevelSpec, forwards input and fixed
// ticks, turns simulation events into particles, sounds and the level-complete callback, and packs the frame
// snapshot. Gameplay rules live in the simulation, not here.
class Game {
public:
    Game();
    void update(float deltaTime);
    void handleInput(const InputState& input);
    void setSoundCallback(emscripten::val callback);
    void loadLevel(const emscripten::val& level);
    void setLevelCompleteCallback(emscripten::val callback);
    Vec2 getPlayerPosition() const;
    Vec2 getPlayerSize() const;
    Vec2 getCameraPosition() const;
    std::string getLevelName() const;
    std::string getLevelDescription() const;

    // Pack this frame's render state into `frameBuffer` (layout: FrameLayout in Types.hpp) and return
    // its length in floats. framePtr() is its byte address in the wasm heap; valid until the next call.
    int captureFrame();
    uintptr_t framePtr() const;

    // === Two-character (Bolts & Volts) API ===
    float getMoveSpeed() const;
    float getJumpStrength() const;
    void switchCharacter();
    int getCurrentCharacter() const; // 0 = Bolts, 1 = Volts
    void useAbility();              // Activate character-specific ability
    int getAbilityState() const;    // 0 = Ready, 1 = Active, 2 = Cooldown
    float getAbilityCooldownPercent() const; // 0.0 to 1.0

private:
    void dispatchEvents();
    void playSound(const std::string& soundName);

    Simulation sim;
    ParticleSystem particleSystem;
    std::vector<SimEvent> pendingEvents;  // reused by dispatchEvents
    emscripten::val soundCallback = emscripten::val::null();
    emscripten::val levelCompleteCallback = emscripten::val::null();
    std::string levelName = "test-1";
    std::string levelDescription;
    std::vector<float> frameBuffer;
};


#endif // GAME_HPP
