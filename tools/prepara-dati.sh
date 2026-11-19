#!/usr/bin/env bash
# Retro486 - prepara data/ (sul server: dati/) con l'hard disk compresso,
# la libreria e i supporti. Da eseguire dopo tools/crea-disco.mjs.
#
#   bash tools/prepara-dati.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
mkdir -p data/dischi data/media data/nvr

if [[ -f data/dischi/c.img ]]; then
  gzip -9 -k -f data/dischi/c.img
  echo "data/dischi/c.img.gz: $(du -h data/dischi/c.img.gz | cut -f1) (originale $(du -h --apparent-size data/dischi/c.img | cut -f1))"
fi

# libreria per il portale: senza i percorsi di Melchior
node -e '
const l = JSON.parse(require("fs").readFileSync("tools/libreria.json", "utf8"));
const voci = l.voci.map(({ sorgente, ...v }) => v);
require("fs").writeFileSync("data/libreria.json", JSON.stringify({ voci }, null, 2) + "\n");
console.log(`data/libreria.json: ${voci.length} voci`);'

# supporti: floppy di MS-DOS 6.22 e CD di Windows 3.11
declare -A ET
for n in 1 2 3 4; do
  src=media/os/msdos-6.22-ita/Disk0$n.img
  [[ -f $src ]] && cp -u "$src" "data/media/msdos622-$n.img" && ET[msdos622-$n.img]="MS-DOS 6.22 ITA - disco $n"
done
[[ -f media/os/win311-ita/WIN311ITA.iso ]] && cp -u media/os/win311-ita/WIN311ITA.iso data/media/win311-ita.iso && ET[win311-ita.iso]="Windows per Workgroups 3.11 ITA (CD)"
{
  echo "{"
  first=1
  for k in "${!ET[@]}"; do
    [[ $first == 1 ]] || echo ","
    printf '  "%s": "%s"' "$k" "${ET[$k]}"
    first=0
  done
  echo; echo "}"
} > data/media/etichette.json
ls -la data/media
