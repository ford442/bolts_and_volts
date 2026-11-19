# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation Map

- Docs hub: [`docs/README.md`](./docs/README.md)
- AI index: [`docs/ai/README.md`](./docs/ai/README.md)
- AGENTS guide: [`AGENTS.md`](./AGENTS.md)
- Grok guide: [`grok.md`](./grok.md)
- Copilot guide: [`.github/copilot-instructions.md`](./.github/copilot-instructions.md)
- Roadmap plan: [`docs/plans/PLAN.md`](./docs/plans/PLAN.md)
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)

## Project Overview

Bolts & Volts (previously referred to as WASM-Venture) is a browser-based 2D platformer. The character Wazzy (a dog robot) is controlled via arrow keys and Space. Game logic runs in C++ compiled to WebAssembly via Emscripten; TypeScript/React bridges the WASM module to a WebGL2 canvas renderer.

## Build & Dev Commands

```bash
# Install dependencies
npm install

# Run dev server (also compiles WASM first)
npm run dev

# Build WASM only
npm run build:wasm        # release (-O3); `npm run dev` uses build:wasm:debug

# Full production build
npm run build

# Lint
npm run lint

# Tests
npm run test
npm run test:e2e

# Preview production build
npm run preview
```

**Prerequisite:** Emscripten (`emcc`) must be on `PATH` for any command that compiles WASM. The `build:wasm` script outputs `src/wasm/main.js` + `main.wasm`. The Playwright smoke test does not require `emcc` because it stubs the WASM module.

## Architecture

### Data flow
```
C++ (Game logic) → Emscripten → src/wasm/main.js + main.wasm
                                      ↓
                            src/wasm/loader.ts   (TypeScript interface + module loader)
                                      ↓
                      src/components/GameCanvas.tsx  (React component, game loop)
                           ↙                  ↘
              src/gl/renderer.ts          src/audio/AudioManager.ts
              (WebGL2 rendering)          (Web Audio API)
```

### C++ side (`cpp/src/`)
- `Game.cpp / Game.hpp` — all game state: player physics, collision, camera, particle system, sound callbacks, level loading. Exposed to JS via Emscripten `embind`.
- `ParticleSystem.hpp` — particle emission/update logic.
- `Types.hpp` — shared structs (`Vec2`, `Platform`, `InputState`, `AnimationState`, `PlayerState`).
- The WASM module is exported as an ES6 factory called `createWasmModule` (not the older `createGameModule`).

### TypeScript/React side (`src/`)
- `wasm/loader.ts` — TypeScript interfaces mirroring the C++ embind exports; `loadWasmModule()` either uses an already-loaded global or injects `game.js` via a `<script>` tag.
- `gl/renderer.ts` — `Renderer` class: compiles GLSL shaders, manages two WebGL programs (sprite and background), loads textures, computes per-frame foot anchors from spritesheet pixel data, draws scene each frame.
- `gl/shaders/` — two shader pairs: `tex.vert/frag.glsl` (sprite/platform rendering with spritesheet UV math) and `background.vert/frag.glsl` (parallax scrolling background quad).
- `audio/AudioManager.ts` — wraps Web Audio API; music starts on first keypress (browser autoplay policy); SFX names (`jump`, `land`) are fired by a JS callback registered with `Game::setSoundCallback`.
- `components/GameCanvas.tsx` — mounts the canvas, owns the `requestAnimationFrame` loop, wires input/output between WASM and renderer, manages volume state and level-complete overlay.
- `components/App.tsx` — top-level React shell (minimal). (The old duplicate `src/App.tsx` mentioned in earlier versions of this doc was removed — `src/main.tsx` only ever imported `./components/App`.)

### Level-authoring hotkeys
`G` grid, `Shift+G` grid spacing (1 / 0.5 / 0.25), `H` authoring mode (HUD with mouse→world coords, strong platform outlines, dimmed player/particles, snap marker), `P` copy a platform JSON snippet at the snapped cursor (authoring mode only). State lives in `GameCanvas.tsx` refs; coordinate math in `src/lib/authoring.ts`; drawing in `Renderer.drawAuthoringOverlay`. `K` cull debug (visible-rect culling is render-only; `src/lib/culling.ts`, shrunken rect + drawn/total counters). Existing keys: `R` reload, `C` character, `E` ability, `1-9` level switch.

### Level format (`public/levels/*.json`)
Full schema: [`docs/architecture/level-format.md`](./docs/architecture/level-format.md)

```json
{
  "spawn": { "x": 0.0, "y": -1.0 },
  "bounds": { "min": { "x": -10.0, "y": -10.0 }, "max": { "x": 20.0, "y": 10.0 } },
  "platforms": [ { "position": { "x": 5.0, "y": -2.0 }, "size": { "x": 110.0, "y": 0.2 } } ],
  "goals":     [ { "position": { "x": 16.0, "y": 2.0 }, "size": { "x": 1.0, "y": 1.0 } } ]
}
```
Levels are fetched at runtime from `/levels/<name>.json` and passed as a plain JS object to `Game::loadLevel` via embind.
An optional `"camera"` block supports per-level camera tuning: `followY`, `verticalDeadzone`, and `lookAheadY`.
Without a `"camera"` block, behavior remains backward-compatible and the camera only follows X.

### Coordinate system
World units are used throughout (not pixels). The viewport shows 10 world-units wide, aspect-ratio-corrected. Positive Y is up. Player collision and camera positions come from WASM; the renderer applies a per-frame foot-anchor offset computed from spritesheet alpha to align sprites with collision boxes.

### Assets (`public/`)
- `wazzy_spritesheet.png` — 64×64 px frames, rows: 0=idle (2 frames), 1=run (4 frames), 2=jump (1 frame).
- `platform.png`, `background.png` — textures tiled/scrolled by the two shader programs.
- `background-music.mp3`, `jump.mp3`, `land.mp3` — audio assets loaded at init.
- `basic.vert/frag.glsl` shader pair in `src/gl/shaders/` is unused dead weight (nothing imports it). `wazzy.png` is *not* dead — `public/levels/demo-decor.json` references it via the `decor` array (see Known Issues below).

## Known Issues / Blockers (2026-09-07)

- **CI added (2026-11-19).** `.github/workflows/ci.yml` runs release WASM build, lint, `tsc -b`, unit and e2e tests on push/PR to `main` (emsdk pinned to 3.1.61). Not yet confirmed green on GitHub — check the first PR run. emcc flags live in `cpp/emscripten-*.response` (see `cpp/README.md`).
- **This file had drifted.** As of this audit it hadn't been updated in ~78 days despite ongoing commits, and `AGENTS.md`'s "Known Issues" list had three already-fixed items still listed as open (a `Game.cpp` compile error, a duplicate `App.tsx`, a hardcoded SFTP credential in `deploy.py` — all fixed). Fixed here and in `AGENTS.md`; worth rechecking both periodically against the actual code.
- **`decor` / `backgroundLayers` level fields aren't documented above.** `public/levels/demo-decor.json` (listed in `public/levels/manifest.json`, selectable in the level dropdown) uses `"decor"` and `"backgroundLayers"` arrays, fully handled client-side by `extractDecorConfigs` / `extractBackgroundLayerConfigs` in `src/components/GameCanvas.tsx` and drawn by `drawBackgroundLayer` in `src/gl/renderer.ts` — but the "Level format" section above only documents `spawn`/`bounds`/`platforms`/`goals`/`camera`. These fields never reach `Game::loadLevel` in C++; they're TS-only. `docs/plans/PLAN.md` §1 lists documenting this schema as a not-started roadmap item.
