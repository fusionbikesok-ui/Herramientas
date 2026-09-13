#!/bin/bash
# Estado del archivado de WAL (E0 nivel 1). Cron del sistema cada 5 min.
# Mide lo que de verdad importa para el RPO: segmentos cerrados que PostgreSQL todavía no pudo
# archivar (archivos .ready) y la antigüedad del más viejo. `last_archived_time` no sirve: con la base
# inactiva no hay segmentos nuevos y parecería un atraso.
set -uo pipefail

REPO="/opt/fusionbikes/herramientas"
C=(docker compose -f "$REPO/deploy/postgres/compose.prod.yml" -p fusion-pg)
ESTADO="/opt/fusionbikes/backups/estado-pg-archivo.json"

AHORA="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
DATOS="$("${C[@]}" exec -T pg bash -c '
  cd "$PGDATA/pg_wal/archive_status" 2>/dev/null || { echo "error sin_pg_wal"; exit 0; }
  n=0; viejo=0; ahora=$(date +%s)
  for f in *.ready; do
    [ -e "$f" ] || continue
    n=$((n+1)); edad=$(( ahora - $(stat -c %Y "$f") ))
    [ "$edad" -gt "$viejo" ] && viejo=$edad
  done
  spool=$(du -sb /var/spool/pgbackrest 2>/dev/null | cut -f1)
  echo "ok $n $viejo ${spool:-0}"' 2>/dev/null)"
FALLIDOS="$("${C[@]}" exec -T pg psql -U postgres -Atqc "select case when last_failed_time is not null and (last_archived_time is null or last_failed_time > last_archived_time) then 1 else 0 end from pg_stat_archiver" 2>/dev/null)"

read -r ESTADO_LECTURA PENDIENTES MAS_VIEJO_S SPOOL_BYTES <<<"${DATOS:-error sin_respuesta}"
if [ "$ESTADO_LECTURA" = "ok" ]; then
  printf '{"medido": "%s", "ok": true, "pendientes": %s, "mas_viejo_s": %s, "spool_bytes": %s, "ultimo_intento_fallido": %s}\n' \
    "$AHORA" "$PENDIENTES" "$MAS_VIEJO_S" "$SPOOL_BYTES" "${FALLIDOS:-null}" > "$ESTADO.tmp"
else
  printf '{"medido": "%s", "ok": false, "detalle": "%s"}\n' "$AHORA" "${PENDIENTES:-sin_respuesta}" > "$ESTADO.tmp"
fi
mv "$ESTADO.tmp" "$ESTADO"
