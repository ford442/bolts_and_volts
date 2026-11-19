import { expect, test } from '@playwright/test';

// Stubbed WASM: camera at the origin, one platform in view and two far outside it.
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
    getPlatforms() {
      return new Vector([
        { position: { x: 1, y: -1 }, size: { x: 4, y: 0.3 } },
        { position: { x: 60, y: -1 }, size: { x: 4, y: 0.3 } },
        { position: { x: -60, y: 30 }, size: { x: 4, y: 0.3 } },
      ]);
    }
    getGoals() { return new Vector([]); }
    getParticles() { return new Vector([]); }
    getPlayerAnimationState() { return { currentState: 'idle', currentFrame: 0, facingLeft: false }; }
    getLevelName() { return 'Cull Test Level'; }
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

test.beforeEach(async ({ page }) => {
  await page.route('**/src/wasm/main.js*', (route) => route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: STUB }));
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
