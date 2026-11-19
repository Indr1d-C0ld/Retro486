#!/usr/bin/env bash
# Retro486 - assembla il sito in dist/:
#   86Box WebAssembly + icone + ROM (da vendor/Web86Box/dist, vedi tools/86box/)
#   ROM della Roland MT-32/CM-32L (da $MT32_ROMS, non distribuite)
#   portale (app/) e backend PHP (api/)
#
#   bash tools/costruisci.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
W86=vendor/Web86Box/dist
MT32_ROMS=${MT32_ROMS:-$HOME/.local/share/melchior688/mt32/rom/mt32pi}
[[ -f $W86/86Box.wasm ]] || { echo "Manca $W86/86Box.wasm: compila 86Box (tools/86box/build-ottimizzata.sh)" >&2; exit 1; }

mkdir -p dist
rsync -a --delete \
  --exclude dati --exclude test --exclude index.html --exclude js --exclude css --exclude coi-serviceworker.js \
  "$W86"/ dist/
rsync -a app/ dist/
rsync -a --delete api/ dist/api/

# ROM MT-32 / CM-32L nei percorsi che si aspetta 86Box (src/sound/midi_mt32.c)
if [[ -d $MT32_ROMS ]]; then
  for d in mt32 mt32_new cm32l; do mkdir -p dist/roms/sound/$d; done
  cp "$MT32_ROMS/ctrl_mt32_1_07.rom" dist/roms/sound/mt32/MT32_CONTROL.ROM
  cp "$MT32_ROMS/pcm_mt32.rom"       dist/roms/sound/mt32/MT32_PCM.ROM
  cp "$MT32_ROMS/ctrl_mt32_2_04.rom" dist/roms/sound/mt32_new/MT32_CONTROL.ROM
  cp "$MT32_ROMS/pcm_mt32.rom"       dist/roms/sound/mt32_new/MT32_PCM.ROM
  cp "$MT32_ROMS/ctrl_cm32l_1_02.rom" dist/roms/sound/cm32l/CM32L_CONTROL.ROM
  cp "$MT32_ROMS/pcm_cm32l.rom"       dist/roms/sound/cm32l/CM32L_PCM.ROM
else
  echo "attenzione: ROM MT-32 non trovate in $MT32_ROMS" >&2
fi
vendor/Web86Box/tools/gen-rom-manifest.sh dist/roms >/dev/null

VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
SPORCO=$([[ -n $(git status --porcelain 2>/dev/null) ]] && echo true || echo false)
cat > dist/version.json <<JSON
{"name":"Retro486","version":"$VERSION","commit":"$COMMIT","dirty":$SPORCO,"built":"$(date -Iseconds)"}
JSON
echo "dist/: $(du -sh dist | cut -f1), versione $VERSION ($COMMIT)"
