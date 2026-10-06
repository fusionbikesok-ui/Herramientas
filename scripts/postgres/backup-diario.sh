#!/bin/bash
# Backup diario de PostgreSQL (E0 nivel 1). Cron del sistema: /etc/cron.d/fusion-backup, 05:30 UTC.
# Domingo: full. Resto: diferencial (pgBackRest lo convierte en full si todavía no existe uno).
# Verifica el repositorio, deja estado en /opt/fusionbikes/backups/estado-pg.json, firma un registro
# Ed25519 y avisa al heartbeat de Better Stack si PG_BACKUP_HEARTBEAT_URL está en .env.
set -uo pipefail

REPO="/opt/fusionbikes/herramientas"
C=(docker compose -f "$REPO/deploy/postgres/compose.prod.yml" -p fusion-pg)
ESTADO="/opt/fusionbikes/backups/estado-pg.json"
REGISTROS="/opt/fusionbikes/backups/pg-registros"
LOG="/opt/fusionbikes/backups/backup-pg.log"
ENV_FILE="$REPO/.env"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }
mkdir -p "$REGISTROS"

TIPO=diff
[ "$(date -u +%u)" = "7" ] && TIPO=full
T0=$(date +%s)
OK=1; DETALLE=ok
if ! "${C[@]}" exec -T pg pgbr --type="$TIPO" backup >>"$LOG" 2>&1; then OK=0; DETALLE="backup $TIPO falló"; fi
if [ "$OK" = 1 ] && ! "${C[@]}" exec -T pg pgbr verify >>"$LOG" 2>&1; then OK=0; DETALLE="verify falló"; fi
# Manifiesto para el nivel 2 (PM-169): sha256 de cada archivo del repositorio tras un backup verificado.
# La Mac lo baja junto con el repositorio y verifica su copia contra él.
if [ "$OK" = 1 ]; then
  MANIFIESTO="/opt/fusionbikes/postgres/repo/MANIFEST-fusion.sha256"
  if (cd /opt/fusionbikes/postgres/repo && find archive backup -type f -print0 | sort -z | xargs -0 sha256sum > "$MANIFIESTO.tmp") 2>>"$LOG"; then
    mv "$MANIFIESTO.tmp" "$MANIFIESTO"; chmod 644 "$MANIFIESTO"
  else
    rm -f "$MANIFIESTO.tmp"; OK=0; DETALLE="no se pudo generar el manifiesto del repositorio"
  fi
fi
DURACION=$(( $(date +%s) - T0 ))

AHORA="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
ULTIMO_OK="$(grep -o '"ultimo_ok": *"[^"]*"' "$ESTADO" 2>/dev/null | cut -d'"' -f4)"
[ "$OK" = 1 ] && ULTIMO_OK="$AHORA"
REPO_BYTES="$(du -sb /opt/fusionbikes/postgres/repo 2>/dev/null | cut -f1)"
printf '{"corrida": "%s", "ok": %s, "tipo": "%s", "detalle": "%s", "duracion_s": %s, "ultimo_ok": "%s", "repo_bytes": %s}\n' \
  "$AHORA" "$([ "$OK" = 1 ] && echo true || echo false)" "$TIPO" "$DETALLE" "$DURACION" "$ULTIMO_OK" "${REPO_BYTES:-null}" > "$ESTADO.tmp" \
  && mv "$ESTADO.tmp" "$ESTADO"

REGISTRO="$REGISTROS/backup-$(date -u +%Y%m%dT%H%M%SZ).json"
{ cat "$ESTADO"; } > "$REGISTRO"
bash "$REPO/scripts/postgres/firmar-registro.sh" firmar "$REGISTRO" >>"$LOG" 2>&1 || log "ERROR: no se pudo firmar $REGISTRO"
find "$REGISTROS" -name 'backup-*.json*' -mtime +90 -delete 2>/dev/null || true

if [ "$OK" = 1 ]; then
  URL="$(grep -m1 '^PG_BACKUP_HEARTBEAT_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r')"
  if [ -n "$URL" ]; then
    curl -fsS -m 30 --retry 3 -o /dev/null "$URL" 2>>"$LOG" && log "heartbeat PostgreSQL OK" || log "ERROR: heartbeat PostgreSQL"
  fi
fi
log "backup PostgreSQL $TIPO: $DETALLE en ${DURACION} s"
[ "$OK" = 1 ]
