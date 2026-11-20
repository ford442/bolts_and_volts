#!/bin/sh
# Build and run the native simulation tests (tests/native/sim_tests.cpp + cpp/src/sim) with the host C++
# compiler. No emsdk, no browser. Extra arguments go to the doctest binary, e.g.
#   npm run test:sim -- --test-case='*coyote*'
# Pick the compiler with CXX=clang++ (default: c++, then g++, then clang++).
set -eu

if [ -z "${CXX:-}" ]; then
  for candidate in c++ g++ clang++; do
    if command -v "$candidate" >/dev/null 2>&1; then
      CXX=$candidate
      break
    fi
  done
fi
if [ -z "${CXX:-}" ]; then
  echo "test:sim needs a host C++17 compiler (g++ or clang++) on PATH, or CXX set." >&2
  exit 1
fi

OUT_DIR=build/native
mkdir -p "$OUT_DIR"

# -ffp-contract=off: no fused multiply-add (wasm has none), so the native float math matches the browser build.
"$CXX" -std=c++17 -O1 -g -Wall -Wextra -Werror -ffp-contract=off \
  -Icpp/src -Itests/native/third_party \
  tests/native/sim_tests.cpp cpp/src/sim/Simulation.cpp \
  -o "$OUT_DIR/sim_tests"

exec "$OUT_DIR/sim_tests" "$@"
