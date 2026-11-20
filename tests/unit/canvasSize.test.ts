import { describe, expect, it } from 'vitest';
import { MAX_PIXEL_RATIO, backingStoreSize } from '../../src/lib/canvasSize';

describe('backingStoreSize', () => {
  it('is one backing pixel per CSS pixel at 1x', () => {
    expect(backingStoreSize(1280, 720, 1)).toEqual({ width: 1280, height: 720, pixelRatio: 1 });
  });

  it('scales by devicePixelRatio and keeps the CSS aspect ratio', () => {
    const size = backingStoreSize(1000, 562.5, 2)!;
    expect(size).toEqual({ width: 2000, height: 1125, pixelRatio: 2 });
    expect(size.width / size.height).toBeCloseTo(1000 / 562.5, 10);
  });

  it('caps the ratio at MAX_PIXEL_RATIO', () => {
    expect(MAX_PIXEL_RATIO).toBe(2);
    expect(backingStoreSize(800, 450, 3)).toEqual({ width: 1600, height: 900, pixelRatio: 2 });
  });

  it('rounds fractional device sizes and never returns less than 1px', () => {
    expect(backingStoreSize(333.3, 187.4, 1.5)).toEqual({ width: 500, height: 281, pixelRatio: 1.5 });
    expect(backingStoreSize(0.2, 0.2, 1)).toEqual({ width: 1, height: 1, pixelRatio: 1 });
  });

  it('treats a missing or invalid devicePixelRatio as 1', () => {
    expect(backingStoreSize(640, 360, 0)).toEqual({ width: 640, height: 360, pixelRatio: 1 });
    expect(backingStoreSize(640, 360, Number.NaN)).toEqual({ width: 640, height: 360, pixelRatio: 1 });
  });

  it('returns null for a hidden or zero-sized box so the previous size is kept', () => {
    expect(backingStoreSize(0, 720, 1)).toBeNull();
    expect(backingStoreSize(1280, 0, 1)).toBeNull();
    expect(backingStoreSize(-5, 100, 1)).toBeNull();
    expect(backingStoreSize(Number.NaN, 100, 1)).toBeNull();
  });
});
