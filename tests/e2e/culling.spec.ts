import { expect, test } from '@playwright/test';
import { routeWasmStub, type StubScene } from './wasmStub';

// Stubbed WASM: camera at the origin, one platform in view and two far outside it. The snapshot carries no
// geometry: the three platforms reach the renderer from the (stubbed) level JSON passed to loadLevel.
const SCENE: StubScene = {
  levelName: 'Cull Test Level',
  platforms: [
    { position: { x: 1, y: -1 }, size: { x: 4, y: 0.3 } },
    { position: { x: 60, y: -1 }, size: { x: 4, y: 0.3 } },
    { position: { x: -60, y: 30 }, size: { x: 4, y: 0.3 } },
  ],
};

test.beforeEach(async ({ page }) => {
  await routeWasmStub(page, SCENE);
  await page.goto('/');
  await expect(page.getByText('Cull Test Level')).toBeVisible();
});

test('K shows cull counters: only the on-screen platform is drawn', async ({ page }) => {
  const hud = page.getByTestId('cull-hud');
  await expect(hud).toHaveCount(0);
  await page.keyboard.press('k');
  await expect(hud).toBeVisible();
  await expect(hud).toContainText('platforms 1/3');
  await page.keyboard.press('k');
  await expect(hud).toHaveCount(0);
});
