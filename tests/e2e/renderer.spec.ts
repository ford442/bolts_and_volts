import { expect, test, type Page } from '@playwright/test';

// These tests drive `Renderer` directly in the browser (modules come from the Vite dev server), so they
// need neither the WASM module nor the full app: a tiny offscreen canvas and a handful of draw calls.

type Frame = { width: number; height: number; pixels: number[] };
type Rig = {
  renderer: { resize(size: { width: number; height: number; pixelRatio: number }): void; setCollisionDebug(on: boolean): void };
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  /** Render an empty scene plus the given goals/platforms and read the pixels back in the same task. */
  draw(opts: { goals?: unknown[]; platforms?: unknown[] }): Frame;
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
    const draw: Rig['draw'] = (opts) => {
      renderer.drawScene(
        { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 },
        (opts.platforms ?? []) as never[], [], null, null, [],
        { distant: [], mid: [], foreground: [] }, [], null,
        (opts.goals ?? []) as never[], 0, null, false
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
