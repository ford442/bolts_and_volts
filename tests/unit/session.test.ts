import { describe, expect, it } from 'vitest';
import { normalizeLevelManifest } from '../../src/lib/levelManifest';
import {
  PROGRESS_KEY,
  browserStorage,
  clearProgress,
  completedCount,
  createPauseControl,
  emptyProgress,
  loadProgress,
  parseProgress,
  saveProgress,
  startingLevel,
  withCheckpoint,
  withCompleted,
  type ProgressStorage,
} from '../../src/game/session';

const memoryStorage = (initial?: string): ProgressStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>(initial === undefined ? [] : [[PROGRESS_KEY, initial]]);
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
};

const levels = normalizeLevelManifest({
  levels: [{ id: 'a', file: 'a.json' }, { id: 'b', file: 'b.json' }, { id: 'c', file: 'c.json' }],
});

describe('createPauseControl', () => {
  it('Escape toggles playing and paused', () => {
    const pause = createPauseControl();
    expect(pause.isPaused()).toBe(false);
    expect(pause.toggle()).toBe('paused');
    expect(pause.isPaused()).toBe(true);
    expect(pause.toggle()).toBe('playing');
    expect(pause.isPaused()).toBe(false);
  });

  it('level complete pauses, and Escape cannot lift it; a level load does', () => {
    const pause = createPauseControl();
    expect(pause.complete()).toBe('complete');
    expect(pause.isPaused()).toBe(true);
    expect(pause.toggle()).toBe('complete');
    expect(pause.isPaused()).toBe(true);
    expect(pause.resume()).toBe('playing');
    expect(pause.isPaused()).toBe(false);
  });

  it('finishing a level while paused moves to the complete screen', () => {
    const pause = createPauseControl();
    pause.toggle();
    expect(pause.complete()).toBe('complete');
  });
});

describe('progress storage', () => {
  it('round-trips completed levels and checkpoints', () => {
    const storage = memoryStorage();
    const progress = withCheckpoint(withCompleted(emptyProgress(), 'a'), 'b', 2);
    expect(saveProgress(storage, progress)).toBe(true);
    expect(loadProgress(storage)).toEqual({ completed: ['a'], checkpoints: { b: 2 } });
  });

  it('uses a namespaced key', () => {
    const storage = memoryStorage();
    saveProgress(storage, emptyProgress());
    expect([...storage.data.keys()]).toEqual([PROGRESS_KEY]);
    expect(PROGRESS_KEY).toMatch(/^bolts-and-volts:/);
  });

  it('reads nothing from another key, bad JSON or the wrong shape', () => {
    expect(loadProgress(null)).toEqual(emptyProgress());
    expect(loadProgress(memoryStorage())).toEqual(emptyProgress());
    expect(loadProgress(memoryStorage('{not json'))).toEqual(emptyProgress());
    expect(loadProgress(memoryStorage('[1,2]'))).toEqual(emptyProgress());
    expect(loadProgress(memoryStorage('"a"'))).toEqual(emptyProgress());
  });

  it('keeps only well-formed entries', () => {
    const raw = JSON.stringify({
      completed: ['a', 7, '', null, 'a', 'b'],
      checkpoints: { a: 1, b: -1, c: 1.5, d: '2', e: 0 },
    });
    expect(parseProgress(raw)).toEqual({ completed: ['a', 'b'], checkpoints: { a: 1, e: 0 } });
  });

  it('survives a storage that throws (blocked site data, full quota)', () => {
    const broken: ProgressStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(loadProgress(broken)).toEqual(emptyProgress());
    expect(saveProgress(broken, emptyProgress())).toBe(false);
    expect(() => clearProgress(broken)).not.toThrow();
    expect(saveProgress(null, emptyProgress())).toBe(false);
  });

  it('clearProgress removes the key', () => {
    const storage = memoryStorage();
    saveProgress(storage, withCompleted(emptyProgress(), 'a'));
    clearProgress(storage);
    expect(storage.data.size).toBe(0);
    expect(loadProgress(storage)).toEqual(emptyProgress());
  });

  it('browserStorage is null (not a throw) where localStorage is missing', () => {
    // Node has no localStorage global here.
    expect(browserStorage()).toBeNull();
  });
});

describe('progress updates', () => {
  it('completing a level marks it once and forgets its checkpoint', () => {
    let progress = withCheckpoint(emptyProgress(), 'a', 1);
    progress = withCheckpoint(progress, 'b', 0);
    const done = withCompleted(withCompleted(progress, 'a'), 'a');
    expect(done).toEqual({ completed: ['a'], checkpoints: { b: 0 } });
    expect(progress.checkpoints).toEqual({ a: 1, b: 0 });  // the input is not changed
  });

  it('a checkpoint replaces the previous one for its level, and undefined forgets it', () => {
    let progress = withCheckpoint(emptyProgress(), 'a', 0);
    progress = withCheckpoint(progress, 'a', 2);
    expect(progress.checkpoints).toEqual({ a: 2 });
    expect(withCheckpoint(progress, 'a', undefined).checkpoints).toEqual({});
  });
});

describe('where to start', () => {
  it('starts at the first level that is not finished', () => {
    expect(startingLevel(levels, emptyProgress())?.id).toBe('a');
    expect(startingLevel(levels, withCompleted(emptyProgress(), 'a'))?.id).toBe('b');
    // Order is the manifest's, not the order they were finished in.
    expect(startingLevel(levels, withCompleted(withCompleted(emptyProgress(), 'b'), 'a'))?.id).toBe('c');
    expect(startingLevel(levels, withCompleted(emptyProgress(), 'b'))?.id).toBe('a');
  });

  it('starts at the first entry when everything is finished', () => {
    const all = ['a', 'b', 'c'].reduce(withCompleted, emptyProgress());
    expect(startingLevel(levels, all)?.id).toBe('a');
  });

  it('ignores ids that are no longer in the manifest', () => {
    const progress = withCompleted(withCompleted(emptyProgress(), 'removed'), 'a');
    expect(startingLevel(levels, progress)?.id).toBe('b');
    expect(completedCount(levels, progress)).toBe(1);
  });

  it('has no starting level for an empty list', () => {
    expect(startingLevel([], emptyProgress())).toBeUndefined();
  });
});
