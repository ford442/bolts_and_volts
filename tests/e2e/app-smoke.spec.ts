import { expect, test } from '@playwright/test';
import { routeWasmStub } from './wasmStub';

test('loads the app shell without console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await routeWasmStub(page, { levelName: 'Smoke Test Level', levelDescription: 'Loaded with a stubbed WASM module.' });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bolts & Volts' })).toBeVisible();
  await expect(page.getByText('Smoke Test Level')).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
