/**
 * Authoring-time level JSON validator.
 *
 * The loaders in `GameCanvas.tsx` are deliberately lenient: bad entries are skipped and
 * missing values fall back to defaults so a broken level still boots. That makes typos
 * invisible. This module walks the same raw JSON and reports everything the loaders would
 * silently drop or default, with a field path, what was expected and what was found.
 *
 * It is pure (no DOM, no console) so it can be unit tested; `reportLevelIssues` does the logging.
 * It never changes what gets loaded.
 */

export type LevelIssueSeverity = 'error' | 'warning';

export type LevelIssue = {
  severity: LevelIssueSeverity;
  /** Field path, e.g. `platforms[3].size.y`. Empty string means the document root. */
  path: string;
  expected: string;
  found: string;
  /** What the loader does about it, e.g. "entry skipped" or "using default 0.4". */
  effect: string;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const TOP_LEVEL_KEYS = [
  'name', 'description', 'author', 'spawn', 'bounds', 'camera', 'platforms', 'goals',
  'hazards', 'payload', 'terminals', 'backgroundLayers', 'decor',
];
const PLATFORM_KEYS = ['position', 'size', 'visual', 'label'];
const GOAL_KEYS = ['position', 'size', 'label'];
const CAMERA_KEYS = ['followY', 'verticalDeadzone', 'lookAheadY'];
const HAZARD_KEYS = ['position', 'size', 'patrol', 'label'];
const PATROL_KEYS = ['x0', 'x1', 'speed'];
const PAYLOAD_KEYS = ['position', 'size', 'label'];
const TERMINAL_KEYS = ['position', 'size', 'disablesHazard', 'label'];
const BACKGROUND_LAYER_KEYS = [
  'image', 'mode', 'scrollFactorX', 'scrollFactorY', 'scale', 'offsetY',
  'position', 'size', 'parallaxX', 'parallaxY', 'label',
];
const PARALLAX_ONLY_KEYS = ['scrollFactorX', 'scrollFactorY', 'scale', 'offsetY'];
const WORLD_ONLY_KEYS = ['position', 'size', 'parallaxX', 'parallaxY'];
const DECOR_KEYS = [
  'image', 'texture', 'position', 'size', 'layer', 'parallaxFactor', 'parallax',
  'parallaxX', 'parallaxY', 'scrollFactorX', 'scrollFactorY', 'uv', 'offsetY', 'label',
];
const DECOR_LAYERS = ['distant', 'far', 'mid', 'foreground', 'front'];

/** Human-readable description of a value for the "found" half of a message. */
export const describeValue = (value: unknown): string => {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
  if (Array.isArray(value)) return `array (length ${value.length})`;
  return 'object';
};

const editDistance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
};

const suggestKey = (key: string, allowed: string[]): string | null => {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of allowed) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

const joinPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key);

export const validateLevel = (level: unknown): LevelIssue[] => {
  const issues: LevelIssue[] = [];
  const add = (severity: LevelIssueSeverity, path: string, expected: string, found: unknown, effect: string): void => {
    issues.push({ severity, path, expected, found: describeValue(found), effect });
  };

  const checkUnknownKeys = (path: string, obj: JsonRecord, allowed: string[]): void => {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const suggestion = suggestKey(key, allowed);
      add(
        'warning',
        joinPath(path, key),
        `one of: ${allowed.join(', ')}`,
        `unknown key "${key}"`,
        suggestion ? `ignored — did you mean "${suggestion}"?` : 'ignored',
      );
    }
  };

  /** Checks `{x, y}` finite numbers; reports each bad axis with its own path. Returns the vec if fully valid. */
  const checkVec2 = (
    path: string,
    value: unknown,
    severity: LevelIssueSeverity,
    effect: string,
  ): { x: number; y: number } | null => {
    if (!isRecord(value)) {
      add(severity, path, '{ "x": number, "y": number }', value, effect);
      return null;
    }
    let ok = true;
    for (const axis of ['x', 'y'] as const) {
      if (!isFiniteNumber(value[axis])) {
        add(severity, `${path}.${axis}`, 'finite number', value[axis], effect);
        ok = false;
      }
    }
    return ok ? { x: value.x as number, y: value.y as number } : null;
  };

  const checkOptionalNumber = (path: string, value: unknown, fallbackText: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!isFiniteNumber(value)) {
      add('warning', path, 'finite number', value, fallbackText);
      return undefined;
    }
    return value;
  };

  const checkImage = (path: string, value: unknown, effect: string): void => {
    if (typeof value !== 'string' || value.trim() === '') {
      add('error', path, 'non-empty image path string, e.g. "./background.png"', value, effect);
      return;
    }
    const image = value.trim();
    if (image.includes('\\')) {
      add('warning', path, 'forward-slash URL relative to public/', value, 'path contains a backslash and will probably fail to load');
    } else if (/^\/?public\//.test(image)) {
      add('warning', path, 'URL relative to public/, e.g. "./file.png"', value, 'files in public/ are served from the site root, so a "public/" prefix will probably 404');
    }
  };

  if (!isRecord(level)) {
    add('error', '', 'a JSON object at the top level', level, 'built-in fallback platforms loaded');
    return issues;
  }

  checkUnknownKeys('', level, TOP_LEVEL_KEYS);

  for (const key of ['name', 'description', 'author']) {
    if (level[key] !== undefined && typeof level[key] !== 'string') {
      add('warning', key, 'string', level[key], 'ignored');
    }
  }

  // --- spawn ---
  const spawn = level.spawn === undefined
    ? null
    : checkVec2('spawn', level.spawn, 'error', 'spawn ignored, player keeps its default position');
  if (level.spawn === undefined) {
    add('warning', 'spawn', '{ "x": number, "y": number }', undefined, 'player keeps its default position');
  }

  // --- bounds ---
  let bounds: { min: { x: number; y: number }; max: { x: number; y: number } } | null = null;
  if (level.bounds !== undefined) {
    if (!isRecord(level.bounds)) {
      add('error', 'bounds', '{ "min": {x, y}, "max": {x, y} }', level.bounds, 'bounds ignored, camera is unclamped');
    } else {
      checkUnknownKeys('bounds', level.bounds, ['min', 'max']);
      const min = checkVec2('bounds.min', level.bounds.min, 'error', 'bounds ignored, camera is unclamped');
      const max = checkVec2('bounds.max', level.bounds.max, 'error', 'bounds ignored, camera is unclamped');
      if (min && max) {
        bounds = { min, max };
        if (min.x >= max.x) {
          add('error', 'bounds', 'min.x < max.x', `min.x ${min.x}, max.x ${max.x}`, 'camera clamp range is empty or inverted');
        }
        if (min.y >= max.y) {
          add('error', 'bounds', 'min.y < max.y', `min.y ${min.y}, max.y ${max.y}`, 'camera clamp range is empty or inverted');
        }
      }
    }
  }
  const outsideBounds = (point: { x: number; y: number }): boolean =>
    bounds !== null && (point.x < bounds.min.x || point.x > bounds.max.x || point.y < bounds.min.y || point.y > bounds.max.y);
  if (spawn && outsideBounds(spawn)) {
    add('warning', 'spawn', 'a point inside bounds', `(${spawn.x}, ${spawn.y}) outside bounds`, 'player starts outside the camera clamp area');
  }

  // --- camera ---
  let followY = false;
  if (level.camera !== undefined) {
    if (!isRecord(level.camera)) {
      add('warning', 'camera', 'object with followY / verticalDeadzone / lookAheadY', level.camera, 'ignored, camera follows X only');
    } else {
      const camera = level.camera;
      checkUnknownKeys('camera', camera, CAMERA_KEYS);
      if (camera.followY !== undefined && typeof camera.followY !== 'boolean') {
        add('warning', 'camera.followY', 'boolean', camera.followY, 'ignored, camera follows X only');
      } else if (camera.followY === true) {
        followY = true;
      }
      const deadzone = checkOptionalNumber('camera.verticalDeadzone', camera.verticalDeadzone, 'ignored, using default 0.75');
      if (deadzone !== undefined && deadzone < 0) {
        add('warning', 'camera.verticalDeadzone', 'number >= 0', `number ${deadzone}`, 'clamped to 0');
      }
      checkOptionalNumber('camera.lookAheadY', camera.lookAheadY, 'ignored, using default 0.8');
      if (!followY && (camera.verticalDeadzone !== undefined || camera.lookAheadY !== undefined)) {
        add('warning', 'camera', 'camera.followY: true for verticalDeadzone / lookAheadY to matter', `followY ${describeValue(camera.followY)}`, 'vertical settings have no effect');
      }
    }
  }

  // --- platforms ---
  if (level.platforms === undefined) {
    add('error', 'platforms', 'non-empty array of { position, size }', undefined, 'built-in fallback platforms loaded');
  } else if (!Array.isArray(level.platforms)) {
    add('error', 'platforms', 'non-empty array of { position, size }', level.platforms, 'built-in fallback platforms loaded');
  } else {
    if (level.platforms.length === 0) {
      add('error', 'platforms', 'non-empty array of { position, size }', level.platforms, 'built-in fallback platforms loaded');
    }
    level.platforms.forEach((item: unknown, index: number) => {
      const path = `platforms[${index}]`;
      if (!isRecord(item)) {
        add('error', path, 'object { position, size }', item, 'entry skipped');
        return;
      }
      checkUnknownKeys(path, item, PLATFORM_KEYS);
      checkVec2(`${path}.position`, item.position, 'error', 'entry skipped');
      const size = checkVec2(`${path}.size`, item.size, 'error', 'entry skipped');
      if (size && (size.x <= 0 || size.y <= 0)) {
        add('warning', `${path}.size`, 'width and height > 0', `(${size.x}, ${size.y})`, 'platform has no collidable area');
      }
      if (item.visual !== undefined && typeof item.visual !== 'boolean') {
        add('warning', `${path}.visual`, 'boolean', item.visual, 'ignored, platform is drawn');
      }
    });
  }

  // --- goals ---
  if (level.goals === undefined) {
    add('warning', 'goals', 'array of { position, size }', undefined, 'level has no goal and cannot be completed');
  } else if (!Array.isArray(level.goals)) {
    add('error', 'goals', 'array of { position, size }', level.goals, 'goals ignored');
  } else {
    if (level.goals.length === 0) {
      add('warning', 'goals', 'at least one { position, size }', level.goals, 'level has no goal and cannot be completed');
    }
    level.goals.forEach((item: unknown, index: number) => {
      const path = `goals[${index}]`;
      if (!isRecord(item)) {
        add('error', path, 'object { position, size }', item, 'entry skipped');
        return;
      }
      checkUnknownKeys(path, item, GOAL_KEYS);
      const position = checkVec2(`${path}.position`, item.position, 'error', 'entry skipped');
      const size = checkVec2(`${path}.size`, item.size, 'error', 'entry skipped');
      if (size && (size.x <= 0 || size.y <= 0)) {
        add('warning', `${path}.size`, 'width and height > 0', `(${size.x}, ${size.y})`, 'goal has no area to touch');
      }
      if (position && outsideBounds(position)) {
        add('warning', `${path}.position`, 'a point inside bounds', `(${position.x}, ${position.y}) outside bounds`, 'goal may be unreachable by the camera');
      }
    });
  }

  // --- hazards (optional) ---
  // Index of each hazard the loader keeps, by array position (null: dropped). Terminals target kept hazards only.
  const keptHazardIndex: (number | null)[] = [];
  if (level.hazards !== undefined) {
    if (!Array.isArray(level.hazards)) {
      add('error', 'hazards', 'array of { position, size, patrol? }', level.hazards, 'hazards ignored');
    } else {
      let kept = 0;
      level.hazards.forEach((item: unknown, index: number) => {
        const path = `hazards[${index}]`;
        if (!isRecord(item)) {
          add('error', path, 'object { position, size, patrol? }', item, 'entry skipped');
          keptHazardIndex.push(null);
          return;
        }
        checkUnknownKeys(path, item, HAZARD_KEYS);
        const position = checkVec2(`${path}.position`, item.position, 'error', 'entry skipped');
        const size = checkVec2(`${path}.size`, item.size, 'error', 'entry skipped');
        keptHazardIndex.push(position && size ? kept++ : null);
        if (size && (size.x <= 0 || size.y <= 0)) {
          add('warning', `${path}.size`, 'width and height > 0', `(${size.x}, ${size.y})`, 'hazard has no area to touch');
        }
        if (item.patrol === undefined) return;
        const patrolPath = `${path}.patrol`;
        if (!isRecord(item.patrol)) {
          add('warning', patrolPath, '{ "x0": number, "x1": number, "speed": number }', item.patrol, 'ignored, hazard is static');
          return;
        }
        const patrol = item.patrol;
        checkUnknownKeys(patrolPath, patrol, PATROL_KEYS);
        let patrolOk = true;
        for (const key of PATROL_KEYS) {
          if (!isFiniteNumber(patrol[key])) {
            add('warning', `${patrolPath}.${key}`, 'finite number', patrol[key], 'patrol ignored, hazard is static');
            patrolOk = false;
          }
        }
        if (!patrolOk) return;
        const x0 = patrol.x0 as number;
        const x1 = patrol.x1 as number;
        const speed = patrol.speed as number;
        if (x0 > x1) add('warning', patrolPath, 'x0 <= x1', `x0 ${x0}, x1 ${x1}`, 'endpoints swapped');
        if (speed < 0) add('warning', `${patrolPath}.speed`, 'number >= 0', `number ${speed}`, 'using its absolute value');
        if (speed === 0) add('warning', `${patrolPath}.speed`, 'number > 0 for a patrol', 'number 0', 'hazard is static');
        if (speed !== 0 && position && (position.x < Math.min(x0, x1) || position.x > Math.max(x0, x1))) {
          add('warning', `${path}.position.x`, `a value in [${Math.min(x0, x1)}, ${Math.max(x0, x1)}]`, `number ${position.x}`, 'clamped into the patrol range');
        }
      });
    }
  }

  // --- payload (optional) ---
  if (level.payload !== undefined) {
    if (!isRecord(level.payload)) {
      add('error', 'payload', 'object { position, size }', level.payload, 'payload ignored, goals complete on touch');
    } else {
      checkUnknownKeys('payload', level.payload, PAYLOAD_KEYS);
      const position = checkVec2('payload.position', level.payload.position, 'error', 'payload ignored, goals complete on touch');
      const size = checkVec2('payload.size', level.payload.size, 'error', 'payload ignored, goals complete on touch');
      if (size && (size.x <= 0 || size.y <= 0)) {
        add('warning', 'payload.size', 'width and height > 0', `(${size.x}, ${size.y})`, 'payload can never be picked up, so the level cannot be completed');
      }
      if (position && size && !(Array.isArray(level.goals) && level.goals.length > 0)) {
        add('warning', 'payload', 'at least one goal to deliver it to', 'a payload with no goals', 'the payload has nowhere to go');
      }
    }
  }

  // --- terminals (optional) ---
  if (level.terminals !== undefined) {
    if (!Array.isArray(level.terminals)) {
      add('error', 'terminals', 'array of { position, size, disablesHazard }', level.terminals, 'terminals ignored');
    } else {
      const keptHazards = keptHazardIndex.filter((i) => i !== null).length;
      level.terminals.forEach((item: unknown, index: number) => {
        const path = `terminals[${index}]`;
        if (!isRecord(item)) {
          add('error', path, 'object { position, size, disablesHazard }', item, 'entry skipped');
          return;
        }
        checkUnknownKeys(path, item, TERMINAL_KEYS);
        checkVec2(`${path}.position`, item.position, 'error', 'entry skipped');
        const size = checkVec2(`${path}.size`, item.size, 'error', 'entry skipped');
        if (size && (size.x <= 0 || size.y <= 0)) {
          add('warning', `${path}.size`, 'width and height > 0', `(${size.x}, ${size.y})`, 'terminal can never be reached');
        }
        const target = item.disablesHazard;
        if (!(typeof target === 'number' && Number.isInteger(target) && target >= 0)) {
          add('error', `${path}.disablesHazard`, 'integer index into hazards (>= 0)', target, 'entry skipped');
        } else if (target >= keptHazards) {
          add('warning', `${path}.disablesHazard`, `an index below ${keptHazards} (the number of valid hazards)`, `number ${target}`, 'terminal disables nothing');
        } else if (keptHazardIndex.indexOf(target) !== target) {
          // Some hazards before it were dropped, so the index no longer means the array position the author sees.
          const arrayIndex = keptHazardIndex.indexOf(target);
          add('warning', `${path}.disablesHazard`, 'an index that ignores no dropped hazards', `number ${target}`, `targets hazards[${arrayIndex}] because invalid hazards before it are skipped`);
        }
      });
    }
  }

  // --- backgroundLayers (optional) ---
  if (level.backgroundLayers !== undefined) {
    if (!Array.isArray(level.backgroundLayers)) {
      add('error', 'backgroundLayers', 'array of { image, ... }', level.backgroundLayers, 'ignored, default background used');
    } else {
      if (level.backgroundLayers.length === 0) {
        add('warning', 'backgroundLayers', 'at least one layer, or omit the field', level.backgroundLayers, 'default background used');
      }
      level.backgroundLayers.forEach((layer: unknown, index: number) => {
        const path = `backgroundLayers[${index}]`;
        if (!isRecord(layer)) {
          add('error', path, 'object { image, ... }', layer, 'entry skipped');
          return;
        }
        checkUnknownKeys(path, layer, BACKGROUND_LAYER_KEYS);
        checkImage(`${path}.image`, layer.image, 'entry skipped');
        if (layer.mode !== undefined && layer.mode !== 'parallax' && layer.mode !== 'world') {
          add('warning', `${path}.mode`, 'one of: parallax, world', layer.mode, 'using "parallax"');
        }
        if (layer.mode === 'world') {
          for (const key of PARALLAX_ONLY_KEYS) {
            if (layer[key] !== undefined) {
              add('warning', `${path}.${key}`, 'only used by mode "parallax"', `${key} set on a world layer`, 'ignored');
            }
          }
          // The loader skips the layer when it cannot be placed: no explicit rectangle and no usable bounds.
          const usableBounds = bounds !== null && bounds.max.x > bounds.min.x && bounds.max.y > bounds.min.y;
          const fallbackText = usableBounds ? 'ignored, derived from level bounds' : 'layer skipped (no usable level bounds to fall back on)';
          const severity: LevelIssueSeverity = usableBounds ? 'warning' : 'error';
          if (layer.position !== undefined) {
            checkVec2(`${path}.position`, layer.position, severity, fallbackText);
          } else if (!usableBounds) {
            add('error', `${path}.position`, '{ "x": number, "y": number } (or valid level bounds to centre on)', undefined, fallbackText);
          }
          if (layer.size !== undefined) {
            const size = checkVec2(`${path}.size`, layer.size, severity, fallbackText);
            if (size && (size.x <= 0 || size.y <= 0)) {
              add(severity, `${path}.size`, 'width and height > 0', `(${size.x}, ${size.y})`, fallbackText);
            }
          } else if (!usableBounds) {
            add('error', `${path}.size`, '{ "x": number, "y": number } (or valid level bounds to fit)', undefined, fallbackText);
          }
          checkOptionalNumber(`${path}.parallaxX`, layer.parallaxX, 'ignored, using default 1 (locked to world)');
          checkOptionalNumber(`${path}.parallaxY`, layer.parallaxY, 'ignored, using default 1 (locked to world)');
          return;
        }
        for (const key of WORLD_ONLY_KEYS) {
          if (layer[key] !== undefined) {
            add('warning', `${path}.${key}`, 'only used by mode "world" (set "mode": "world")', `${key} set on a parallax layer`, 'ignored');
          }
        }
        checkOptionalNumber(`${path}.scrollFactorX`, layer.scrollFactorX, 'ignored, using default 0.4');
        const scrollY = checkOptionalNumber(`${path}.scrollFactorY`, layer.scrollFactorY, 'ignored, using default 0');
        const scale = checkOptionalNumber(`${path}.scale`, layer.scale, 'ignored, using default 1');
        checkOptionalNumber(`${path}.offsetY`, layer.offsetY, 'ignored, using default 0');
        if (scale !== undefined && scale <= 0) {
          add('warning', `${path}.scale`, 'number > 0', `number ${scale}`, 'clamped to 0.01');
        }
        if (scrollY !== undefined && scrollY !== 0 && !followY) {
          add('warning', `${path}.scrollFactorY`, 'camera.followY: true for vertical parallax to be visible', `number ${scrollY} with followY off`, 'no visible effect');
        }
      });
    }
  }

  // --- decor (optional) ---
  if (level.decor !== undefined) {
    if (!Array.isArray(level.decor)) {
      add('error', 'decor', 'array of { image, position, ... }', level.decor, 'ignored, no decor drawn');
    } else {
      level.decor.forEach((item: unknown, index: number) => {
        const path = `decor[${index}]`;
        if (!isRecord(item)) {
          add('error', path, 'object { image, position, ... }', item, 'entry skipped');
          return;
        }
        checkUnknownKeys(path, item, DECOR_KEYS);
        // Loader: `image` wins if it is a string, otherwise `texture` is used.
        const imageKey = typeof item.image === 'string' ? 'image' : (typeof item.texture === 'string' ? 'texture' : 'image');
        if (item.image === undefined && item.texture === undefined) {
          add('error', `${path}.image`, 'non-empty image path string (or "texture")', undefined, 'entry skipped');
        } else {
          checkImage(`${path}.${imageKey}`, item[imageKey], 'entry skipped');
        }
        checkVec2(`${path}.position`, item.position, 'error', 'entry skipped');
        if (item.size !== undefined) {
          checkVec2(`${path}.size`, item.size, 'warning', 'ignored, size derived from the image');
        }
        if (item.layer !== undefined && !(typeof item.layer === 'string' && DECOR_LAYERS.includes(item.layer))) {
          add('warning', `${path}.layer`, `one of: ${DECOR_LAYERS.join(', ')}`, item.layer, 'using "mid"');
        }
        for (const key of ['parallaxFactor', 'parallax', 'parallaxX', 'parallaxY', 'scrollFactorX', 'scrollFactorY']) {
          checkOptionalNumber(`${path}.${key}`, item[key], 'ignored, falling back to the next parallax setting or 1');
        }
        checkOptionalNumber(`${path}.offsetY`, item.offsetY, 'ignored, using default 0');
        if (item.uv !== undefined) {
          const uv = item.uv;
          const uvValid = Array.isArray(uv) && uv.length === 4 && uv.every(isFiniteNumber) && (uv[2] as number) > 0 && (uv[3] as number) > 0;
          if (!uvValid) {
            add('warning', `${path}.uv`, '[x, y, w, h] — 4 finite numbers with w > 0 and h > 0', Array.isArray(uv) ? `array ${JSON.stringify(uv)}` : uv, 'ignored, whole image used');
          }
        }
      });
    }
  }

  return issues;
};

/** One-line, grep-friendly rendering of an issue. */
export const formatLevelIssue = (levelLabel: string, issue: LevelIssue): string => {
  const location = issue.path || '(root)';
  return `[level ${levelLabel}] ${location}: expected ${issue.expected}, found ${issue.found} — ${issue.effect}`;
};

export type LevelIssueSummary = { errors: number; warnings: number; first: string | null };

export const summarizeLevelIssues = (levelLabel: string, issues: LevelIssue[]): LevelIssueSummary => {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.length - errors.length;
  const first = errors[0] ?? issues[0];
  return { errors: errors.length, warnings, first: first ? formatLevelIssue(levelLabel, first) : null };
};

/** Logs each issue (errors via console.error, warnings via console.warn). Silent when there are none. */
export const reportLevelIssues = (
  levelLabel: string,
  issues: LevelIssue[],
  sink: Pick<Console, 'warn' | 'error'> = console,
): void => {
  for (const issue of issues) {
    const message = formatLevelIssue(levelLabel, issue);
    if (issue.severity === 'error') sink.error(message);
    else sink.warn(message);
  }
};
