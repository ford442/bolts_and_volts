import { describe, expect, it } from 'vitest';
import {
  CULL_MARGIN,
  boxOverlapsRect,
  formatCullStats,
  emptyCullStats,
  insetRect,
  parallaxRect,
  visibleRect,
} from '../../src/lib/culling';

const VIEW = { x: 10, y: 6 };

describe('culling helpers', () => {
  it('builds the view rect around the camera plus the margin', () => {
    expect(visibleRect({ x: 20, y: 3 }, VIEW, 1)).toEqual({ minX: 14, maxX: 26, minY: -1, maxY: 7 });
    expect(visibleRect({ x: 0, y: 0 }, VIEW)).toEqual({ minX: -5 - CULL_MARGIN, maxX: 5 + CULL_MARGIN, minY: -3 - CULL_MARGIN, maxY: 3 + CULL_MARGIN });
  });

  it('keeps boxes that overlap the rect, including partial and edge-touching overlap', () => {
    const rect = visibleRect({ x: 0, y: 0 }, VIEW, 0); // x -5..5, y -3..3
    expect(boxOverlapsRect({ x: 0, y: 0 }, { x: 1, y: 1 }, rect)).toBe(true);
    expect(boxOverlapsRect({ x: 5.5, y: 0 }, { x: 2, y: 1 }, rect)).toBe(true); // straddles right edge
    expect(boxOverlapsRect({ x: 6, y: 0 }, { x: 2, y: 1 }, rect)).toBe(true); // touches right edge
    expect(boxOverlapsRect({ x: 0, y: 0 }, { x: 200, y: 0.2 }, rect)).toBe(true); // very wide platform spanning the view
  });

  it('culls boxes fully outside on each side', () => {
    const rect = visibleRect({ x: 0, y: 0 }, VIEW, 0);
    expect(boxOverlapsRect({ x: 6.01, y: 0 }, { x: 2, y: 1 }, rect)).toBe(false);
    expect(boxOverlapsRect({ x: -6.01, y: 0 }, { x: 2, y: 1 }, rect)).toBe(false);
    expect(boxOverlapsRect({ x: 0, y: 4.01 }, { x: 2, y: 1 }, rect)).toBe(false);
    expect(boxOverlapsRect({ x: 0, y: -4.01 }, { x: 2, y: 1 }, rect)).toBe(false);
  });

  it('margin keeps a just-off-screen box alive so it does not pop in', () => {
    const camera = { x: 0, y: 0 };
    const offscreen = { x: 5.6, y: 0 };
    expect(boxOverlapsRect(offscreen, { x: 1, y: 1 }, visibleRect(camera, VIEW, 0))).toBe(false);
    expect(boxOverlapsRect(offscreen, { x: 1, y: 1 }, visibleRect(camera, VIEW))).toBe(true);
  });

  it('scales the camera by parallax for decor', () => {
    // Camera at x=40, parallax 0.5 => decor sees the world as if the camera were at x=20.
    const rect = parallaxRect({ x: 40, y: 0 }, 0.5, 1, VIEW, 0);
    expect(rect).toEqual({ minX: 15, maxX: 25, minY: -3, maxY: 3 });
    expect(boxOverlapsRect({ x: 20, y: 0 }, { x: 2, y: 2 }, rect)).toBe(true);
    expect(boxOverlapsRect({ x: 40, y: 0 }, { x: 2, y: 2 }, rect)).toBe(false);
  });

  it('insets a rect and never inverts it', () => {
    const rect = { minX: -5, maxX: 5, minY: -3, maxY: 3 };
    expect(insetRect(rect, 1)).toEqual({ minX: -4, maxX: 4, minY: -2, maxY: 2 });
    const collapsed = insetRect(rect, 100);
    expect(collapsed.minX).toBe(collapsed.maxX);
    expect(collapsed.minY).toBe(collapsed.maxY);
  });

  it('formats drawn/total counters', () => {
    const stats = emptyCullStats();
    stats.platforms = { drawn: 3, total: 40 };
    expect(formatCullStats(stats)).toContain('platforms 3/40');
    expect(formatCullStats(stats)).toContain('particles 0/0');
  });
});
