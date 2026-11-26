# Bolts & Volts — Agent Guide

> This file is written for AI coding agents. The reader is assumed to know nothing about the project.

## Documentation Map

- Docs hub: [`docs/README.md`](./docs/README.md)
- AI index: [`docs/ai/README.md`](./docs/ai/README.md)
- Claude guide: [`CLAUDE.md`](./CLAUDE.md)
- Grok guide: [`grok.md`](./grok.md)
- Copilot guide: [`.github/copilot-instructions.md`](./.github/copilot-instructions.md)
- Roadmap plan: [`docs/plans/PLAN.md`](./docs/plans/PLAN.md)
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)

## Project Overview

**Bolts & Volts** is a 2D browser platformer. The player controls Wazzy, a small dog robot, navigating levels to collect ship parts and return home.

- **Core logic:** C++ (physics, collision, animation state machine, particle system)
- **Compilation target:** WebAssembly via Emscripten (`emcc`)
- **Frontend / bridge:** TypeScript + React 19
- **Rendering:** WebGL2 on an HTML Canvas element
- **Build tool:** Vite

## Technology Stack

| Layer | Tech |
|-------|------|
| Game engine | C++17-ish (no external C++ deps) |
| WASM toolchain | Emscripten (`emcc`) with **embind** |
| Frontend framework | React 19 (functional components + hooks) |
| Language | TypeScript 5.8 (strict mode) |
| Bundler / dev server | Vite 7 |
| Renderer | Raw WebGL2 (GLSL ES 3.0) |
| Audio | Web Audio API (`AudioContext`) |
| Deployment | Python 3 + Paramiko (SFTP upload) |

## Project Structure

```
├── cpp/src/                    # C++ game engine
│   ├── main.cpp                # Embind bindings (JS ↔ C++ bridge)
│   ├── Game.cpp / Game.hpp     # embind adapter: level parsing, events → particles/sounds, frame snapshot
│   ├── sim/Simulation.*        # Deterministic core: physics, collision, abilities, camera (no emscripten)
│   ├── sim/SimEvent.hpp        # Events the sim emits (Jumped, Landed, PoundImpact, HoverTick, …)
│   ├── Types.hpp               # Shared structs: Vec2, Platform, InputState, AnimationState; tuning constants
│   └── ParticleSystem.hpp      # Cosmetic particles fed by sim events; seeded xorshift RNG
├── tests/native/               # doctest sim tests (`npm run test:sim`, host compiler only)
├── src/                        # TypeScript / React source
│   ├── main.tsx                # React root mount
│   ├── components/
│   │   ├── App.tsx             # Top-level layout (header, canvas, footer)
│   │   ├── GameCanvas.tsx      # Game loop, input handling, WASM init, renderer setup
│   │   └── AbilityHud.tsx      # Ability overlay markup (filled per frame by game/abilityHud.ts, no React state)
│   ├── gl/
│   │   ├── renderer.ts         # WebGL2 renderer: sprite drawing, background, textures
│   │   └── shaders/            # GLSL ES 3.0 shaders
│   │       ├── tex.vert.glsl / tex.frag.glsl         # Sprite / spritesheet shader
│   │       └── background.vert.glsl / background.frag.glsl  # Parallax background shader
│   ├── wasm/
│   │   └── loader.ts           # TypeScript interfaces + WASM module loader
│   └── audio/
│       └── AudioManager.ts     # Web Audio API wrapper (music + SFX)
├── public/                     # Static assets served by Vite
│   ├── levels/test-1.json      # Level definition (spawn, platforms, goals, bounds)
│   ├── shaders/                # Legacy copy of GLSL shaders (unused by Vite build)
│   ├── wazzy_spritesheet.png   # Player sprite sheet (64×64 frames)
│   ├── platform.png            # Platform texture
│   ├── background.png          # Parallax background texture
│   ├── wazzy.png               # Standalone player sprite (unused)
│   ├── background-music.mp3    # BGM
│   ├── jump / land / ground_pound / hover / switch .mp3  # SFX (the last three come from scripts/gen_sfx.py)
│   └── ...
├── index.html                  # Entry HTML (no inline WASM script; loaded dynamically)
├── package.json                # npm scripts & deps
├── vite.config.ts              # Vite config (base: './', React plugin)
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json  # TypeScript configs
├── custom.d.ts                 # vite/client type reference
└── deploy.py                   # SFTP deployment script
```

## Build & Run Commands

All commands run from the repository root.

**Prerequisites:**
- Node.js + npm
- Emscripten SDK (`emcc` must be on `PATH`)

**Development:**
```bash
npm install
npm run dev           # build:wasm:debug (-O1, assertions) + vite dev server
```

**Production build:**
```bash
npm run build         # build:wasm + tsc + vite build → dist/
```

**WASM-only build:**
```bash
npm run build:wasm    # release emcc build (-O3) → src/wasm/main.js; flags in cpp/emscripten-*.response
npm run build:wasm:debug  # debug emcc build (-O1 -g -gsource-map, ASSERTIONS=2)
```

**Lint:**
```bash
npm run lint          # eslint . --max-warnings 0 (flat config in eslint.config.js)
```

**Tests:**
```bash
npm run test          # Vitest unit tests
npm run test:e2e      # Playwright smoke test (stubs WASM; no emcc required)
npm run test:sim      # Native C++ simulation tests (g++/clang++; no emsdk, no browser)
```

**Preview production build:**
```bash
npm run preview       # vite preview
```

## Architecture Details

### C++ ↔ JS Bridge (embind)

`cpp/src/main.cpp` uses `EMSCRIPTEN_BINDINGS` to expose:
- Value objects: `Vec2`, `InputState`
- Class: `Game` with methods `update`, `handleInput`, `captureFrame`, `framePtr`, `getPlayerPosition`, `getCameraPosition`, `getPlayerSize`, `getLevelName`, `getLevelDescription`, `setSoundCallback`, `loadLevel`, `setLevelCompleteCallback`, plus the character/ability methods

Per-frame render state crosses as one float buffer, not embind objects: `captureFrame()` packs it (layout `FrameLayout` in `Types.hpp`, mirrored by `FRAME` in `src/game/snapshot.ts`) and returns its length; JS views it at `framePtr()` through `module.HEAPF32`, re-wrapping every frame. Only what moves or changes state is in it: platforms and goals cross once, in `loadLevel`, and the loop draws the arrays it passed in (`SceneAssets` in `src/game/loop.ts`). Animation state is a `PlayerState` int; the renderer maps it to a spritesheet row.

The Emscripten build produces an ES module (`src/wasm/main.js`) with `EXPORT_ES6=1`, `MODULARIZE=1` and `EXPORT_NAME=createWasmModule`; `src/wasm/loader.ts` dynamic-imports it.

### Game Loop

`src/game/loop.ts` (`startGameLoop`) owns the loop; `GameCanvas.tsx` only starts it:
1. `requestAnimationFrame` drives `tick(timestamp)`.
2. Each frame:
   - Adds real elapsed time to an accumulator and runs `handleInput(KeyboardInput.snapshot())` + `update(1/60)` once per whole tick (max 4; backlog beyond that is dropped).
   - Calls `captureFrame()` and decodes the snapshot with `readFrame` into a reused `FrameState`.
   - Calls `renderer.drawScene(...)`, then writes HUD text to DOM refs (never React state).

### Rendering

`src/gl/renderer.ts` is a hand-written WebGL2 renderer:
- **Sprite program:** draws textured quads with sprite-sheet animation support (`u_sprite_frame_coord`, `u_flip_horizontal`).
- **Background program:** full-screen quad with parallax scrolling based on camera position.
- **Context and sizing:** the WebGL2 context is opaque (`alpha: false`), non-MSAA, with no depth/stencil, and requests `desynchronized` presentation (one retry without it). The canvas backing store follows its CSS box × `min(devicePixelRatio, 2)` (`src/lib/canvasSize.ts`, applied by the game loop through `Renderer.resize`); the world is always 10 units across the backing-store width. Each program has a VAO that is bound together with it (`useSpriteProgram` / `useBackgroundProgram`); constant GL state is set once at init.
- **Debug overlays:** semi-transparent red (player) and green (platform) collision boxes, hidden unless `Renderer.setCollisionDebug(true)`.
- **Texture anchors:** when loading the player spritesheet, the renderer inspects alpha pixels to compute per-frame bottom offsets so the sprite’s feet align with the collision box.

### Level Format

> Full schema reference (spawn, bounds, camera, backgroundLayers, decor, `visual`, manifest): [`docs/architecture/level-format.md`](./docs/architecture/level-format.md)

Levels are JSON files like `public/levels/test-1.json`:
```json
{
  "spawn": { "x": 0.0, "y": -1.0 },
  "bounds": { "min": { "x": -10.0, "y": -10.0 }, "max": { "x": 20.0, "y": 10.0 } },
  "platforms": [
    { "position": { "x": 0.0, "y": -0.8 }, "size": { "x": 2.0, "y": 0.2 } }
  ],
  "goals": [
    { "position": { "x": 16.0, "y": 2.0 }, "size": { "x": 1.0, "y": 1.0 } }
  ]
}
```

`Game::loadLevel(emscripten::val level)` parses this at runtime (clearing the hard-coded fallback platforms).
Levels can optionally include a `"camera"` object with `followY`, `verticalDeadzone`, and `lookAheadY` to enable vertical camera follow per level.
If `"camera"` is omitted, camera behavior stays backward-compatible and remains X-follow only.

### Audio

`AudioManager` uses the Web Audio API:
- Loads SFX and music via `fetch` → `decodeAudioData`.
- Plays SFX through a shared `GainNode`.
- Loops music via `AudioBufferSourceNode`.
- Volume slider in `GameCanvas` adjusts the `GainNode` gain.
- The audio context is resumed on first keydown (browser autoplay policy).

Sound events are triggered from C++ via `setSoundCallback` → JS callback. Supported names: `"jump"`, `"land"`, `"ground_pound"`, `"hover"`, `"switch"` (one `public/<name>.mp3` each; `SFX_URLS` in `GameCanvas.tsx` lists them). `playSfx` ignores a name with no buffer.

## Code Style Guidelines

- **TypeScript:** Strict mode enabled (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`).
- **React:** Functional components only; hooks for state and effects.
- **Styling:** Inline `React.CSSProperties` objects inside components. No CSS-in-JS library. Global theme variables live in `src/index.css` (`:root` CSS custom properties).
- **Imports:** ES modules (`"type": "module"` in `package.json`). Use `?raw` suffix for GLSL imports in Vite.
- **C++:** Header guards (`#ifndef … #define … #endif`). No namespaces used. `std::vector` for lists. `emscripten::val` for JS callbacks.

## Known Issues & Quirks

1. **Tests now exist.** `npm run test` runs Vitest unit tests, `npm run test:e2e` runs the Playwright smoke check (stubs the WASM module, so no Emscripten build needed), and `npm run test:sim` runs the native C++ simulation tests.
2. **`public/wazzy.png` is not dead.** It is referenced by `public/levels/demo-decor.json` via the `decor` array — see below. (The unused `basic.*` shaders and the `public/shaders/` copies were deleted; Vite loads GLSL via `?raw` from `src/gl/shaders/`.)

> As of 2026-09-07: the previous #1 (`Game.cpp` stray block causing a compile error), #2 (duplicate `src/App.tsx`), and the hardcoded SFTP credential in `deploy.py` (see Security Considerations below) have all been fixed — `loadLevel`'s platform-parsing block is inside the function, `src/App.tsx` no longer exists, and `deploy.py` now reads "No SFTP passwords are stored in this repo." Removed those stale entries so an agent doesn't waste a cycle "fixing" something that's already fixed.
>
> As of 2026-11-20: the former #1 ("ground pound can tunnel through thin floors", sideways ejection on `test-1`) is fixed. It was float rounding, not tunneling: after the vertical resolve, the resting height (e.g. −2.4 on test-1's spawn floor) rounded so that the horizontal resolve saw an overlap and pushed the player to the platform edge. Overlaps of ≤ `CONTACT_EPSILON` now count as contact (`cpp/src/sim/Simulation.cpp`), and `tests/native/sim_tests.cpp` ("resting contact is not a collision") covers test-1's floor and a sweep of heights.

## Known Issues / Blockers (2026-09-07)

- **CI added (2026-11-19).** `.github/workflows/ci.yml` runs release WASM build, lint, `tsc -b`, unit and e2e tests on push/PR to `main` (emsdk pinned to 3.1.61). Not yet confirmed green on GitHub — check the first PR run.
- **Doc drift generally.** This file and `CLAUDE.md` hadn't been touched in ~78 days relative to the last code commit as of this audit, and the "Known Issues" list above had gone stale (three of its five items were already-fixed non-issues). Worth a periodic recheck of this file against the actual code rather than assuming it's current.
- **`decor` / `backgroundLayers` level fields are undocumented here.** `public/levels/demo-decor.json` (wired into `public/levels/manifest.json` as a selectable level) uses `"decor"` and `"backgroundLayers"` arrays that are fully parsed and rendered client-side (`extractDecorConfigs` / `extractBackgroundLayerConfigs` in `src/lib/levelData.ts`, drawn via `drawBackgroundLayer` in `src/gl/renderer.ts`) — but neither field is mentioned in the "Level Format" section above or in `CLAUDE.md`'s level-format block, and neither is parsed by `Game::loadLevel` in `cpp/src/Game.cpp` (they're TS/renderer-only, never reach C++). `docs/plans/PLAN.md` §1 still lists "expand level schema documentation (camera, backgroundLayers, decor, manifest)" as a not-yet-started roadmap item, which matches. `public/wazzy.png` is referenced from `demo-decor.json`'s `decor` array, so it is no longer a genuinely dead asset (it's just not rendered by anything other than this one demo level).

## Deployment

`deploy.py` recursively uploads the `dist/` directory via SFTP to `go.1ink.us/platformer`.

Usage:
```bash
npm run build
python deploy.py
```

> Do not commit `deploy.py` changes that include credentials.

## Security Considerations

- `deploy.py` no longer contains a hardcoded SFTP password (fixed since this doc was last written — it now reads credentials elsewhere). Double check before assuming, since this was previously a real leak.
- The game runs entirely client-side; there is no server-side auth or data persistence.
- `eslint` is configured but does not run automatically on build or in CI — see "Known Issues / Blockers" above.
