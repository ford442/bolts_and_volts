import type { Page } from '@playwright/test';
import { FRAME } from '../../src/game/snapshot';
import { DEFAULT_PLATFORMS } from '../../src/lib/levelData';

type V = { x: number; y: number };
type Box = { position: V; size: V };

export type StubScene = {
  levelName: string;
  levelDescription?: string;
  player?: V;
  camera?: V;
  platforms?: Box[];
  goals?: Box[];
  /** Starting character (0 = Bolts, 1 = Volts); `switchCharacter()` toggles it. */
  character?: number;
  /** `AbilityState` (0 ready, 1 active, 2 cooldown) and the cooldown fraction reported in the snapshot. */
  abilityState?: number;
  abilityCooldown?: number;
  /** Drain `abilityCooldown` by 0.01 on every captureFrame (wrapping at 0), so the HUD bar changes every frame. */
  drainingAbility?: boolean;
};

/**
 * Source for a fake `src/wasm/main.js`: a static scene served through the same snapshot protocol as the real
 * module (`captureFrame` packs into `HEAPF32`, `framePtr` gives its byte address). Layout from FRAME. Like the
 * real snapshot it carries no platforms or goals: those reach the renderer from the level JSON (`stubLevel`).
 */
export const wasmStubSource = (scene: StubScene): string => `
  const F = ${JSON.stringify(FRAME)};
  const scene = ${JSON.stringify({ player: { x: -3, y: 1 }, camera: { x: 0, y: 0 }, levelDescription: '', character: 0, abilityState: 0, abilityCooldown: 0, ...scene })};
  const HEAPF32 = new Float32Array(4096);
  const PTR_FLOATS = 16; // non-zero offset, like a real heap allocation
  class Game {
    update() {}
    handleInput() {}
    captureFrame() {
      if (scene.drainingAbility) scene.abilityCooldown = scene.abilityCooldown > 0.011 ? scene.abilityCooldown - 0.01 : 1;
      const out = HEAPF32.subarray(PTR_FLOATS);
      out.fill(0, 0, F.HEADER_SIZE);
      out[F.PLAYER_X] = scene.player.x; out[F.PLAYER_Y] = scene.player.y;
      out[F.PLAYER_W] = 1; out[F.PLAYER_H] = 1;
      out[F.CAMERA_X] = scene.camera.x; out[F.CAMERA_Y] = scene.camera.y;
      out[F.CHARACTER] = scene.character;
      out[F.ABILITY_STATE] = scene.abilityState; out[F.ABILITY_COOLDOWN] = scene.abilityCooldown;
      out[F.PARTICLE_COUNT] = 0;
      return F.HEADER_SIZE;
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
    switchCharacter() { scene.character = scene.character === 0 ? 1 : 0; }
    getCurrentCharacter() { return scene.character; }
    useAbility() {}
    getAbilityState() { return scene.abilityState; }
    getAbilityCooldownPercent() { return scene.abilityCooldown; }
    delete() {}
  }
  export default async function createWasmModule() { return { Game, HEAPF32 }; }
`;

/**
 * The level file every level id loads under the stub. Static geometry is uploaded with `loadLevel`, so this is
 * where the scene's platforms and goals come from. A scene without platforms gets the default list (an empty one
 * is a validator error).
 */
export const stubLevel = (scene: StubScene) => ({
  name: scene.levelName,
  platforms: scene.platforms ?? DEFAULT_PLATFORMS,
  goals: scene.goals ?? [],
});

export const routeWasmStub = async (page: Page, scene: StubScene) => {
  await page.route('**/src/wasm/main.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: wasmStubSource(scene) }));
  await page.route(
    (url) => url.pathname.startsWith('/levels/') && url.pathname.endsWith('.json') && url.pathname !== '/levels/manifest.json',
    (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(stubLevel(scene)) }),
  );
};
