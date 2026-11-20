import type { DecorLayerName } from '../gl/renderer';
import type { Platform } from '../wasm/loader';

/**
 * Level JSON → typed level data. Lenient: anything malformed is dropped or defaulted (the validator in
 * levelValidator.ts is what reports problems). Pure, so it is unit-testable without WebGL or WASM.
 */

export const BACKGROUND_URL = './background.png';

export type JsonRecord = Record<string, unknown>;
export type Vec2 = { x: number; y: number };

export type ParallaxBackgroundConfig = {
  mode: 'parallax';
  image: string;
  scrollFactorX: number;
  scrollFactorY: number;
  scale: number;
  offsetY: number;
};

export type WorldBackgroundConfig = {
  mode: 'world';
  image: string;
  position: Vec2;
  size: Vec2;
  parallaxX: number;
  parallaxY: number;
};

export type BackgroundLayerConfig = ParallaxBackgroundConfig | WorldBackgroundConfig;

export type DecorConfig = {
  image: string;
  position: Vec2;
  size: Vec2 | null;
  layer: DecorLayerName;
  parallaxX: number;
  parallaxY: number;
  offsetY: number;
  uv: [number, number, number, number] | null;
};

export type HazardPatrol = { x0: number; x1: number; speed: number };
export type CoreHazard = Platform & { patrol?: HazardPatrol };
/** `disablesHazard` indexes the level's *valid* hazards (dropped entries do not count). */
export type CoreTerminal = Platform & { disablesHazard: number };

/**
 * The subset of a level JSON that `Game::loadLevel` reads. `decor`, `backgroundLayers` and the per-platform
 * `visual` flag are TS-only and never cross into C++. Hazards, payload and terminals cross as plain numbers too:
 * C++ never parses JSON.
 */
export type CoreLevel = {
  name?: string;
  description?: string;
  spawn?: Vec2;
  bounds?: { min: Vec2; max: Vec2 };
  camera?: { followY?: boolean; verticalDeadzone?: number; lookAheadY?: number };
  platforms: Platform[];
  goals?: Platform[];
  hazards?: CoreHazard[];
  /** Present: the goals only complete while it is carried. */
  payload?: Platform;
  terminals?: CoreTerminal[];
};

export type LevelData = {
  coreLevel: CoreLevel;
  backgroundLayers: BackgroundLayerConfig[];
  decor: DecorConfig[];
  platformVisualFlags: boolean[];
};

export const DEFAULT_BACKGROUND_LAYER: ParallaxBackgroundConfig = {
  mode: 'parallax',
  image: BACKGROUND_URL,
  scrollFactorX: 0.4,
  scrollFactorY: 0.0,
  scale: 1.0,
  offsetY: 0.0,
};

export const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const parseVec2 = (value: unknown): Vec2 | null => {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  return { x, y };
};

const parsePlatformArray = (value: unknown): Platform[] => {
  if (!Array.isArray(value)) return [];
  const parsed: Platform[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const position = parseVec2(item.position);
    const size = parseVec2(item.size);
    if (!position || !size) continue;
    parsed.push({ position, size });
  }
  return parsed;
};

const parseBox = (item: unknown): Platform | null => {
  if (!isRecord(item)) return null;
  const position = parseVec2(item.position);
  const size = parseVec2(item.size);
  return position && size ? { position, size } : null;
};

/** A patrol needs finite `x0`, `x1` and `speed`; anything less leaves the hazard static. C++ orders x0/x1 and takes |speed|. */
const parsePatrol = (value: unknown): HazardPatrol | null => {
  if (!isRecord(value)) return null;
  const { x0, x1, speed } = value;
  if (!isFiniteNumber(x0) || !isFiniteNumber(x1) || !isFiniteNumber(speed)) return null;
  return { x0, x1, speed };
};

const parseHazards = (value: unknown): CoreHazard[] => {
  if (!Array.isArray(value)) return [];
  const parsed: CoreHazard[] = [];
  for (const item of value) {
    const hazard: CoreHazard | null = parseBox(item);
    if (!hazard) continue;
    const patrol = parsePatrol((item as JsonRecord).patrol);
    if (patrol) hazard.patrol = patrol;
    parsed.push(hazard);
  }
  return parsed;
};

/** Terminals without a non-negative integer `disablesHazard` are dropped (they would do nothing). */
const parseTerminals = (value: unknown): CoreTerminal[] => {
  if (!Array.isArray(value)) return [];
  const parsed: CoreTerminal[] = [];
  for (const item of value) {
    const box = parseBox(item);
    if (!box) continue;
    const target = (item as JsonRecord).disablesHazard;
    if (!Number.isInteger(target) || (target as number) < 0) continue;
    parsed.push({ ...box, disablesHazard: target as number });
  }
  return parsed;
};

/** Level `bounds` as a rectangle, or null when absent/invalid. */
const parseBoundsRect = (level: JsonRecord): { min: Vec2; max: Vec2 } | null => {
  if (!isRecord(level.bounds)) return null;
  const min = parseVec2(level.bounds.min);
  const max = parseVec2(level.bounds.max);
  if (!min || !max || max.x <= min.x || max.y <= min.y) return null;
  return { min, max };
};

/**
 * World-mode layer. `position`/`size` are optional: a missing `size` fits the level bounds width
 * (height follows the image aspect once the texture is known, see `loadBackgroundLayers`), and a
 * missing `position` centres on the bounds. Returns null (layer skipped) when it cannot be placed.
 */
const parseWorldBackground = (layer: JsonRecord, image: string, level: JsonRecord): WorldBackgroundConfig | null => {
  const bounds = parseBoundsRect(level);
  const explicitSize = parseVec2(layer.size);
  const explicitPosition = parseVec2(layer.position);
  const size = explicitSize && explicitSize.x > 0 && explicitSize.y > 0
    ? explicitSize
    : (bounds ? { x: bounds.max.x - bounds.min.x, y: 0 } : null); // y = 0 -> derive from image aspect
  const position = explicitPosition ?? (bounds
    ? { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 }
    : null);
  if (!size || !position) return null;
  const parallaxX = isFiniteNumber(layer.parallaxX) ? layer.parallaxX : 1.0;
  const parallaxY = isFiniteNumber(layer.parallaxY) ? layer.parallaxY : 1.0;
  return { mode: 'world', image, position, size, parallaxX, parallaxY };
};

export const extractBackgroundLayerConfigs = (level: unknown): BackgroundLayerConfig[] => {
  if (!isRecord(level) || !Array.isArray(level.backgroundLayers)) {
    return [DEFAULT_BACKGROUND_LAYER];
  }

  const parsed: BackgroundLayerConfig[] = [];
  for (const layer of level.backgroundLayers) {
    if (!isRecord(layer)) continue;
    const image = typeof layer.image === 'string' ? layer.image.trim() : '';
    if (!image) continue;

    if (layer.mode === 'world') {
      const world = parseWorldBackground(layer, image, level);
      if (world) parsed.push(world);
      continue;
    }

    parsed.push({
      mode: 'parallax',
      image,
      scrollFactorX: isFiniteNumber(layer.scrollFactorX) ? layer.scrollFactorX : DEFAULT_BACKGROUND_LAYER.scrollFactorX,
      scrollFactorY: isFiniteNumber(layer.scrollFactorY) ? layer.scrollFactorY : DEFAULT_BACKGROUND_LAYER.scrollFactorY,
      scale: Math.max(0.01, isFiniteNumber(layer.scale) ? layer.scale : DEFAULT_BACKGROUND_LAYER.scale),
      offsetY: isFiniteNumber(layer.offsetY) ? layer.offsetY : DEFAULT_BACKGROUND_LAYER.offsetY,
    });
  }

  return parsed.length > 0 ? parsed : [DEFAULT_BACKGROUND_LAYER];
};

const parseDecorLayer = (value: unknown): DecorLayerName => {
  if (value === 'distant' || value === 'far') return 'distant';
  if (value === 'foreground' || value === 'front') return 'foreground';
  return 'mid';
};

const parseDecorUV = (value: unknown): [number, number, number, number] | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [u, v, w, h] = value;
  if (!isFiniteNumber(u) || !isFiniteNumber(v) || !isFiniteNumber(w) || !isFiniteNumber(h)) return null;
  if (w <= 0 || h <= 0) return null;
  return [u, v, w, h];
};

export const extractDecorConfigs = (level: unknown): DecorConfig[] => {
  if (!isRecord(level) || !Array.isArray(level.decor)) return [];
  const parsed: DecorConfig[] = [];
  for (const item of level.decor) {
    if (!isRecord(item)) continue;
    const position = parseVec2(item.position);
    if (!position) continue;
    const imageValue = typeof item.image === 'string' ? item.image : (typeof item.texture === 'string' ? item.texture : '');
    const image = imageValue.trim();
    if (!image) continue;
    const size = parseVec2(item.size);
    const parallaxScalar = isFiniteNumber(item.parallaxFactor)
      ? item.parallaxFactor
      : (isFiniteNumber(item.parallax) ? item.parallax : 1.0);
    const parallaxX = isFiniteNumber(item.parallaxX)
      ? item.parallaxX
      : (isFiniteNumber(item.scrollFactorX) ? item.scrollFactorX : parallaxScalar);
    const parallaxY = isFiniteNumber(item.parallaxY)
      ? item.parallaxY
      : (isFiniteNumber(item.scrollFactorY) ? item.scrollFactorY : parallaxScalar);
    parsed.push({
      image,
      position,
      size,
      layer: parseDecorLayer(item.layer),
      parallaxX,
      parallaxY,
      offsetY: isFiniteNumber(item.offsetY) ? item.offsetY : 0.0,
      uv: parseDecorUV(item.uv),
    });
  }
  return parsed;
};

export const normalizeLevelData = (level: unknown): LevelData => {
  const fallbackPlatforms = [
    { position: { x: -12.25, y: -2.0 }, size: { x: 110.0, y: 0.2 } },
    { position: { x: 0.0, y: -0.8 }, size: { x: 2.0, y: 0.2 } },
    { position: { x: 2.0, y: -0.6 }, size: { x: 1.0, y: 0.2 } },
    { position: { x: 4.0, y: -0.4 }, size: { x: 1.0, y: 0.2 } },
    { position: { x: 6.0, y: -0.2 }, size: { x: 1.5, y: 0.2 } },
    { position: { x: 8.0, y: 0.2 }, size: { x: 1.0, y: 0.2 } },
    { position: { x: 10.0, y: 0.6 }, size: { x: 1.0, y: 0.2 } },
  ];

  if (!isRecord(level)) {
    return {
      coreLevel: { platforms: fallbackPlatforms },
      backgroundLayers: [DEFAULT_BACKGROUND_LAYER],
      decor: [],
      platformVisualFlags: fallbackPlatforms.map(() => true),
    };
  }

  const coreLevel: CoreLevel = { platforms: [] };
  if (typeof level.name === 'string') coreLevel.name = level.name;
  if (typeof level.description === 'string') coreLevel.description = level.description;
  const spawn = parseVec2(level.spawn);
  if (spawn) coreLevel.spawn = spawn;
  const bounds = isRecord(level.bounds) ? level.bounds : null;
  if (bounds) {
    const min = parseVec2(bounds.min);
    const max = parseVec2(bounds.max);
    if (min && max) coreLevel.bounds = { min, max };
  }
  const camera = isRecord(level.camera) ? level.camera : null;
  if (camera) {
    const cameraOut: NonNullable<CoreLevel['camera']> = {};
    if (isBoolean(camera.followY)) cameraOut.followY = camera.followY;
    if (isFiniteNumber(camera.verticalDeadzone)) cameraOut.verticalDeadzone = camera.verticalDeadzone;
    if (isFiniteNumber(camera.lookAheadY)) cameraOut.lookAheadY = camera.lookAheadY;
    if (Object.keys(cameraOut).length > 0) coreLevel.camera = cameraOut;
  }

  const sourcePlatforms = Array.isArray(level.platforms) ? level.platforms : [];
  const parsedPlatforms: Platform[] = [];
  const platformVisualFlags: boolean[] = [];
  for (const item of sourcePlatforms) {
    if (!isRecord(item)) continue;
    const position = parseVec2(item.position);
    const size = parseVec2(item.size);
    if (!position || !size) continue;
    parsedPlatforms.push({ position, size });
    platformVisualFlags.push(isBoolean(item.visual) ? item.visual : true);
  }
  const platforms = parsedPlatforms.length > 0 ? parsedPlatforms : fallbackPlatforms;
  coreLevel.platforms = platforms;

  const goals = parsePlatformArray(level.goals);
  if (goals.length > 0) coreLevel.goals = goals;
  const hazards = parseHazards(level.hazards);
  if (hazards.length > 0) coreLevel.hazards = hazards;
  const payload = parseBox(level.payload);
  if (payload) coreLevel.payload = payload;
  const terminals = parseTerminals(level.terminals);
  if (terminals.length > 0) coreLevel.terminals = terminals;

  return {
    coreLevel,
    backgroundLayers: extractBackgroundLayerConfigs(level),
    decor: extractDecorConfigs(level),
    platformVisualFlags: parsedPlatforms.length > 0 ? platformVisualFlags : fallbackPlatforms.map(() => true),
  };
};
