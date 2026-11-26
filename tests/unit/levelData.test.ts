import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLATFORMS, normalizeLevelData } from '../../src/lib/levelData';

const base = {
  spawn: { x: 0, y: -1 },
  platforms: [{ position: { x: 0, y: -3 }, size: { x: 10, y: 0.4 } }],
  goals: [{ position: { x: 5, y: -2 }, size: { x: 1, y: 1 } }],
};

describe('normalizeLevelData — courier entities', () => {
  it('passes hazards, payload and terminals through to the core level', () => {
    const { coreLevel } = normalizeLevelData({
      ...base,
      hazards: [
        { position: { x: 8, y: -1 }, size: { x: 0.8, y: 0.6 }, patrol: { x0: 6, x1: 10, speed: 1.5 }, label: 'cat' },
        { position: { x: 3, y: -1 }, size: { x: 0.4, y: 2 } },
      ],
      payload: { position: { x: 2, y: -0.2 }, size: { x: 0.4, y: 0.4 }, label: 'box' },
      terminals: [{ position: { x: 12, y: 1 }, size: { x: 0.6, y: 0.8 }, disablesHazard: 1 }],
    });
    expect(coreLevel.hazards).toEqual([
      { position: { x: 8, y: -1 }, size: { x: 0.8, y: 0.6 }, patrol: { x0: 6, x1: 10, speed: 1.5 } },
      { position: { x: 3, y: -1 }, size: { x: 0.4, y: 2 } },
    ]);
    expect(coreLevel.payload).toEqual({ position: { x: 2, y: -0.2 }, size: { x: 0.4, y: 0.4 } });
    expect(coreLevel.terminals).toEqual([{ position: { x: 12, y: 1 }, size: { x: 0.6, y: 0.8 }, disablesHazard: 1 }]);
  });

  it('drops what C++ could not use, leniently', () => {
    const { coreLevel } = normalizeLevelData({
      ...base,
      hazards: [
        { position: { x: 1, y: 'a' }, size: { x: 1, y: 1 } },
        { position: { x: 2, y: 0 }, size: { x: 1, y: 1 }, patrol: { x0: 0, speed: 1 } },
        7,
      ],
      payload: { position: { x: 0, y: 0 } },
      terminals: [
        { position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, disablesHazard: -1 },
        { position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, disablesHazard: 0.5 },
        { position: { x: 0, y: 0 }, size: { x: 1, y: 1 } },
        { position: { x: 4, y: 0 }, size: { x: 1, y: 1 }, disablesHazard: 0 },
      ],
    });
    // The bad entry is gone, so the static hazard is index 0, which is what the surviving terminal targets.
    expect(coreLevel.hazards).toEqual([{ position: { x: 2, y: 0 }, size: { x: 1, y: 1 } }]);
    expect(coreLevel.payload).toBeUndefined();
    expect(coreLevel.terminals).toEqual([{ position: { x: 4, y: 0 }, size: { x: 1, y: 1 }, disablesHazard: 0 }]);
  });

  it('leaves the existing levels without any of the new keys', () => {
    for (const name of ['test-1', 'demo-decor', 'demo-pano']) {
      const { coreLevel } = normalizeLevelData(JSON.parse(readFileSync(`public/levels/${name}.json`, 'utf8')));
      expect(coreLevel).not.toHaveProperty('hazards');
      expect(coreLevel).not.toHaveProperty('payload');
      expect(coreLevel).not.toHaveProperty('terminals');
    }
  });

  it('loads the courier demo level with all three', () => {
    const { coreLevel } = normalizeLevelData(JSON.parse(readFileSync('public/levels/courier-1.json', 'utf8')));
    expect(coreLevel.hazards).toHaveLength(3);
    expect(coreLevel.payload).toBeDefined();
    expect(coreLevel.terminals).toEqual([expect.objectContaining({ disablesHazard: 1 })]);
    expect(coreLevel.hazards?.[1].patrol).toBeUndefined(); // the gate the terminal opens is the static one
  });
});

describe('DEFAULT_PLATFORMS', () => {
  it("matches Game.cpp's defaultLevel(), which a new Game collides with until the first loadLevel", () => {
    // The snapshot no longer carries platforms, so before any level loads the renderer draws this list.
    const source = readFileSync('cpp/src/Game.cpp', 'utf8');
    const body = source.slice(source.indexOf('LevelSpec defaultLevel()'));
    const start = body.indexOf('level.platforms = {');
    const block = body.slice(start, body.indexOf('\n    };', start));
    const num = String.raw`(-?\d+(?:\.\d+)?)f`;
    const entry = new RegExp(String.raw`\{\s*\{${num},\s*${num}\},\s*\{${num},\s*${num}\}\s*\}`, 'g');
    const parsed = [...block.matchAll(entry)].map((m) => ({
      position: { x: Number(m[1]), y: Number(m[2]) },
      size: { x: Number(m[3]), y: Number(m[4]) },
    }));
    expect(parsed).toEqual(DEFAULT_PLATFORMS);
  });

  it('is what a level without valid platforms falls back to', () => {
    expect(normalizeLevelData({ platforms: [] }).coreLevel.platforms).toEqual(DEFAULT_PLATFORMS);
  });
});
