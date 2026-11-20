import type { Vec2 } from '../wasm/loader';

/**
 * Float layout of the per-frame snapshot written by `Game::captureFrame()`.
 * Mirrors `FrameLayout` in cpp/src/Types.hpp — change both together.
 */
export const FRAME = {
  PLAYER_X: 0,
  PLAYER_Y: 1,
  PLAYER_W: 2,
  PLAYER_H: 3,
  CAMERA_X: 4,
  CAMERA_Y: 5,
  ANIM_STATE: 6,
  ANIM_FRAME: 7,
  FACING_LEFT: 8,
  CHARACTER: 9,
  ABILITY_STATE: 10,
  ABILITY_COOLDOWN: 11,
  PLATFORM_COUNT: 12,
  GOAL_COUNT: 13,
  PARTICLE_COUNT: 14,
  HEADER_SIZE: 16,
  BOX_STRIDE: 4,
  PARTICLE_STRIDE: 4,
} as const;

/** `PlayerState` in cpp/src/Types.hpp. */
export const AnimState = { Idle: 0, Run: 1, Jump: 2, Fall: 3 } as const;
export type AnimState = (typeof AnimState)[keyof typeof AnimState];

/** `AbilityState` in cpp/src/Types.hpp. */
export const AbilityState = { Ready: 0, Active: 1, Cooldown: 2 } as const;

export interface Box { position: Vec2; size: Vec2; }

export interface ParticleView {
  position: Vec2;
  size: number;
  /** Remaining life as a fraction of its total, 1 → 0. */
  lifeRatio: number;
}

export interface PlayerAnimation {
  state: number;
  frame: number;
  facingLeft: boolean;
}

/**
 * Decoded frame. Built once and refilled in place by `readFrame`, so a steady-state frame allocates
 * nothing. Treat it as valid only until the next `readFrame`.
 */
export interface FrameState {
  player: { position: Vec2; size: Vec2 };
  camera: Vec2;
  anim: PlayerAnimation;
  character: number;
  abilityState: number;
  abilityCooldown: number;
  platforms: Box[];
  goals: Box[];
  particles: ParticleView[];
}

export const createFrameState = (): FrameState => ({
  player: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } },
  camera: { x: 0, y: 0 },
  anim: { state: AnimState.Idle, frame: 0, facingLeft: false },
  character: 0,
  abilityState: AbilityState.Ready,
  abilityCooldown: 0,
  platforms: [],
  goals: [],
  particles: [],
});

const readBoxes = (data: Float32Array, offset: number, count: number, out: Box[]): number => {
  for (let i = 0; i < count; i++) {
    const o = offset + i * FRAME.BOX_STRIDE;
    let box = out[i];
    if (!box) out[i] = box = { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } };
    box.position.x = data[o];
    box.position.y = data[o + 1];
    box.size.x = data[o + 2];
    box.size.y = data[o + 3];
  }
  out.length = count;
  return offset + count * FRAME.BOX_STRIDE;
};

/**
 * Decode a snapshot into `out`. `data` must start at the snapshot header (see `viewFrame`).
 * Throws if the buffer is shorter than its own header claims.
 */
export const readFrame = (data: Float32Array, out: FrameState): FrameState => {
  if (data.length < FRAME.HEADER_SIZE) throw new Error(`frame snapshot too short: ${data.length} floats`);
  const platformCount = data[FRAME.PLATFORM_COUNT];
  const goalCount = data[FRAME.GOAL_COUNT];
  const particleCount = data[FRAME.PARTICLE_COUNT];
  const expected = FRAME.HEADER_SIZE + (platformCount + goalCount) * FRAME.BOX_STRIDE + particleCount * FRAME.PARTICLE_STRIDE;
  if (data.length < expected) throw new Error(`frame snapshot truncated: ${data.length} < ${expected} floats`);

  out.player.position.x = data[FRAME.PLAYER_X];
  out.player.position.y = data[FRAME.PLAYER_Y];
  out.player.size.x = data[FRAME.PLAYER_W];
  out.player.size.y = data[FRAME.PLAYER_H];
  out.camera.x = data[FRAME.CAMERA_X];
  out.camera.y = data[FRAME.CAMERA_Y];
  out.anim.state = data[FRAME.ANIM_STATE];
  out.anim.frame = data[FRAME.ANIM_FRAME];
  out.anim.facingLeft = data[FRAME.FACING_LEFT] !== 0;
  out.character = data[FRAME.CHARACTER];
  out.abilityState = data[FRAME.ABILITY_STATE];
  out.abilityCooldown = data[FRAME.ABILITY_COOLDOWN];

  let offset: number = FRAME.HEADER_SIZE;
  offset = readBoxes(data, offset, platformCount, out.platforms);
  offset = readBoxes(data, offset, goalCount, out.goals);

  const particles = out.particles;
  for (let i = 0; i < particleCount; i++) {
    const o = offset + i * FRAME.PARTICLE_STRIDE;
    let p = particles[i];
    if (!p) particles[i] = p = { position: { x: 0, y: 0 }, size: 0, lifeRatio: 0 };
    p.position.x = data[o];
    p.position.y = data[o + 1];
    p.size = data[o + 2];
    p.lifeRatio = data[o + 3];
  }
  particles.length = particleCount;
  return out;
};

/**
 * View the snapshot in the wasm heap. Call this every frame and do not keep the result: with
 * ALLOW_MEMORY_GROWTH the heap's ArrayBuffer is replaced (and the old one detached) when memory grows,
 * so `heap` must be the module's *current* HEAPF32.
 */
export const viewFrame = (heap: Float32Array, bytePtr: number, length: number): Float32Array =>
  new Float32Array(heap.buffer, bytePtr, length);
