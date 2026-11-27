#!/usr/bin/env bash
# =============================================================================
# Retro486 - build e pubblicazione su Balthasar sotto /retro486/.
#
#   bash deploy/pubblica.sh            # build + rsync del sito
#   bash deploy/pubblica.sh --prova    # build e rsync a secco (--dry-run)
#
# Non tocca dati/ (hard disk, profili, supporti salvati dal portale): per quelli
# c'e' deploy/pubblica-dati.sh.
# Prima volta: copia l'installatore su Balthasar e lancialo con sudo:
#   bash deploy/pubblica.sh --installatore
#   ssh -t balthasar sudo bash ~/Claude/balthasar-retro486/installa.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

# impostazioni locali (indirizzo del sito, host ssh): deploy/locale.env, fuori da git; vedi locale.env.esempio
[[ -f deploy/locale.env ]] && source deploy/locale.env
HOST=${R486_HOST:-balthasar}
DEST=${R486_DEST:-/var/www/html/retro486}
URL=${R486_URL:-}

if [[ ${1:-} == --installatore ]]; then
  ssh "$HOST" 'mkdir -p ~/Claude/balthasar-retro486'
  rsync -a deploy/balthasar/ "$HOST:Claude/balthasar-retro486/"
  echo "Copiato in $HOST:~/Claude/balthasar-retro486/ - ora: ssh -t $HOST sudo bash ~/Claude/balthasar-retro486/installa.sh"
  exit 0
fi
DRY=""; [[ ${1:-} == --prova ]] && DRY="--dry-run"

echo "== build =="
bash tools/costruisci.sh
COMMIT=$(node -p "require('./dist/version.json').commit")

echo "== rsync verso $HOST:$DEST =="
rsync -rltz --delete --delay-updates $DRY \
  --chmod=D2775,F0664 \
  --exclude '/dati' --exclude '.DS_Store' \
  dist/ "$HOST:$DEST/"

[[ -n $DRY ]] && exit 0
[[ -n $URL ]] || { echo "   verifica saltata: manca R486_URL (deploy/locale.env)"; exit 0; }
echo "== verifica =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
scrivi=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'X-Retro486: 1' -H 'Content-Type: application/json' --data '[]' "${URL}api/profili.php")
ver=$(ssh "$HOST" "cat $DEST/version.json" | node -pe 'JSON.parse(require("fs").readFileSync(0)).commit' 2>/dev/null || echo "?")
echo "   $URL -> HTTP $code (200: aperto a tutti), commit pubblicato $ver"
echo "   scrittura senza password -> HTTP $scrivi (401: solo l'admin scrive sul server)"
[[ $code == 200 && $scrivi == 401 && $ver == "$COMMIT" ]]
