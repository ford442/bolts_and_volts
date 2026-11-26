import type { Vec2, Platform } from '../wasm/loader';
import { AnimState, type FlagBox, type ParticleView, type PlayerAnimation } from '../game/snapshot';
import { VIEW_WORLD_WIDTH, gridLineIndices, type AuthoringOverlay } from '../lib/authoring';
import type { CanvasSize } from '../lib/canvasSize';
import { INSTANCE_BYTES, SpriteBatch, newSpriteInstance, type SpriteInstance } from './spriteBatch';
import {
  CULL_DEBUG_INSET,
  CULL_MARGIN,
  boxOverlapsRect,
  emptyCullStats,
  insetRect,
  visibleRect,
  type CullStats,
  type Rect,
} from '../lib/culling';

/** Opacity applied to the player and particles while level-authoring mode is on. */
const AUTHORING_DIM_ALPHA = 0.3;

/**
 * Sprite tint: an RGB multiplier applied after the texture sample, with `desaturate` (0..1) first fading the sample
 * toward its own brightness (0 keeps its hue, 1 colours its light and dark with the RGB alone). `NO_TINT` leaves a
 * sprite untouched.
 */
export type Tint = readonly [r: number, g: number, b: number, desaturate: number];
export const NO_TINT: Tint = [1, 1, 1, 0];

/** Courier entities from the frame snapshot. The arrays are the snapshot's own (refilled in place every frame). */
export type SceneEntities = {
  /** `flag`: enabled. */
  hazards: FlagBox[];
  /** Zero or one entry; `flag`: carried. */
  payloads: FlagBox[];
  /** `flag`: used. */
  terminals: FlagBox[];
};
export const NO_ENTITIES: SceneEntities = { hazards: [], payloads: [], terminals: [] };

export type TextureObject = {
  texture: WebGLTexture;
  width: number;
  height: number;
};

export type TextureLoadOptions = {
  repeat?: boolean;
  pixelated?: boolean;
};

/** Full-screen camera-parallax quad (the original background layer kind). */
export type ParallaxBackgroundLayer = {
  mode: 'parallax';
  texture: TextureObject;
  scrollFactorX: number;
  scrollFactorY: number;
  scale: number;
  offsetY: number;
};

/**
 * A painted image placed at a fixed rectangle in world space, so platforms can be authored
 * against it. `parallaxX/Y` of 1 keep it locked to the world; smaller values let it drift
 * slowly while staying aligned whenever the camera is at the image's centre.
 */
export type WorldBackgroundLayer = {
  mode: 'world';
  texture: TextureObject;
  /** Centre of the image, world units. */
  position: Vec2;
  /** Full width/height, world units. */
  size: Vec2;
  parallaxX: number;
  parallaxY: number;
};

export type BackgroundLayer = ParallaxBackgroundLayer | WorldBackgroundLayer;

export type DecorLayerName = 'distant' | 'mid' | 'foreground';

export type DecorItem = {
  position: Vec2;
  size: Vec2;
  texture: TextureObject;
  layer: DecorLayerName;
  parallaxX: number;
  parallaxY: number;
  offsetY: number;
  frameCoord: Vec2;
  frameSize: Vec2;
};

export type DecorLayers = {
  distant: DecorItem[];
  mid: DecorItem[];
  foreground: DecorItem[];
};

/**
 * Opaque 2D game view: no alpha channel to composite with the page, no MSAA (sprites are NEAREST-filtered
 * pixel art), no depth/stencil (nothing uses them). `premultipliedAlpha` and `preserveDrawingBuffer` are
 * spelled out at their defaults on purpose; `failIfMajorPerformanceCaveat: false` keeps software GL booting.
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
};

/**
 * Low-latency presentation is a hint some browsers reject. `getContext` may reject it by returning null or by throwing,
 * so both lead to exactly one retry without it. (A throw from the retry propagates: there is no third option.)
 */
function createWebGL2Context(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    const context = canvas.getContext('webgl2', { ...CONTEXT_ATTRIBUTES, desynchronized: true });
    if (context) return context;
  } catch {
    // fall through to the retry
  }
  return canvas.getContext('webgl2', { ...CONTEXT_ATTRIBUTES, desynchronized: false });
}

const animationMap = {
  idle: { row: 0, frames: 2, frameSize: { x: 64, y: 64 } },
  run: { row: 1, frames: 4, frameSize: { x: 64, y: 64 } },
  jump: { row: 2, frames: 1, frameSize: { x: 64, y: 64 } },
};

/** Spritesheet row for a simulation `AnimState`. Fall reuses the jump row until it gets its own art. */
const animationForState = (state: number) => {
  switch (state) {
    case AnimState.Run: return animationMap.run;
    case AnimState.Jump:
    case AnimState.Fall: return animationMap.jump;
    default: return animationMap.idle;
  }
};

/** What `onContextChange` listeners hear. While lost, every GL call is a no-op: callers should stop drawing. */
export type ContextStatus = 'lost' | 'restored';

/** Draw-call counters from the most recent `drawScene` (all programs). */
export type DrawStats = { drawCalls: number; instances: number };

/** Everything needed to upload a texture again after a context loss, keyed by the `TextureObject` callers hold. */
type TextureSource =
  | { kind: 'image'; image: HTMLImageElement; repeat: boolean; pixelated: boolean }
  | { kind: 'solid'; color: Uint8Array };

// Fixed attribute slots, matching the `layout(location = N)` qualifiers in tex.vert.glsl.
const SPRITE_POSITION_LOCATION = 0;
const SPRITE_TEXCOORD_LOCATION = 1;
const SPRITE_INSTANCE_FIRST_LOCATION = 2; // a_model, a_frame, a_sheet, a_tint: four vec4s
const SPRITE_INSTANCE_VEC4S = 4;

export class Renderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private shaderSources: { spriteVs: string; spriteFs: string; bgVs: string; bgFs: string };
  // Everything below that holds a GL object is (re)created by `initGL`, once at construction and again on restore.
  private spriteProgram!: WebGLProgram;
  private spriteCameraPositionUniformLocation: WebGLUniformLocation | null = null;
  private spriteProjectionMatrixUniformLocation: WebGLUniformLocation | null = null;
  private backgroundProgram!: WebGLProgram;
  private backgroundPositionAttributeLocation = -1;
  private backgroundCameraPositionUniformLocation: WebGLUniformLocation | null = null;
  private backgroundTextureSizeUniformLocation: WebGLUniformLocation | null = null;
  private backgroundResolutionUniformLocation: WebGLUniformLocation | null = null;
  private backgroundScrollFactorUniformLocation: WebGLUniformLocation | null = null;
  private backgroundScaleUniformLocation: WebGLUniformLocation | null = null;
  private backgroundOffsetYUniformLocation: WebGLUniformLocation | null = null;
  private spriteVao: WebGLVertexArrayObject | null = null;
  private backgroundVao: WebGLVertexArrayObject | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private instanceBufferBytes = 0;
  // Every texture this renderer made, with what it was made from, so a restore can upload each one again in place:
  // callers (level assets, the loader's per-URL cache) keep their `TextureObject`s and never notice.
  private textureSources = new Map<TextureObject, TextureSource>();
  // Per-texture foot anchors: anchors.get(texture) -> array[row][frame] = offsetPx. Computed from image pixels, so it
  // survives a context loss unchanged.
  private anchors = new Map<TextureObject, number[][]>();
  private debugRedTexture: TextureObject;
  private debugGreenTexture: TextureObject;
  private whiteTexture: TextureObject;
  private debugCyanTexture: TextureObject; // goal visualization (playability win)
  // First art for the courier entities: flat tinted quads (one 1x1 texture per state).
  private entityTextures: {
    hazard: TextureObject;
    hazardOff: TextureObject;
    payload: TextureObject;
    terminal: TextureObject;
    terminalUsed: TextureObject;
  };
  // World-space view and the sprite projection, rebuilt on resize (never per sprite).
  private view = { worldWidth: VIEW_WORLD_WIDTH, worldHeight: VIEW_WORLD_WIDTH };
  private projection = new Float32Array(16);
  // Backing-store pixels per CSS pixel; lets authoring lines keep a constant on-screen thickness at any DPR.
  private pixelRatio = 1;
  // Red player / green platform collision boxes. Off for normal play; a debug toggle can flip it via setCollisionDebug.
  private collisionDebug = false;
  // Draw counters from the most recent drawScene call (render-only visible-rect culling).
  private cullStats: CullStats = emptyCullStats();
  private drawStats: DrawStats = { drawCalls: 0, instances: 0 };
  // Sprites for the current frame, in paint order. `flush` turns each texture run into one instanced draw.
  private batch = new SpriteBatch<TextureObject>();
  // Reused for every push; the batch copies its numbers.
  private sprite: SpriteInstance = newSpriteInstance();
  // Set from inside drawScene: the camera the batch's positions are relative to.
  private camera: Vec2 = { x: 0, y: 0 };
  private platformVisible: boolean[] = [];
  // Level-authoring overlay colours (grid, platform outlines, snap marker).
  private authoringTextures: {
    gridMinor: TextureObject;
    gridMajor: TextureObject;
    gridAxis: TextureObject;
    outline: TextureObject;
    halo: TextureObject;
    snap: TextureObject;
  };
  private contextLost = false;
  private contextListeners = new Set<(status: ContextStatus) => void>();
  private restoreWaiters: Array<() => void> = [];
  private readonly handleContextLost = (event: Event) => {
    // Without preventDefault the browser never fires webglcontextrestored.
    event.preventDefault();
    this.contextLost = true;
    this.instanceBufferBytes = 0;
    this.emitContextChange('lost');
  };
  private readonly handleContextRestored = () => {
    try {
      this.restore();
    } catch (error) {
      // Stay "lost": the loop stays paused rather than drawing into half-built state.
      console.error('Failed to rebuild WebGL state after a context restore:', error);
    }
  };

  constructor(canvas: HTMLCanvasElement, spriteVsSource: string, spriteFsSource: string, bgVsSource: string, bgFsSource: string) {
    const context = createWebGL2Context(canvas);
    if (!context) throw new Error('WebGL2 is not supported.');
    this.gl = context;
    this.canvas = canvas;
    this.shaderSources = { spriteVs: spriteVsSource, spriteFs: spriteFsSource, bgVs: bgVsSource, bgFs: bgFsSource };
    this.initGL();
    this.debugRedTexture = this.createSolidTexture([255, 0, 0, 128]);
    this.debugGreenTexture = this.createSolidTexture([0, 255, 0, 128]);
    this.whiteTexture = this.createSolidTexture([255, 255, 255, 255]);
    this.debugCyanTexture = this.createSolidTexture([0, 255, 255, 170]); // cyan goals (visible target)
    this.entityTextures = {
      hazard: this.createSolidTexture([255, 70, 40, 230]),
      hazardOff: this.createSolidTexture([150, 150, 150, 80]),
      payload: this.createSolidTexture([215, 155, 70, 255]),
      terminal: this.createSolidTexture([70, 235, 120, 230]),
      terminalUsed: this.createSolidTexture([60, 120, 90, 140]),
    };
    this.authoringTextures = {
      gridMinor: this.createSolidTexture([255, 255, 255, 70]),
      gridMajor: this.createSolidTexture([255, 255, 255, 150]),
      gridAxis: this.createSolidTexture([255, 140, 0, 220]),
      outline: this.createSolidTexture([255, 235, 0, 255]),
      halo: this.createSolidTexture([0, 0, 0, 230]),
      snap: this.createSolidTexture([255, 0, 220, 255]),
    };
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  /**
   * Every GL object and every piece of one-time state, built from scratch. Runs at construction and again after a
   * context restore (a restored context starts empty, like a new one). Textures are not here: see `restore`.
   */
  private initGL() {
    const gl = this.gl;
    // Pipeline state that never changes, set once instead of per draw call.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // odd-width PNG uploads
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    const { spriteVs, spriteFs, bgVs, bgFs } = this.shaderSources;
    this.spriteProgram = this.createProgram(this.compileShader(gl.VERTEX_SHADER, spriteVs), this.compileShader(gl.FRAGMENT_SHADER, spriteFs));
    this.spriteCameraPositionUniformLocation = gl.getUniformLocation(this.spriteProgram, 'u_camera_position');
    this.spriteProjectionMatrixUniformLocation = gl.getUniformLocation(this.spriteProgram, 'u_projection');
    this.backgroundProgram = this.createProgram(this.compileShader(gl.VERTEX_SHADER, bgVs), this.compileShader(gl.FRAGMENT_SHADER, bgFs));
    this.backgroundPositionAttributeLocation = gl.getAttribLocation(this.backgroundProgram, 'a_position');
    this.backgroundCameraPositionUniformLocation = gl.getUniformLocation(this.backgroundProgram, 'u_camera_position');
    this.backgroundTextureSizeUniformLocation = gl.getUniformLocation(this.backgroundProgram, 'u_texture_size');
    this.backgroundResolutionUniformLocation = gl.getUniformLocation(this.backgroundProgram, 'u_resolution');
    this.backgroundScrollFactorUniformLocation = gl.getUniformLocation(this.backgroundProgram, 'u_scroll_factor');
    this.backgroundScaleUniformLocation = gl.getUniformLocation(this.backgroundProgram, 'u_scale');
    this.backgroundOffsetYUniformLocation = gl.getUniformLocation(this.backgroundProgram, 'u_offset_y');
    this.setupGeometry();
    // Both programs sample unit 0 only.
    gl.useProgram(this.backgroundProgram);
    gl.uniform1i(gl.getUniformLocation(this.backgroundProgram, 'u_texture'), 0);
    this.useSpriteProgram();
    gl.uniform1i(gl.getUniformLocation(this.spriteProgram, 'u_texture'), 0);
    this.updateViewport();
  }

  /** True between `webglcontextlost` and a successful rebuild. Drawing while lost does nothing. */
  public isContextLost(): boolean {
    return this.contextLost;
  }

  /** Hear about context loss and restore (the game loop pauses on `lost`). Returns an unsubscribe function. */
  public onContextChange(listener: (status: ContextStatus) => void): () => void {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  private emitContextChange(status: ContextStatus) {
    for (const listener of [...this.contextListeners]) listener(status);
  }

  /**
   * Rebuild after `webglcontextrestored`: programs, VAOs, buffers and one-time state (`initGL`), then every texture
   * uploaded again into the same `TextureObject`. Public so it can be exercised without a real GPU reset; it is the
   * same class of rebuild as a resize clearing the drawing buffer, not a new renderer.
   */
  public restore() {
    this.initGL();
    for (const [textureObj, source] of this.textureSources) textureObj.texture = this.uploadTexture(source);
    this.contextLost = false;
    const waiters = this.restoreWaiters;
    this.restoreWaiters = [];
    for (const resolve of waiters) resolve();
    this.emitContextChange('restored');
  }

  /** Detach the context-loss listeners (the GL objects go with the context). */
  public dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.contextListeners.clear();
  }

  /**
   * Match the drawing buffer to the canvas's on-screen size (see `observeCanvasSize`). Assigning
   * `canvas.width/height` clears the buffer even when the value is unchanged, so only touch it on a real change.
   */
  public resize(size: CanvasSize) {
    const canvas = this.canvas;
    if (canvas.width === size.width && canvas.height === size.height && this.pixelRatio === size.pixelRatio) return;
    canvas.width = size.width;
    canvas.height = size.height;
    this.pixelRatio = size.pixelRatio;
    this.updateViewport();
  }

  private updateViewport() {
    const { width, height } = this.canvas;
    this.gl.viewport(0, 0, width, height);
    // World policy: VIEW_WORLD_WIDTH units across the backing-store width, height follows the aspect (no letterboxing).
    const worldWidth = VIEW_WORLD_WIDTH;
    const worldHeight = worldWidth / (width / height);
    this.view = { worldWidth, worldHeight };
    this.projection.set([2.0 / worldWidth, 0, 0, 0, 0, 2.0 / worldHeight, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
    // Uniforms persist per program, so uploading here covers every later draw.
    this.useSpriteProgram();
    this.gl.uniformMatrix4fv(this.spriteProjectionMatrixUniformLocation, false, this.projection);
  }

  /** Show or hide the red player / green platform collision boxes (off by default). */
  public setCollisionDebug(enabled: boolean) {
    this.collisionDebug = enabled;
  }

  /** The sprite VAO must be bound whenever sprites are drawn, so the two always switch together. */
  private useSpriteProgram() {
    this.gl.useProgram(this.spriteProgram);
    this.gl.bindVertexArray(this.spriteVao);
  }

  private useBackgroundProgram() {
    this.gl.useProgram(this.backgroundProgram);
    this.gl.bindVertexArray(this.backgroundVao);
  }

  /** World units covered by one CSS pixel, for overlay lines that should keep a constant on-screen thickness. */
  private worldUnitsPerCssPixel(): number {
    return (this.view.worldWidth / this.canvas.width) * this.pixelRatio;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type)!;
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile error: ${this.gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  private createProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
    const program = this.gl.createProgram()!;
    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${this.gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  /** Create a GL texture from a recorded source (also how a restore brings each texture back). */
  private uploadTexture(source: TextureSource): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (source.kind === 'solid') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.color);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return texture;
    }
    const wrap = source.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (source.pixelated) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    return texture;
  }

  private untilRestored(): Promise<void> {
    return new Promise((resolve) => this.restoreWaiters.push(resolve));
  }

  public async loadTexture(url: string, options: TextureLoadOptions = {}): Promise<TextureObject> {
    const { repeat = false, pixelated = true } = options;
    const image = new Image();
    image.src = url;
    await image.decode(); // Wait for the image to load
    // A lost context cannot create textures; finish the upload once it is back.
    if (this.contextLost) await this.untilRestored();
    const source: TextureSource = { kind: 'image', image, repeat, pixelated };
    const textureObj: TextureObject = { texture: this.uploadTexture(source), width: image.width, height: image.height };
    this.textureSources.set(textureObj, source);

    // If the image looks like the player spritesheet (matches frame sizes in animationMap), compute per-frame bottommost alpha to anchor feet
    try {
      // create an offscreen canvas to inspect pixels
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        const anchorsForTexture: number[][] = [];
        // attempt to compute anchors for each row/frame described in animationMap
        for (const anim of Object.values(animationMap)) {
          const frameW = anim.frameSize.x;
          const frameH = anim.frameSize.y;
          const row = anim.row;
          const frames = anim.frames;
          // ensure frame area fits in the image
          if ((row + 1) * frameH <= image.height && frames * frameW <= image.width) {
            // ensure anchorsForTexture has enough rows
            if (!anchorsForTexture[row]) anchorsForTexture[row] = [];
            for (let f = 0; f < frames; ++f) {
              const sx = f * frameW;
              const sy = row * frameH;
              const imgData = ctx.getImageData(sx, sy, frameW, frameH).data;
              let bottommost = -1; // y index (0..frameH-1) of bottommost non-transparent pixel
              for (let y = frameH - 1; y >= 0; --y) {
                let rowHasOpaque = false;
                for (let x = 0; x < frameW; ++x) {
                  const idx = (y * frameW + x) * 4;
                  const alpha = imgData[idx + 3];
                  if (alpha > 10) { rowHasOpaque = true; break; }
                }
                if (rowHasOpaque) { bottommost = y; break; }
              }
              if (bottommost === -1) {
                // fully transparent frame; assume bottommost at bottom
                anchorsForTexture[row][f] = 0;
              } else {
                const offsetPx = (frameH - 1) - bottommost; // pixels between bottommost opaque and bottom
                anchorsForTexture[row][f] = offsetPx;
              }
            }
          }
        }
        // store anchors if any found
        let hasAny = false;
        for (const r in anchorsForTexture) if (anchorsForTexture[r] && anchorsForTexture[r].length) { hasAny = true; break; }
        if (hasAny) this.anchors.set(textureObj, anchorsForTexture);
      }
    } catch (err) {
      // non-fatal: if pixel inspection fails, we simply don't set anchors
      console.warn('Failed to compute texture anchors for', url, err);
    }

    return textureObj;
  }

  private setupGeometry() {
    const gl = this.gl;
    const positions = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5]);
    const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);
    const fullScreenPositions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const staticBuffer = (data: Float32Array) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return buffer;
    };
    const unitSquarePositionBuffer = staticBuffer(positions);
    const unitSquareTexCoordBuffer = staticBuffer(texCoords);
    const fullScreenQuadBuffer = staticBuffer(fullScreenPositions);
    this.instanceBuffer = gl.createBuffer();
    this.instanceBufferBytes = 0;

    // One VAO per quad kind records the attribute wiring once; drawing then only binds it with its program.
    this.spriteVao = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVao);
    this.bindQuadAttribute(SPRITE_POSITION_LOCATION, unitSquarePositionBuffer);
    this.bindQuadAttribute(SPRITE_TEXCOORD_LOCATION, unitSquareTexCoordBuffer);
    // Per-instance vec4s. Their pointers are set per texture range in `flush` (WebGL2 has no base-instance draw).
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let i = 0; i < SPRITE_INSTANCE_VEC4S; i++) {
      const location = SPRITE_INSTANCE_FIRST_LOCATION + i;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, INSTANCE_BYTES, i * 16);
      gl.vertexAttribDivisor(location, 1);
    }
    this.backgroundVao = gl.createVertexArray();
    gl.bindVertexArray(this.backgroundVao);
    this.bindQuadAttribute(this.backgroundPositionAttributeLocation, fullScreenQuadBuffer);
    gl.bindVertexArray(null);
  }

  private bindQuadAttribute(location: number, buffer: WebGLBuffer | null) {
    if (location < 0) return; // attribute optimised out of the shader
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribPointer(location, 2, this.gl.FLOAT, false, 0, 0);
  }

  /**
   * Draw everything batched so far: one buffer upload, then one `drawArraysInstanced` per run of same-texture sprites
   * (in paint order). Called whenever the background program has to draw in between, and at the end of the frame.
   */
  private flush() {
    const batch = this.batch;
    if (batch.count === 0) return;
    const gl = this.gl;
    this.useSpriteProgram();
    gl.uniform2f(this.spriteCameraPositionUniformLocation, this.camera.x, this.camera.y);
    const data = batch.instanceData();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (data.byteLength > this.instanceBufferBytes) {
      // Grow with headroom so a level with a few more sprites next frame does not reallocate again.
      this.instanceBufferBytes = Math.max(data.byteLength * 2, INSTANCE_BYTES * 256);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceBufferBytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    for (const range of batch.ranges) {
      const base = range.first * INSTANCE_BYTES;
      for (let i = 0; i < SPRITE_INSTANCE_VEC4S; i++) {
        gl.vertexAttribPointer(SPRITE_INSTANCE_FIRST_LOCATION + i, 4, gl.FLOAT, false, INSTANCE_BYTES, base + i * 16);
      }
      gl.bindTexture(gl.TEXTURE_2D, range.texture.texture);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, range.count);
      this.drawStats.drawCalls++;
    }
    this.drawStats.instances += batch.count;
    batch.reset();
  }

  /**
   * Fill the shared scratch sprite: an untinted, unflipped, fully opaque full-texture quad at `x, y`. Callers then
   * override what differs (frame, flip, alpha, tint) and push it.
   */
  private spriteAt(x: number, y: number, w: number, h: number, texture: TextureObject): SpriteInstance {
    const s = this.sprite;
    s.x = x; s.y = y; s.w = w; s.h = h;
    s.frameX = 0; s.frameY = 0; s.frameW = texture.width; s.frameH = texture.height;
    s.sheetW = texture.width; s.sheetH = texture.height;
    s.flip = false;
    s.alpha = 1;
    s.tintR = 1; s.tintG = 1; s.tintB = 1; s.tintDesaturate = 0;
    return s;
  }

  /**
   * Drawn centre Y for a sprite whose feet should meet its collision box: shifts down by the frame's precomputed
   * transparent bottom rows (or a 64x64-frame heuristic when the texture has none), then by `visualYOffset`.
   */
  private anchoredY(textureObj: TextureObject, y: number, height: number, frameCoord: Vec2, frameSize: Vec2, visualYOffset: number): number {
    let modelPosY = y;
    const anchorsForTex = this.anchors.get(textureObj);
    if (anchorsForTex) {
      const frameIndex = Math.round(frameCoord.x / (frameSize.x || 1));
      const rowIndex = Math.round(frameCoord.y / (frameSize.y || 1));
      if (anchorsForTex[rowIndex] && anchorsForTex[rowIndex][frameIndex] !== undefined) {
        const offsetPx = anchorsForTex[rowIndex][frameIndex];
        modelPosY = y - (offsetPx / frameSize.y) * height; // shift sprite down so foot aligns with collision bottom
      }
    } else if (frameSize.y === 64 && frameSize.x === 64) {
      // Fallback for our 64x64 player sheet without anchors: lower the sprite by a fraction of its height.
      modelPosY = y - height * 0.25;
    }
    // positive visualYOffset moves the sprite down
    return modelPosY - visualYOffset;
  }

  /** Solid 1x1 quad (entities, goals, particles, debug boxes, overlay lines), culled against `rect` when given. */
  private pushBox(position: Vec2, size: Vec2, texture: TextureObject, alpha: number, rect: Rect | null): boolean {
    const s = this.spriteAt(position.x, position.y, size.x, size.y, texture);
    s.alpha = alpha;
    if (rect) return this.batch.pushIfVisible(texture, s, rect);
    this.batch.push(texture, s);
    return true;
  }

  private drawWorldBackgroundLayer(cameraPosition: Vec2, layer: WorldBackgroundLayer) {
    // Parallax pivots on the image centre: effective camera = centre + (camera - centre) * factor.
    // factor 1 is identical to the world camera; the image is exactly aligned when the camera sits at its centre.
    const effectiveCamera = {
      x: layer.position.x + (cameraPosition.x - layer.position.x) * layer.parallaxX,
      y: layer.position.y + (cameraPosition.y - layer.position.y) * layer.parallaxY,
    };
    const { worldWidth, worldHeight } = this.view;
    // Cheap cull: skip the draw when the image rectangle is entirely off screen.
    const dx = Math.abs(layer.position.x - effectiveCamera.x);
    const dy = Math.abs(layer.position.y - effectiveCamera.y);
    if (dx > (layer.size.x + worldWidth) / 2 || dy > (layer.size.y + worldHeight) / 2) return;
    // The whole batch shares one camera uniform, so move the quad by (camera - effective camera) instead.
    const s = this.spriteAt(
      layer.position.x + cameraPosition.x - effectiveCamera.x,
      layer.position.y + cameraPosition.y - effectiveCamera.y,
      layer.size.x, layer.size.y, layer.texture,
    );
    this.batch.push(layer.texture, s);
  }

  private drawBackgroundLayer(cameraPosition: Vec2, layer: BackgroundLayer) {
    if (layer.mode === 'world') {
      this.drawWorldBackgroundLayer(cameraPosition, layer);
      return;
    }
    // Paint order: sprites batched before this layer must land first.
    this.flush();
    this.useBackgroundProgram();
    this.gl.bindTexture(this.gl.TEXTURE_2D, layer.texture.texture);
    this.gl.uniform2f(this.backgroundCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    this.gl.uniform2f(this.backgroundTextureSizeUniformLocation, layer.texture.width, layer.texture.height);
    this.gl.uniform2f(this.backgroundResolutionUniformLocation, this.canvas.width, this.canvas.height);
    this.gl.uniform2f(this.backgroundScrollFactorUniformLocation, layer.scrollFactorX, layer.scrollFactorY);
    this.gl.uniform1f(this.backgroundScaleUniformLocation, layer.scale);
    this.gl.uniform1f(this.backgroundOffsetYUniformLocation, layer.offsetY);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.drawStats.drawCalls++;
  }

  private drawDecorItems(cameraPosition: Vec2, decorItems: DecorItem[], cullRect: Rect) {
    for (const item of decorItems) {
      this.cullStats.decor.total++;
      // Decor is drawn against a parallax-scaled camera and nudged down by offsetY. With one camera uniform for the
      // whole batch, the quad moves by (camera - camera * parallax) instead, which also makes the plain view rect the
      // right cull rect for it (the same test as `parallaxRect` around the scaled camera).
      const s = this.spriteAt(
        item.position.x + cameraPosition.x * (1 - item.parallaxX),
        item.position.y - item.offsetY + cameraPosition.y * (1 - item.parallaxY),
        item.size.x, item.size.y, item.texture,
      );
      s.frameX = item.frameCoord.x; s.frameY = item.frameCoord.y;
      s.frameW = item.frameSize.x; s.frameH = item.frameSize.y;
      if (this.batch.pushIfVisible(item.texture, s, cullRect)) this.cullStats.decor.drawn++;
    }
  }

  private createSolidTexture(color: [number, number, number, number]): TextureObject {
    const source: TextureSource = { kind: 'solid', color: new Uint8Array(color) };
    const textureObj: TextureObject = { texture: this.uploadTexture(source), width: 1, height: 1 };
    this.textureSources.set(textureObj, source);
    return textureObj;
  }

  public drawScene(
    cameraPosition: Vec2,
    playerPosition: Vec2,
    playerSize: Vec2,
    platforms: Platform[],
    particles: ParticleView[],
    playerTexture: TextureObject | null,
    platformTexture: TextureObject | null,
    backgroundLayers: BackgroundLayer[] = [],
    decorLayers: DecorLayers = { distant: [], mid: [], foreground: [] },
    platformVisualFlags: boolean[] = [],
    playerAnim: PlayerAnimation | null,
    goals: Platform[] = [],
    playerTint: Tint = NO_TINT,
    authoring: AuthoringOverlay | null = null,
    cullDebug: boolean = false,
    entities: SceneEntities = NO_ENTITIES
  ) {
    const stats = (this.cullStats = emptyCullStats());
    this.drawStats = { drawCalls: 0, instances: 0 };
    if (this.contextLost) return;
    const batch = this.batch;
    batch.reset();
    this.camera = cameraPosition;
    this.gl.clearColor(0.1, 0.1, 0.1, 1.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    for (const layer of backgroundLayers) this.drawBackgroundLayer(cameraPosition, layer);

    const view = this.view;
    // Render-only visible-rect culling: physics never sees this rect (its broadphase is a grid over the whole level,
    // cpp/src/sim/PlatformGrid). In cull-debug mode the rect is shrunk inside the screen so items visibly drop out
    // before reaching the edge. Sprites are culled here, on the CPU, before they reach the instance buffer.
    let cullRect: Rect = visibleRect(cameraPosition, { x: view.worldWidth, y: view.worldHeight }, CULL_MARGIN);
    if (cullDebug) cullRect = insetRect(cullRect, CULL_DEBUG_INSET);
    const platformVisible = this.platformVisible;
    platformVisible.length = platforms.length;
    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      platformVisible[i] = boxOverlapsRect(p.position, p.size, cullRect);
      if (platformVisible[i]) stats.platforms.drawn++;
    }
    stats.platforms.total = platforms.length;

    this.drawDecorItems(cameraPosition, decorLayers.distant, cullRect);

    if (platformTexture) {
      const frameSize = { x: platformTexture.width, y: platformTexture.height };
      const frameCoord = { x: 0, y: 0 };
      for (let i = 0; i < platforms.length; i++) {
        if (platformVisualFlags[i] === false || !platformVisible[i]) continue;
        const { position, size } = platforms[i];
        const y = this.anchoredY(platformTexture, position.y, size.y, frameCoord, frameSize, 0);
        batch.push(platformTexture, this.spriteAt(position.x, y, size.x, size.y, platformTexture));
      }
    }

    this.drawDecorItems(cameraPosition, decorLayers.mid, cullRect);

    // Goals as bright cyan boxes so the player has a clear, visible target (Phase 1 playability fix).
    // Goals are triggers, not solid — drawn on top of platforms but under the player sprite.
    stats.goals.total = goals.length;
    for (const goal of goals) {
      if (this.pushBox(goal.position, goal.size, this.debugCyanTexture, 1, cullRect)) stats.goals.drawn++;
    }

    // Terminals and hazards: triggers, drawn like goals (over platforms, under the player). Disabled hazards and
    // used terminals stay visible but faded, so the player can see what the terminal did.
    const entityTextures = this.entityTextures;
    stats.entities.total = entities.hazards.length + entities.payloads.length + entities.terminals.length;
    const drawEntity = (box: FlagBox, texture: TextureObject, alpha: number) => {
      if (this.pushBox(box.position, box.size, texture, alpha, cullRect)) stats.entities.drawn++;
    };
    for (const terminal of entities.terminals) drawEntity(terminal, terminal.flag ? entityTextures.terminalUsed : entityTextures.terminal, 1);
    for (const hazard of entities.hazards) drawEntity(hazard, hazard.flag ? entityTextures.hazard : entityTextures.hazardOff, 1);

    // compute nearest platform top under the player horizontally (renderer-level)
    let nearestTop: number | null = null;
    for (const p of platforms) {
      const pxMin = p.position.x - p.size.x / 2;
      const pxMax = p.position.x + p.size.x / 2;
      if (playerPosition.x >= pxMin - 0.01 && playerPosition.x <= pxMax + 0.01) {
        const top = p.position.y + p.size.y / 2;
        if (nearestTop === null || top > nearestTop) nearestTop = top;
      }
    }
    let visualYOffset = 0;
    if (nearestTop !== null) {
      const playerBottom = playerPosition.y - playerSize.y / 2;
      visualYOffset = playerBottom - nearestTop; // positive => sprite bottom is above platform top; move sprite down by this amount
      if (visualYOffset < 0 || visualYOffset > 0.2) visualYOffset = 0; // Only snap if close enough (avoid snapping when jumping high)
    }

    // Authoring mode: fade the player, its debug box, the payload and particles so platforms and the background stay readable.
    const dimAlpha = authoring?.strongOutlines === true ? AUTHORING_DIM_ALPHA : 1;

    if (playerTexture && playerAnim) {
      const animData = animationForState(playerAnim.state);
      const frame = playerAnim.frame % animData.frames;
      const frameCoord = { x: frame * animData.frameSize.x, y: animData.row * animData.frameSize.y };
      // visualYOffset nudges the sprite down to sit on the platform. The tint is this instance's own, so nothing
      // drawn after the player can pick it up.
      const y = this.anchoredY(playerTexture, playerPosition.y, playerSize.y, frameCoord, animData.frameSize, visualYOffset);
      const s = this.spriteAt(playerPosition.x, y, playerSize.x, playerSize.y, playerTexture);
      s.frameX = frameCoord.x; s.frameY = frameCoord.y;
      s.frameW = animData.frameSize.x; s.frameH = animData.frameSize.y;
      s.flip = playerAnim.facingLeft;
      s.alpha = dimAlpha;
      s.tintR = playerTint[0]; s.tintG = playerTint[1]; s.tintB = playerTint[2]; s.tintDesaturate = playerTint[3];
      batch.push(playerTexture, s);

      if (this.collisionDebug) this.pushBox(playerPosition, playerSize, this.debugRedTexture, dimAlpha, null);
    }

    // The payload goes over the player: when carried it sits on top of the collision box.
    for (const payload of entities.payloads) drawEntity(payload, entityTextures.payload, dimAlpha);

    stats.particles.total = particles.length;
    for (const p of particles) {
      const s = this.spriteAt(p.position.x, p.position.y, p.size, p.size, this.whiteTexture);
      s.alpha = dimAlpha;
      if (batch.pushIfVisible(this.whiteTexture, s, cullRect)) stats.particles.drawn++;
    }

    this.drawDecorItems(cameraPosition, decorLayers.foreground, cullRect);

    // debug collision boxes (platforms = green; the player's red box is drawn with the player above)
    if (this.collisionDebug) {
      for (let i = 0; i < platforms.length; i++) {
        if (platformVisible[i]) this.pushBox(platforms[i].position, platforms[i].size, this.debugGreenTexture, 1, null);
      }
    }

    if (authoring) this.drawAuthoringOverlay(cameraPosition, platforms, platformVisible, authoring);
    if (cullDebug) this.drawCullRect(cullRect);
    this.flush();
  }

  /** Draw counters (drawn / total) from the most recent `drawScene`. */
  public getCullStats(): CullStats {
    return this.cullStats;
  }

  /** GL draw calls and sprite instances issued by the most recent `drawScene`. */
  public getDrawStats(): DrawStats {
    return this.drawStats;
  }

  /** Debug: outline the rect used for culling, in constant-pixel-width lines. */
  private drawCullRect(rect: Rect) {
    const px = this.worldUnitsPerCssPixel();
    const size = { x: rect.maxX - rect.minX, y: rect.maxY - rect.minY };
    const center = { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 };
    this.strokeRect(center, size, 3 * px, this.authoringTextures.snap);
  }

  /** Solid axis-aligned rectangle in world space, added to the frame's batch. */
  private fillRect(centerX: number, centerY: number, width: number, height: number, texture: TextureObject) {
    this.batch.push(texture, this.spriteAt(centerX, centerY, width, height, texture));
  }

  /** Rectangle outline whose edges are centred on the rectangle boundary, `t` world units thick. */
  private strokeRect(position: Vec2, size: Vec2, t: number, texture: TextureObject) {
    this.fillRect(position.x, position.y + size.y / 2, size.x + t, t, texture); // top
    this.fillRect(position.x, position.y - size.y / 2, size.x + t, t, texture); // bottom
    this.fillRect(position.x - size.x / 2, position.y, t, size.y + t, texture); // left
    this.fillRect(position.x + size.x / 2, position.y, t, size.y + t, texture); // right
  }

  /**
   * Level-authoring aids, all in world space so they line up with platforms regardless of which
   * background mode is active: grid, high-contrast platform outlines, and a snap marker.
   * Line widths are constant in CSS pixels, so they keep the same on-screen thickness at any canvas size or DPR.
   */
  private drawAuthoringOverlay(cameraPosition: Vec2, platforms: Platform[], platformVisible: boolean[], overlay: AuthoringOverlay) {
    const textures = this.authoringTextures;
    const { worldWidth, worldHeight } = this.view;
    const px = this.worldUnitsPerCssPixel();
    const left = cameraPosition.x - worldWidth / 2;
    const right = cameraPosition.x + worldWidth / 2;
    const bottom = cameraPosition.y - worldHeight / 2;
    const top = cameraPosition.y + worldHeight / 2;

    if (overlay.grid && overlay.gridStep > 0) {
      const step = overlay.gridStep;
      const majorEvery = step >= 1 ? 5 : Math.max(1, Math.round(1 / step));
      const pick = (index: number) => (index === 0 ? textures.gridAxis : index % majorEvery === 0 ? textures.gridMajor : textures.gridMinor);
      const thickness = (index: number) => (index === 0 ? 3 * px : 1.5 * px);
      for (const i of gridLineIndices(left, right, step)) {
        this.fillRect(i * step, cameraPosition.y, thickness(i), worldHeight, pick(i));
      }
      for (const i of gridLineIndices(bottom, top, step)) {
        this.fillRect(cameraPosition.x, i * step, worldWidth, thickness(i), pick(i));
      }
    }

    if (overlay.strongOutlines) {
      // Dark halo under a bright line keeps the edge visible on both light and dark paintings.
      for (let i = 0; i < platforms.length; i++) {
        if (platformVisible[i]) this.strokeRect(platforms[i].position, platforms[i].size, 6 * px, textures.halo);
      }
      for (let i = 0; i < platforms.length; i++) {
        if (platformVisible[i]) this.strokeRect(platforms[i].position, platforms[i].size, 2.5 * px, textures.outline);
      }
    }

    if (overlay.snapMarker) {
      const { x, y } = overlay.snapMarker;
      this.fillRect(x, y, 14 * px, 3 * px, textures.snap);
      this.fillRect(x, y, 3 * px, 14 * px, textures.snap);
    }
  }
}
