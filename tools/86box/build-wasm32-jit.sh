#!/usr/bin/env bash
# Retro486: build a 32 bit (wasm32) con il ricompilatore dinamico di 86Box e il backend WebAssembly
# (tools/86box/jit): i blocchi compilati diventano moduli wasm generati a tempo di esecuzione.
# Applica tools/86box/patch/*.patch al sottomodulo 86Box e copia i sorgenti del backend in src/codegen.
# Il ricompilatore si sceglie poi a tempo di esecuzione con cpu_use_dynarec nella configurazione della VM.
# Build Web86Box: 86Box compiled to WebAssembly plus the web frontend.
#
#   ./build.sh            release build into dist/
#   BUILD_TYPE=Debug ./build.sh
#
# Requires an activated Emscripten SDK (emcmake/emcc on PATH).
set -euo pipefail

ROOT="${WEB86BOX:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../vendor/Web86Box" && pwd)}"
BUILD_TYPE="${BUILD_TYPE:-Release}"
BUILD_DIR="${BUILD_DIR:-$ROOT/build/$BUILD_TYPE}"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"

command -v emcmake >/dev/null || { echo "emcmake not found: activate the Emscripten SDK first" >&2; exit 1; }

# 86Box sources (git submodule) + our patches.
if [ ! -f "$ROOT/86Box/CMakeLists.txt" ]; then
  git -C "$ROOT" submodule update --init 86Box
fi
"$ROOT/tools/apply-patches.sh"

# Patch di Retro486 (wasm32 e backend wasm del ricompilatore) e sorgenti del backend.
RETRO486_TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for p in "$RETRO486_TOOLS"/patch/*.patch; do
  [ -e "$p" ] || continue
  if git -C "$ROOT/86Box" apply --reverse --check "$p" 2>/dev/null; then
    continue # gia applicata
  fi
  if ! git -C "$ROOT/86Box" apply --check "$p" 2>/dev/null; then
    echo "attenzione: $(basename "$p") non si applica (sorgenti gia modificati a mano?): la salto" >&2
    continue
  fi
  echo "Applico $(basename "$p")"
  git -C "$ROOT/86Box" apply "$p"
done
for f in "$RETRO486_TOOLS"/jit/*.c "$RETRO486_TOOLS"/jit/*.h; do
  cmp -s "$f" "$ROOT/86Box/src/codegen/$(basename "$f")" || cp "$f" "$ROOT/86Box/src/codegen/"
done

case "$BUILD_TYPE" in
  Debug) OPT="-O1 -g"; LINK_EXTRA="-sASSERTIONS=1" ;;
  *)     OPT="${OPT_FLAGS:--O3 -flto -msimd128}";    LINK_EXTRA="${LINK_FLAGS:-}" ;;
esac

emcmake cmake -S "$ROOT/86Box" -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DCMAKE_C_FLAGS="-pthread $OPT" \
  -DCMAKE_CXX_FLAGS="-pthread -fwasm-exceptions $OPT" \
  -DCMAKE_EXE_LINKER_FLAGS="-pthread -fwasm-exceptions $OPT $LINK_EXTRA" \
  -DWEB86BOX_PLATFORM_DIR="$ROOT/platform" \
  -DQT=OFF -DDYNAREC=ON -DOPENAL=OFF \
  -DRTMIDI=OFF -DFLUIDSYNTH=OFF -DMUNT=ON -DSOUNDCANVAS=OFF \
  -DDISCORD=OFF -DVNC=OFF -DMINITRACE=OFF -DGDBSTUB=OFF \
  -DCPPTHREADS=ON -DSTATIC_BUILD=OFF -DRELEASE=$([ "$BUILD_TYPE" = Debug ] && echo OFF || echo ON)

cmake --build "$BUILD_DIR" --target 86Box

# Assemble the site.
mkdir -p "$DIST_DIR/icons/systemicons"
cp "$BUILD_DIR"/src/86Box.mjs "$BUILD_DIR"/src/86Box.wasm "$DIST_DIR"/
cp -r "$ROOT"/web/. "$DIST_DIR"/
# 86Box's own Qt icons, so the UI looks like the desktop version.
cp "$ROOT"/86Box/src/qt/icons/*.ico "$DIST_DIR"/icons/
cp "$ROOT"/86Box/src/qt/assets/systemicons/*.png "$DIST_DIR"/icons/systemicons/
(cd "$DIST_DIR"/icons/systemicons && ls *.png | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))') > "$DIST_DIR"/icons/systemicons.json

# ROM set: ROMS_DIR=<checkout of github.com/86Box/roms> copies it into the
# site (the emulator downloads individual ROMs on demand). Without it, an
# existing dist/roms is kept.
if [ -n "${ROMS_DIR:-}" ]; then
  mkdir -p "$DIST_DIR/roms"
  rsync -a --delete --exclude .git "$ROMS_DIR"/ "$DIST_DIR/roms/" 2>/dev/null \
    || (cd "$ROMS_DIR" && tar --exclude=.git -cf - . | tar -xf - -C "$DIST_DIR/roms")
fi
if [ -d "$DIST_DIR/roms" ]; then
  "$ROOT"/tools/gen-rom-manifest.sh "$DIST_DIR/roms"
else
  echo "warning: no ROMs in $DIST_DIR/roms (set ROMS_DIR); machines will be unavailable" >&2
fi
echo "Built into $DIST_DIR"
