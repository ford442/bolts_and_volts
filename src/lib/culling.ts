import type { Vec2 } from '../wasm/loader';

/**
 * Render-only visible-rect culling helpers. Physics/collision never use these: they only decide
 * whether a draw call is worth issuing.
 */

/** Axis-aligned rectangle in world units. */
export type Rect = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Extra world units kept around the camera view so sprites never pop in at the screen edge.
 * Comfortably covers the per-frame foot-anchor nudge (a few % of a sprite's height) and one frame
 * of camera movement. Larger than any sane scroll speed * frame time.
 */
export const CULL_MARGIN = 1.0;

/** How far (world units) the debug view shrinks the cull rect so culling is visible on screen. */
export const CULL_DEBUG_INSET = 2.0;

/** Camera view rectangle (camera at the centre), grown by `margin` on every side. */
export function visibleRect(camera: Vec2, view: Vec2, margin: number = CULL_MARGIN): Rect {
  const hx = view.x / 2 + margin;
  const hy = view.y / 2 + margin;
  return { minX: camera.x - hx, minY: camera.y - hy, maxX: camera.x + hx, maxY: camera.y + hy };
}

/** True when a centre-anchored box overlaps the rect (touching edges count as visible). */
export function boxOverlapsRect(center: Vec2, size: Vec2, rect: Rect): boolean {
  const hx = size.x / 2;
  const hy = size.y / 2;
  return center.x + hx >= rect.minX && center.x - hx <= rect.maxX && center.y + hy >= rect.minY && center.y - hy <= rect.maxY;
}

/**
 * Cull rect for items drawn with a parallax-scaled camera (decor). The shader subtracts the
 * effective camera, so an item is on screen when it overlaps the view centred on that camera.
 */
export function parallaxRect(camera: Vec2, parallaxX: number, parallaxY: number, view: Vec2, margin: number = CULL_MARGIN): Rect {
  return visibleRect({ x: camera.x * parallaxX, y: camera.y * parallaxY }, view, margin);
}

/** Shrink (positive `amount`) a rect on every side; clamps so it never inverts. */
export function insetRect(rect: Rect, amount: number): Rect {
  const cx = (rect.minX + rect.maxX) / 2;
  const cy = (rect.minY + rect.maxY) / 2;
  const hx = Math.max(0, (rect.maxX - rect.minX) / 2 - amount);
  const hy = Math.max(0, (rect.maxY - rect.minY) / 2 - amount);
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}

/** Per-frame draw counters, `drawn` / `total`, for the debug HUD. */
export type CullStats = {
  platforms: { drawn: number; total: number };
  decor: { drawn: number; total: number };
  goals: { drawn: number; total: number };
  /** Hazards, payload and terminals together. */
  entities: { drawn: number; total: number };
  particles: { drawn: number; total: number };
};

export function emptyCullStats(): CullStats {
  return {
    platforms: { drawn: 0, total: 0 },
    decor: { drawn: 0, total: 0 },
    goals: { drawn: 0, total: 0 },
    entities: { drawn: 0, total: 0 },
    particles: { drawn: 0, total: 0 },
  };
}

export function formatCullStats(stats: CullStats): string {
  const f = (label: string, c: { drawn: number; total: number }) => `${label} ${c.drawn}/${c.total}`;
  return `CULL  ${f('platforms', stats.platforms)}  ${f('decor', stats.decor)}  ${f('goals', stats.goals)}  ${f('entities', stats.entities)}  ${f('particles', stats.particles)}`;
}
