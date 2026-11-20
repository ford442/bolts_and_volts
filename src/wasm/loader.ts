import type { CoreLevel } from '../lib/levelData';

export interface Vec2 { x: number; y: number; }

export interface Platform { position: Vec2; size: Vec2; }

export interface InputState { left: boolean; right: boolean; jump: boolean; abilityKey: boolean; }

export interface Game {
  update(deltaTime: number): void;
  handleInput(inputState: InputState): void;
  /** Pack this frame's render state into the snapshot buffer; returns its length in floats. */
  captureFrame(): number;
  /** Byte address of the snapshot buffer in the wasm heap. Valid until the next `captureFrame`. */
  framePtr(): number;
  getPlayerPosition(): Vec2;
  getPlayerSize(): Vec2;
  getCameraPosition(): Vec2;
  getLevelName(): string;
  getLevelDescription(): string;
  setSoundCallback(callback: (soundName: string) => void): void;
  loadLevel(level: CoreLevel): void;
  setLevelCompleteCallback(callback: () => void): void;
  // Two-character (Bolts / Volts) system
  switchCharacter(): void;
  getCurrentCharacter(): number; // 0 = Bolts, 1 = Volts
  useAbility(): void;
  getAbilityState(): number;    // 0 = Ready, 1 = Active, 2 = Cooldown
  getAbilityCooldownPercent(): number; // 0.0 to 1.0
  delete(): void;
}

export interface GameModule {
  Game: { new(): Game };
  /** Replaced by Emscripten when memory grows: read it fresh every frame, never cache it. */
  HEAPF32: Float32Array;
}

/**
 * Load the Emscripten ES module (`-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createWasmModule`). The dynamic
 * import keeps the glue + .wasm fetch on demand and lets Vite handle the .wasm sibling asset.
 */
export const loadWasmModule = async (): Promise<GameModule> => {
  const mod = (await import('../wasm/main.js')) as { default: () => Promise<GameModule> };
  return mod.default();
};
