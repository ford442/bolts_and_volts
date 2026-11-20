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
  await routeWasmStub(page, { levelName: 'Render Count Level', abilityState: 2, abilityCooldown: 1, drainingAbility: true });
  await page.goto('/');
  await expect(page.getByText('Render Count Level')).toBeVisible();
});

test('the game loop updates the HUD without re-rendering React every frame', async ({ page }) => {
  const bar = page.getByRole('progressbar', { name: 'Ability cooldown' });
  await expect(page.getByTestId('hud-character')).toHaveText('Bolts');

  const before = await page.evaluate(() => window.__commits);
  const valueBefore = await bar.getAttribute('aria-valuenow');
  // ~30 frames at 60 Hz; the stub drains the cooldown every frame, so the HUD bar changes every frame.
  await page.waitForTimeout(500);
  await expect(bar).not.toHaveAttribute('aria-valuenow', valueBefore ?? '');
  const after = await page.evaluate(() => window.__commits);
  expect(before).toBeGreaterThan(0); // the hook is wired up
  expect(after - before).toBeLessThanOrEqual(1);

  // A real UI change still renders.
  await page.keyboard.press('k');
  await expect(page.getByTestId('cull-hud')).toBeVisible();
  expect(await page.evaluate(() => window.__commits)).toBeGreaterThan(after);
});
