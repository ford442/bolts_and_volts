import { describe, expect, it } from 'vitest';
import {
  GRID_STEPS,
  cycleGridStep,
  gridLineIndices,
  platformSnippet,
  screenToWorld,
  snapToGrid,
  viewSize,
} from '../../src/lib/authoring';

describe('authoring helpers', () => {
  it('derives the view size from the canvas aspect ratio', () => {
    expect(viewSize(1280, 720)).toEqual({ x: 10, y: 10 / (1280 / 720) });
  });

  it('maps the canvas centre to the camera and the corners to the view edges', () => {
    const view = { x: 10, y: 5 };
    const camera = { x: 20, y: 3 };
    expect(screenToWorld(0.5, 0.5, camera, view)).toEqual(camera);
    expect(screenToWorld(0, 0, camera, view)).toEqual({ x: 15, y: 5.5 }); // top-left: left + up
    expect(screenToWorld(1, 1, camera, view)).toEqual({ x: 25, y: 0.5 }); // bottom-right
  });

  it('snaps to the nearest grid point without producing -0', () => {
    expect(snapToGrid({ x: 1.26, y: -2.74 }, 0.5)).toEqual({ x: 1.5, y: -2.5 });
    expect(Object.is(snapToGrid({ x: -0.1, y: 0.1 }, 1).x, -0)).toBe(false);
  });

  it('cycles through every grid step and wraps', () => {
    let index = 0;
    const seen: number[] = [GRID_STEPS[index]];
    for (let i = 0; i < GRID_STEPS.length; i++) {
      index = cycleGridStep(index);
      seen.push(GRID_STEPS[index]);
    }
    expect(seen).toEqual([...GRID_STEPS, GRID_STEPS[0]]);
  });

  it('lists grid line indices inside a range, including negatives', () => {
    expect(gridLineIndices(-1.2, 1.2, 0.5)).toEqual([-2, -1, 0, 1, 2]);
    expect(gridLineIndices(0.1, 0.9, 1)).toEqual([]);
  });

  it('formats a pasteable platform snippet', () => {
    expect(platformSnippet({ x: 1.5, y: -2 }, { x: 2, y: 0.25 }))
      .toBe('{ "position": { "x": 1.5, "y": -2.0 }, "size": { "x": 2.0, "y": 0.25 } }');
    expect(platformSnippet({ x: 0.1 + 0.2, y: 0 })).toContain('"x": 0.3,');
    expect(JSON.parse(platformSnippet({ x: -0.75, y: 4 }))).toEqual({ position: { x: -0.75, y: 4 }, size: { x: 2, y: 0.25 } });
  });
});
