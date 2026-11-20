import type { Page } from '@playwright/test';
import { FRAME } from '../../src/game/snapshot';

type V = { x: number; y: number };
type Box = { position: V; size: V };

export type StubScene = {
  levelName: string;
  levelDescription?: string;
  player?: V;
  camera?: V;
  platforms?: Box[];
  goals?: Box[];
  /** Move the player +0.1 in x on every captureFrame, so per-frame HUD text changes every frame. */
  movingPlayer?: boolean;
};

/**
 * Source for a fake `src/wasm/main.js`: a static scene served through the same snapshot protocol as the real
 * module (`captureFrame` packs into `HEAPF32`, `framePtr` gives its byte address). Layout from FRAME.
 */
export const wasmStubSource = (scene: StubScene): string => `
  const F = ${JSON.stringify(FRAME)};
  const scene = ${JSON.stringify({ player: { x: -3, y: 1 }, camera: { x: 0, y: 0 }, platforms: [], goals: [], levelDescription: '', ...scene })};
  const HEAPF32 = new Float32Array(4096);
  const PTR_FLOATS = 16; // non-zero offset, like a real heap allocation
  class Game {
    update() {}
    handleInput() {}
    captureFrame() {
      if (scene.movingPlayer) scene.player = { x: scene.player.x + 0.1, y: scene.player.y };
      const out = HEAPF32.subarray(PTR_FLOATS);
      out.fill(0, 0, F.HEADER_SIZE);
      out[F.PLAYER_X] = scene.player.x; out[F.PLAYER_Y] = scene.player.y;
      out[F.PLAYER_W] = 1; out[F.PLAYER_H] = 1;
      out[F.CAMERA_X] = scene.camera.x; out[F.CAMERA_Y] = scene.camera.y;
      out[F.PLATFORM_COUNT] = scene.platforms.length;
      out[F.GOAL_COUNT] = scene.goals.length;
      out[F.PARTICLE_COUNT] = 0;
      let o = F.HEADER_SIZE;
      for (const b of [...scene.platforms, ...scene.goals]) {
        out[o++] = b.position.x; out[o++] = b.position.y; out[o++] = b.size.x; out[o++] = b.size.y;
      }
      return o;
    }
    framePtr() { return PTR_FLOATS * 4; }
    getPlayerPosition() { return scene.player; }
    getPlayerSize() { return { x: 1, y: 1 }; }
    getCameraPosition() { return scene.camera; }
    getLevelName() { return scene.levelName; }
    getLevelDescription() { return scene.levelDescription; }
    setSoundCallback() {}
    loadLevel() {}
    setLevelCompleteCallback() {}
    switchCharacter() {}
    getCurrentCharacter() { return 0; }
    useAbility() {}
    getAbilityState() { return 0; }
    getAbilityCooldownPercent() { return 0; }
    delete() {}
  }
  export default async function createWasmModule() { return { Game, HEAPF32 }; }
`;

export const routeWasmStub = (page: Page, scene: StubScene) =>
  page.route('**/src/wasm/main.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: wasmStubSource(scene) }));
