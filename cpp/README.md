# cpp/ build flags

`em++` response files (no comments allowed in them, so rationale lives here). The npm scripts call `em++`, not `emcc`: `emcc` only links the C++ runtime when it is handed `.cpp` inputs, and on emsdk 6.x that no longer happens (`undefined symbol: operator new`, `typeinfo for float`).

| File | Used by | Contents |
| --- | --- | --- |
| `emscripten-common.response` | all builds | sources, `-o src/wasm/main.js`, `-std=c++17 -Wall -Wextra -Werror`, embind, ES6 module factory `createWasmModule`, `ENVIRONMENT=web`, `FILESYSTEM=0`, the memory settings below, `DISABLE_EXCEPTION_CATCHING=1`, `EXPORTED_RUNTIME_METHODS=HEAPF32` |
| `emscripten-release.response` | `npm run build:wasm` (and `npm run build`, CI) | `-O3 -flto -sASSERTIONS=0` |
| `emscripten-debug.response` | `npm run build:wasm:debug` (and `npm run dev`) | `-O1 -g -gsource-map -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2` |

Run as `em++ @cpp/emscripten-common.response @cpp/emscripten-<variant>.response` from the repo root (the npm scripts do this via `scripts/with-emsdk.sh`).

## Toolchain pin

**emsdk 6.0.13** (`em++ --version`), in two places that must change together: `version:` of `mymindstorm/setup-emsdk` in `.github/workflows/ci.yml`, and this line. Checked with this version: release and debug builds link clean under `-Werror`, `npm run test:sim` passes, and a scripted trace (walk, jump with cut, ground pound, switch to Volts, hover; 584 ticks, player and camera positions compared as float bits) is bit-identical between the native `Simulation` and the wasm `Game`, for both the release (`-O3 -flto`) and debug builds.

A compiler bump can change wasm float codegen even when the C++ is unchanged. When bumping: rebuild, run `npm run test:sim`, and replay one native walk/jump trace against the wasm module once. `tests/native` (`-ffp-contract=off`) is the determinism gate either way.

## Memory contract

Written out in `emscripten-common.response` instead of inherited from emcc defaults (which would be a 2 GB ceiling under `ALLOW_MEMORY_GROWTH`):

| Flag | Value | Why |
| --- | --- | --- |
| `-sINITIAL_MEMORY` | 16777216 (16 MB) | what the build already used |
| `-sMAXIMUM_MEMORY` | 67108864 (64 MB) | far above the player, platforms, particles and a snapshot; a leak in the frame buffer or particle list fails at 64 MB instead of growing toward 2 GB. Raise it deliberately when large levels or instanced buffers need it |
| `-sSTACK_SIZE` | 65536 (64 KB) | the emcc default, now explicit |
| `-sALLOW_MEMORY_GROWTH=1` | | stays on; `src/game/snapshot.ts` re-wraps the heap view every frame because growth detaches the old buffer |

The built module reports 256 pages initial, 1024 pages maximum.

## Other flags and decisions

- `-Werror` (with `-Wall -Wextra`) matches `scripts/test-sim.sh`, so a warning fails the wasm build the same way it fails the native one.
- `-flto` is release only. The link takes seconds; CI's job timeout is 20 minutes.
- `-sSTACK_OVERFLOW_CHECK=2` is debug only, next to `ASSERTIONS=2`. `SAFE_HEAP` is deliberately not in `npm run dev`: it is too slow for the inner loop. If wanted, add a separate script.
- Staying off, on purpose: SIMD, pthreads / `SHARED_MEMORY` (no cross-origin isolation needed to host the game), exceptions (`DISABLE_EXCEPTION_CATCHING=1`; nothing in `cpp/src` throws and JSON stays in TypeScript, so revisit only if that changes) and the filesystem (`FILESYSTEM=0`).
- All JS calls go through embind, so `ccall`/`cwrap` and `_malloc`/`_free` are not exported. If a future zero-copy snapshot needs `_malloc`, export only that.
- `-sSTRICT=1` was trialed on 6.0.13 and not adopted: on top of these files the link fails (`entry symbol not defined: main`; the module has no `main`), so it is not a free repeat of settings already made here. Revisit only with a reason to take on that extra flag work.
- New `.cpp` files must be added to `emscripten-common.response` (currently `main.cpp`, `Game.cpp`, `sim/Simulation.cpp`, `sim/PlatformGrid.cpp`) and, if the sim uses them, to `scripts/test-sim.sh`.

## Native simulation tests

`cpp/src/sim/` has no emscripten include, so `npm run test:sim` (`scripts/test-sim.sh`) compiles it with the host compiler together with `tests/native/sim_tests.cpp` (doctest, vendored under `tests/native/third_party/doctest/`) into `build/native/sim_tests`. Flags: `-std=c++17 -O1 -Wall -Wextra -Werror -ffp-contract=off`. The last one keeps the host from fusing multiply-adds, which wasm never does, so native runs reproduce browser positions exactly. `CXX=clang++` picks the compiler; extra arguments go to doctest (`npm run test:sim -- --test-case='*coyote*'`). doctest is never linked into the emscripten build.
