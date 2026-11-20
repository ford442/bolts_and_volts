import { describe, expect, it } from 'vitest';
import { FIXED_STEP, MAX_STEPS_PER_FRAME, advanceAccumulator } from '../../src/game/loop';

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
