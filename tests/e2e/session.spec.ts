import { expect, test, type Page } from '@playwright/test';
import { PROGRESS_KEY } from '../../src/game/session';
import { routeWasmStub } from './wasmStub';

type StubHooks = { updates: number; restored: number[]; completeLevel: () => void; reachCheckpoint: (index: number) => void };
declare global {
  interface Window { __stub: StubHooks }
}

// a -> b ends the route; c names a level that is not in the manifest.
const MANIFEST = {
  levels: [
    { id: 'a', file: 'a.json', name: 'Alpha', next: 'b' },
    { id: 'b', file: 'b.json', name: 'Beta' },
    { id: 'c', file: 'c.json', name: 'Gamma', next: 'ghost' },
  ],
};

const onLevel = (page: Page, id: string) => expect(page.getByText(`level: ${id} (${id})`)).toBeVisible();

/** Boots on the manifest's first level; by then the stub module is loaded and the level-select handler is wired. */
const open = async (page: Page) => {
  await routeWasmStub(page, { levelName: 'Session Level' }, { manifest: MANIFEST });
  await page.goto('/');
  await onLevel(page, 'a');
  await expect(page.getByTestId('reset-progress')).toHaveText('Reset progress (0/3)');
};
const updates = (page: Page) => page.evaluate(() => window.__stub.updates);

test('the complete screen offers Next only when the manifest entry names a level, and never wraps', async ({ page }) => {
  await open(page);
  await onLevel(page, 'a');

  await page.evaluate(() => window.__stub.completeLevel());
  await expect(page.getByTestId('level-complete')).toBeVisible();
  await expect(page.getByTestId('complete-next')).toBeVisible();
  await expect(page.getByTestId('route-end')).toHaveCount(0);

  await page.getByTestId('complete-next').click();
  await onLevel(page, 'b');
  await expect(page.getByTestId('level-complete')).toHaveCount(0);

  // b has no `next`: the route ends, rather than wrapping to a.
  await page.evaluate(() => window.__stub.completeLevel());
  await expect(page.getByTestId('level-complete')).toBeVisible();
  await expect(page.getByTestId('complete-next')).toHaveCount(0);
  await expect(page.getByTestId('route-end')).toBeVisible();
  await expect(page.getByTestId('complete-reload')).toBeVisible();
});

test('a next that names no manifest entry ends the route too', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
  await open(page);
  await page.getByRole('combobox').selectOption('c');
  await onLevel(page, 'c');

  await page.evaluate(() => window.__stub.completeLevel());
  await expect(page.getByTestId('route-end')).toBeVisible();
  await expect(page.getByTestId('complete-next')).toHaveCount(0);
  expect(warnings.join('\n')).toContain('"ghost"');
});

test('Escape pauses the simulation and resumes it; the complete screen pauses until a level loads', async ({ page }) => {
  await open(page);
  await expect.poll(() => updates(page)).toBeGreaterThan(3);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-overlay')).toBeVisible();
  const frozen = await updates(page);
  await page.waitForTimeout(250);
  expect(await updates(page)).toBe(frozen);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
  await expect.poll(() => updates(page)).toBeGreaterThan(frozen);

  // Level complete pauses; Escape does not lift it.
  await page.evaluate(() => window.__stub.completeLevel());
  await expect(page.getByTestId('level-complete')).toBeVisible();
  const stopped = await updates(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await expect(page.getByTestId('level-complete')).toBeVisible();
  await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
  expect(await updates(page)).toBe(stopped);

  // Next clears it.
  await page.getByTestId('complete-next').click();
  await onLevel(page, 'b');
  await expect.poll(() => updates(page)).toBeGreaterThan(stopped);
});

test('finished levels and the active checkpoint survive a reload; Reset progress clears them', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__stub.completeLevel());
  await page.getByTestId('complete-next').click();
  await onLevel(page, 'b');
  await expect(page.getByTestId('reset-progress')).toHaveText('Reset progress (1/3)');

  await page.evaluate(() => window.__stub.reachCheckpoint(2));
  await page.reload();
  await expect(page.getByTestId('reset-progress')).toHaveText('Reset progress (1/3)');
  await onLevel(page, 'b');  // first level not finished
  expect(await page.evaluate(() => window.__stub.restored)).toEqual([2]);  // and the checkpoint is put back on

  await page.getByTestId('reset-progress').click();
  await onLevel(page, 'a');
  await expect(page.getByTestId('reset-progress')).toHaveText('Reset progress (0/3)');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), PROGRESS_KEY)).toBeNull();
  await page.reload();
  await onLevel(page, 'a');
  expect(await page.evaluate(() => window.__stub.restored)).toEqual([]);
});
