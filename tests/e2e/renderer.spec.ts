import { expect, test, type Page } from '@playwright/test';

// These tests drive `Renderer` directly in the browser (modules come from the Vite dev server), so they
// need neither the WASM module nor the full app: a tiny offscreen canvas and a handful of draw calls.

type Frame = { width: number; height: number; pixels: number[] };
type Rig = {
  renderer: {
    resize(size: { width: number; height: number; pixelRatio: number }): void;
    setCollisionDebug(on: boolean): void;
    getCullStats(): { entities: { drawn: number; total: number }; platforms: { drawn: number; total: number } };
    getDrawStats(): { drawCalls: number; instances: number };
    isContextLost(): boolean;
    onContextChange(listener: (status: 'lost' | 'restored') => void): () => void;
  };
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  /**
   * Render an empty scene plus the given goals/platforms and read the pixels back in the same task.
   * `player` draws a solid white (or red) player at the origin (size 1) with the given tint; `whitePlatforms`
   * textures the platforms with solid white instead of leaving them undrawn.
   */
  draw(opts: {
    goals?: unknown[];
    platforms?: unknown[];
    player?: { tint: [number, number, number, number]; color?: 'white' | 'red' };
    whitePlatforms?: boolean;
    /** Hazards / payload / terminals, as `drawScene`'s `entities` (`{ position, size, flag }` boxes). */
    entities?: { hazards?: unknown[]; payloads?: unknown[]; terminals?: unknown[] };
  }): Frame;
};
declare global {
  interface Window { __rig?: Rig }
}

/** Build a Renderer on a fresh 320x180 canvas inside the page and expose it as `window.__rig`. */
async function createRig(page: Page) {
  await page.evaluate(async () => {
    const [{ Renderer }, vs, fs, bvs, bfs] = await Promise.all([
      import('/src/gl/renderer.ts'),
      import('/src/gl/shaders/tex.vert.glsl?raw').then((m) => m.default),
      import('/src/gl/shaders/tex.frag.glsl?raw').then((m) => m.default),
      import('/src/gl/shaders/background.vert.glsl?raw').then((m) => m.default),
      import('/src/gl/shaders/background.frag.glsl?raw').then((m) => m.default),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const renderer = new Renderer(canvas, vs, fs, bvs, bfs);
    const gl = canvas.getContext('webgl2')!;
    const swatch = async (color: string) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return renderer.loadTexture(c.toDataURL('image/png'));
    };
    const white = await swatch('#fff');
    const red = await swatch('#f00');
    const draw: Rig['draw'] = (opts) => {
      renderer.drawScene(
        { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 },
        (opts.platforms ?? []) as never[], [], opts.player ? (opts.player.color === 'red' ? red : white) : null, opts.whitePlatforms ? white : null, [],
        { distant: [], mid: [], foreground: [] }, [], opts.player ? { state: 0, frame: 0, facingLeft: false } : null,
        (opts.goals ?? []) as never[], opts.player?.tint, null, false,
        { hazards: [], payloads: [], terminals: [], ...opts.entities } as never
      );
      // The drawing buffer is only valid until the end of the task, so read it back right away.
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { width: canvas.width, height: canvas.height, pixels: Array.from(pixels) };
    };
    window.__rig = { renderer, canvas, gl, draw };
  });
}

test.beforeEach(async ({ page }) => {
  // Any document on the dev-server origin will do; this one is static and renders nothing.
  await page.goto('/levels/manifest.json');
});

test('creates an opaque, non-MSAA context with no depth or stencil buffer', async ({ page }) => {
  await createRig(page);
  const attrs = await page.evaluate(() => window.__rig!.gl.getContextAttributes());
  expect(attrs).toMatchObject({
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  });
});

test('retries once without `desynchronized` when the first context request is rejected', async ({ page }) => {
  const requests = await page.evaluate(async () => {
    const calls: Array<{ desynchronized: unknown }> = [];
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, attrs?: unknown) {
      const desynchronized = (attrs as { desynchronized?: unknown } | undefined)?.desynchronized;
      if (type === 'webgl2') calls.push({ desynchronized });
      if (type === 'webgl2' && desynchronized === true) return null; // simulate a browser rejecting the hint
      return (original as (...a: unknown[]) => unknown).call(this, type, attrs);
    } as typeof original;
    try {
      const [{ Renderer }, vs, fs, bvs, bfs] = await Promise.all([
        import('/src/gl/renderer.ts'),
        import('/src/gl/shaders/tex.vert.glsl?raw').then((m) => m.default),
        import('/src/gl/shaders/tex.frag.glsl?raw').then((m) => m.default),
        import('/src/gl/shaders/background.vert.glsl?raw').then((m) => m.default),
        import('/src/gl/shaders/background.frag.glsl?raw').then((m) => m.default),
      ]);
      new Renderer(document.createElement('canvas'), vs, fs, bvs, bfs);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
    return calls;
  });
  expect(requests).toEqual([{ desynchronized: true }, { desynchronized: false }]);
});

test('retries once without `desynchronized` when the first context request throws', async ({ page }) => {
  const requests = await page.evaluate(async () => {
    const calls: Array<{ desynchronized: unknown }> = [];
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, attrs?: unknown) {
      const desynchronized = (attrs as { desynchronized?: unknown } | undefined)?.desynchronized;
      if (type === 'webgl2') calls.push({ desynchronized });
      if (type === 'webgl2' && desynchronized === true) throw new TypeError('desynchronized is not supported'); // a throwing rejection
      return (original as (...a: unknown[]) => unknown).call(this, type, attrs);
    } as typeof original;
    try {
      const [{ Renderer }, vs, fs, bvs, bfs] = await Promise.all([
        import('/src/gl/renderer.ts'),
        import('/src/gl/shaders/tex.vert.glsl?raw').then((m) => m.default),
        import('/src/gl/shaders/tex.frag.glsl?raw').then((m) => m.default),
        import('/src/gl/shaders/background.vert.glsl?raw').then((m) => m.default),
        import('/src/gl/shaders/background.frag.glsl?raw').then((m) => m.default),
      ]);
      new Renderer(document.createElement('canvas'), vs, fs, bvs, bfs);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
    return calls;
  });
  expect(requests).toEqual([{ desynchronized: true }, { desynchronized: false }]);
});

test('resizing changes the backing store and viewport and the world is not stretched', async ({ page }) => {
  await createRig(page);
  // A 2 x 2 world-unit goal must stay square on screen and span 2/10 of the width, whatever the canvas shape or DPR.
  const shapes: Array<[number, number, number]> = [[320, 180, 1], [400, 200, 1], [200, 300, 1], [640, 360, 2]];
  const results = await page.evaluate((shapesIn) => {
    const rig = window.__rig!;
    return shapesIn.map(([width, height, pixelRatio]) => {
      rig.renderer.resize({ width, height, pixelRatio });
      const frame = rig.draw({ goals: [{ position: { x: 0, y: 0 }, size: { x: 2, y: 2 } }] });
      // Pixel bounding box of the cyan goal quad: green channel lit well above the grey clear colour.
      let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          if (frame.pixels[(y * frame.width + x) * 4 + 1] > 100) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
      }
      return {
        canvas: [rig.canvas.width, rig.canvas.height],
        viewport: Array.from(rig.gl.getParameter(rig.gl.VIEWPORT) as Int32Array).slice(2),
        boxW: maxX - minX + 1,
        boxH: maxY - minY + 1,
      };
    });
  }, shapes);

  results.forEach((result, i) => {
    const [width, height] = shapes[i];
    expect(result.canvas).toEqual([width, height]);
    expect(result.viewport).toEqual([width, height]);
    expect(Math.abs(result.boxW - width / 5)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.boxH - width / 5)).toBeLessThanOrEqual(2); // square: same pixel span on both axes
  });
});

test('collision boxes are hidden unless the debug flag is set', async ({ page }) => {
  await createRig(page);
  const centre = await page.evaluate(() => {
    const rig = window.__rig!;
    const platforms = [{ position: { x: 0, y: 0 }, size: { x: 2, y: 2 } }];
    const centreOf = (frame: Frame) => {
      const i = ((frame.height >> 1) * frame.width + (frame.width >> 1)) * 4;
      return { r: frame.pixels[i], g: frame.pixels[i + 1], b: frame.pixels[i + 2] };
    };
    const off = centreOf(rig.draw({ platforms }));
    rig.renderer.setCollisionDebug(true);
    const on = centreOf(rig.draw({ platforms }));
    rig.renderer.setCollisionDebug(false);
    const offAgain = centreOf(rig.draw({ platforms }));
    return { off, on, offAgain };
  });
  // A texture-less platform draws nothing but the clear colour (0.1 grey, 25 or 26 depending on rounding) while the flag is off.
  for (const channel of [centre.off.r, centre.off.g, centre.off.b]) expect(Math.abs(channel - 25.5)).toBeLessThanOrEqual(1);
  expect(centre.on.g).toBeGreaterThan(100); // 50% green overlay
  expect(centre.on.r).toBeLessThan(40);
  expect(centre.offAgain).toEqual(centre.off);
});

test('the player tint colours the player sprite only, and does not leak into later draws', async ({ page }) => {
  await createRig(page);
  const px = await page.evaluate(() => {
    const rig = window.__rig!;
    // The player is at the view centre; the platform is 3 world units to its right (32 px per unit on this canvas).
    const platforms = [{ position: { x: 3, y: 0 }, size: { x: 1, y: 1 } }];
    const at = (frame: Frame, worldX: number) => {
      const i = ((frame.height >> 1) * frame.width + (frame.width >> 1) + Math.round(worldX * 32)) * 4;
      return [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]];
    };
    const warm = { tint: [1.0, 0.78, 0.45, 1.0] as [number, number, number, number] };
    const first = rig.draw({ player: warm, platforms, whitePlatforms: true });
    // Platforms are drawn before the player in a frame, so a tint left on after the first frame would show here.
    const second = rig.draw({ player: warm, platforms, whitePlatforms: true });
    const untinted = rig.draw({ player: { tint: [1, 1, 1, 0] }, platforms, whitePlatforms: true });
    return {
      firstPlayer: at(first, 0), firstPlatform: at(first, 3),
      secondPlayer: at(second, 0), secondPlatform: at(second, 3),
      untintedPlayer: at(untinted, 0),
    };
  });
  const close = (actual: number[], expected: number[]) => {
    for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(2);
  };
  close(px.firstPlayer, [255, 199, 115]); // (1.0, 0.78, 0.45) * 255 on white
  close(px.secondPlayer, [255, 199, 115]);
  close(px.firstPlatform, [255, 255, 255]);
  close(px.secondPlatform, [255, 255, 255]);
  close(px.untintedPlayer, [255, 255, 255]);
});

test('a tint multiplies the sample, and desaturate swaps its own hue for the tint colour', async ({ page }) => {
  await createRig(page);
  const px = await page.evaluate(() => {
    const rig = window.__rig!;
    const centre = (frame: Frame) => {
      const i = ((frame.height >> 1) * frame.width + (frame.width >> 1)) * 4;
      return [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]];
    };
    const draw = (tint: [number, number, number, number]) => centre(rig.draw({ player: { tint, color: 'red' } }));
    return {
      untinted: draw([1, 1, 1, 0]),
      multiplied: draw([0.55, 0.95, 1.0, 0]), // cool tint, hue kept
      recoloured: draw([1.0, 0.78, 0.45, 1.0]), // warm tint on the grey of red: luma 0.299
    };
  });
  const close = (actual: number[], expected: number[]) => {
    for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(2);
  };
  close(px.untinted, [255, 0, 0]);
  close(px.multiplied, [140, 0, 0]); // 0.55 * 255
  close(px.recoloured, [76, 59, 34]); // 0.299 * (1.0, 0.78, 0.45) * 255
});

test('hazards, terminals and the payload draw as flat quads, faded once switched off, the payload over the player', async ({ page }) => {
  await createRig(page);
  const px = await page.evaluate(() => {
    const rig = window.__rig!;
    const at = (frame: Frame, worldX: number) => {
      const i = ((frame.height >> 1) * frame.width + (frame.width >> 1) + Math.round(worldX * 32)) * 4;
      return [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]];
    };
    const box = (x: number, flag: boolean) => ({ position: { x, y: 0 }, size: { x: 1, y: 1 }, flag });
    const white = { tint: [1, 1, 1, 0] as [number, number, number, number] };
    const live = rig.draw({ player: white, entities: { hazards: [box(-3, true)], terminals: [box(3, false)], payloads: [box(0, true)] } });
    const liveStats = { ...rig.renderer.getCullStats().entities };
    const off = rig.draw({ entities: { hazards: [box(-3, false), box(40, true)], terminals: [box(3, true)] } });
    const offStats = { ...rig.renderer.getCullStats().entities };
    return {
      hazard: at(live, -3), terminal: at(live, 3), payload: at(live, 0),
      hazardOff: at(off, -3), terminalUsed: at(off, 3), liveStats, offStats,
    };
  });
  const close = (actual: number[], expected: number[]) => {
    for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(3);
  };
  // Colour * alpha + the 0.1-grey clear colour (25.5) * (1 - alpha), for the Renderer's entity textures.
  close(px.hazard, [233, 66, 39]);
  close(px.terminal, [66, 215, 111]);
  close(px.payload, [215, 155, 70]); // opaque, and drawn after the white player
  close(px.hazardOff, [65, 65, 65]);
  close(px.terminalUsed, [44, 77, 61]);
  expect(px.liveStats).toEqual({ drawn: 3, total: 3 });
  expect(px.offStats).toEqual({ drawn: 2, total: 3 }); // the hazard at x = 40 is culled
});

test('sprites sharing a texture draw as one instanced call; a texture change starts the next, culled sprites add none', async ({ page }) => {
  await createRig(page);
  const result = await page.evaluate(() => {
    const rig = window.__rig!;
    // 60 platforms on screen plus 40 far off to the right (culled), all with the same white texture.
    const platforms = [
      ...Array.from({ length: 60 }, (_, i) => ({ position: { x: -4.5 + (i % 10), y: -2 + Math.floor(i / 10) * 0.5 }, size: { x: 0.8, y: 0.2 } })),
      ...Array.from({ length: 40 }, (_, i) => ({ position: { x: 100 + i, y: 0 }, size: { x: 0.8, y: 0.2 } })),
    ];
    rig.draw({ platforms, whitePlatforms: true });
    const platformsOnly = { ...rig.renderer.getDrawStats(), cull: { ...rig.renderer.getCullStats().platforms } };
    // Goals are a different texture drawn after the platforms: one more range, one more call.
    rig.draw({ platforms, whitePlatforms: true, goals: [{ position: { x: 0, y: 2 }, size: { x: 1, y: 1 } }, { position: { x: 2, y: 2 }, size: { x: 1, y: 1 } }] });
    const withGoals = { ...rig.renderer.getDrawStats() };
    return { platformsOnly, withGoals };
  });
  expect(result.platformsOnly).toEqual({ drawCalls: 1, instances: 60, cull: { drawn: 60, total: 100 } });
  expect(result.withGoals).toEqual({ drawCalls: 2, instances: 62 });
});

// Playwright cannot dispatch a real GPU reset, but WEBGL_lose_context makes the browser lose and restore the context
// for real: the actual webglcontextlost / webglcontextrestored events, with every GL object gone in between.
test('after a context loss and restore, the same renderer draws the same frame again without a reload', async ({ page }) => {
  await createRig(page);
  const result = await page.evaluate(async () => {
    const rig = window.__rig!;
    const scene = {
      player: { tint: [1.0, 0.78, 0.45, 1.0] as [number, number, number, number] }, // white loaded image, warm tint
      platforms: [{ position: { x: 3, y: 0 }, size: { x: 1, y: 1 } }],
      whitePlatforms: true,
      goals: [{ position: { x: -3, y: 0 }, size: { x: 1, y: 1 } }],
    };
    const at = (frame: Frame, worldX: number) => {
      const i = ((frame.height >> 1) * frame.width + (frame.width >> 1) + Math.round(worldX * 32)) * 4;
      return [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]];
    };
    const sample = (frame: Frame) => ({ player: at(frame, 0), platform: at(frame, 3), goal: at(frame, -3) });
    const before = sample(rig.draw(scene));

    const ext = rig.gl.getExtension('WEBGL_lose_context')!;
    const statuses: string[] = [];
    rig.renderer.onContextChange((status) => statuses.push(status));
    const next = (status: string) => new Promise<void>((resolve) => {
      const off = rig.renderer.onContextChange((s) => { if (s === status) { off(); resolve(); } });
    });
    const lostEvent = next('lost');
    ext.loseContext();
    await lostEvent;
    // Chrome only allows restoreContext once the lost event's dispatch has returned (it checks defaultPrevented
    // then); the promise above resumes inside that dispatch, so yield one task first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lostFlag = rig.renderer.isContextLost();
    rig.draw(scene); // must be a harmless no-op while lost
    const drawCallsWhileLost = rig.renderer.getDrawStats().drawCalls;

    const restoredEvent = next('restored');
    ext.restoreContext();
    await restoredEvent;
    const after = sample(rig.draw(scene));
    return { before, after, lostFlag, drawCallsWhileLost, lostAfter: rig.renderer.isContextLost(), statuses, drawCallsAfter: rig.renderer.getDrawStats().drawCalls };
  });
  expect(result.lostFlag).toBe(true);
  expect(result.drawCallsWhileLost).toBe(0);
  expect(result.lostAfter).toBe(false);
  expect(result.statuses).toEqual(['lost', 'restored']);
  expect(result.drawCallsAfter).toBeGreaterThan(0);
  const close = (actual: number[], expected: number[]) => {
    for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(2);
  };
  close(result.before.player, [255, 199, 115]);
  close(result.before.platform, [255, 255, 255]);
  close(result.after.player, result.before.player); // the loaded image texture was uploaded again
  close(result.after.platform, result.before.platform);
  close(result.after.goal, result.before.goal); // solid textures too
});
