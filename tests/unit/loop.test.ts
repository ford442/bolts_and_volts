import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXED_STEP, MAX_STEPS_PER_FRAME, advanceAccumulator, startGameLoop, type GameLoopOptions, type LoopRenderer } from '../../src/game/loop';
import { FRAME } from '../../src/game/snapshot';
import type { ContextStatus, TextureObject } from '../../src/gl/renderer';

/** Feed frame durations (ms) through the accumulator; return the step count of each frame. */
const run = (framesMs: number[], onStep: () => void = () => {}): number[] => {
  let acc = 0;
  return framesMs.map((ms) => {
    const r = advanceAccumulator(acc, ms / 1000);
    acc = r.accumulator;
    for (let i = 0; i < r.steps; i++) onStep();
    return r.steps;
  });
};

describe('advanceAccumulator', () => {
  it('runs one tick per 60 Hz frame', () => {
    expect(run(new Array(10).fill(1000 / 60))).toEqual(new Array(10).fill(1));
  });

  it('runs a tick every other frame at 120 Hz', () => {
    expect(run(new Array(6).fill(1000 / 120))).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('catches up after a short hitch instead of dropping time', () => {
    expect(run([1000 / 60, 50, 1000 / 60])).toEqual([1, 3, 1]);
  });

  it(`caps at ${MAX_STEPS_PER_FRAME} ticks and drops the backlog after a long stall`, () => {
    const r = advanceAccumulator(0, 5);
    expect(r).toEqual({ steps: MAX_STEPS_PER_FRAME, accumulator: 0 });
  });

  it('ignores negative elapsed time', () => {
    expect(advanceAccumulator(0.01, -1)).toEqual({ steps: 0, accumulator: 0.01 });
  });

  it('keeps the leftover below one tick', () => {
    const r = advanceAccumulator(0, FIXED_STEP * 2.5);
    expect(r.steps).toBe(2);
    expect(r.accumulator).toBeCloseTo(FIXED_STEP * 0.5, 12);
  });
});

describe('jump height under fixed step', () => {
  // A jump integrated like Game::update (semi-implicit Euler with apex hang time). Its apex depends on dt,
  // so it only matches across frame pacings if every tick uses the same dt.
  const simulateApex = (framesMs: number[]): number => {
    let y = 0;
    let vy = 6.2;
    let apex = 0;
    run(framesMs, () => {
      const gravityMult = Math.abs(vy) < 1.8 ? 0.45 : 1.0;
      vy += -9.8 * 2.5 * gravityMult * FIXED_STEP;
      y += vy * FIXED_STEP;
      apex = Math.max(apex, y);
    });
    return apex;
  };

  it('a tab hitch mid-jump does not change the apex', () => {
    const steady = new Array(90).fill(1000 / 60);
    const hitched = [...new Array(10).fill(1000 / 60), 1000 / 60 * 3, ...new Array(77).fill(1000 / 60)];
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(hitched)).toBeCloseTo(sum(steady), 6);
    expect(simulateApex(hitched)).toBe(simulateApex(steady));
  });

  it('display rate does not change the apex', () => {
    expect(simulateApex(new Array(180).fill(1000 / 120))).toBe(simulateApex(new Array(90).fill(1000 / 60)));
  });
});

describe('startGameLoop and WebGL context loss', () => {
  // A hand-driven requestAnimationFrame: `frame(ms)` runs whatever callback is pending at that timestamp.
  let pending: FrameRequestCallback | null = null;
  const installRaf = () => {
    pending = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { pending = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { pending = null; });
  };
  const frame = (ms: number) => {
    const cb = pending;
    pending = null;
    cb?.(ms);
  };
  afterEach(() => vi.unstubAllGlobals());

  const setup = () => {
    installRaf();
    let lost = false;
    const listeners = new Set<(status: ContextStatus) => void>();
    const emit = (status: ContextStatus) => { lost = status === 'lost'; for (const l of listeners) l(status); };
    const renderer = {
      draws: 0,
      drawScene() { this.draws++; },
      isContextLost: () => lost,
      onContextChange: (l: (status: ContextStatus) => void) => { listeners.add(l); return () => listeners.delete(l); },
    };
    const heap = new Float32Array(FRAME.HEADER_SIZE);
    const game = { updates: 0, handleInput() {}, update() { this.updates++; }, captureFrame: () => FRAME.HEADER_SIZE, framePtr: () => 0 };
    const texture = {} as TextureObject;
    const options = {
      module: { HEAPF32: heap },
      game,
      renderer: renderer as unknown as LoopRenderer,
      input: { snapshot: () => ({}) },
      assets: { playerTexture: texture, platformTexture: texture, backgroundLayers: [], decorLayers: { distant: [], mid: [], foreground: [] }, platforms: [], platformVisualFlags: [], goals: [] },
    } as unknown as GameLoopOptions;
    const stop = startGameLoop(options);
    return { renderer, game, emit, stop, listeners };
  };

  it('stops drawing and ticking while the context is lost, and resumes on restore without replaying the gap', () => {
    const { renderer, game, emit, stop, listeners } = setup();
    frame(0);
    frame(1000 / 60);
    expect(renderer.draws).toBe(2);
    expect(game.updates).toBe(1);

    emit('lost');
    expect(pending).toBeNull(); // no frame is scheduled while lost
    frame(10_000);
    expect(renderer.draws).toBe(2);

    emit('restored');
    expect(pending).not.toBeNull();
    frame(60_000); // first frame after restore: fresh clock, so the minute spent lost runs no ticks
    expect(renderer.draws).toBe(3);
    expect(game.updates).toBe(1);
    frame(60_000 + 1000 / 60);
    expect(game.updates).toBe(2);

    stop();
    expect(pending).toBeNull();
    expect(listeners.size).toBe(0);
    emit('restored'); // a restore after stop must not restart the loop
    expect(pending).toBeNull();
  });

  it('a frame already scheduled when the context is lost does not draw', () => {
    const { renderer, emit, stop } = setup();
    frame(0);
    const scheduled = pending;
    emit('lost');
    scheduled?.(16); // e.g. the browser had already queued it
    expect(renderer.draws).toBe(1);
    stop();
  });
});
