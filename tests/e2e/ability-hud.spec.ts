import { expect, test } from '@playwright/test';
import { routeWasmStub, type StubScene } from './wasmStub';

const open = async (page: Parameters<typeof routeWasmStub>[0], scene: Partial<StubScene> = {}) => {
  await routeWasmStub(page, { levelName: 'HUD Level', ...scene });
  await page.goto('/');
  await expect(page.getByText('HUD Level')).toBeVisible();
};

test('the HUD names the character and its ability, and C switches both', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('hud-character')).toHaveText('Bolts');
  await expect(page.getByTestId('hud-ability')).toHaveText('Ground Pound');

  await page.keyboard.press('c');
  await expect(page.getByTestId('hud-character')).toHaveText('Volts');
  await expect(page.getByTestId('hud-ability')).toHaveText('Hover');

  await page.keyboard.press('c');
  await expect(page.getByTestId('hud-character')).toHaveText('Bolts');
});

test('the HUD shows ready, active and cooldown with the bar from the snapshot', async ({ page }) => {
  const hud = page.getByTestId('ability-hud');
  const bar = page.getByRole('progressbar', { name: 'Ability cooldown' });

  await open(page);
  await expect(page.getByTestId('hud-state')).toHaveText('Ready');
  await expect(hud).toHaveAttribute('data-state', 'ready');
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await page.unrouteAll();

  await open(page, { abilityState: 1, abilityCooldown: 1 });
  await expect(page.getByTestId('hud-state')).toHaveText('Active');
  await expect(hud).toHaveAttribute('data-state', 'active');
  await expect(bar).toHaveAttribute('aria-valuenow', '100');
  await page.unrouteAll();

  await open(page, { abilityState: 2, abilityCooldown: 0.4 });
  await expect(page.getByTestId('hud-state')).toHaveText('Cooldown');
  await expect(hud).toHaveAttribute('data-state', 'cooldown');
  await expect(bar).toHaveAttribute('aria-valuenow', '40');
});

test('every sound the simulation can emit has an audio file that loads', async ({ page }) => {
  const sfx = ['jump', 'land', 'ground_pound', 'hover', 'switch'];
  const responses = new Map<string, string>();
  page.on('response', (response) => {
    const name = new URL(response.url()).pathname.slice(1);
    // Status and type: a missing file must not pass as a 200 HTML fallback that `decodeAudioData` then rejects.
    if (sfx.some((s) => name === `${s}.mp3`)) responses.set(name, `${response.status()} ${response.headers()['content-type']}`);
  });
  await open(page);
  await expect.poll(() => responses.size).toBe(sfx.length);
  for (const name of sfx) expect(responses.get(`${name}.mp3`), name).toMatch(/^200 audio\//);
});
