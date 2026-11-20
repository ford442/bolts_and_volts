import { describe, expect, it } from 'vitest';
import { abilityHudView } from '../../src/game/abilityHud';
import { CHARACTERS, characterPresentation, tintToCss } from '../../src/game/characters';
import { AbilityState } from '../../src/game/snapshot';

describe('characterPresentation', () => {
  it('names Bolts and Volts with their abilities, indexed by the sim CharacterType', () => {
    expect(characterPresentation(0)).toMatchObject({ name: 'Bolts', ability: 'Ground Pound' });
    expect(characterPresentation(1)).toMatchObject({ name: 'Volts', ability: 'Hover' });
  });

  it('falls back to Bolts for an unknown id', () => {
    expect(characterPresentation(7)).toBe(CHARACTERS[0]);
    expect(characterPresentation(-1)).toBe(CHARACTERS[0]);
  });

  it('gives the dogs different tints, none of them the identity', () => {
    const [bolts, volts] = CHARACTERS.map((c) => c.tint);
    expect(bolts).not.toEqual(volts);
    for (const tint of [bolts, volts]) expect(tint).not.toEqual([1, 1, 1, 0]);
  });

  it('renders a tint as the CSS colour the HUD accent uses', () => {
    expect(tintToCss([1, 0.5, 0, 1])).toBe('rgb(255, 128, 0)'); // desaturate is not part of the colour
  });
});

describe('abilityHudView', () => {
  const view = (character: number, abilityState: number, abilityCooldown: number) =>
    abilityHudView({ character, abilityState, abilityCooldown });

  it('reads ready with an empty bar', () => {
    expect(view(0, AbilityState.Ready, 0)).toMatchObject({ character: 'Bolts', ability: 'Ground Pound', state: 'ready', percent: 0 });
  });

  it('reads active with a full bar (the sim reports 1 while active)', () => {
    expect(view(1, AbilityState.Active, 1)).toMatchObject({ character: 'Volts', ability: 'Hover', state: 'active', percent: 100 });
  });

  it('reads cooldown as the draining fraction, in whole percent', () => {
    expect(view(0, AbilityState.Cooldown, 0.5)).toMatchObject({ state: 'cooldown', percent: 50 });
    expect(view(0, AbilityState.Cooldown, 0.333)).toMatchObject({ percent: 33 });
  });

  it('clamps a stray cooldown value into 0..100', () => {
    expect(view(0, AbilityState.Cooldown, 1.4).percent).toBe(100);
    expect(view(0, AbilityState.Cooldown, -0.2).percent).toBe(0);
  });

  it('treats an unknown ability state as ready', () => {
    expect(view(0, 9, 0).state).toBe('ready');
  });

  it('accents the HUD with the character tint', () => {
    expect(view(0, AbilityState.Ready, 0).accent).toBe(tintToCss(CHARACTERS[0].tint));
    expect(view(1, AbilityState.Ready, 0).accent).toBe(tintToCss(CHARACTERS[1].tint));
  });
});
