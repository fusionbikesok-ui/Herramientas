#!/bin/bash
# npm run test:e0 — ensayo del nivel 1 de DR (docs/superpowers/deliveries/E0-infraestructura-dr.md).
# Todo ocurre en un proyecto Docker y un directorio temporales; al terminar se borra (E0_KEEP=1 lo
# conserva para inspección). Falla (exit != 0) si falta cualquier escenario obligatorio.
#
# Escenarios: E0-WAL-01 archive_command con spool; E0-WAL-02 push asíncrono al repositorio;
# E0-WAL-03 backup completo + verify; E0-PITR-01 restauración a un instante en otro contenedor;
# E0-RPO-01 RPO/RTO medidos y registro firmado; E0-LEG-01 producción legacy intacta.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
export E0_PROJECT="fusion-pg-e0-$$"
export E0_DIR="${E0_DIR:-$(mktemp -d /tmp/fusion-pg-e0.XXXXXX)}"
export E0_PORT="${E0_PORT:-55432}"
COMPOSE=(docker compose -f "$REPO/deploy/postgres/compose.yml" -p "$E0_PROJECT")
RESULTADO="$E0_DIR/resultado.json"
FALLOS=0
declare -A ESTADO

log() { echo "[e0 $(date -u '+%H:%M:%S')] $*"; }
ok() { ESTADO[$1]="ok"; log "OK   $1 — $2"; }
falla() { ESTADO[$1]="falla"; FALLOS=$((FALLOS+1)); log "FALLA $1 — $2"; }
psqlq() { "${COMPOSE[@]}" exec -T pg psql -U postgres -d "${2:-postgres}" -Atqc "$1"; }
pgbr() { "${COMPOSE[@]}" exec -T -u postgres pg pgbackrest --stanza=fusion "$@"; }

limpiar() {
  local code=$?
  if [ "${E0_KEEP:-0}" != "1" ]; then
    "${COMPOSE[@]}" --profile restore down -v --remove-orphans >/dev/null 2>&1 || true
    docker run --rm -v "$E0_DIR:/d" alpine:3 sh -c 'rm -rf /d/* /d/.[!.]*' >/dev/null 2>&1 || true
    rm -rf "$E0_DIR"
  else
    log "E0_KEEP=1: se conserva $E0_DIR y el proyecto $E0_PROJECT"
  fi
  exit $code
}
trap limpiar EXIT

# E0-LEG-01 (antes): huella de producción legacy
LEG_ANTES="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/healthz || echo sin-respuesta)"

mkdir -p "$E0_DIR"/{pgdata,repo,spool,secrets,restore-data,restore-spool}
openssl rand -base64 24 > "$E0_DIR/secrets/postgres-pass"
export E0_CIPHER_PASS="$(openssl rand -base64 32)"   # clave de ensayo: se descarta con el directorio
# El contenedor corre procesos como postgres (uid 999 en la imagen oficial).
chown -R 999:999 "$E0_DIR"/{pgdata,repo,spool,restore-data,restore-spool}
chmod 755 "$E0_DIR/secrets"; chmod 644 "$E0_DIR/secrets/postgres-pass"

log "build y arranque (proyecto $E0_PROJECT, puerto 127.0.0.1:$E0_PORT)"
"${COMPOSE[@]}" up -d --build pg >/dev/null 2>&1
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q pg)" 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
psqlq "select 1" >/dev/null || { falla E0-WAL-01 "PostgreSQL no arrancó"; exit 1; }

log "stanza"
pgbr stanza-create >/dev/null
if pgbr check >/dev/null 2>&1; then ok E0-WAL-01 "pgbackrest check: archive_command empuja WAL vía spool"; else falla E0-WAL-01 "pgbackrest check falló"; fi

log "base de ensayo y backup completo"
psqlq "create database e0_test" >/dev/null
psqlq "create table centinela (id bigserial primary key, fase text not null, creado timestamptz not null default clock_timestamp())" e0_test
psqlq "insert into centinela (fase) select 'antes_backup' from generate_series(1,1000)" e0_test
T_BACKUP0=$(date +%s)
if pgbr --type=full backup >/dev/null 2>&1 && pgbr verify >/dev/null 2>&1; then
  ok E0-WAL-03 "backup completo y verify en $(( $(date +%s) - T_BACKUP0 )) s"
else
  falla E0-WAL-03 "backup o verify con error"
fi

log "escritura, instante objetivo y escritura posterior"
psqlq "insert into centinela (fase) select 'antes_objetivo' from generate_series(1,500)" e0_test
sleep 2
TARGET="$(psqlq "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
ESPERADAS="$(psqlq "select count(*) from centinela" e0_test)"
sleep 2
psqlq "insert into centinela (fase) select 'despues_objetivo' from generate_series(1,700)" e0_test
psqlq "select pg_switch_wal()" >/dev/null

# E0-WAL-02: el push asíncrono lleva el WAL al repositorio; se mide la demora (archive lag) hasta que
# pg_stat_archiver informa EXACTAMENTE el segmento recién cerrado.
esperar_archivado() {  # $1 = nombre del segmento; imprime segundos o -1 si no llegó en 180 s
  local t0=$(date +%s)
  for _ in $(seq 1 180); do
    [ "$(psqlq "select coalesce(last_archived_wal,'') >= '$1' from pg_stat_archiver")" = "t" ] && { echo $(( $(date +%s) - t0 )); return; }
    sleep 1
  done
  echo -1
}
# Se escribe antes de tomar el segmento: un pg_switch_wal() sobre un segmento vacío no cierra nada y la
# medición terminaría esperando archive_timeout (medido: 121 s en vez de ~1 s).
# failed_count es acumulado desde el arranque: incluye intentos previos a stanza-create. Se mide la
# diferencia dentro de la ventana del escenario.
FALLIDOS_ANTES="$(psqlq "select failed_count from pg_stat_archiver")"
psqlq "insert into centinela (fase) select 'medicion_lag' from generate_series(1,100)" e0_test
SEG="$(psqlq "select pg_walfile_name(pg_current_wal_lsn())")"
psqlq "select pg_switch_wal()" >/dev/null
LAG="$(esperar_archivado "$SEG")"
FALLIDOS_VENTANA=$(( $(psqlq "select failed_count from pg_stat_archiver") - FALLIDOS_ANTES ))
if [ "$FALLIDOS_VENTANA" = "0" ] && [ "$LAG" -ge 0 ] && [ "$LAG" -le 180 ]; then
  ok E0-WAL-02 "WAL archivado en el repositorio; demora ${LAG} s (alerta > 180 s); 0 fallos en la ventana (previos al escenario: $FALLIDOS_ANTES)"
else
  falla E0-WAL-02 "fallos en la ventana: $FALLIDOS_VENTANA; demora ${LAG} s"
  log "diagnóstico pg_stat_archiver: $(psqlq "select archived_count||' archivados, '||failed_count||' fallidos, último fallido '||coalesce(last_failed_wal,'-')||' a las '||coalesce(last_failed_time::text,'-') from pg_stat_archiver")"
  "${COMPOSE[@]}" exec -T pg bash -c 'tail -n 15 /var/log/pgbackrest/*archive-push*.log 2>/dev/null | grep -E "ERROR|WARN" | tail -5' || true
fi

# Caída del proceso de push: sin procps en la imagen, se busca por /proc. Se exige haber matado al
# menos un proceso; el segmento cerrado durante la caída tiene que llegar al repositorio igual.
log "caída del proceso asíncrono de push"
matar_push() {
  # Sólo procesos cuyo ejecutable es pgbackrest (primer argumento) y nunca este mismo shell: su propio
  # texto contiene el patrón buscado y se mataba a sí mismo antes de imprimir el conteo.
  "${COMPOSE[@]}" exec -T pg bash -c '
    n=0; yo=$$
    for d in /proc/[0-9]*; do
      pid=${d#/proc/}; [ "$pid" = "$yo" ] && continue
      exe=$(tr "\0" "\n" < "$d/cmdline" 2>/dev/null | head -n1) || continue
      case "$exe" in pgbackrest|*/pgbackrest) ;; *) continue ;; esac
      tr "\0" " " < "$d/cmdline" 2>/dev/null | grep -q "archive-push:async" || continue
      kill -9 "$pid" 2>/dev/null && n=$((n+1))
    done
    echo "$n"' 2>/dev/null || echo 0
}
# Asegurar que el proceso asíncrono exista: se genera WAL y se lo busca varias veces.
# Además se exige que postgres NO se reinicie: sin init como PID 1, matar el push huérfano provocaba
# recuperación de arranque (medido 2026-09-13).
INICIO_PG="$(psqlq "select pg_postmaster_start_time()")"
MUERTOS=0
for _ in $(seq 1 20); do
  psqlq "insert into centinela (fase) select 'durante_caida' from generate_series(1,200)" e0_test
  psqlq "select pg_switch_wal()" >/dev/null
  M="$(matar_push | tr -dc '0-9')"
  MUERTOS=$(( MUERTOS + ${M:-0} ))
  [ "$MUERTOS" -gt 0 ] && break
done
sleep 3
for _ in $(seq 1 30); do psqlq "select 1" >/dev/null 2>&1 && break; sleep 1; done
INICIO_PG_DESPUES="$(psqlq "select pg_postmaster_start_time()" 2>/dev/null || echo desconocido)"
SEG_CAIDA="$(psqlq "select pg_walfile_name(pg_current_wal_lsn())")"
psqlq "insert into centinela (fase) select 'durante_caida' from generate_series(1,100)" e0_test
psqlq "select pg_switch_wal()" >/dev/null
LAG_CAIDA="$(esperar_archivado "$SEG_CAIDA")"
if [ "$MUERTOS" -gt 0 ] && [ "$INICIO_PG" != "$INICIO_PG_DESPUES" ]; then
  falla E0-WAL-01b "matar el push asíncrono reinició postgres ($INICIO_PG → $INICIO_PG_DESPUES): falta init como PID 1"
elif [ "$MUERTOS" -gt 0 ] && [ "$LAG_CAIDA" -ge 0 ] && pgbr check >/dev/null 2>&1; then
  ok E0-WAL-01b "matados $MUERTOS proceso(s) de push sin reiniciar postgres; el segmento cerrado durante la caída llegó en ${LAG_CAIDA} s y check pasa"
elif [ "$MUERTOS" -eq 0 ]; then
  falla E0-WAL-01b "no se encontró ningún proceso archive-push:async para matar: el escenario no se probó"
else
  falla E0-WAL-01b "tras la caída el segmento no llegó (lag $LAG_CAIDA) o check falló"
fi
psqlq "select pg_switch_wal()" >/dev/null
pgbr check >/dev/null 2>&1 || true

log "restauración PITR en otro contenedor hasta $TARGET"
"${COMPOSE[@]}" --profile restore up -d restore >/dev/null 2>&1
T_RESTORE0=$(date +%s)
if "${COMPOSE[@]}" exec -T -u postgres restore pgbackrest --stanza=fusion --type=time "--target=$TARGET" --target-action=promote --pg1-path=/var/lib/postgresql/data/pgdata restore >/dev/null 2>&1 \
   && "${COMPOSE[@]}" exec -T -u postgres -d restore postgres -D /var/lib/postgresql/data/pgdata -c archive_mode=off >/dev/null 2>&1; then
  for _ in $(seq 1 90); do
    "${COMPOSE[@]}" exec -T -u postgres restore pg_isready -q >/dev/null 2>&1 && \
      [ "$("${COMPOSE[@]}" exec -T -u postgres restore psql -Atqc 'select pg_is_in_recovery()' 2>/dev/null)" = "f" ] && break
    sleep 2
  done
  RTO=$(( $(date +%s) - T_RESTORE0 ))
  RESTAURADAS="$("${COMPOSE[@]}" exec -T -u postgres restore psql -d e0_test -Atqc "select count(*) from centinela" 2>/dev/null || echo 0)"
  POSTERIORES="$("${COMPOSE[@]}" exec -T -u postgres restore psql -d e0_test -Atqc "select count(*) from centinela where fase='despues_objetivo'" 2>/dev/null || echo -1)"
  if [ "$RESTAURADAS" = "$ESPERADAS" ] && [ "$POSTERIORES" = "0" ]; then
    ok E0-PITR-01 "restaurado al instante: $RESTAURADAS filas (esperadas $ESPERADAS), 0 posteriores; RTO ${RTO} s"
  else
    falla E0-PITR-01 "filas restauradas $RESTAURADAS, esperadas $ESPERADAS, posteriores $POSTERIORES"
  fi
else
  RTO=-1
  falla E0-PITR-01 "pgbackrest restore o arranque falló"
fi

# E0-RPO-01: RPO acotado por archive_timeout + demora de push medida; RTO del ensayo local.
RPO_MAX=$(( 60 + LAG ))
if [ "$RPO_MAX" -le 300 ] && [ "$RTO" -ge 0 ] && [ "$RTO" -le 3600 ]; then
  ok E0-RPO-01 "RPO máximo estimado ${RPO_MAX} s (≤ 300), RTO ${RTO} s (≤ 3600)"
else
  falla E0-RPO-01 "RPO ${RPO_MAX} s o RTO ${RTO} s fuera de objetivo"
fi

LEG_DESPUES="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/healthz || echo sin-respuesta)"
if [ "$LEG_ANTES" = "$LEG_DESPUES" ]; then ok E0-LEG-01 "healthz legacy igual antes y después ($LEG_DESPUES)"; else falla E0-LEG-01 "healthz legacy cambió: $LEG_ANTES → $LEG_DESPUES"; fi

INFO="$(pgbr --output=json info 2>/dev/null | head -c 20000 || echo '[]')"
{
  printf '{"commit":"%s","fecha_utc":"%s","postgres":"18.6","pgbackrest":"2.59.1",' "$(git -C "$REPO" rev-parse --short HEAD)" "$(date -u +%FT%TZ)"
  printf '"target":"%s","rpo_max_s":%s,"rto_s":%s,"archive_lag_s":%s,"lag_tras_caida_s":%s,"procesos_push_matados":%s,"escenarios":{' "$TARGET" "$RPO_MAX" "$RTO" "$LAG" "${LAG_CAIDA:--1}" "${MUERTOS:-0}"
  primero=1; for k in "${!ESTADO[@]}"; do [ $primero = 1 ] || printf ','; primero=0; printf '"%s":"%s"' "$k" "${ESTADO[$k]}"; done
  printf '},"fallos":%s}\n' "$FALLOS"
} > "$RESULTADO"
echo "$INFO" > "$E0_DIR/pgbackrest-info.json"
HASH="$(sha256sum "$RESULTADO" | cut -d' ' -f1)"
log "registro: $(cat "$RESULTADO")"
log "sha256 del registro: $HASH"
# E0-FIRMA-01: firma Ed25519 con una clave descartable del ensayo y verificación con su pública; un
# registro alterado tiene que fallar la verificación. En producción se usa la clave del VPS.
openssl genpkey -algorithm ed25519 -out "$E0_DIR/firma.pem" 2>/dev/null
openssl pkey -in "$E0_DIR/firma.pem" -pubout -out "$E0_DIR/firma.pub" 2>/dev/null
if bash "$REPO/scripts/postgres/firmar-registro.sh" firmar "$RESULTADO" "$E0_DIR/firma.pem" >/dev/null \
   && bash "$REPO/scripts/postgres/firmar-registro.sh" verificar "$RESULTADO" "$E0_DIR/firma.pub" >/dev/null 2>&1; then
  cp "$RESULTADO" "$E0_DIR/alterado.json"; cp "$RESULTADO.sig" "$E0_DIR/alterado.json.sig"
  sed -i 's/"fallos"/"fallos_alterado"/' "$E0_DIR/alterado.json"
  if bash "$REPO/scripts/postgres/firmar-registro.sh" verificar "$E0_DIR/alterado.json" "$E0_DIR/firma.pub" >/dev/null 2>&1; then
    falla E0-FIRMA-01 "un registro alterado pasó la verificación"
  else
    ok E0-FIRMA-01 "registro firmado con Ed25519, verificado, y la alteración detectada"
  fi
else
  falla E0-FIRMA-01 "no se pudo firmar o verificar el registro"
fi

OBLIGATORIOS=(E0-WAL-01 E0-WAL-01b E0-WAL-02 E0-WAL-03 E0-PITR-01 E0-RPO-01 E0-LEG-01 E0-FIRMA-01)
for e in "${OBLIGATORIOS[@]}"; do [ -n "${ESTADO[$e]:-}" ] || { log "FALLA escenario obligatorio sin ejecutar: $e"; FALLOS=$((FALLOS+1)); }; done
[ "$FALLOS" = "0" ] && log "E0 nivel 1: todos los escenarios OK" || log "E0 nivel 1: $FALLOS falla(s)"
exit "$FALLOS"
