import type { BackgroundLayer, DecorItem, DecorLayers, Renderer, TextureObject } from '../gl/renderer';
import type { BackgroundLayerConfig, DecorConfig } from '../lib/levelData';

export const EMPTY_DECOR_LAYERS: DecorLayers = { distant: [], mid: [], foreground: [] };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Turns parsed background/decor configs into GPU-backed layers. Textures are cached per URL for the
 * renderer's lifetime, so switching levels or pressing R does not re-upload shared images.
 */
export const createLevelAssetLoader = (renderer: Renderer, logPrefix: () => string) => {
  const backgroundTextureCache = new Map<string, Promise<TextureObject>>();
  const decorTextureCache = new Map<string, Promise<TextureObject>>();
  const cached = (cache: Map<string, Promise<TextureObject>>, url: string, repeat: boolean): Promise<TextureObject> => {
    const existing = cache.get(url);
    if (existing) return existing;
    const request = renderer.loadTexture(url, { repeat, pixelated: false });
    cache.set(url, request);
    return request;
  };
  const loadBackgroundTexture = (url: string) => cached(backgroundTextureCache, url, true);
  const loadDecorTexture = (url: string) => cached(decorTextureCache, url, false);

  const loadBackgroundLayers = async (configs: BackgroundLayerConfig[]): Promise<BackgroundLayer[]> => Promise.all(
    configs.map(async (config): Promise<BackgroundLayer> => {
      if (config.mode === 'world') {
        // Clamp-to-edge texture: a placed pano must not wrap around its rectangle.
        const texture = await loadDecorTexture(config.image);
        const size = config.size.y > 0
          ? config.size
          : { x: config.size.x, y: config.size.x * (texture.height / texture.width) };
        return { mode: 'world', texture, position: config.position, size, parallaxX: config.parallaxX, parallaxY: config.parallaxY };
      }
      return {
        mode: 'parallax',
        texture: await loadBackgroundTexture(config.image),
        scrollFactorX: config.scrollFactorX,
        scrollFactorY: config.scrollFactorY,
        scale: config.scale,
        offsetY: config.offsetY,
      };
    })
  );

  const loadDecorLayers = async (configs: DecorConfig[]): Promise<DecorLayers> => {
    const loaded = await Promise.all(
      configs.map(async (config): Promise<DecorItem | null> => {
        try {
          const texture = await loadDecorTexture(config.image);
          const uv = config.uv ?? [0, 0, texture.width, texture.height];
          const frameCoord = { x: uv[0], y: uv[1] };
          const frameSize = { x: uv[2], y: uv[3] };
          const size = config.size ?? {
            x: clamp(frameSize.x / frameSize.y, 0.1, 10.0),
            y: 1.0,
          };
          return {
            position: config.position,
            size: {
              x: clamp(size.x, 0.1, 20.0),
              y: clamp(size.y, 0.1, 20.0),
            },
            texture,
            layer: config.layer,
            parallaxX: config.parallaxX,
            parallaxY: config.parallaxY,
            offsetY: config.offsetY,
            frameCoord,
            frameSize,
          };
        } catch (error) {
          console.warn(`${logPrefix()} Failed to load decor texture "${config.image}"`, error);
          return null;
        }
      })
    );

    const layers: DecorLayers = { distant: [], mid: [], foreground: [] };
    for (const item of loaded) {
      if (!item) continue;
      layers[item.layer].push(item);
    }
    return layers;
  };

  return { loadBackgroundLayers, loadDecorLayers };
};
