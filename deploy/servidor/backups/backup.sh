#!/bin/bash
# Backup diario de herramientas-app (cron: /etc/cron.d/fusion-backup, 06:00 UTC).
#
#  - LOCAL: snapshot consistente de la base (14 días) + tarball de uploads (2 días, sólo
#    como red rápida: la copia durable está en B2).
#  - NUBE (Backblaze B2, bucket con versionado + Object Lock + SSE): todo pasa por un remoto
#    rclone "crypt", así que en B2 los nombres y contenidos van cifrados con la passphrase.
#      crypt:db/fusion-<stamp>.sqlite.gz   una copia por día, nunca se pisa
#      crypt:env/env-<stamp>                .env del día
#      crypt:uploads/...                    espejo INCREMENTAL (sólo sube lo nuevo o cambiado)
#    La clave del VPS NO tiene deleteFiles: este script nunca borra en la nube, y aunque
#    alguien entre al servidor no puede destruir los respaldos (B2 guarda todas las versiones).
#
# Restaurar: ver /opt/fusionbikes/backups/RESTAURAR.md
set -uo pipefail   # sin -e: un fallo de la nube no debe abortar lo local

APP_DIR="/opt/fusionbikes/herramientas"
BK_DIR="/opt/fusionbikes/backups"
DB_SRC="$APP_DIR/data/fusion.sqlite"
ENV_FILE="$APP_DIR/.env"
RETENTION_DB_DAYS=14
RETENTION_UPLOADS_DAYS=2
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
LOG="$BK_DIR/backup.log"
ESTADO="$BK_DIR/estado-nube.json"
PASS_FILE="${FUSION_PASS_FILE:-/root/.config/fusion-backup/passphrase}"
REMOTE_PREFIX="${FUSION_REMOTE_PREFIX:-herramientas/crypt}"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }
env_var() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r'; }

# ── 1) LOCAL: base ───────────────────────────────────────────────────────────
mkdir -p "$BK_DIR/db" "$BK_DIR/uploads"
DB_SNAP="$BK_DIR/db/fusion-$STAMP.sqlite"
DB_OK=0
if node "$BK_DIR/backup-db.mjs" "$DB_SRC" "$DB_SNAP" >>"$LOG" 2>&1 && gzip -f "$DB_SNAP"; then
  DB_OK=1
  log "base OK -> $(basename "$DB_SNAP").gz ($(du -h "$DB_SNAP.gz" | cut -f1))"
else
  log "ERROR: falló el snapshot de la base"
fi

# ── 2) NUBE ──────────────────────────────────────────────────────────────────
NUBE_OK=0
NUBE_DETALLE=""
BUCKET_BYTES=""
B2_ID="$(env_var B2_KEY_ID)"; B2_KEY="$(env_var B2_APPLICATION_KEY)"; B2_BUCKET="$(env_var B2_BUCKET)"
if [ ! -f "$PASS_FILE" ]; then
  NUBE_DETALLE="sin passphrase en $PASS_FILE"
elif [ -z "$B2_ID" ] || [ -z "$B2_KEY" ] || [ -z "$B2_BUCKET" ]; then
  NUBE_DETALLE="faltan B2_KEY_ID / B2_APPLICATION_KEY / B2_BUCKET en .env"
else
  export RCLONE_CONFIG_FUSIONB2_TYPE=b2
  export RCLONE_CONFIG_FUSIONB2_ACCOUNT="$B2_ID"
  export RCLONE_CONFIG_FUSIONB2_KEY="$B2_KEY"
  export RCLONE_CONFIG_FUSIONCRYPT_TYPE=crypt
  export RCLONE_CONFIG_FUSIONCRYPT_REMOTE="fusionb2:$B2_BUCKET/$REMOTE_PREFIX"
  export RCLONE_CONFIG_FUSIONCRYPT_FILENAME_ENCRYPTION=standard
  export RCLONE_CONFIG_FUSIONCRYPT_DIRECTORY_NAME_ENCRYPTION=true
  RCLONE_CONFIG_FUSIONCRYPT_PASSWORD="$(rclone obscure - < "$PASS_FILE")"
  export RCLONE_CONFIG_FUSIONCRYPT_PASSWORD
  RC=(rclone --config /dev/null --stats-log-level NOTICE --stats 0 --retries 5 --low-level-retries 20)

  FALLOS=0
  if [ "$DB_OK" = "1" ]; then
    if "${RC[@]}" copyto --no-check-dest "$DB_SNAP.gz" "fusioncrypt:db/fusion-$STAMP.sqlite.gz" >>"$LOG" 2>&1; then
      log "nube: base OK"
    else FALLOS=$((FALLOS+1)); log "ERROR nube: base"; fi
  else FALLOS=$((FALLOS+1)); fi

  if "${RC[@]}" copyto --no-check-dest "$ENV_FILE" "fusioncrypt:env/env-$STAMP" >>"$LOG" 2>&1; then
    log "nube: .env OK"
  else FALLOS=$((FALLOS+1)); log "ERROR nube: .env"; fi

  # copy (no sync): lo borrado localmente se conserva en la nube.
  if "${RC[@]}" copy "$APP_DIR/uploads" "fusioncrypt:uploads" --transfers 8 >>"$LOG" 2>&1; then
    log "nube: uploads OK (incremental)"
  else FALLOS=$((FALLOS+1)); log "ERROR nube: uploads"; fi

  # Tamaño total del bucket (con versiones): la cuenta no tiene tarjeta y el plan gratis corta
  # las subidas a los 10 GB. Sólo lista (transacciones clase C), no descarga.
  BUCKET_BYTES="$(rclone --config /dev/null size "fusionb2:$B2_BUCKET" --b2-versions --json 2>>"$LOG" | grep -o '"bytes":[0-9]*' | cut -d: -f2)"

  if [ "$FALLOS" = "0" ]; then NUBE_OK=1; NUBE_DETALLE="ok"; else NUBE_DETALLE="$FALLOS pasos fallaron, ver backup.log"; fi
fi
[ "$NUBE_OK" = "1" ] || log "nube: NO completa — $NUBE_DETALLE"

# Estado legible para monitoreo (el último éxito se conserva si esta corrida falla).
ULTIMO_OK="$(grep -o '"ultimo_ok": *"[^"]*"' "$ESTADO" 2>/dev/null | cut -d'"' -f4)"
[ "$NUBE_OK" = "1" ] && ULTIMO_OK="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '{"corrida": "%s", "nube_ok": %s, "detalle": "%s", "ultimo_ok": "%s", "bucket_bytes": %s}\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$([ "$NUBE_OK" = 1 ] && echo true || echo false)" \
  "$NUBE_DETALLE" "$ULTIMO_OK" "${BUCKET_BYTES:-null}" > "$ESTADO"

# Heartbeat externo (Better Stack): sólo si la nube quedó completa. Si el VPS entero cae o el
# backup falla, el ping no llega y Better Stack alerta desde afuera (el vigía interno no puede).
HEARTBEAT_URL="$(env_var BACKUP_HEARTBEAT_URL)"
if [ "$NUBE_OK" = "1" ] && [ -n "$HEARTBEAT_URL" ]; then
  if curl -fsS -m 30 --retry 3 -o /dev/null "$HEARTBEAT_URL" 2>>"$LOG"; then
    log "heartbeat externo OK"
  else
    log "ERROR: no se pudo enviar el heartbeat externo"
  fi
fi

# ── 3) LOCAL: uploads (red rápida de pocos días) ─────────────────────────────
UP_OUT="$BK_DIR/uploads/uploads-$STAMP.tar.gz"
if tar -czf "$UP_OUT" -C "$APP_DIR" uploads 2>>"$LOG"; then
  log "uploads local OK -> $(basename "$UP_OUT") ($(du -h "$UP_OUT" | cut -f1))"
else
  log "ERROR: falló el tarball local de uploads"; rm -f "$UP_OUT"
fi

# ── 4) Rotación local ────────────────────────────────────────────────────────
# Si la nube falló, no se achica la red local: se retienen 14 días también de uploads.
[ "$NUBE_OK" = "1" ] || RETENTION_UPLOADS_DAYS=$RETENTION_DB_DAYS
find "$BK_DIR/db"      -name 'fusion-*.sqlite.gz' -mtime +$RETENTION_DB_DAYS      -delete 2>>"$LOG" || true
find "$BK_DIR/uploads" -name 'uploads-*.tar.gz'   -mtime +$RETENTION_UPLOADS_DAYS -delete 2>>"$LOG" || true

log "backup finalizado (nube: $NUBE_DETALLE; local base ${RETENTION_DB_DAYS}d, uploads ${RETENTION_UPLOADS_DAYS}d)"
