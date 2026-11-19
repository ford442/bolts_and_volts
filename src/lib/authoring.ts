import type { Vec2 } from '../wasm/loader';

/** World units visible horizontally. Mirrors `Renderer.setSpriteProjection`. */
export const VIEW_WORLD_WIDTH = 10.0;

/** Grid spacings (world units) that the grid-step hotkey cycles through. */
export const GRID_STEPS = [1.0, 0.5, 0.25] as const;

/** Default size of the platform snippet copied to the clipboard (matches common level platforms). */
export const SNIPPET_PLATFORM_SIZE: Vec2 = { x: 2.0, y: 0.25 };

export type AuthoringState = {
  /** World-space grid overlay (G). Independent of authoring mode. */
  grid: boolean;
  /** Authoring mode (H): HUD, strong platform outlines, dimmed player/particles, snap marker. */
  hud: boolean;
  /** Index into GRID_STEPS. */
  gridStepIndex: number;
};

export const INITIAL_AUTHORING_STATE: AuthoringState = { grid: false, hud: false, gridStepIndex: 0 };

export type AuthoringOverlay = {
  grid: boolean;
  gridStep: number;
  /** Authoring mode: outline platforms, dim player + particles. */
  strongOutlines: boolean;
  /** World position of the snapped cursor to mark, or null when the mouse is off the canvas. */
  snapMarker: Vec2 | null;
};

export function viewSize(canvasWidth: number, canvasHeight: number): Vec2 {
  return { x: VIEW_WORLD_WIDTH, y: VIEW_WORLD_WIDTH / (canvasWidth / canvasHeight) };
}

/**
 * Convert a normalized canvas position (u, v in [0,1], origin top-left) to world coordinates.
 * The camera sits at the centre of the view; +Y is up in world space, down on screen.
 */
export function screenToWorld(u: number, v: number, camera: Vec2, view: Vec2): Vec2 {
  return { x: camera.x + (u - 0.5) * view.x, y: camera.y + (0.5 - v) * view.y };
}

export function snapToGrid(p: Vec2, step: number): Vec2 {
  // `+ 0` normalizes -0 so it never shows up as "-0.00" in the HUD / snippets.
  return { x: Math.round(p.x / step) * step + 0, y: Math.round(p.y / step) * step + 0 };
}

export function cycleGridStep(index: number): number {
  return (index + 1) % GRID_STEPS.length;
}

/** Multiples of `step` within [min, max], as integer indices so floating error cannot accumulate. */
export function gridLineIndices(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/** Number formatting for JSON snippets: at most 3 decimals, no trailing zeros, always a decimal point. */
function formatNumber(n: number): string {
  const rounded = Math.round(n * 1000) / 1000 + 0;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

/** A platform entry ready to paste into a level's `platforms` array. */
export function platformSnippet(center: Vec2, size: Vec2 = SNIPPET_PLATFORM_SIZE): string {
  return `{ "position": { "x": ${formatNumber(center.x)}, "y": ${formatNumber(center.y)} }, "size": { "x": ${formatNumber(size.x)}, "y": ${formatNumber(size.y)} } }`;
}
