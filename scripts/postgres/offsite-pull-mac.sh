#!/bin/bash
# Nivel 2 de DR (PM-167, PM-169): la Mac del local DESCARGA el repositorio pgBackRest del VPS.
# Corre en la Mac (launchd: al iniciar sesión y cada hora mientras está encendida).
#
# - Pull por SSH con una clave limitada en el VPS a `rrsync -ro` sobre el repositorio: la Mac no puede
#   escribir ni borrar nada en el VPS, y un intruso en el VPS no puede tocar la copia de la Mac.
# - El repositorio viaja y queda cifrado (aes-256-cbc de pgBackRest): la Mac nunca ve datos en claro.
# - Una foto diaria con enlaces duros (14 días): si algo borra el repositorio en el VPS, la foto de ayer
#   sigue intacta en la Mac.
# - Verifica los hashes contra el manifiesto que genera el VPS después de cada backup verificado.
# - Si todo sale bien, avisa al heartbeat de Better Stack (URL en ~/.config/fusion-offsite/heartbeat-url).
#
# Configuración en la Mac (~/.config/fusion-offsite/):
#   destino            host SSH del VPS (ej.: fusion-offsite@IP_DEL_VPS)
#   id_ed25519         clave privada de la Mac (su pública va en el VPS con command=rrsync)
#   heartbeat-url      opcional
set -euo pipefail

CONF="$HOME/.config/fusion-offsite"
BASE="${FUSION_OFFSITE_DIR:-$HOME/FusionBackups/pgbackrest}"
LOG="$BASE/pull.log"
DESTINO="$(cat "$CONF/destino")"
CLAVE="$CONF/id_ed25519"
HOY="$(date -u +%Y-%m-%d)"
RETENCION_DIAS=14

mkdir -p "$BASE/actual" "$BASE/diario"
log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }

# Un solo pull a la vez (launchd puede disparar al despertar y por intervalo).
LOCK="$BASE/.pull.lock"
if ! mkdir "$LOCK" 2>/dev/null; then log "otro pull en curso; se omite"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

SSH="ssh -i $CLAVE -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30"
log "pull desde $DESTINO"
# rrsync -ro expone el repositorio como raíz: "./" es /opt/fusionbikes/postgres/repo en el VPS.
rsync -a --delete --partial --timeout=600 -e "$SSH" "$DESTINO:./" "$BASE/actual/"

# Verificación: el manifiesto lista sha256 de cada archivo del repositorio al terminar el último backup.
# Archivos de WAL posteriores al manifiesto no están listados todavía: se verifica lo listado.
MANIFIESTO="$BASE/actual/MANIFEST-fusion.sha256"
if [ ! -s "$MANIFIESTO" ]; then log "ERROR: falta el manifiesto; no se da por buena la copia"; exit 1; fi
if ! (cd "$BASE/actual" && shasum -a 256 -c --quiet "MANIFEST-fusion.sha256" >/dev/null 2>>"$LOG"); then
  log "ERROR: hashes distintos respecto del manifiesto"; exit 1
fi
ARCHIVOS="$(wc -l < "$MANIFIESTO" | tr -d ' ')"

# Foto diaria con enlaces duros contra la anterior (ocupa sólo lo que cambió).
if [ ! -d "$BASE/diario/$HOY" ]; then
  ANTERIOR="$(ls -1 "$BASE/diario" 2>/dev/null | sort | tail -n1)"
  if [ -n "$ANTERIOR" ]; then
    rsync -a --link-dest="$BASE/diario/$ANTERIOR" "$BASE/actual/" "$BASE/diario/$HOY/"
  else
    rsync -a "$BASE/actual/" "$BASE/diario/$HOY/"
  fi
  find "$BASE/diario" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENCION_DIAS" -exec rm -rf {} +
fi

log "OK: $ARCHIVOS archivos verificados; foto diaria $HOY"
if [ -s "$CONF/heartbeat-url" ]; then
  curl -fsS -m 30 --retry 3 -o /dev/null "$(cat "$CONF/heartbeat-url")" && log "heartbeat nivel 2 OK" || log "ERROR: heartbeat nivel 2"
fi
