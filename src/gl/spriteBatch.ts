import type { Rect } from '../lib/culling';

/**
 * Sprite batching with no GL in it: sprites go in, in paint order, and come out as one packed instance array plus
 * ranges of consecutive sprites that share a texture. The renderer draws each range with one instanced call.
 *
 * Ranges never reorder sprites. Blending makes paint order visible, so texture A, B, A gives three ranges, not two.
 */

/** One quad as the sprite shader sees it. Write into a reused object and `push` it; the batch copies the numbers. */
export type SpriteInstance = {
  /** Centre and full size of the drawn quad, world units (anchor/parallax adjustments already applied). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Top-left corner and size of the frame inside the sheet, pixels. */
  frameX: number;
  frameY: number;
  frameW: number;
  frameH: number;
  /** Full texture size, pixels. */
  sheetW: number;
  sheetH: number;
  flip: boolean;
  alpha: number;
  /** RGB multiplier and 0..1 desaturate amount, as `Tint` in renderer.ts. */
  tintR: number;
  tintG: number;
  tintB: number;
  tintDesaturate: number;
};

export const newSpriteInstance = (): SpriteInstance => ({
  x: 0, y: 0, w: 1, h: 1,
  frameX: 0, frameY: 0, frameW: 1, frameH: 1,
  sheetW: 1, sheetH: 1,
  flip: false, alpha: 1,
  tintR: 1, tintG: 1, tintB: 1, tintDesaturate: 0,
});

/** Floats per instance, in shader attribute order: model (4), frame (4), sheet+flip+alpha (4), tint (4). */
export const INSTANCE_FLOATS = 16;
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

/** A run of `count` consecutive instances, starting at instance `first`, all drawn with `texture`. */
export type InstanceRange<T> = { texture: T; first: number; count: number };

/** `boxOverlapsRect` for a sprite's drawn box (same inequalities), without building two `Vec2`s per sprite. */
export const spriteOverlapsRect = (s: SpriteInstance, rect: Rect): boolean => {
  const hx = s.w / 2;
  const hy = s.h / 2;
  return s.x + hx >= rect.minX && s.x - hx <= rect.maxX && s.y + hy >= rect.minY && s.y - hy <= rect.maxY;
};

export class SpriteBatch<T> {
  private data: Float32Array;
  private size = 0;
  private rangeList: InstanceRange<T>[] = [];
  // Range objects are reused across frames so a steady scene allocates nothing.
  private rangePool: InstanceRange<T>[] = [];

  constructor(initialCapacity = 256) {
    this.data = new Float32Array(Math.max(1, initialCapacity) * INSTANCE_FLOATS);
  }

  /** Forget everything pushed so far (capacity is kept). */
  reset(): void {
    this.size = 0;
    this.rangeList.length = 0;
  }

  /** Number of instances pushed since the last reset. */
  get count(): number {
    return this.size;
  }

  /** The texture runs, in paint order. Valid until the next `reset`/`push`. */
  get ranges(): readonly InstanceRange<T>[] {
    return this.rangeList;
  }

  /** The packed instances (`count * INSTANCE_FLOATS` floats). A view of internal storage: upload it, don't keep it. */
  instanceData(): Float32Array {
    return this.data.subarray(0, this.size * INSTANCE_FLOATS);
  }

  /** Append one sprite; starts a new range when its texture differs from the previous sprite's. */
  push(texture: T, s: SpriteInstance): void {
    if ((this.size + 1) * INSTANCE_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data;
    let o = this.size * INSTANCE_FLOATS;
    d[o++] = s.x; d[o++] = s.y; d[o++] = s.w; d[o++] = s.h;
    d[o++] = s.frameX; d[o++] = s.frameY; d[o++] = s.frameW; d[o++] = s.frameH;
    d[o++] = s.sheetW; d[o++] = s.sheetH; d[o++] = s.flip ? 1 : 0; d[o++] = s.alpha;
    d[o++] = s.tintR; d[o++] = s.tintG; d[o++] = s.tintB; d[o] = s.tintDesaturate;

    const last = this.rangeList[this.rangeList.length - 1];
    if (last && last.texture === texture) {
      last.count++;
    } else {
      const range = this.rangePool[this.rangeList.length] ?? (this.rangePool[this.rangeList.length] = { texture, first: 0, count: 0 });
      range.texture = texture;
      range.first = this.size;
      range.count = 1;
      this.rangeList.push(range);
    }
    this.size++;
  }

  /**
   * `push` only when the sprite's drawn box overlaps `rect` (the visible-rect cull from `lib/culling`). Returns whether
   * it was pushed, so callers can keep drawn/total counters. A culled sprite leaves no trace: no instance, no range.
   */
  pushIfVisible(texture: T, s: SpriteInstance, rect: Rect): boolean {
    if (!spriteOverlapsRect(s, rect)) return false;
    this.push(texture, s);
    return true;
  }
}
