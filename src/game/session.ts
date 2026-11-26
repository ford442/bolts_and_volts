import type { LevelManifestEntry } from '../lib/levelManifest';

/**
 * Campaign rules that sit above one level: what the complete screen offers next, whether the simulation is paused,
 * and what is remembered between visits. Pure (storage is passed in), so `GameCanvas` only wires it to React and
 * the unit tests need no browser. One canvas, no routes.
 */

// --- Route: what comes after a level -------------------------------------------------------------------------

export type NextLevel =
  | { kind: 'next'; level: LevelManifestEntry }
  /**
   * The route stops here. `no-next`: the entry names none (absent or blank). `unknown-next`: it names an id the manifest
   * does not have (an authoring mistake worth a warning). `unknown-level`: `currentId` is not in the manifest at all.
   */
  | { kind: 'end'; reason: 'no-next' | 'unknown-next' | 'unknown-level' };

/** Where the complete screen goes from `currentId`: follows the entry's `next` and never wraps around. */
export const resolveNextLevel = (levels: readonly LevelManifestEntry[], currentId: string): NextLevel => {
  const current = levels.find((entry) => entry.id === currentId);
  if (!current) return { kind: 'end', reason: 'unknown-level' };
  const nextId = current.next?.trim();
  if (!nextId) return { kind: 'end', reason: 'no-next' };
  const level = levels.find((entry) => entry.id === nextId);
  return level ? { kind: 'next', level } : { kind: 'end', reason: 'unknown-next' };
};

// --- Pause ---------------------------------------------------------------------------------------------------

/** `complete` is a pause the player cannot toggle out of: only loading a level (Reload, Next, the dropdown) ends it. */
export type SessionPhase = 'playing' | 'paused' | 'complete';

export type PauseControl = {
  phase: () => SessionPhase;
  /** What the game loop reads each frame: true in both `paused` and `complete`. */
  isPaused: () => boolean;
  /** Escape. Pauses or resumes; does nothing on the complete screen. Returns the phase after. */
  toggle: () => SessionPhase;
  /** The level was finished. */
  complete: () => SessionPhase;
  /** A level (re)loaded, or Resume was pressed: back to playing. */
  resume: () => SessionPhase;
};

export const createPauseControl = (): PauseControl => {
  let phase: SessionPhase = 'playing';
  return {
    phase: () => phase,
    isPaused: () => phase !== 'playing',
    toggle: () => {
      if (phase !== 'complete') phase = phase === 'paused' ? 'playing' : 'paused';
      return phase;
    },
    complete: () => { phase = 'complete'; return phase; },
    resume: () => { phase = 'playing'; return phase; },
  };
};

// --- Progress (localStorage) ---------------------------------------------------------------------------------

/** What is remembered: finished levels, and the active checkpoint of levels in progress. Both are by manifest level id. */
export type Progress = {
  completed: string[];
  /** Level id -> index into that level's `checkpoints`. Absent: start from the spawn. */
  checkpoints: Record<string, number>;
};

export const PROGRESS_KEY = 'bolts-and-volts:progress:v1';

export const emptyProgress = (): Progress => ({ completed: [], checkpoints: {} });

/** Just enough of `Storage` for progress, so tests (and a blocked `localStorage`) can substitute. */
export type ProgressStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `window.localStorage`, or null where it is unavailable or throws (blocked site data, some private windows). */
export const browserStorage = (): ProgressStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Anything unreadable (bad JSON, wrong shapes, bad entries) is dropped, never thrown: stale data must not stop the game. */
export const parseProgress = (raw: string | null): Progress => {
  if (!raw) return emptyProgress();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyProgress();
  }
  if (!isRecord(data)) return emptyProgress();
  const completed = Array.isArray(data.completed)
    ? [...new Set(data.completed.filter((id): id is string => typeof id === 'string' && id !== ''))]
    : [];
  const checkpoints: Record<string, number> = {};
  if (isRecord(data.checkpoints)) {
    for (const [id, index] of Object.entries(data.checkpoints)) {
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0) checkpoints[id] = index;
    }
  }
  return { completed, checkpoints };
};

export const loadProgress = (storage: ProgressStorage | null): Progress => {
  try {
    return parseProgress(storage?.getItem(PROGRESS_KEY) ?? null);
  } catch {
    return emptyProgress();
  }
};

/** Best effort: a full or blocked store loses progress, not the game. Returns whether it was written. */
export const saveProgress = (storage: ProgressStorage | null, progress: Progress): boolean => {
  try {
    storage?.setItem(PROGRESS_KEY, JSON.stringify(progress));
    return storage !== null;
  } catch {
    return false;
  }
};

/** The control that clears the key. */
export const clearProgress = (storage: ProgressStorage | null): void => {
  try {
    storage?.removeItem(PROGRESS_KEY);
  } catch {
    // Nothing to clear if the store cannot be reached.
  }
};

const withoutKey = (record: Record<string, number>, key: string): Record<string, number> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

/**
 * A finished level is done: it is marked, and its checkpoint is forgotten so the next visit starts at the spawn.
 * Returns a new object (the argument is not changed).
 */
export const withCompleted = (progress: Progress, levelId: string): Progress => ({
  completed: progress.completed.includes(levelId) ? progress.completed : [...progress.completed, levelId],
  checkpoints: withoutKey(progress.checkpoints, levelId),
});

/** Remember checkpoint `index` for `levelId`, or forget it with `undefined`. Returns a new object. */
export const withCheckpoint = (progress: Progress, levelId: string, index: number | undefined): Progress => {
  const rest = withoutKey(progress.checkpoints, levelId);
  return { completed: progress.completed, checkpoints: index === undefined ? rest : { ...rest, [levelId]: index } };
};

/** Ids that are not in the manifest (a level removed or renamed since) are ignored, not an error. */
export const isCompleted = (progress: Progress, levelId: string): boolean => progress.completed.includes(levelId);

export const completedCount = (levels: readonly LevelManifestEntry[], progress: Progress): number =>
  levels.filter((entry) => isCompleted(progress, entry.id)).length;

/** Where to start on boot: the first level not yet finished, else (all finished, or none) the first entry. */
export const startingLevel = (levels: readonly LevelManifestEntry[], progress: Progress): LevelManifestEntry | undefined =>
  levels.find((entry) => !isCompleted(progress, entry.id)) ?? levels[0];
