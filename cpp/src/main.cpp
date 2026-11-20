#include "Game.hpp"
#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(WASM_Venture) {
    emscripten::value_object<Vec2>("Vec2")
        .field("x", &Vec2::x)
        .field("y", &Vec2::y);

    emscripten::value_object<InputState>("InputState")
        .field("left", &InputState::left)
        .field("right", &InputState::right)
        .field("jump", &InputState::jump)
        .field("abilityKey", &InputState::abilityKey);

    // Per-frame render state crosses the boundary as one float buffer (captureFrame + framePtr,
    // read through HEAPF32), not as embind objects. Layout: FrameLayout in Types.hpp.
    emscripten::class_<Game>("Game")
        .constructor<>()
        .function("update", &Game::update)
        .function("handleInput", &Game::handleInput)
        .function("captureFrame", &Game::captureFrame)
        .function("framePtr", &Game::framePtr)
        .function("getPlayerPosition", &Game::getPlayerPosition)
        .function("getCameraPosition", &Game::getCameraPosition)
        .function("getPlayerSize", &Game::getPlayerSize)
        .function("getLevelName", &Game::getLevelName)
        .function("getLevelDescription", &Game::getLevelDescription)
        .function("setSoundCallback", &Game::setSoundCallback)
        .function("loadLevel", &Game::loadLevel)
        .function("setLevelCompleteCallback", &Game::setLevelCompleteCallback)
        // Bolts & Volts two-character system
        .function("switchCharacter", &Game::switchCharacter)
        .function("getCurrentCharacter", &Game::getCurrentCharacter)
        .function("useAbility", &Game::useAbility)
        .function("getAbilityState", &Game::getAbilityState)
        .function("getAbilityCooldownPercent", &Game::getAbilityCooldownPercent);
}
