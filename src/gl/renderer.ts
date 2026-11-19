import type { Vec2, Platform, AnimationState, Particle } from '../wasm/loader';
import { gridLineIndices, type AuthoringOverlay } from '../lib/authoring';
import {
  CULL_DEBUG_INSET,
  CULL_MARGIN,
  boxOverlapsRect,
  emptyCullStats,
  insetRect,
  parallaxRect,
  visibleRect,
  type CullStats,
  type Rect,
} from '../lib/culling';

/** Opacity applied to the player and particles while level-authoring mode is on. */
const AUTHORING_DIM_ALPHA = 0.3;

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

const animationMap = {
  idle: { row: 0, frames: 2, frameSize: { x: 64, y: 64 } },
  run: { row: 1, frames: 4, frameSize: { x: 64, y: 64 } },
  jump: { row: 2, frames: 1, frameSize: { x: 64, y: 64 } },
};


export class Renderer {
  private gl: WebGL2RenderingContext;
  private spriteProgram: WebGLProgram;
  private spritePositionAttributeLocation: number;
  private spriteTexCoordAttributeLocation: number;
  private spriteModelPositionUniformLocation: WebGLUniformLocation | null;
  private spriteModelSizeUniformLocation: WebGLUniformLocation | null;
  private spriteCameraPositionUniformLocation: WebGLUniformLocation | null;
  private spriteTextureUniformLocation: WebGLUniformLocation | null;
  private spriteFrameSizeUniformLocation: WebGLUniformLocation | null;
  private spriteSheetSizeUniformLocation: WebGLUniformLocation | null;
  private spriteFrameCoordUniformLocation: WebGLUniformLocation | null;
  private spriteFlipHorizontalUniformLocation: WebGLUniformLocation | null;
  private spriteAlphaUniformLocation: WebGLUniformLocation | null;
  private spriteProjectionMatrixUniformLocation: WebGLUniformLocation | null;
  private backgroundProgram: WebGLProgram;
  private backgroundPositionAttributeLocation: number;
  private backgroundCameraPositionUniformLocation: WebGLUniformLocation | null;
  private backgroundTextureSizeUniformLocation: WebGLUniformLocation | null;
  private backgroundResolutionUniformLocation: WebGLUniformLocation | null;
  private backgroundTextureUniformLocation: WebGLUniformLocation | null;
  private backgroundScrollFactorUniformLocation: WebGLUniformLocation | null;
  private backgroundScaleUniformLocation: WebGLUniformLocation | null;
  private backgroundOffsetYUniformLocation: WebGLUniformLocation | null;
  private unitSquarePositionBuffer: WebGLBuffer | null = null;
  private unitSquareTexCoordBuffer: WebGLBuffer | null = null;
  private fullScreenQuadBuffer: WebGLBuffer | null = null;
  // Map to store per-texture anchors: anchors.get(texture) -> array[row][frame] = offsetPx
  private anchors: Map<WebGLTexture, number[][]> = new Map();
  private debugRedTexture: TextureObject | null = null;
  private debugGreenTexture: TextureObject | null = null;
  private whiteTexture: TextureObject | null = null;
  private debugCyanTexture: TextureObject | null = null; // used for goal visualization (playability win)
  // Draw counters from the most recent drawScene call (render-only visible-rect culling).
  private cullStats: CullStats = emptyCullStats();
  // Level-authoring overlay colours (grid, platform outlines, snap marker).
  private authoringTextures: {
    gridMinor: TextureObject;
    gridMajor: TextureObject;
    gridAxis: TextureObject;
    outline: TextureObject;
    halo: TextureObject;
    snap: TextureObject;
  } | null = null;


  constructor(canvas: HTMLCanvasElement, spriteVsSource: string, spriteFsSource: string, bgVsSource: string, bgFsSource: string) {
    const context = canvas.getContext('webgl2');
    if (!context) throw new Error('WebGL2 is not supported.');
    this.gl = context;
    const spriteVertexShader = this.compileShader(this.gl.VERTEX_SHADER, spriteVsSource);
    const spriteFragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, spriteFsSource);
    this.spriteProgram = this.createProgram(spriteVertexShader, spriteFragmentShader);
    this.spritePositionAttributeLocation = this.gl.getAttribLocation(this.spriteProgram, 'a_position');
    this.spriteTexCoordAttributeLocation = this.gl.getAttribLocation(this.spriteProgram, 'a_texCoord');
    this.spriteModelPositionUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_model_position');
    this.spriteModelSizeUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_model_size');
    this.spriteCameraPositionUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_camera_position');
    this.spriteTextureUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_texture');
    this.spriteFrameSizeUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_sprite_frame_size');
    this.spriteSheetSizeUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_sprite_sheet_size');
    this.spriteFrameCoordUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_sprite_frame_coord');
    this.spriteFlipHorizontalUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_flip_horizontal');
    this.spriteProjectionMatrixUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_projection');
    this.spriteAlphaUniformLocation = this.gl.getUniformLocation(this.spriteProgram, 'u_alpha');
    const bgVertexShader = this.compileShader(this.gl.VERTEX_SHADER, bgVsSource);
    const bgFragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, bgFsSource);
    this.backgroundProgram = this.createProgram(bgVertexShader, bgFragmentShader);
    this.backgroundPositionAttributeLocation = this.gl.getAttribLocation(this.backgroundProgram, 'a_position');
    this.backgroundCameraPositionUniformLocation = this.gl.getUniformLocation(this.backgroundProgram, 'u_camera_position');
    this.backgroundTextureSizeUniformLocation = this.gl.getUniformLocation(this.backgroundProgram, 'u_texture_size');
    this.backgroundResolutionUniformLocation = this.gl.getUniformLocation(this.backgroundProgram, 'u_resolution');
    this.backgroundTextureUniformLocation = this.gl.getUniformLocation(this.backgroundProgram, 'u_texture');
    this.backgroundScrollFactorUniformLocation = this.gl.getUniformLocation(this.backgroundProgram, 'u_scroll_factor');
    this.backgroundScaleUniformLocation = this.gl.getUniformLocation(this.backgroundProgram, 'u_scale');
    this.backgroundOffsetYUniformLocation = this.gl.getUniformLocation(this.backgroundProgram, 'u_offset_y');
    this.gl.viewport(0, 0, canvas.width, canvas.height);
    this.setupGeometry();
    // create simple solid debug textures
    this.debugRedTexture = this.createSolidTexture([255, 0, 0, 128]);
    this.debugGreenTexture = this.createSolidTexture([0, 255, 0, 128]);
    this.whiteTexture = this.createSolidTexture([255, 255, 255, 255]);
    this.debugCyanTexture = this.createSolidTexture([0, 255, 255, 170]); // cyan goals (visible target)
    this.authoringTextures = {
      gridMinor: this.createSolidTexture([255, 255, 255, 70]),
      gridMajor: this.createSolidTexture([255, 255, 255, 150]),
      gridAxis: this.createSolidTexture([255, 140, 0, 220]),
      outline: this.createSolidTexture([255, 235, 0, 255]),
      halo: this.createSolidTexture([0, 0, 0, 230]),
      snap: this.createSolidTexture([255, 0, 220, 255]),
    };
    // u_alpha has no GLSL default (it would read as 0), so initialise it once up front.
    this.gl.useProgram(this.spriteProgram);
    this.gl.uniform1f(this.spriteAlphaUniformLocation, 1.0);
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


  public async loadTexture(url: string, options: TextureLoadOptions = {}): Promise<TextureObject> {
    const { repeat = false, pixelated = true } = options;
    const texture = this.gl.createTexture();
    if (!texture) throw new Error("Failed to create texture");
    const image = new Image();
    image.src = url;
    await image.decode(); // Wait for the image to load
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, repeat ? this.gl.REPEAT : this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, repeat ? this.gl.REPEAT : this.gl.CLAMP_TO_EDGE);
    if (pixelated) {
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    } else {
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.generateMipmap(this.gl.TEXTURE_2D);
    }

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
        for (const key of Object.keys(animationMap)) {
          const anim = (animationMap as any)[key];
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
        if (hasAny) this.anchors.set(texture, anchorsForTexture);
      }
    } catch (err) {
      // non-fatal: if pixel inspection fails, we simply don't set anchors
      console.warn('Failed to compute texture anchors for', url, err);
    }

    return { texture, width: image.width, height: image.height };
  }


  private setupGeometry() {
    const positions = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5]);
    this.unitSquarePositionBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.unitSquarePositionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);
    const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);
    this.unitSquareTexCoordBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.unitSquareTexCoordBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, texCoords, this.gl.STATIC_DRAW);
    const fullScreenPositions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.fullScreenQuadBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.fullScreenQuadBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, fullScreenPositions, this.gl.STATIC_DRAW);
  }


  private drawSprite(
    position: Vec2,
    size: Vec2,
    textureObj: TextureObject,
    sheetSize: Vec2,
    frameSize: Vec2,
    frameCoord: Vec2,
    facingLeft: boolean,
    visualYOffset: number = 0,
    applyAutoAnchor: boolean = true
  ) {
    this.gl.bindTexture(this.gl.TEXTURE_2D, textureObj.texture);
    this.gl.uniform1i(this.spriteTextureUniformLocation, 0);

    // compute vertical anchor offset (in world units) if we have precomputed anchors for this texture
    let modelPosY = position.y;
    const anchorsForTex = applyAutoAnchor ? this.anchors.get(textureObj.texture) : undefined;
    if (applyAutoAnchor && anchorsForTex) {
      // determine current frame indices
      const frameIndex = Math.round(frameCoord.x / (frameSize.x || 1));
      const rowIndex = Math.round(frameCoord.y / (frameSize.y || 1));
      if (anchorsForTex[rowIndex] && anchorsForTex[rowIndex][frameIndex] !== undefined) {
        const offsetPx = anchorsForTex[rowIndex][frameIndex];
        const offsetWorld = (offsetPx / frameSize.y) * size.y;
        modelPosY = position.y - offsetWorld; // shift sprite down so foot aligns with collision bottom
      }
    } else if (applyAutoAnchor) {
      // Fallback: if sprite frames are 64x64 (our player sheet), apply a small heuristic offset so feet sit lower
      if (frameSize && frameSize.y === 64 && frameSize.x === 64) {
        const fallbackFraction = 0.25; // increased: fraction of sprite height to lower the sprite
        const offsetWorld = size.y * fallbackFraction;
        modelPosY = position.y - offsetWorld;
      }
    }

    // apply an additional visual Y offset (in world units), positive means move sprite down
    if (visualYOffset) modelPosY -= visualYOffset;

    this.gl.uniform2f(this.spriteModelPositionUniformLocation, position.x, modelPosY);
    this.gl.uniform2f(this.spriteModelSizeUniformLocation, size.x, size.y);
    this.gl.uniform2f(this.spriteSheetSizeUniformLocation, sheetSize.x, sheetSize.y);
    this.gl.uniform2f(this.spriteFrameSizeUniformLocation, frameSize.x, frameSize.y);
    this.gl.uniform2f(this.spriteFrameCoordUniformLocation, frameCoord.x, frameCoord.y);
    this.gl.uniform1f(this.spriteFlipHorizontalUniformLocation, facingLeft ? 1.0 : 0.0);
    this.gl.enableVertexAttribArray(this.spritePositionAttributeLocation);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.unitSquarePositionBuffer);
    this.gl.vertexAttribPointer(this.spritePositionAttributeLocation, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.enableVertexAttribArray(this.spriteTexCoordAttributeLocation);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.unitSquareTexCoordBuffer);
    this.gl.vertexAttribPointer(this.spriteTexCoordAttributeLocation, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }


  private setSpriteProjection() {
    const aspectRatio = this.gl.canvas.width / this.gl.canvas.height;
    const worldWidth = 10.0;
    const worldHeight = worldWidth / aspectRatio;
    const projectionMatrix = [2.0 / worldWidth, 0, 0, 0, 0, 2.0 / worldHeight, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    this.gl.uniformMatrix4fv(this.spriteProjectionMatrixUniformLocation, false, projectionMatrix);
    return { worldWidth, worldHeight };
  }

  private drawWorldBackgroundLayer(cameraPosition: Vec2, layer: WorldBackgroundLayer) {
    // Parallax pivots on the image centre: effective camera = centre + (camera - centre) * factor.
    // factor 1 is identical to the world camera; the image is exactly aligned when the camera sits at its centre.
    const effectiveCamera = {
      x: layer.position.x + (cameraPosition.x - layer.position.x) * layer.parallaxX,
      y: layer.position.y + (cameraPosition.y - layer.position.y) * layer.parallaxY,
    };
    this.gl.useProgram(this.spriteProgram);
    const { worldWidth, worldHeight } = this.setSpriteProjection();
    // Cheap cull: skip the draw when the image rectangle is entirely off screen.
    const dx = Math.abs(layer.position.x - effectiveCamera.x);
    const dy = Math.abs(layer.position.y - effectiveCamera.y);
    if (dx > (layer.size.x + worldWidth) / 2 || dy > (layer.size.y + worldHeight) / 2) return;
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.uniform2f(this.spriteCameraPositionUniformLocation, effectiveCamera.x, effectiveCamera.y);
    const full = { x: layer.texture.width, y: layer.texture.height };
    this.drawSprite(layer.position, layer.size, layer.texture, full, full, { x: 0, y: 0 }, false, 0, false);
  }

  private drawBackgroundLayer(cameraPosition: Vec2, layer: BackgroundLayer) {
    if (layer.mode === 'world') {
      this.drawWorldBackgroundLayer(cameraPosition, layer);
      return;
    }
    this.gl.useProgram(this.backgroundProgram);
    this.gl.bindTexture(this.gl.TEXTURE_2D, layer.texture.texture);
    this.gl.uniform1i(this.backgroundTextureUniformLocation, 0);
    this.gl.uniform2f(this.backgroundCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    this.gl.uniform2f(this.backgroundTextureSizeUniformLocation, layer.texture.width, layer.texture.height);
    this.gl.uniform2f(this.backgroundResolutionUniformLocation, this.gl.canvas.width, this.gl.canvas.height);
    this.gl.uniform2f(this.backgroundScrollFactorUniformLocation, layer.scrollFactorX, layer.scrollFactorY);
    this.gl.uniform1f(this.backgroundScaleUniformLocation, layer.scale);
    this.gl.uniform1f(this.backgroundOffsetYUniformLocation, layer.offsetY);
    this.gl.enableVertexAttribArray(this.backgroundPositionAttributeLocation);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.fullScreenQuadBuffer);
    this.gl.vertexAttribPointer(this.backgroundPositionAttributeLocation, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }

  private drawDecorItems(cameraPosition: Vec2, decorItems: DecorItem[], view: Vec2, cullMargin: number, cullInset: number) {
    for (const item of decorItems) {
      this.cullStats.decor.total++;
      // Decor is drawn against a parallax-scaled camera and nudged down by offsetY (see drawSprite),
      // so test its drawn box against the view centred on that scaled camera.
      let rect = parallaxRect(cameraPosition, item.parallaxX, item.parallaxY, view, cullMargin);
      if (cullInset > 0) rect = insetRect(rect, cullInset);
      if (!boxOverlapsRect({ x: item.position.x, y: item.position.y - item.offsetY }, item.size, rect)) continue;
      this.cullStats.decor.drawn++;
      this.gl.uniform2f(
        this.spriteCameraPositionUniformLocation,
        cameraPosition.x * item.parallaxX,
        cameraPosition.y * item.parallaxY
      );
      this.drawSprite(
        item.position,
        item.size,
        item.texture,
        { x: item.texture.width, y: item.texture.height },
        item.frameSize,
        item.frameCoord,
        false,
        item.offsetY,
        false
      );
    }
  }


  private createSolidTexture(color: [number, number, number, number]): TextureObject {
    const tex = this.gl.createTexture();
    if (!tex) throw new Error('Failed to create debug texture');
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
    const data = new Uint8Array(color);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, 1, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, data);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    return { texture: tex, width: 1, height: 1 };
  }

  public drawScene(
    cameraPosition: Vec2,
    playerPosition: Vec2,
    playerSize: Vec2,
    platforms: Platform[],
    particles: Particle[],
    playerTexture: TextureObject | null,
    platformTexture: TextureObject | null,
    backgroundLayers: BackgroundLayer[] = [],
    decorLayers: DecorLayers = { distant: [], mid: [], foreground: [] },
    platformVisualFlags: boolean[] = [],
    playerAnim: AnimationState | null,
    goals: Platform[] = [],
    character: number = 0,
    authoring: AuthoringOverlay | null = null,
    cullDebug: boolean = false
  ) {
    this.gl.clearColor(0.1, 0.1, 0.1, 1.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    if (backgroundLayers.length > 0) {
      for (const layer of backgroundLayers) {
        this.drawBackgroundLayer(cameraPosition, layer);
      }
    }
    this.gl.useProgram(this.spriteProgram);
    const view = this.setSpriteProjection();
    this.gl.uniform2f(this.spriteCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

    // Render-only visible-rect culling: physics keeps using every platform. In cull-debug mode the
    // rect is shrunk inside the screen so items visibly drop out before reaching the edge.
    const cullInset = cullDebug ? CULL_DEBUG_INSET : 0;
    let cullRect: Rect = visibleRect(cameraPosition, { x: view.worldWidth, y: view.worldHeight });
    if (cullInset > 0) cullRect = insetRect(cullRect, cullInset);
    const viewVec = { x: view.worldWidth, y: view.worldHeight };
    const stats = (this.cullStats = emptyCullStats());
    const platformVisible: boolean[] = new Array(platforms.length);
    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      platformVisible[i] = boxOverlapsRect(p.position, p.size, cullRect);
      if (platformVisible[i]) stats.platforms.drawn++;
    }
    stats.platforms.total = platforms.length;

    if (decorLayers.distant.length > 0) {
      this.drawDecorItems(cameraPosition, decorLayers.distant, viewVec, CULL_MARGIN, cullInset);
      this.gl.uniform2f(this.spriteCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    }

    if (platformTexture) {
      for (let i = 0; i < platforms.length; i++) {
        if (platformVisualFlags[i] === false || !platformVisible[i]) continue;
        const platform = platforms[i];
        this.drawSprite(platform.position, platform.size, platformTexture, { x: platformTexture.width, y: platformTexture.height }, { x: platformTexture.width, y: platformTexture.height }, { x: 0, y: 0 }, false, 0);
      }
    }

    if (decorLayers.mid.length > 0) {
      this.drawDecorItems(cameraPosition, decorLayers.mid, viewVec, CULL_MARGIN, cullInset);
      this.gl.uniform2f(this.spriteCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    }

    // Draw goals as bright cyan boxes so the player has a clear, visible target (Phase 1 playability fix).
    // Goals are triggers, not solid — drawn on top of platforms but under the player sprite.
    if (this.debugCyanTexture && goals.length > 0) {
      stats.goals.total = goals.length;
      for (const goal of goals) {
        if (!boxOverlapsRect(goal.position, goal.size, cullRect)) continue;
        stats.goals.drawn++;
        this.drawSprite(goal.position, goal.size, this.debugCyanTexture, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, false);
      }
    }

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

    // Authoring mode: fade the player + particles so platforms and the background stay readable.
    const dimmed = authoring?.strongOutlines === true;
    if (dimmed) this.gl.uniform1f(this.spriteAlphaUniformLocation, AUTHORING_DIM_ALPHA);

    if (playerTexture && playerAnim) {
      const animData = animationMap[playerAnim.currentState as keyof typeof animationMap] || animationMap.idle;
      const frame = playerAnim.currentFrame % animData.frames;
      const frameCoord = { x: frame * animData.frameSize.x, y: animData.row * animData.frameSize.y };
      // pass visualYOffset so sprite is nudged down to sit on platform
      this.drawSprite(playerPosition, playerSize, playerTexture, { x: playerTexture.width, y: playerTexture.height }, animData.frameSize, frameCoord, playerAnim.facingLeft, visualYOffset);

      // character param received (0=Bolts, 1=Volts). Future: different tint, atlas row offset, or separate texture.
      // For now the debug UI + mechanical differences (speed/jump) provide the differentiation.

      // draw player collision box
      if (this.debugRedTexture) {
        this.drawSprite({ x: playerPosition.x, y: playerPosition.y }, { x: playerSize.x, y: playerSize.y }, this.debugRedTexture, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, false);
      }
    }

    // Draw particles
    if (this.whiteTexture) {
      stats.particles.total = particles.length;
      for (const p of particles) {
        if (!boxOverlapsRect(p.position, { x: p.size, y: p.size }, cullRect)) continue;
        stats.particles.drawn++;
        this.drawSprite(p.position, { x: p.size, y: p.size }, this.whiteTexture, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, false, 0);
      }
    }

    if (dimmed) this.gl.uniform1f(this.spriteAlphaUniformLocation, 1.0);

    if (decorLayers.foreground.length > 0) {
      this.drawDecorItems(cameraPosition, decorLayers.foreground, viewVec, CULL_MARGIN, cullInset);
      this.gl.uniform2f(this.spriteCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    }

    // draw debug collision boxes (platforms = green, player = red)
    if (this.debugGreenTexture) {
      for (let i = 0; i < platforms.length; i++) {
        if (!platformVisible[i]) continue;
        const platform = platforms[i];
        this.drawSprite(
          { x: platform.position.x, y: platform.position.y },
          { x: platform.size.x, y: platform.size.y },
          this.debugGreenTexture,
          { x: 1, y: 1 },
          { x: 1, y: 1 },
          { x: 0, y: 0 },
          false
        );
      }
    }

    if (authoring) {
      this.drawAuthoringOverlay(cameraPosition, platforms.filter((_, i) => platformVisible[i]), authoring);
    }
    if (cullDebug) this.drawCullRect(cameraPosition, cullRect);
  }

  /** Draw counters (drawn / total) from the most recent `drawScene`. */
  public getCullStats(): CullStats {
    return this.cullStats;
  }

  /** Debug: outline the rect used for culling, in constant-pixel-width lines. */
  private drawCullRect(cameraPosition: Vec2, rect: Rect) {
    const textures = this.authoringTextures;
    if (!textures) return;
    this.gl.useProgram(this.spriteProgram);
    const { worldWidth } = this.setSpriteProjection();
    this.gl.uniform2f(this.spriteCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    const px = worldWidth / this.gl.canvas.width;
    const size = { x: rect.maxX - rect.minX, y: rect.maxY - rect.minY };
    const center = { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 };
    this.strokeRect(center, size, 3 * px, textures.snap);
  }

  /** Solid axis-aligned rectangle in world space (sprite program must be active). */
  private fillRect(centerX: number, centerY: number, width: number, height: number, texture: TextureObject) {
    this.drawSprite({ x: centerX, y: centerY }, { x: width, y: height }, texture, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, false);
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
   * Line widths are constant in screen pixels, so they stay crisp at any canvas size.
   */
  private drawAuthoringOverlay(cameraPosition: Vec2, platforms: Platform[], overlay: AuthoringOverlay) {
    const textures = this.authoringTextures;
    if (!textures) return;
    this.gl.useProgram(this.spriteProgram);
    const { worldWidth, worldHeight } = this.setSpriteProjection();
    this.gl.uniform2f(this.spriteCameraPositionUniformLocation, cameraPosition.x, cameraPosition.y);
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    const px = worldWidth / this.gl.canvas.width; // world units per screen pixel
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
      for (const platform of platforms) this.strokeRect(platform.position, platform.size, 6 * px, textures.halo);
      for (const platform of platforms) this.strokeRect(platform.position, platform.size, 2.5 * px, textures.outline);
    }

    if (overlay.snapMarker) {
      const { x, y } = overlay.snapMarker;
      this.fillRect(x, y, 14 * px, 3 * px, textures.snap);
      this.fillRect(x, y, 3 * px, 14 * px, textures.snap);
    }
  }
}
