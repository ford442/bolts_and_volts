import { expect, test, type Page } from '@playwright/test';

// Stubbed WASM: a static scene, so only the canvas sizing logic is under test.
const STUB = `
  class Vector {
    constructor(items) { this.items = items; }
    get(index) { return this.items[index]; }
    size() { return this.items.length; }
  }
  class Game {
    update() {}
    handleInput() {}
    getPlayerPosition() { return { x: -3, y: 1 }; }
    getPlayerSize() { return { x: 1, y: 1 }; }
    getCameraPosition() { return { x: 0, y: 0 }; }
    getPlatforms() { return new Vector([]); }
    getGoals() { return new Vector([]); }
    getParticles() { return new Vector([]); }
    getPlayerAnimationState() { return { currentState: 'idle', currentFrame: 0, facingLeft: false }; }
    getLevelName() { return 'Canvas Size Test Level'; }
    getLevelDescription() { return ''; }
    setSoundCallback() {}
    loadLevel() {}
    setLevelCompleteCallback() {}
    switchCharacter() {}
    getCurrentCharacter() { return 0; }
    useAbility() {}
    getAbilityState() { return 0; }
    getAbilityCooldownPercent() { return 0; }
    delete() {}
  }
  export default async function createWasmModule() { return { Game }; }
`;

type CanvasMetrics = { width: number; height: number; clientWidth: number; clientHeight: number };

const metrics = (page: Page) =>
  page.evaluate((): CanvasMetrics => {
    const canvas = document.querySelector('canvas')!;
    return { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight };
  });

/** Wait until the backing store is `ratio` x the CSS box (and settled), then return the metrics. */
async function settledMetrics(page: Page, ratio: number): Promise<CanvasMetrics> {
  await expect
    .poll(async () => {
      const m = await metrics(page);
      return m.clientWidth > 0 && m.width === Math.round(m.clientWidth * ratio) && m.height === Math.round(m.clientHeight * ratio);
    }, { timeout: 30_000 })
    .toBe(true);
  return metrics(page);
}

async function openApp(page: Page) {
  await page.route('**/src/wasm/main.js*', (route) => route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: STUB }));
  await page.goto('/');
  // Software GL at 2x can be slow to initialise; this wait is not what the tests are about.
  await expect(page.getByText('Canvas Size Test Level')).toBeVisible({ timeout: 30_000 });
}

test.describe('1x display', () => {
  test('backing store matches the canvas box, follows window resizes, and the box stays 16:9', async ({ page }) => {
    await openApp(page);
    const first = await settledMetrics(page, 1);
    expect(first.clientWidth / first.clientHeight).toBeCloseTo(16 / 9, 1);

    await page.setViewportSize({ width: 900, height: 700 });
    const smaller = await settledMetrics(page, 1);
    expect(smaller.width).toBeLessThan(first.width);
    // The canvas must not size its own box (intrinsic size -> layout -> backing store feedback): still 16:9.
    expect(smaller.clientWidth / smaller.clientHeight).toBeCloseTo(16 / 9, 1);

    await page.setViewportSize({ width: 1400, height: 900 });
    const larger = await settledMetrics(page, 1);
    expect(larger.width).toBeGreaterThan(smaller.width);
    expect(larger.clientWidth / larger.clientHeight).toBeCloseTo(16 / 9, 1);
  });

  test('a canvas box that is not 16:9 gets a matching backing store and an undistorted view', async ({ page }) => {
    await openApp(page);
    await settledMetrics(page, 1);
    await page.evaluate(() => { document.querySelector('canvas')!.style.height = '300px'; });
    const m = await settledMetrics(page, 1);
    expect(m.clientHeight).toBe(300);

    // The authoring HUD derives its view from the backing-store aspect: 10 units wide, 10 * h / w tall.
    await page.keyboard.press('h');
    const expectedHalfHeight = (5 * m.height) / m.width;
    const hud = page.getByTestId('authoring-hud');
    await expect(hud).toContainText('x -5.00..5.00');
    await expect(hud).toContainText(`y ${(-expectedHalfHeight).toFixed(2)}..${expectedHalfHeight.toFixed(2)}`);
  });
});

test.describe('devicePixelRatio change', () => {
  test.use({ viewport: { width: 560, height: 520 } });

  test('re-sizes the backing store when only the ratio changes (zoom, moving between monitors)', async ({ page }) => {
    await openApp(page);
    const before = await settledMetrics(page, 1);

    // Same CSS viewport, so the canvas box and the ResizeObserver are untouched; only devicePixelRatio moves.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 520, deviceScaleFactor: 2, mobile: false });
    const after = await settledMetrics(page, 2);
    expect(after.clientWidth).toBe(before.clientWidth);
    expect(after.clientHeight).toBe(before.clientHeight);
    expect(after.width).toBe(before.width * 2);
  });
});

test.describe('2x display', () => {
  // Small viewport: software GL (CI) is fill-rate bound and a 2x buffer at 1280x720 stalls the page.
  test.use({ deviceScaleFactor: 2, viewport: { width: 560, height: 520 } });

  test('backing store is twice the CSS box, so sprites are not upscaled', async ({ page }) => {
    await openApp(page);
    const m = await settledMetrics(page, 2);
    expect(m.width).toBe(m.clientWidth * 2);
    expect(m.height).toBe(m.clientHeight * 2);
  });
});
