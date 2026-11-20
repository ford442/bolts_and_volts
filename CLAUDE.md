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
npm run test:sim          # native C++ simulation tests (host g++/clang++; no emsdk, no browser)

# Preview production build
npm run preview
```

**Prerequisite:** Emscripten (`emcc`) must be on `PATH` for any command that compiles WASM. The `build:wasm` script outputs `src/wasm/main.js` + `main.wasm`. The Playwright smoke test does not require `emcc` because it stubs the WASM module. `npm run test:sim` needs only a host C++17 compiler (`scripts/test-sim.sh`, output in `build/native/`).

## Architecture

### Data flow
```
C++ (Game logic) → Emscripten → src/wasm/main.js + main.wasm
                                      ↓
                            src/wasm/loader.ts   (TypeScript interface + module loader)
                                      ↓
                      src/game/loop.ts  (rAF, fixed 1/60 step, one snapshot read per frame)
                           ↙                  ↘
              src/gl/renderer.ts          src/components/GameCanvas.tsx
              (WebGL2 rendering)          (React shell: level select, volume, overlays; no per-frame state)
```

Layering: C++ owns physics, collision, abilities, camera, goals and particle simulation. `src/gl` owns GL only. `src/game/loop.ts` owns the per-frame work and never touches React state. React re-renders only on level change, volume, hotkey toggles and level complete — per-frame HUD text is written to DOM refs.

### C++ side (`cpp/src/`)
- `sim/Simulation.hpp / .cpp` — the deterministic platformer core: player body, platforms, goals, character + ability, camera follow, animation state. **No emscripten include, no RNG, no JSON** — it takes an already-parsed `LevelSpec`. Built into the WASM and, on its own, into the native tests.
- `sim/SimEvent.hpp` — what a sim call produced (`Jumped`, `Landed`, `PoundStarted`, `PoundImpact`, `HoverStarted`, `HoverTick`, `Running`, `CharacterSwitched`, `GoalReached`), drained with `drainEvents`. The sim never reads them back.
- `Game.cpp / Game.hpp` — the embind adapter: `loadLevel` copies `val` fields into a `LevelSpec`, `handleInput`/`update` forward to the sim, `dispatchEvents` turns events into particles, sound names (`jump`, `land`, `ground_pound`, `hover`, `switch`) and the level-complete callback, `captureFrame` packs the snapshot. Gameplay rules belong in the sim, not here.
- `ParticleSystem.hpp` — cosmetic only, fed by sim events (`onEvent`); owns a seeded xorshift32 (`ParticleRng`). Not used by the native tests.
- `Types.hpp` — shared structs (`Vec2`, `Platform`, `InputState`, `AnimationState`, `PlayerState`), tuning (`Physics`, `CharacterStats`) and `FrameLayout`, the float layout of the per-frame snapshot.
- **Tick order** (`Simulation::update`): buffered/coyote jump → horizontal accel → ability and buffer timers → gravity (skipped on the takeoff tick; the tuned jump heights assume it) → vertical move + resolve, which **sets grounded** (gravity also runs while standing so the small step down re-detects the floor) → horizontal move + resolve → landing/coyote bookkeeping → animation → camera → goals. Landing events fire on the tick of contact.
- **Collision details:** a vertical move longer than half of (player half-height + thinnest platform half-height) is split into substeps so fast falls cannot pass, or be pushed, through thin platforms (normal play is one step). Overlaps of ≤ `CONTACT_EPSILON` (1e-4) are contact, not penetration — without it, float rounding of the resting height makes the horizontal pass eject the player to a platform edge (e.g. test-1's spawn floor).
- **Frame snapshot:** `Game::captureFrame()` packs player, camera, anim state (`PlayerState` as an int), character, ability, platforms, goals and particles into one `std::vector<float>`; `framePtr()` gives its heap address. JS views it via `HEAPF32` (exported with `-sEXPORTED_RUNTIME_METHODS=HEAPF32`). `FrameLayout` and `FRAME` in `src/game/snapshot.ts` must change together.
- **Fixed step:** `Game::update` is called with exactly 1/60 s by the TS loop (up to 4 ticks per rendered frame, then backlog is dropped). Its 33 ms clamp (`Simulation::MAX_STEP`) is only a guard.
- **Native tests:** `tests/native/sim_tests.cpp` (doctest, vendored at `tests/native/third_party/doctest/`) drives `Simulation` tick by tick (`handleInput` then `update(1/60)`). Built with `-ffp-contract=off` (wasm has no FMA), so native positions match the WASM build bit for bit (checked on walk/jump/pound/hover traces, 2026-11-20). Add a case there with any change to movement, collision or abilities.
- The WASM module is exported as an ES6 factory called `createWasmModule`. The legacy `game.js` / `window.createGameModule` loader paths were removed.

### TypeScript/React side (`src/`)
- `wasm/loader.ts` — TypeScript interfaces mirroring the C++ embind exports; `loadWasmModule()` dynamic-imports `src/wasm/main.js` and calls its default factory. `loadLevel` takes a `CoreLevel`.
- `game/snapshot.ts` — snapshot layout (`FRAME`), `AnimState`, and `readFrame`, which decodes into a reused `FrameState` (no per-frame allocation). Re-wrap the heap view every frame (`viewFrame`): memory growth detaches the old buffer.
- `game/loop.ts` — `startGameLoop` (rAF → fixed-step `handleInput`/`update` → `captureFrame` → `drawScene`) and the pure `advanceAccumulator`.
- `game/input.ts` — `KeyboardInput`, held-key state for the simulation. One-shot hotkeys stay as keydown handlers in `GameCanvas`.
- `game/levelAssets.ts` — turns parsed background/decor configs into texture-backed layers (cached per URL).
- `lib/levelData.ts` — `normalizeLevelData` and the decor/background parsers: level JSON → `CoreLevel` (for C++) + TS-only render data.
- `gl/renderer.ts` — `Renderer` class: creates an opaque, non-MSAA, depth-less WebGL2 context (`CONTEXT_ATTRIBUTES`; `desynchronized` is requested with one retry without it), compiles GLSL shaders, manages two WebGL programs (sprite and background) each with a VAO bound alongside the program, loads textures, computes per-frame foot anchors from spritesheet pixel data, draws scene each frame. Constant GL state (blend, depth/scissor off, `UNPACK_ALIGNMENT`) is set once at init; the projection and viewport are rebuilt in `resize()`. Red/green collision boxes are off by default (`setCollisionDebug`).
- `gl/shaders/` — two shader pairs: `tex.vert/frag.glsl` (sprite/platform rendering with spritesheet UV math) and `background.vert/frag.glsl` (parallax scrolling background quad).
- `audio/AudioManager.ts` — wraps Web Audio API; music starts on first keypress (browser autoplay policy); SFX names (`jump`, `land`) are fired by a JS callback registered with `Game::setSoundCallback`.
- `lib/canvasSize.ts` — `observeCanvasSize` reports the canvas's backing-store size (CSS content box × `min(devicePixelRatio, 2)`) on `ResizeObserver` and DPR changes; `backingStoreSize` is the pure part (unit-tested).
- `components/GameCanvas.tsx` — mounts the canvas, loads the WASM module/level/assets, starts the game loop, owns level select, volume, hotkeys and the level-complete overlay. No `useState` is set per frame. The canvas has no fixed `width`/`height`; the game loop applies the latest observed size via `renderer.resize()` right before drawing. The canvas is `position: absolute` in its wrapper on purpose: in flow, its intrinsic size (the backing store) feeds back into the flex layout and the box ratchets larger.
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
World units are used throughout (not pixels). The viewport shows 10 world-units across the canvas's backing-store width, with the height following the canvas aspect ratio (no letterboxing). Positive Y is up. Player collision and camera positions come from WASM; the renderer applies a per-frame foot-anchor offset computed from spritesheet alpha to align sprites with collision boxes.

### Assets (`public/`)
- `wazzy_spritesheet.png` — 64×64 px frames, rows: 0=idle (2 frames), 1=run (4 frames), 2=jump (1 frame).
- `platform.png`, `background.png` — textures tiled/scrolled by the two shader programs.
- `background-music.mp3`, `jump.mp3`, `land.mp3` — audio assets loaded at init.
- `wazzy.png` is *not* dead — `public/levels/demo-decor.json` references it via the `decor` array (see Known Issues below).

## Known Issues / Blockers (2026-09-07)

- **CI added (2026-11-19).** `.github/workflows/ci.yml` runs native sim tests (`npm run test:sim`, before emsdk is installed), release WASM build, lint, `tsc -b`, unit and e2e tests on push/PR to `main` (emsdk pinned to 3.1.61). Not yet confirmed green on GitHub — check the first PR run. emcc flags live in `cpp/emscripten-*.response` (see `cpp/README.md`).
- **This file had drifted.** As of this audit it hadn't been updated in ~78 days despite ongoing commits, and `AGENTS.md`'s "Known Issues" list had three already-fixed items still listed as open (a `Game.cpp` compile error, a duplicate `App.tsx`, a hardcoded SFTP credential in `deploy.py` — all fixed). Fixed here and in `AGENTS.md`; worth rechecking both periodically against the actual code.
- **`decor` / `backgroundLayers` level fields aren't documented above.** `public/levels/demo-decor.json` (listed in `public/levels/manifest.json`, selectable in the level dropdown) uses `"decor"` and `"backgroundLayers"` arrays, fully handled client-side by `extractDecorConfigs` / `extractBackgroundLayerConfigs` in `src/lib/levelData.ts` and drawn by `drawBackgroundLayer` in `src/gl/renderer.ts` — but the "Level format" section above only documents `spawn`/`bounds`/`platforms`/`goals`/`camera`. These fields never reach `Game::loadLevel` in C++; they're TS-only. `docs/plans/PLAN.md` §1 lists documenting this schema as a not-started roadmap item.
