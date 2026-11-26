import type { BackgroundLayer, DecorLayers, Renderer, SceneEntities, TextureObject } from '../gl/renderer';
import type { AuthoringOverlay } from '../lib/authoring';
import type { Game, GameModule, Platform } from '../wasm/loader';
import type { KeyboardInput } from './input';
import { characterPresentation } from './characters';
import { createFrameState, readFrame, viewFrame, type FrameState } from './snapshot';

/** Simulation tick. `Game::update` always advances by exactly this much, so physics never depends on frame pacing. */
export const FIXED_STEP = 1 / 60;
/** Most ticks run for one rendered frame. Past this, backlog is dropped so a background tab cannot spiral. */
export const MAX_STEPS_PER_FRAME = 4;

/**
 * Add `elapsedSeconds` of real time to the accumulator and return how many fixed ticks to run now plus the
 * leftover (in [0, FIXED_STEP) unless the cap was hit, in which case the backlog is discarded).
 */
export const advanceAccumulator = (accumulator: number, elapsedSeconds: number): { steps: number; accumulator: number } => {
  let acc = accumulator + Math.max(0, elapsedSeconds);
  // Tolerate float error so an exact multiple of FIXED_STEP is not split into n-1 steps plus a near-full remainder.
  const eps = 1e-9;
  let steps = Math.floor((acc + eps) / FIXED_STEP);
  if (steps >= MAX_STEPS_PER_FRAME) {
    steps = MAX_STEPS_PER_FRAME;
    acc = 0;
  } else {
    acc = Math.max(0, acc - steps * FIXED_STEP);
  }
  return { steps, accumulator: acc };
};

/** Level-dependent draw inputs. Mutated in place by level loading; read once per frame. */
export type SceneAssets = {
  playerTexture: TextureObject;
  platformTexture: TextureObject;
  backgroundLayers: BackgroundLayer[];
  decorLayers: DecorLayers;
  /**
   * The level's static geometry, exactly as passed to `Game::loadLevel` (the snapshot does not carry it). Replace
   * these together with every `loadLevel`, or they stop matching what the simulation collides with.
   */
  platforms: Platform[];
  /** Index-aligned with `platforms`. */
  platformVisualFlags: boolean[];
  goals: Platform[];
};

export type GameLoopOptions = {
  module: GameModule;
  game: Game;
  renderer: Renderer;
  input: KeyboardInput;
  assets: SceneAssets;
  /** Runs first every frame (e.g. apply a pending canvas resize, which must happen right before drawing). */
  beforeFrame?: () => void;
  /** Authoring overlay for this frame, from the freshly read snapshot. */
  overlay?: (frame: FrameState) => AuthoringOverlay | null;
  cullDebug?: () => boolean;
  /** After drawing: HUD text etc. Must not call React `setState` — it runs at display refresh rate. */
  afterDraw?: (frame: FrameState) => void;
};

/**
 * Owns `requestAnimationFrame`: fixed-step simulation, one snapshot read, one `drawScene` per frame.
 * Returns a stop function.
 */
export const startGameLoop = (options: GameLoopOptions): (() => void) => {
  const { module, game, renderer, input, assets } = options;
  const frame = createFrameState();
  // readFrame refills these arrays in place, so one object covers every frame.
  const entities: SceneEntities = { hazards: frame.hazards, payloads: frame.payloads, terminals: frame.terminals };
  let accumulator = 0;
  let lastTime: number | null = null;
  let rafId = 0;
  let stopped = false;

  const tick = (timestamp: number) => {
    if (stopped) return;
    options.beforeFrame?.();

    const elapsed = lastTime === null ? 0 : (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    const advanced = advanceAccumulator(accumulator, elapsed);
    accumulator = advanced.accumulator;
    for (let i = 0; i < advanced.steps; i++) {
      game.handleInput(input.snapshot());
      game.update(FIXED_STEP);
    }

    const length = game.captureFrame();
    // Re-read HEAPF32 every frame: memory growth replaces it and detaches the old buffer.
    readFrame(viewFrame(module.HEAPF32, game.framePtr(), length), frame);

    const cullDebug = options.cullDebug?.() ?? false;
    renderer.drawScene(
      frame.camera,
      frame.player.position,
      frame.player.size,
      assets.platforms,
      frame.particles,
      assets.playerTexture,
      assets.platformTexture,
      assets.backgroundLayers,
      assets.decorLayers,
      assets.platformVisualFlags,
      frame.anim,
      assets.goals,
      characterPresentation(frame.character).tint,
      options.overlay?.(frame) ?? null,
      cullDebug,
      entities,
    );
    options.afterDraw?.(frame);
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
  };
};
