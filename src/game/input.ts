import type { InputState } from '../wasm/loader';

/** Held-key state for the keys the simulation reads. One-shot keys (R, C, digits, authoring) are handled as events. */
export class KeyboardInput {
  private held = { ArrowLeft: false, ArrowRight: false, Space: false, KeyE: false };

  private readonly onKeyDown = (e: KeyboardEvent) => this.set(e.code, true);
  private readonly onKeyUp = (e: KeyboardEvent) => this.set(e.code, false);
  private readonly target: Window;

  constructor(target: Window = window) {
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
  }

  private set(code: string, down: boolean) {
    if (code in this.held) this.held[code as keyof typeof this.held] = down;
  }

  /** Fresh object per call: `handleInput` is an embind value_object, so it copies the fields anyway. */
  snapshot(): InputState {
    return {
      left: this.held.ArrowLeft,
      right: this.held.ArrowRight,
      jump: this.held.Space,
      abilityKey: this.held.KeyE,
    };
  }

  dispose() {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
  }
}
