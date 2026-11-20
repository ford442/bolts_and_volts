import { describe, expect, it } from 'vitest';
import { AnimState, FRAME, createFrameState, readFrame, viewFrame } from '../../src/game/snapshot';

/** Build a snapshot the way Game::captureFrame lays it out. */
const pack = (opts: {
  platforms?: number[][];
  goals?: number[][];
  hazards?: number[][];
  payloads?: number[][];
  terminals?: number[][];
  particles?: number[][];
  header?: Partial<Record<keyof typeof FRAME, number>>;
}): Float32Array => {
  const platforms = opts.platforms ?? [];
  const goals = opts.goals ?? [];
  const particles = opts.particles ?? [];
  const hazards = opts.hazards ?? [];
  const payloads = opts.payloads ?? [];
  const terminals = opts.terminals ?? [];
  const header = new Array(FRAME.HEADER_SIZE).fill(0);
  for (const [key, value] of Object.entries(opts.header ?? {})) header[FRAME[key as keyof typeof FRAME]] = value;
  header[FRAME.PLATFORM_COUNT] = platforms.length;
  header[FRAME.GOAL_COUNT] = goals.length;
  header[FRAME.PARTICLE_COUNT] = particles.length;
  header[FRAME.HAZARD_COUNT] = hazards.length;
  header[FRAME.PAYLOAD_COUNT] = payloads.length;
  header[FRAME.TERMINAL_COUNT] = terminals.length;
  return new Float32Array([
    ...header, ...platforms.flat(), ...goals.flat(),
    ...hazards.flat(), ...payloads.flat(), ...terminals.flat(), ...particles.flat(),
  ]);
};

describe('readFrame', () => {
  it('decodes header, boxes and particles', () => {
    const data = pack({
      header: { PLAYER_X: 1.5, PLAYER_Y: -2, PLAYER_W: 0.5, PLAYER_H: 0.75, CAMERA_X: 3, CAMERA_Y: 4, ANIM_STATE: AnimState.Fall, ANIM_FRAME: 7, FACING_LEFT: 1, CHARACTER: 1, ABILITY_STATE: 2, ABILITY_COOLDOWN: 0.25 },
      platforms: [[0, -2, 10, 0.25], [5, 1, 2, 0.5]],
      goals: [[16, 2, 1, 1]],
      hazards: [[8, -1, 0.75, 0.5, 1], [19, 0, 0.5, 3.5, 0]],
      payloads: [[2, -0.25, 0.5, 0.5, 1]],
      terminals: [[12, 1, 0.5, 0.75, 0]],
      particles: [[1, 2, 0.125, 0.5]],
    });
    const frame = readFrame(data, createFrameState());
    expect(frame.player).toEqual({ position: { x: 1.5, y: -2 }, size: { x: 0.5, y: 0.75 } });
    expect(frame.camera).toEqual({ x: 3, y: 4 });
    expect(frame.anim).toEqual({ state: AnimState.Fall, frame: 7, facingLeft: true });
    expect(frame.character).toBe(1);
    expect(frame.abilityState).toBe(2);
    expect(frame.abilityCooldown).toBe(0.25);
    expect(frame.platforms).toEqual([
      { position: { x: 0, y: -2 }, size: { x: 10, y: 0.25 } },
      { position: { x: 5, y: 1 }, size: { x: 2, y: 0.5 } },
    ]);
    expect(frame.goals).toEqual([{ position: { x: 16, y: 2 }, size: { x: 1, y: 1 } }]);
    expect(frame.hazards).toEqual([
      { position: { x: 8, y: -1 }, size: { x: 0.75, y: 0.5 }, flag: true },
      { position: { x: 19, y: 0 }, size: { x: 0.5, y: 3.5 }, flag: false },
    ]);
    expect(frame.payloads).toEqual([{ position: { x: 2, y: -0.25 }, size: { x: 0.5, y: 0.5 }, flag: true }]);
    expect(frame.terminals).toEqual([{ position: { x: 12, y: 1 }, size: { x: 0.5, y: 0.75 }, flag: false }]);
    expect(frame.particles).toEqual([{ position: { x: 1, y: 2 }, size: 0.125, lifeRatio: 0.5 }]);
  });

  it('reuses objects across frames and shrinks lists', () => {
    const out = createFrameState();
    readFrame(pack({ particles: [[0, 0, 1, 1], [1, 1, 1, 1], [2, 2, 1, 1]] }), out);
    const first = out.particles[0];
    readFrame(pack({ particles: [[9, 9, 1, 1]] }), out);
    expect(out.particles).toHaveLength(1);
    expect(out.particles[0]).toBe(first);
    expect(out.particles[0].position).toEqual({ x: 9, y: 9 });
  });

  it('empties the entity lists when a level without them loads', () => {
    const out = createFrameState();
    readFrame(pack({ hazards: [[0, 0, 1, 1, 1]], payloads: [[0, 0, 1, 1, 0]], terminals: [[0, 0, 1, 1, 0]] }), out);
    readFrame(pack({ platforms: [[0, -2, 10, 0.25]] }), out);
    expect(out.hazards).toEqual([]);
    expect(out.payloads).toEqual([]);
    expect(out.terminals).toEqual([]);
    expect(out.platforms).toHaveLength(1);
  });

  it('rejects a buffer shorter than its header claims', () => {
    const data = pack({ platforms: [[0, 0, 1, 1]] });
    expect(() => readFrame(data.subarray(0, data.length - 1), createFrameState())).toThrow(/truncated/);
    const withTerminal = pack({ terminals: [[0, 0, 1, 1, 0]] });
    expect(() => readFrame(withTerminal.subarray(0, withTerminal.length - 1), createFrameState())).toThrow(/truncated/);
    expect(() => readFrame(new Float32Array(3), createFrameState())).toThrow(/too short/);
  });
});

describe('viewFrame', () => {
  it('views the snapshot at its byte offset in the heap', () => {
    const heap = new Float32Array(64);
    const snapshot = pack({ header: { PLAYER_X: 42 } });
    heap.set(snapshot, 8);
    const view = viewFrame(heap, 8 * 4, snapshot.length);
    expect(view.buffer).toBe(heap.buffer);
    expect(readFrame(view, createFrameState()).player.position.x).toBe(42);
  });
});
