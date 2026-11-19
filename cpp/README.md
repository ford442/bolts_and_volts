# cpp/ build flags

`emcc` response files (no comments allowed in them, so rationale lives here):

| File | Used by | Notes |
| --- | --- | --- |
| `emscripten-common.response` | all builds | sources, `-o src/wasm/main.js`, `-std=c++17 -Wall -Wextra`, embind, ES6 module factory `createWasmModule`, `ENVIRONMENT=web`, `FILESYSTEM=0`, `ALLOW_MEMORY_GROWTH=1`, `DISABLE_EXCEPTION_CATCHING=1` |
| `emscripten-release.response` | `npm run build:wasm` (and `npm run build`) | `-O3 -sASSERTIONS=0` |
| `emscripten-debug.response` | `npm run build:wasm:debug` (and `npm run dev`) | `-O1 -g -gsource-map -sASSERTIONS=2` |

- Run as `emcc @cpp/emscripten-common.response @cpp/emscripten-<variant>.response` from the repo root (the npm scripts do this via `scripts/with-emsdk.sh`).
- All JS calls go through embind, so `ccall`/`cwrap` and `_malloc`/`_free` are not exported. If a future zero-copy snapshot needs `_malloc`, export only that.
- `DISABLE_EXCEPTION_CATCHING=1` is explicit because `Game.cpp` does not throw. Revisit if C++ starts using exceptions.
- `SAFE_HEAP`, pthreads, `SHARED_MEMORY` and SIMD are deliberately not enabled.
