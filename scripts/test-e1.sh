#!/bin/bash
# Ensayo contractual de E1. Crea proyecto, Postgres, simulador y secretos efímeros; no toca E0 ni
# canales reales. E1_TRAMO=1 (fundación) o 2 (barridos): el tramo 2 además levanta el simulador de
# canales con fixture en memoria y hace barrer al worker real contra él.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PLATAFORMA="$RAIZ/plataforma"
TRABAJO="$(mktemp -d /tmp/fusion-e1.XXXXXX)"
TRAMO="${E1_TRAMO:-1}"
case "$TRAMO" in 1|2|3) ;; *) echo "E1_TRAMO debe ser 1, 2 o 3 (recibido: $TRAMO)" >&2; exit 2 ;; esac
# El tramo 3 está documentado y con contrato exigible, pero sin implementar: su gate falla a propósito
# hasta que los cortes C1–C9 del plan existan.
export E1_PROJECT="fusion-e1-$$"
export SECRET_DIR="$TRABAJO/secretos"
export ESTADO_PG_DIR="$TRABAJO/estado-pg"
export KEYRING_DIR="$TRABAJO/keyring"
REPORTE="$TRABAJO/vitest.json"
if [ -n "${E1_PORT:-}" ]; then
  export API_PORT="$E1_PORT"
else
  # Reservar un puerto efímero evita que dos ensayos aislados compitan por 53201.
  export API_PORT="$(node --input-type=module -e "import net from 'node:net'; const s=net.createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });")"
fi
COMPOSE=(docker compose -f "$PLATAFORMA/deploy/compose.test.yml" -p "$E1_PROJECT")
limpiar() {
  code=$?
  if [ "$code" -ne 0 ]; then "${COMPOSE[@]}" logs --no-color >&2 || true; fi
  if [ "${E1_KEEP:-0}" != 1 ]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TRABAJO"; else echo "E1_KEEP=1: $TRABAJO proyecto $E1_PROJECT"; fi
}
trap limpiar EXIT
mkdir -p "$SECRET_DIR" "$ESTADO_PG_DIR" "$KEYRING_DIR"
printf 'migrador\n' > "$SECRET_DIR/migrador-pass"
printf 'app\n' > "$SECRET_DIR/app-pass"
chmod 600 "$SECRET_DIR"/*
printf '{"medido":"%s","ok":true,"mas_viejo_s":0}\n' "$(date -u +%FT%TZ)" > "$ESTADO_PG_DIR/estado-pg-archivo.json"

# Keyring efímero de sobres: 32 bytes al azar, sólo para este ensayo. El worker corre como uid 1000
# dentro del contenedor y el cargador rechaza un archivo legible por grupo u otros.
node --input-type=module -e "
import { randomBytes } from 'node:crypto';
process.stdout.write(JSON.stringify({ activeKeyId: 'e1-ensayo', keys: { 'e1-ensayo': randomBytes(32).toString('base64') } }) + '\n');
" > "$KEYRING_DIR/keyring.json"
chown 1000:1000 "$KEYRING_DIR/keyring.json" 2>/dev/null || true
chmod 400 "$KEYRING_DIR/keyring.json"

sql() { "${COMPOSE[@]}" exec -T pg psql -U postgres -d plataforma -At -c "$1"; }
afirmar() { # afirmar <descripción> <esperado> <obtenido>
  if [ "$2" != "$3" ]; then echo "FALLA: $1 (esperado $2, obtenido $3)" >&2; exit 1; fi
  echo "ok: $1 = $3"
}

if [ "${E1_SKIP_UNIT:-0}" != 1 ]; then
  npm --prefix "$PLATAFORMA" run typecheck
  npm --prefix "$PLATAFORMA" test -- --reporter=json --outputFile="$REPORTE"
else
  echo 'E1_SKIP_UNIT=1: ensayo sin suite unitaria; el gate de escenarios no se aplica' >&2
fi

"${COMPOSE[@]}" up -d --build pg
for _ in $(seq 1 45); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q pg)" 2>/dev/null || true)" = healthy ] && break; sleep 1; done
"${COMPOSE[@]}" exec -T pg pg_isready -U postgres -q
"${COMPOSE[@]}" build migrate api worker scheduler
"${COMPOSE[@]}" run --rm migrate

if [ "$TRAMO" -ge 2 ]; then
  # Cuenta de canal del ensayo y sus diez corrientes, con la misma función que usa la migración.
  CUENTA="$(sql "with e as (insert into core.companies(legal_name) values ('Ensayo E1 T2') returning id),
                      a as (insert into core.channel_accounts(company_id,channel,external_account)
                            select id,'mercadolibre','ensayo-t2' from e returning id)
                 select id from a")"
  [ -n "$CUENTA" ] || { echo 'no se pudo crear la cuenta de ensayo' >&2; exit 1; }
  afirmar 'corrientes sembradas' 10 "$(sql "select integrations.sembrar_corrientes('$CUENTA')")"
  # Dos olas: envíos y mensajes descubren sus recursos por las relaciones que dejan las órdenes, y las
  # vueltas de presencia necesitan observaciones para poder declarar una baja. En el ensayo tampoco se
  # espera hasta las 04:00: las vueltas completas corren dentro de la corrida.
  sql "update integrations.reconciliation_cursors set next_run_at=now()+interval '1 hour'" >/dev/null
  sql "update integrations.reconciliation_cursors set next_run_at=now()
        where (topic,cursor_kind) in (('ml.orders','state_sweep'),('ml.questions','state_sweep'),
              ('ml.claims','state_sweep'),('ml.items','full_scan'),('woo.orders','state_sweep'),
              ('woo.products','state_sweep'))" >/dev/null
  export BARRIDOS_CUENTA="$CUENTA"
  export BARRIDOS_ML_URL='http://simulator:8080'
  export BARRIDOS_WOO_URL='http://simulator:8080'
  export BARRIDOS_ML_SELLER='777'
  export BARRIDOS_KEYRING_FILE='/run/fusion-keyring/keyring.json'
  "${COMPOSE[@]}" up -d simulator
  SIM="$("${COMPOSE[@]}" port simulator 8080)"
  for _ in $(seq 1 30); do curl -fsS "http://${SIM}/__qa/llamadas" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://${SIM}/__qa/llamadas" >/dev/null
fi

"${COMPOSE[@]}" up -d api worker scheduler
for _ in $(seq 1 45); do curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null
# E1-SVC-01: la caída del worker no arrastra a la API y /health lo declara con 503.
"${COMPOSE[@]}" stop worker >/dev/null
for _ in $(seq 1 45); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/api/v2/health")" = "503" ] && break; sleep 1; done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/api/v2/health")" = "503" ]
"${COMPOSE[@]}" start worker >/dev/null
for _ in $(seq 1 45); do curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null

if [ "$TRAMO" -ge 2 ]; then
  # El scheduler materializa cada ola y el worker real la barre contra el simulador.
  esperar_corridas() { # esperar_corridas <corridas exitosas esperadas>
    for _ in $(seq 1 90); do
      [ "$(sql "select count(*) from integrations.sweep_runs where status='succeeded'")" -ge "$1" ] && return 0
      if [ "$(sql "select count(*) from integrations.sweep_runs where status in ('failed','partial')")" != 0 ]; then
        sql "select topic||'|'||cursor_kind||' '||status||' '||coalesce(error_detail,'-') from integrations.sweep_runs where status in ('failed','partial')" >&2
        echo 'FALLA: hay corridas fallidas o parciales' >&2; return 1
      fi
      sleep 2
    done
    echo "FALLA: esperaba $1 corridas exitosas y hay $(sql "select count(*) from integrations.sweep_runs where status='succeeded'")" >&2
    return 1
  }
  esperar_corridas 6
  sql "update integrations.reconciliation_cursors set next_run_at=now()
        where (topic,cursor_kind) in (('ml.shipments','state_sweep'),('ml.messages','state_sweep'),
              ('woo.orders','full_scan'),('woo.products','full_scan'))" >/dev/null
  esperar_corridas 10
  afirmar 'corrientes barridas con éxito' 10 "$(sql "select count(distinct (topic,cursor_kind)) from integrations.sweep_runs where status='succeeded'")"
  afirmar 'corridas no exitosas' 0 "$(sql "select count(*) from integrations.sweep_runs where status<>'succeeded'")"
  afirmar 'tópicos con inbox' 8 "$(sql "select count(distinct topic) from integrations.inbox_messages")"
  afirmar 'payloads sin cifrar' 0 "$(sql "select count(*) from integrations.inbox_messages where payload_ciphertext is null or payload_key_id is null or payload_nonce is null or payload_tag is null")"
  afirmar 'payloads con PII en claro' 0 "$(sql "select count(*) from integrations.inbox_messages where encode(payload_ciphertext,'escape') like '%fixture.invalid%'")"
  afirmar 'cursores sin avanzar' 0 "$(sql "select count(*) from integrations.reconciliation_cursors where cursor_value is null")"
  afirmar 'relaciones descubiertas' 1 "$(sql "select (count(*) > 0)::int from integrations.resource_relations")"
  afirmar 'observaciones registradas' 1 "$(sql "select (count(*) > 0)::int from integrations.resource_observations")"
  # Ningún método distinto de GET puede atribuirse al transporte de canal; `__qa` es plano de control.
  node --input-type=module -e "
const llamadas = await (await fetch('http://${SIM}/__qa/llamadas')).json();
const canal = llamadas.filter((l) => l.headers?.['x-fusion-plano'] === 'canal');
const noGet = canal.filter((l) => l.metodo !== 'GET');
if (!canal.length) { console.error('el simulador no registró llamadas de canal'); process.exit(1); }
if (noGet.length) { console.error('métodos no GET en el canal: ' + noGet.map((l) => l.metodo + ' ' + l.ruta).join(', ')); process.exit(1); }
console.log('ok: ' + canal.length + ' llamadas de canal, todas GET');
"
fi

if [ "${E1_SKIP_UNIT:-0}" != 1 ]; then
  node "$RAIZ/scripts/qa/gate-e1.mjs" --tramo "$TRAMO" --reporte "$REPORTE" --verificado E1-SVC-01
fi

# Ningún proceso ni contenedor del ensayo queda vivo.
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null
RESTANTES="$(docker ps -a --format '{{.Names}}' | grep -c "^${E1_PROJECT}" || true)"
afirmar 'contenedores del ensayo restantes' 0 "$RESTANTES"

if [ "$TRAMO" -ge 2 ]; then
  echo "{\"tramo\":\"E1-$TRAMO\",\"resultado\":\"ok\",\"escenarios\":[\"SCH\",\"AUD\",\"Q\",\"DUP\",\"CAP\",\"API\",\"SVC\",\"SWP\",\"CONV\",\"DEL\"]}"
else
  echo '{"tramo":"E1-1","resultado":"ok","escenarios":["SCH","AUD","Q","DUP","CAP","API","SVC"]}'
fi
