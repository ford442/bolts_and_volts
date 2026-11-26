import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEVELS, normalizeLevelManifest, resolveLevelEntry } from '../../src/lib/levelManifest';
import { resolveNextLevel } from '../../src/game/session';

describe('levelManifest helpers', () => {
  it('falls back to the default level list', () => {
    expect(normalizeLevelManifest(null)).toEqual(DEFAULT_LEVELS);
  });

  it('normalizes valid manifest entries', () => {
    expect(normalizeLevelManifest({
      levels: [
        { id: 'alpha', file: 'alpha.json', name: 'Alpha', description: 'First', author: 'Team' },
        { id: '', file: 'skip.json' },
      ],
    })).toEqual([
      { id: 'alpha', file: 'alpha.json', name: 'Alpha', description: 'First', author: 'Team', music: undefined },
    ]);
  });

  it('resolves the requested level or falls back to the first entry', () => {
    const levels = normalizeLevelManifest({
      levels: [
        { id: 'alpha', file: 'alpha.json' },
        { id: 'beta', file: 'beta.json' },
      ],
    });

    expect(resolveLevelEntry(levels, 'beta')).toEqual({ id: 'beta', file: 'beta.json', name: undefined, description: undefined, author: undefined, music: undefined });
    expect(resolveLevelEntry(levels, 'missing')).toEqual({ id: 'alpha', file: 'alpha.json', name: undefined, description: undefined, author: undefined, music: undefined });
  });

  describe('next', () => {
    it('keeps a string id, trimmed', () => {
      const [alpha] = normalizeLevelManifest({ levels: [{ id: 'alpha', file: 'alpha.json', next: '  beta ' }] });
      expect(alpha.next).toBe('beta');
    });

    it('drops blank and non-string values', () => {
      const levels = normalizeLevelManifest({
        levels: [
          { id: 'a', file: 'a.json', next: '' },
          { id: 'b', file: 'b.json', next: '   ' },
          { id: 'c', file: 'c.json', next: 7 },
          { id: 'd', file: 'd.json', next: null },
          { id: 'e', file: 'e.json', next: ['f'] },
          { id: 'f', file: 'f.json' },
        ],
      });
      expect(levels.map((l) => l.next)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    });
  });

  describe('resolveNextLevel (the complete-screen target)', () => {
    const levels = normalizeLevelManifest({
      levels: [
        { id: 'one', file: '1.json', next: 'two' },
        { id: 'two', file: '2.json', next: 'ghost' },
        { id: 'three', file: '3.json', next: 'one' },
        { id: 'last', file: '4.json' },
      ],
    });

    it('follows next, in any direction (it is not the list order)', () => {
      expect(resolveNextLevel(levels, 'one')).toMatchObject({ kind: 'next', level: { id: 'two' } });
      expect(resolveNextLevel(levels, 'three')).toMatchObject({ kind: 'next', level: { id: 'one' } });
    });

    it('ends the route when the entry has no next, instead of wrapping to the first level', () => {
      expect(resolveNextLevel(levels, 'last')).toEqual({ kind: 'end', reason: 'no-next' });
    });

    it('tells an unknown next id apart, so it can be reported', () => {
      expect(resolveNextLevel(levels, 'two')).toEqual({ kind: 'end', reason: 'unknown-next' });
    });

    it('ends the route for a current level the manifest does not have', () => {
      expect(resolveNextLevel(levels, 'nope')).toEqual({ kind: 'end', reason: 'unknown-level' });
    });
  });

  it('the shipped manifest is one route: every next exists, nothing loops, and the walk from the first level covers all', () => {
    const levels = normalizeLevelManifest(JSON.parse(readFileSync('public/levels/manifest.json', 'utf8')));
    const walked: string[] = [];
    let step = resolveNextLevel(levels, levels[0].id);
    walked.push(levels[0].id);
    while (step.kind === 'next') {
      expect(walked).not.toContain(step.level.id);
      walked.push(step.level.id);
      step = resolveNextLevel(levels, step.level.id);
    }
    expect(step).toEqual({ kind: 'end', reason: 'no-next' });  // ends cleanly, not on a dangling id
    expect(walked).toEqual(levels.map((l) => l.id));
  });
});
