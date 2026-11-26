#!/usr/bin/env bash
# Retro486 - prima installazione su Balthasar (da eseguire li', con sudo):
#   sudo bash ~/Claude/balthasar-retro486/installa.sh
# Crea la cartella del sito e quella dei dati, installa la configurazione di
# Apache e chiede la password per l'accesso (utente: admin, o RETRO486_UTENTE).
set -euo pipefail
QUI="$(cd "$(dirname "$0")" && pwd)"
SITO=/var/www/html/retro486
UTENTE=${RETRO486_UTENTE:-admin}
PROPRIETARIO=${SUDO_USER:-randolph}
[[ $EUID -eq 0 ]] || { echo "Va eseguito con sudo" >&2; exit 1; }

install -d -o "$PROPRIETARIO" -g www-data -m 2775 "$SITO" "$SITO/dati" "$SITO/dati/dischi" "$SITO/dati/media" "$SITO/dati/nvr"

CONF=/etc/apache2/conf-available/retro486.conf
[[ -f $CONF ]] && cp -a "$CONF" "$CONF.prima-di-retro486-$(date +%Y%m%d%H%M%S)"
install -m 644 "$QUI/retro486.conf" "$CONF"

PW=/etc/apache2/.htpasswd-retro486
if [[ ! -f $PW ]]; then
  echo "Scegli la password dell'amministratore '$UTENTE' di Retro486 (serve solo per scrivere sul server):"
  htpasswd -c "$PW" "$UTENTE"
  chown root:www-data "$PW"; chmod 640 "$PW"
else
  echo "$PW esiste gia' (per cambiare password: sudo htpasswd $PW $UTENTE)"
fi

a2enmod -q headers deflate >/dev/null
a2enconf -q retro486
apache2ctl configtest
systemctl reload apache2
echo "Fatto: https://example.org/retro486/ (pubblica i file da Melchior con deploy/pubblica.sh)"
