import { expect, test } from '@playwright/test';
import { routeWasmStub, type StubScene } from './wasmStub';

// Stubbed WASM: a static scene with one platform, camera at the origin.
const SCENE: StubScene = {
  levelName: 'Authoring Test Level',
  platforms: [{ position: { x: 1, y: -1 }, size: { x: 4, y: 0.3 } }],
};

test.beforeEach(async ({ page }) => {
  await routeWasmStub(page, SCENE);
  await page.goto('/');
  await expect(page.getByText('Authoring Test Level')).toBeVisible();
});

test('H shows the authoring HUD with world coordinates under the mouse', async ({ page }) => {
  const canvas = page.locator('canvas');
  const hud = page.getByTestId('authoring-hud');
  await expect(hud).toHaveCount(0);

  const box = (await canvas.boundingBox())!;
  // Centre of the canvas content box (the 2px border is excluded, but it is symmetric) == camera position.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('h');
  await expect(hud).toBeVisible();
  await expect(hud).toContainText('mouse  0.00, 0.00');

  // 1 world unit == width/10 screen pixels, so +2 units right / +1 unit up from the centre:
  await page.mouse.move(box.x + box.width / 2 + box.width / 5, box.y + box.height / 2 - box.width / 10);
  await expect(hud).toContainText(/mouse {2}2\.0\d, 1\.0\d/);
  await expect(hud).toContainText('snap   2.00, 1.00');

  await page.keyboard.press('h');
  await expect(hud).toHaveCount(0);
});

test('G toggles the grid overlay and Shift+G cycles spacing, without touching other state', async ({ page }) => {
  const canvas = page.locator('canvas');
  const off = await canvas.screenshot();
  await page.keyboard.press('g');
  const on = await canvas.screenshot();
  expect(on.equals(off)).toBe(false);

  await page.keyboard.press('Shift+G');
  const finer = await canvas.screenshot();
  expect(finer.equals(on)).toBe(false);

  // Back to the starting spacing (1 -> 0.5 -> 0.25 -> 1), then off.
  await page.keyboard.press('Shift+G');
  await page.keyboard.press('Shift+G');
  expect((await canvas.screenshot()).equals(on)).toBe(true);
  await page.keyboard.press('g');
  expect((await canvas.screenshot()).equals(off)).toBe(true);

  // Existing UI is untouched: still on the same level.
  await expect(page.getByText(/^level:/)).toBeVisible();
});

test('authoring mode changes the render (outlines, dimmed player) and reverts cleanly', async ({ page }) => {
  const canvas = page.locator('canvas');
  const normal = await canvas.screenshot();
  await page.keyboard.press('h');
  expect((await canvas.screenshot()).equals(normal)).toBe(false);
  await page.keyboard.press('h');
  expect((await canvas.screenshot()).equals(normal)).toBe(true);
});

test('hotkeys are ignored with Ctrl held', async ({ page }) => {
  const canvas = page.locator('canvas');
  const before = await canvas.screenshot();
  await page.keyboard.press('Control+g');
  expect((await canvas.screenshot()).equals(before)).toBe(true);
});
