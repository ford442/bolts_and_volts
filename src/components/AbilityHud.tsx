import type { Ref } from 'react';

/**
 * Markup for the ability overlay. The game loop fills it in (`createAbilityHudWriter`, src/game/abilityHud.ts), so
 * it renders once with no per-frame props — React never re-renders it as the ability changes.
 * Colours come from `--hud-accent` (the character's tint) and `data-state` on the root; see `.ability-hud-*` in index.css.
 */
const AbilityHud = ({ rootRef }: { rootRef: Ref<HTMLDivElement> }) => (
  <div
    ref={rootRef}
    data-testid="ability-hud"
    data-state="ready"
    style={{ marginTop: 6, width: 160 }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
      <span data-hud="character" data-testid="hud-character" style={{ fontWeight: 700, color: 'var(--hud-accent, #fff)' }} />
      <span data-hud="state" data-testid="hud-state" className="ability-hud-state" />
    </div>
    <div data-hud="ability" data-testid="hud-ability" style={{ opacity: 0.85 }} />
    <div
      data-hud="bar"
      role="progressbar"
      aria-label="Ability cooldown"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      style={{ marginTop: 3, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}
    >
      <div data-hud="fill" className="ability-hud-fill" style={{ height: '100%', width: '0%', background: 'var(--hud-accent, #fff)' }} />
    </div>
  </div>
);

export default AbilityHud;
