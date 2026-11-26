import { describe, expect, it } from 'vitest';
import { INSTANCE_FLOATS, SpriteBatch, newSpriteInstance, type SpriteInstance } from '../../src/gl/spriteBatch';
import { visibleRect } from '../../src/lib/culling';

const at = (x: number, y = 0, size = 1): SpriteInstance => ({ ...newSpriteInstance(), x, y, w: size, h: size });
const plain = <T>(batch: SpriteBatch<T>) => batch.ranges.map(({ texture, first, count }) => ({ texture, first, count }));

describe('SpriteBatch', () => {
  it('collapses consecutive sprites with the same texture into one range', () => {
    const batch = new SpriteBatch<string>();
    for (let i = 0; i < 5; i++) batch.push('platform', at(i));
    expect(batch.count).toBe(5);
    expect(plain(batch)).toEqual([{ texture: 'platform', first: 0, count: 5 }]);
  });

  it('starts a new range when the texture changes, and never reorders to merge (paint order wins)', () => {
    const batch = new SpriteBatch<string>();
    batch.push('a', at(0));
    batch.push('a', at(1));
    batch.push('b', at(2));
    batch.push('a', at(3));
    expect(plain(batch)).toEqual([
      { texture: 'a', first: 0, count: 2 },
      { texture: 'b', first: 2, count: 1 },
      { texture: 'a', first: 3, count: 1 },
    ]);
  });

  it('culled sprites never reach the instance data or a range', () => {
    const batch = new SpriteBatch<string>();
    const rect = visibleRect({ x: 0, y: 0 }, { x: 10, y: 6 }, 0); // x in [-5, 5], y in [-3, 3]
    expect(batch.pushIfVisible('a', at(0), rect)).toBe(true);
    expect(batch.pushIfVisible('b', at(50), rect)).toBe(false); // off screen: must not split the 'a' run either
    expect(batch.pushIfVisible('a', at(-5.5), rect)).toBe(true); // half on screen (touching counts)
    expect(batch.pushIfVisible('a', at(0, -40), rect)).toBe(false);
    expect(plain(batch)).toEqual([{ texture: 'a', first: 0, count: 2 }]);
    const data = batch.instanceData();
    expect(data.length).toBe(2 * INSTANCE_FLOATS);
    expect([data[0], data[INSTANCE_FLOATS]]).toEqual([0, -5.5]);
    expect(Array.from(data).some((v) => v === 50 || v === -40)).toBe(false);
  });

  it('packs each instance in shader attribute order (model, frame, sheet/flip/alpha, tint)', () => {
    const batch = new SpriteBatch<string>();
    batch.push('sheet', {
      x: 1, y: 2, w: 3, h: 4,
      frameX: 64, frameY: 128, frameW: 64, frameH: 64,
      sheetW: 256, sheetH: 192, flip: true, alpha: 0.5,
      tintR: 1, tintG: 0.75, tintB: 0.5, tintDesaturate: 0.25,
    });
    expect(Array.from(batch.instanceData())).toEqual([1, 2, 3, 4, 64, 128, 64, 64, 256, 192, 1, 0.5, 1, 0.75, 0.5, 0.25]);
  });

  it('grows past its initial capacity and resets without losing it', () => {
    const batch = new SpriteBatch<number>(2);
    for (let i = 0; i < 1000; i++) batch.push(i % 3 === 0 ? 1 : 2, at(i));
    expect(batch.count).toBe(1000);
    expect(batch.instanceData()[999 * INSTANCE_FLOATS]).toBe(999);
    expect(batch.ranges.reduce((n, r) => n + r.count, 0)).toBe(1000);
    batch.reset();
    expect(batch.count).toBe(0);
    expect(batch.ranges).toEqual([]);
    batch.push(7, at(42));
    expect(plain(batch)).toEqual([{ texture: 7, first: 0, count: 1 }]);
    expect(batch.instanceData()[0]).toBe(42);
  });
});
