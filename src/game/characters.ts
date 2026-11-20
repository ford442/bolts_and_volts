import type { Tint } from '../gl/renderer';

/**
 * How each dog is presented. The ids are `CharacterType` in cpp/src/Types.hpp (the snapshot's `character`),
 * and the ability is the one `Simulation::useAbility` runs for that character. Presentation only: no tuning here.
 */
export interface CharacterPresentation {
  name: string;
  ability: string;
  /** Applied to the player sprite (shared sheet, so the tint is what tells the dogs apart). */
  tint: Tint;
}

export const CHARACTERS: readonly CharacterPresentation[] = [
  { name: 'Bolts', ability: 'Ground Pound', tint: [1.0, 0.78, 0.45, 1.0] }, // warm metal; the sheet is blue, so drop its hue first or it comes out green
  { name: 'Volts', ability: 'Hover', tint: [0.55, 0.95, 1.0, 0.0] }, // cool cyan; already blue, a plain multiply keeps its shading
];

/** Unknown ids fall back to Bolts, like the sim's default character. */
export const characterPresentation = (character: number): CharacterPresentation =>
  CHARACTERS[character] ?? CHARACTERS[0];

/** The tint's colour as CSS, so the HUD accent always matches the sprite. */
export const tintToCss = (tint: Tint): string =>
  `rgb(${tint.slice(0, 3).map((channel) => Math.round(channel * 255)).join(', ')})`;
