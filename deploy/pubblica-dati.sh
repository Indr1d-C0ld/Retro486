#!/usr/bin/env bash
# Retro486 - invia a Balthasar i dati iniziali preparati con tools/prepara-dati.sh:
# hard disk C: compresso, libreria, supporti (floppy di MS-DOS, CD di Windows 3.11).
#
#   bash deploy/pubblica-dati.sh           # solo i file che sul server mancano
#   bash deploy/pubblica-dati.sh --forza   # sovrascrive anche l'hard disk del server
#
# Senza --forza l'hard disk del server non viene mai sostituito: puo' contenere
# quello che hai salvato dal portale.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
HOST=${R486_HOST:-balthasar}
DEST=${R486_DEST:-/var/www/html/retro486}/dati
FORZA=""; [[ ${1:-} == --forza ]] && FORZA=1

[[ -f data/dischi/c.img.gz ]] || { echo "Manca data/dischi/c.img.gz: node tools/crea-disco.mjs && bash tools/prepara-dati.sh" >&2; exit 1; }
OPZ=(-rltz --chmod=D2775,F0664)
rsync "${OPZ[@]}" data/libreria.json "$HOST:$DEST/"
rsync "${OPZ[@]}" --ignore-existing data/media/ "$HOST:$DEST/media/"
rsync "${OPZ[@]}" data/media/etichette.json "$HOST:$DEST/media/"
if [[ -n $FORZA ]]; then
  ssh "$HOST" "cd $DEST/dischi && [ -f c.img.gz ] && cp -a c.img.gz c.img.gz.prima-di-forza-\$(date +%Y%m%d%H%M%S) || true"
  rsync "${OPZ[@]}" data/dischi/c.img.gz data/dischi/c.json "$HOST:$DEST/dischi/"
else
  rsync "${OPZ[@]}" --ignore-existing data/dischi/c.img.gz data/dischi/c.json "$HOST:$DEST/dischi/"
fi
ssh "$HOST" "ls -la $DEST $DEST/dischi $DEST/media"
