import { AbilityState, type FrameState } from './snapshot';
import { characterPresentation, tintToCss } from './characters';

export type AbilityHudState = 'ready' | 'active' | 'cooldown';

export interface AbilityHudView {
  character: string;
  ability: string;
  state: AbilityHudState;
  /** Bar fill, whole percent 0..100 (so the DOM is only touched when it visibly changes). */
  percent: number;
  /** CSS colour of the character's tint. */
  accent: string;
}

const STATE_BY_ABILITY: Record<number, AbilityHudState> = {
  [AbilityState.Ready]: 'ready',
  [AbilityState.Active]: 'active',
  [AbilityState.Cooldown]: 'cooldown',
};

export const STATE_LABELS: Record<AbilityHudState, string> = { ready: 'Ready', active: 'Active', cooldown: 'Cooldown' };

/**
 * What the ability overlay shows for a frame. The bar is `getAbilityCooldownPercent` as the sim reports it:
 * empty when ready, full while active, then draining to empty over the cooldown.
 */
export const abilityHudView = (frame: Pick<FrameState, 'character' | 'abilityState' | 'abilityCooldown'>): AbilityHudView => {
  const presentation = characterPresentation(frame.character);
  const fill = Math.min(1, Math.max(0, frame.abilityCooldown));
  return {
    character: presentation.name,
    ability: presentation.ability,
    state: STATE_BY_ABILITY[frame.abilityState] ?? 'ready',
    percent: Math.round(fill * 100),
    accent: tintToCss(presentation.tint),
  };
};

/**
 * Hooks up the overlay markup (see components/AbilityHud.tsx) and returns the per-frame updater. It writes
 * straight to the DOM and only when a value changed — it runs at display refresh rate and must not go through
 * React state.
 */
export const createAbilityHudWriter = (root: HTMLElement): ((frame: FrameState) => void) => {
  const part = (name: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>(`[data-hud="${name}"]`);
    if (!el) throw new Error(`ability HUD is missing its "${name}" element`);
    return el;
  };
  const characterEl = part('character');
  const abilityEl = part('ability');
  const stateEl = part('state');
  const barEl = part('bar');
  const fillEl = part('fill');

  let last: AbilityHudView | null = null;
  return (frame) => {
    const view = abilityHudView(frame);
    if (last && view.character === last.character && view.state === last.state && view.percent === last.percent) return;
    if (!last || view.character !== last.character) {
      characterEl.textContent = view.character;
      abilityEl.textContent = view.ability;
      root.style.setProperty('--hud-accent', view.accent);
    }
    if (!last || view.state !== last.state) {
      stateEl.textContent = STATE_LABELS[view.state];
      root.dataset.state = view.state;
    }
    if (!last || view.percent !== last.percent) {
      fillEl.style.width = `${view.percent}%`;
      barEl.setAttribute('aria-valuenow', String(view.percent));
    }
    last = view;
  };
};
