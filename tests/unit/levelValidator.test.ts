import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  formatLevelIssue,
  reportLevelIssues,
  summarizeLevelIssues,
  validateLevel,
} from '../../src/lib/levelValidator';

const validLevel = () => ({
  spawn: { x: 0, y: -1 },
  bounds: { min: { x: -10, y: -10 }, max: { x: 20, y: 10 } },
  platforms: [{ position: { x: 0, y: -3 }, size: { x: 10, y: 0.4 } }],
  goals: [{ position: { x: 5, y: -2 }, size: { x: 1, y: 1 } }],
});

const paths = (level: unknown) => validateLevel(level).map((i) => `${i.severity}:${i.path}`);

describe('validateLevel — shipped levels', () => {
  for (const name of ['test-1', 'demo-decor', 'demo-pano', 'courier-1']) {
    it(`${name}.json has no issues`, () => {
      const json = JSON.parse(readFileSync(`public/levels/${name}.json`, 'utf8'));
      expect(validateLevel(json)).toEqual([]);
    });
  }
});

describe('validateLevel — silence', () => {
  it('is silent for a minimal level without camera, decor or backgroundLayers', () => {
    expect(validateLevel(validLevel())).toEqual([]);
  });
});

describe('validateLevel — shape', () => {
  it('errors when the root is not an object', () => {
    expect(paths(null)).toEqual(['error:']);
    expect(paths([])).toEqual(['error:']);
  });

  it('errors when platforms is missing or empty', () => {
    const { platforms: _omit, ...noPlatforms } = validLevel();
    expect(paths(noPlatforms)).toEqual(['error:platforms']);
    expect(paths({ ...validLevel(), platforms: [] })).toEqual(['error:platforms']);
  });

  it('warns about missing spawn and goals', () => {
    const { spawn: _s, goals: _g, ...rest } = validLevel();
    expect(paths(rest).sort()).toEqual(['warning:goals', 'warning:spawn']);
  });

  it('suggests the right key for a top-level typo', () => {
    const issues = validateLevel({ ...validLevel(), platfroms: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', path: 'platfroms' });
    expect(issues[0].effect).toContain('"platforms"');
  });
});

describe('validateLevel — platforms and goals', () => {
  it('reports the exact bad axis with expected vs found', () => {
    const level = validLevel();
    level.platforms.push({ position: { x: 1, y: 1 }, size: { x: 2, y: 'tall' as unknown as number } });
    const issues = validateLevel(level);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'error',
      path: 'platforms[1].size.y',
      expected: 'finite number',
      found: 'string "tall"',
    });
  });

  it('reports a missing position and a typo\'d key', () => {
    const level = { ...validLevel(), platforms: [{ positon: { x: 0, y: 0 }, size: { x: 1, y: 1 } }] };
    expect(paths(level).sort()).toEqual(['error:platforms[0].position', 'warning:platforms[0].positon']);
  });

  it('reports a missing size.x as "missing"', () => {
    const level = { ...validLevel(), goals: [{ position: { x: 1, y: 1 }, size: { y: 1 } }] };
    const [issue] = validateLevel(level);
    expect(issue).toMatchObject({ path: 'goals[0].size.x', found: 'missing' });
  });

  it('flags non-array goals and non-object entries', () => {
    expect(paths({ ...validLevel(), goals: {} })).toEqual(['error:goals']);
    expect(paths({ ...validLevel(), platforms: [42] })).toEqual(['error:platforms[0]']);
  });

  it('allows the documented `label` and `visual` keys', () => {
    const level = { ...validLevel(), platforms: [{ position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, label: 'a', visual: false }] };
    expect(validateLevel(level)).toEqual([]);
  });
});

describe('validateLevel — hazards, payload, terminals', () => {
  const courier = () => ({
    ...validLevel(),
    hazards: [
      { position: { x: 8, y: -1 }, size: { x: 0.8, y: 0.6 }, patrol: { x0: 6, x1: 10, speed: 1.5 }, label: 'cat' },
      { position: { x: 3, y: -1 }, size: { x: 0.4, y: 2 } },
    ],
    payload: { position: { x: 2, y: -0.2 }, size: { x: 0.4, y: 0.4 } },
    terminals: [{ position: { x: 12, y: 1 }, size: { x: 0.6, y: 0.8 }, disablesHazard: 1 }],
  });

  it('is silent for the documented shape', () => {
    expect(validateLevel(courier())).toEqual([]);
  });

  it('flags bad hazard entries and patrols', () => {
    const level = courier();
    (level.hazards as unknown[]).push(
      { position: { x: 1, y: 'a' }, size: { x: 1, y: 1 } },
      { position: { x: 3, y: 0 }, size: { x: 1, y: 1 }, patrol: { x0: 5, x1: 2, speed: -1 } },
      { position: { x: 9, y: 0 }, size: { x: 1, y: 1 }, patrol: { x0: 0, x1: 2, speed: 1, sped: 2 } },
      { position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, patrol: { x0: 0, speed: 1 } },
    );
    const issues = validateLevel(level);
    expect(issues.map((i) => `${i.severity}:${i.path}`)).toEqual([
      'error:hazards[2].position.y',
      'warning:hazards[3].patrol',
      'warning:hazards[3].patrol.speed',
      'warning:hazards[4].patrol.sped',
      'warning:hazards[4].position.x',
      'warning:hazards[5].patrol.x1',
    ]);
    expect(issues[1].effect).toBe('endpoints swapped');
    expect(issues[3].effect).toContain('did you mean "speed"');
    expect(issues[4].effect).toBe('clamped into the patrol range');
    expect(issues[5].effect).toBe('patrol ignored, hazard is static');
  });

  it('checks the terminal target against the hazards the loader keeps', () => {
    const level = courier();
    level.terminals.push(
      { position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, disablesHazard: 2 },
      { position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, disablesHazard: 0.5 },
      { position: { x: 0, y: 0 }, size: { x: 1, y: 1 } } as never,
    );
    expect(paths(level)).toEqual([
      'warning:terminals[1].disablesHazard',
      'error:terminals[2].disablesHazard',
      'error:terminals[3].disablesHazard',
    ]);

    // An invalid hazard before the target shifts what the index means.
    const shifted = courier();
    shifted.hazards.unshift({ position: { x: 0, y: 0 } } as never);
    shifted.terminals[0].disablesHazard = 1;
    const issues = validateLevel(shifted).filter((i) => i.path.startsWith('terminals'));
    expect(issues).toHaveLength(1);
    expect(issues[0].effect).toBe('targets hazards[2] because invalid hazards before it are skipped');
  });

  it('flags a payload without goals or with a bad shape', () => {
    const noGoals: Record<string, unknown> = courier();
    delete noGoals.goals;
    expect(paths(noGoals)).toEqual(['warning:goals', 'warning:payload']);
    expect(paths({ ...courier(), payload: [] })).toEqual(['error:payload']);
    expect(paths({ ...courier(), payload: { position: { x: 0, y: 0 } } })).toEqual(['error:payload.size']);
  });
});

describe('validateLevel — world-space backgroundLayers', () => {
  const world = (extra: Record<string, unknown> = {}) => ({
    mode: 'world',
    image: './pano.png',
    position: { x: 24, y: 0 },
    size: { x: 56, y: 18 },
    ...extra,
  });

  it('accepts a complete world layer and a parallax layer in the same level without issues', () => {
    const level = { ...validLevel(), backgroundLayers: [{ image: './a.png', scrollFactorX: 0.1 }, world({ parallaxX: 0.15, parallaxY: 0.05 })] };
    expect(paths(level)).toEqual([]);
  });

  it('is silent for a world layer that omits position/size when bounds are usable (fits to bounds)', () => {
    const level = { ...validLevel(), backgroundLayers: [{ mode: 'world', image: './pano.png' }] };
    expect(paths(level)).toEqual([]);
  });

  it('errors with field paths when a world layer cannot be placed (no rectangle, no bounds)', () => {
    const { bounds: _bounds, ...noBounds } = validLevel();
    const level = { ...noBounds, backgroundLayers: [{ mode: 'world', image: './pano.png' }] };
    expect(paths(level)).toEqual(['error:backgroundLayers[0].position', 'error:backgroundLayers[0].size']);
  });

  it('warns per bad axis / non-positive size and says the bounds fallback is used', () => {
    const level = {
      ...validLevel(),
      backgroundLayers: [world({ position: { x: 'a', y: 0 }, size: { x: 56, y: -1 }, parallaxX: 'x' })],
    };
    expect(paths(level)).toEqual([
      'warning:backgroundLayers[0].position.x',
      'warning:backgroundLayers[0].size',
      'warning:backgroundLayers[0].parallaxX',
    ]);
    expect(validateLevel(level)[0].effect).toMatch(/bounds/);
  });

  it('flags keys that do not apply to the layer mode', () => {
    const level = {
      ...validLevel(),
      backgroundLayers: [world({ scrollFactorX: 0.2, scale: 2 }), { image: './a.png', position: { x: 0, y: 0 }, parallaxX: 1 }],
    };
    expect(paths(level)).toEqual([
      'warning:backgroundLayers[0].scrollFactorX',
      'warning:backgroundLayers[0].scale',
      'warning:backgroundLayers[1].position',
      'warning:backgroundLayers[1].parallaxX',
    ]);
  });

  it('warns on an unknown mode and still requires an image', () => {
    const level = { ...validLevel(), backgroundLayers: [{ image: './a.png', mode: 'worldspace' }, world({ image: '' })] };
    expect(paths(level)).toEqual(['warning:backgroundLayers[0].mode', 'error:backgroundLayers[1].image']);
  });
});

describe('validateLevel — backgroundLayers', () => {
  it('requires an image path', () => {
    const level = { ...validLevel(), backgroundLayers: [{ scrollFactorX: 0.1 }, { image: '  ' }] };
    expect(paths(level)).toEqual(['error:backgroundLayers[0].image', 'error:backgroundLayers[1].image']);
  });

  it('warns on bad numeric fields and non-positive scale', () => {
    const level = {
      ...validLevel(),
      backgroundLayers: [{ image: './a.png', scrollFactorX: 'fast', scale: 0 }],
    };
    expect(paths(level)).toEqual(['warning:backgroundLayers[0].scrollFactorX', 'warning:backgroundLayers[0].scale']);
  });

  it('warns on suspicious image paths', () => {
    const level = { ...validLevel(), backgroundLayers: [{ image: 'public/a.png' }, { image: '.\\a.png' }] };
    expect(paths(level)).toEqual(['warning:backgroundLayers[0].image', 'warning:backgroundLayers[1].image']);
  });

  it('warns when vertical parallax has no followY to act on', () => {
    const level = { ...validLevel(), backgroundLayers: [{ image: './a.png', scrollFactorY: 0.1 }] };
    expect(paths(level)).toEqual(['warning:backgroundLayers[0].scrollFactorY']);
    const withCamera = { ...level, camera: { followY: true } };
    expect(validateLevel(withCamera)).toEqual([]);
  });
});

describe('validateLevel — decor', () => {
  const decor = (entry: Record<string, unknown>) => ({ ...validLevel(), decor: [entry] });

  it('accepts image or texture', () => {
    expect(validateLevel(decor({ image: './a.png', position: { x: 0, y: 0 } }))).toEqual([]);
    expect(validateLevel(decor({ texture: './a.png', position: { x: 0, y: 0 } }))).toEqual([]);
  });

  it('errors when neither image nor texture is set, and on bad position', () => {
    expect(paths(decor({ position: { x: 0, y: 0 } }))).toEqual(['error:decor[0].image']);
    expect(paths(decor({ image: './a.png', position: { x: 'a', y: 0 } }))).toEqual(['error:decor[0].position.x']);
  });

  it('warns on unknown layer, bad uv, bad size', () => {
    const level = decor({
      image: './a.png',
      position: { x: 0, y: 0 },
      layer: 'middle',
      uv: [0, 0, 0, 64],
      size: { x: 1 },
    });
    expect(paths(level).sort()).toEqual(['warning:decor[0].layer', 'warning:decor[0].size.y', 'warning:decor[0].uv']);
  });

  it('accepts layer aliases and a valid uv', () => {
    const level = decor({ image: './a.png', position: { x: 0, y: 0 }, layer: 'far', uv: [0, 0, 64, 64], parallax: 0.5 });
    expect(validateLevel(level)).toEqual([]);
  });
});

describe('validateLevel — camera and bounds consistency', () => {
  it('errors on inverted bounds', () => {
    const level = { ...validLevel(), bounds: { min: { x: 5, y: 0 }, max: { x: 0, y: 10 } }, spawn: { x: 2, y: 1 } };
    expect(paths(level).filter((p) => p === 'error:bounds')).toHaveLength(1);
  });

  it('errors when only one of bounds.min / bounds.max is valid', () => {
    const level = { ...validLevel(), bounds: { min: { x: 0, y: 0 } } };
    expect(paths(level)).toContain('error:bounds.max');
  });

  it('warns when spawn or goal sit outside bounds', () => {
    const level = { ...validLevel(), spawn: { x: 100, y: 0 }, goals: [{ position: { x: 0, y: 50 }, size: { x: 1, y: 1 } }] };
    expect(paths(level).sort()).toEqual(['warning:goals[0].position', 'warning:spawn']);
  });

  it('warns about wrong-typed and ineffective camera settings', () => {
    expect(paths({ ...validLevel(), camera: { followY: 'yes' } })).toEqual(['warning:camera.followY']);
    expect(paths({ ...validLevel(), camera: { lookAheadY: 1 } })).toEqual(['warning:camera']);
    expect(validateLevel({ ...validLevel(), camera: { followY: true, verticalDeadzone: 0.5, lookAheadY: 1 } })).toEqual([]);
  });
});

describe('reporting', () => {
  it('formats with level label, path, expected and found', () => {
    const [issue] = validateLevel({ ...validLevel(), platforms: [{ position: { x: 0, y: 0 }, size: { x: 1, y: null } }] });
    expect(formatLevelIssue('t (t.json)', issue)).toBe(
      '[level t (t.json)] platforms[0].size.y: expected finite number, found null — entry skipped',
    );
  });

  it('routes errors to console.error and warnings to console.warn, nothing when clean', () => {
    const sink = { warn: vi.fn(), error: vi.fn() };
    reportLevelIssues('x', validateLevel(validLevel()), sink);
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();

    const { platforms: _p, ...noPlatforms } = validLevel();
    reportLevelIssues('x', validateLevel({ ...noPlatforms, extra: 1 }), sink);
    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledTimes(1);
  });

  it('summarizes counts and prefers an error as the headline', () => {
    const { platforms: _p, ...noPlatforms } = validLevel();
    const summary = summarizeLevelIssues('x', validateLevel({ ...noPlatforms, extra: 1 }));
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.first).toContain('platforms');
  });
});
