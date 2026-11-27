#!/usr/bin/env bash
# Retro486 - invia a Balthasar i dati iniziali preparati con tools/prepara-dati.sh:
# hard disk C: compresso e sua copia di fabbrica, libreria, supporti, pacchetto di Windows 3.11.
#
#   bash deploy/pubblica-dati.sh           # solo i file che sul server mancano
#   bash deploy/pubblica-dati.sh --forza   # sovrascrive anche l'hard disk del server
#
# Senza --forza l'hard disk del server non viene mai sostituito: puo' contenere
# quello che hai salvato dal portale.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
[[ -f deploy/locale.env ]] && source deploy/locale.env
HOST=${R486_HOST:-balthasar}
DEST=${R486_DEST:-/var/www/html/retro486}/dati
FORZA=""; [[ ${1:-} == --forza ]] && FORZA=1

[[ -f data/dischi/c.img.gz ]] || { echo "Manca data/dischi/c.img.gz: node tools/crea-disco.mjs && bash tools/prepara-dati.sh" >&2; exit 1; }
OPZ=(-rltz --chmod=D2775,F0664)
rsync "${OPZ[@]}" data/libreria.json "$HOST:$DEST/"
# copertine dei giochi di serie; quelle delle schede degli utenti (u*.*) restano come sono
[[ -d data/libreria ]] && rsync "${OPZ[@]}" --exclude 'u*' data/libreria/ "$HOST:$DEST/libreria/"
rsync "${OPZ[@]}" --ignore-existing data/media/ "$HOST:$DEST/media/"
rsync "${OPZ[@]}" data/media/etichette.json "$HOST:$DEST/media/"
if [[ -n $FORZA ]]; then
  ssh "$HOST" "cd $DEST/dischi && [ -f c.img.gz ] && cp -a c.img.gz c.img.gz.prima-di-forza-\$(date +%Y%m%d%H%M%S) || true"
  rsync "${OPZ[@]}" data/dischi/c.img.gz data/dischi/c.json "$HOST:$DEST/dischi/"
else
  rsync "${OPZ[@]}" --ignore-existing data/dischi/c.img.gz data/dischi/c.json "$HOST:$DEST/dischi/"
fi
# copia di fabbrica dell'hard disk (mai sovrascritta) e pacchetto di Windows 3.11 (tools/win311/)
[[ -f data/dischi/fabbrica/c.img.gz ]] && rsync "${OPZ[@]}" --ignore-existing data/dischi/fabbrica/ "$HOST:$DEST/dischi/fabbrica/"
[[ -f data/pacchetti/windows311.zip ]] && ssh "$HOST" "mkdir -p -m 2775 $DEST/pacchetti" && rsync "${OPZ[@]}" data/pacchetti/windows311.zip "$HOST:$DEST/pacchetti/"
ssh "$HOST" "ls -la $DEST $DEST/dischi $DEST/dischi/fabbrica $DEST/pacchetti $DEST/media"
