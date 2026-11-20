import { expect, test } from '@playwright/test';
import { routeWasmStub } from './wasmStub';

declare global {
  interface Window { __commits: number }
}

// A minimal React DevTools hook: React calls onCommitFiberRoot once per committed render.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__commits = 0;
    (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() { return 1; },
      onCommitFiberRoot() { window.__commits++; },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  });
  await routeWasmStub(page, { levelName: 'Render Count Level', movingPlayer: true });
  await page.goto('/');
  await expect(page.getByText('Render Count Level')).toBeVisible();
});

test('the game loop updates the HUD without re-rendering React every frame', async ({ page }) => {
  const status = page.getByTestId('status-hud');
  await expect(status).toContainText('[BOLTS] pos:');

  const before = await page.evaluate(() => window.__commits);
  const textBefore = await status.textContent();
  // ~30 frames at 60 Hz; the stub moves the player every frame, so the HUD text changes every frame.
  await page.waitForTimeout(500);
  await expect(status).not.toHaveText(textBefore ?? '');
  const after = await page.evaluate(() => window.__commits);
  expect(before).toBeGreaterThan(0); // the hook is wired up
  expect(after - before).toBeLessThanOrEqual(1);

  // A real UI change still renders.
  await page.keyboard.press('k');
  await expect(page.getByTestId('cull-hud')).toBeVisible();
  expect(await page.evaluate(() => window.__commits)).toBeGreaterThan(after);
});
