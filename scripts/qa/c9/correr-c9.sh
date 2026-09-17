#!/bin/bash
# E1 T3 · C9 — E1-LAT-01 (latencia del ACK en tres modos) y E1-PGDOWN-01 (PostgreSQL detenido con tráfico).
#
# Todo aislado: PostgreSQL y la API de señales en un proyecto Docker efímero, y una instancia PROPIA del
# legado sobre una base SQLite nueva, escuchando sólo en 127.0.0.1, con crons apagados, sin el .env de
# producción (arranca en el directorio de trabajo) y con ML/Woo apuntando a direcciones inalcanzables.
# Nunca toca la app de producción ni su base (sólo la lee en solo lectura para anonimizar).
#
# Parámetros por entorno (defaults = corrida contractual):
#   C9_N=500 C9_DURACION_S=1800 C9_PG_STOP_TRAS_S=300 C9_PG_CAIDO_S=600 C9_IMPORTAR_CADA_MS=300000
#   C9_ESPERA_IMPORT_S=420 C9_CARGA_MAX=1.6 C9_EVIDENCIA_REPO=1 (copia el resumen al repo)
#   C9_REUSAR=/root/e1-c9/<ts> + C9_CORRIDAS="C": retoma una corrida interrumpida con las MISMAS peticiones
#   y los resultados ya completos de las corridas que no se repiten.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
PLATAFORMA="$RAIZ/plataforma"
N="${C9_N:-500}"; DUR="${C9_DURACION_S:-1800}"; PG_STOP="${C9_PG_STOP_TRAS_S:-300}"; PG_CAIDO="${C9_PG_CAIDO_S:-600}"
IMPORT_MS="${C9_IMPORTAR_CADA_MS:-300000}"; ESPERA_IMPORT="${C9_ESPERA_IMPORT_S:-420}"; CARGA_MAX="${C9_CARGA_MAX:-1.6}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="/root/e1-c9/$TS"; mkdir -p "$WORK"; chmod 700 /root/e1-c9 "$WORK"
exec > >(tee -a "$WORK/c9.log") 2>&1
echo "C9 $TS N=$N DUR=${DUR}s PG_STOP=${PG_STOP}s PG_CAIDO=${PG_CAIDO}s"

puerto_libre() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
export E1_PROJECT="fusion-c9-$$"
export SECRET_DIR="$WORK/secretos" ESTADO_PG_DIR="$WORK/estado-pg" KEYRING_DIR="$WORK/keyring"
export API_PORT="$(puerto_libre)"
LPORT="$(puerto_libre)"
COMPOSE=(docker compose -f "$PLATAFORMA/deploy/compose.test.yml" -p "$E1_PROJECT")
LEGADO_PID=""

limpiar() {
  code=$?
  [ -n "$LEGADO_PID" ] && kill "$LEGADO_PID" 2>/dev/null || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  echo "C9 fin (exit $code). Evidencia en $WORK"
}
trap limpiar EXIT

# Guardas: nunca con el VPS cargado ni con producción caída.
guarda() {
  local carga; carga="$(cut -d' ' -f1 /proc/loadavg)"
  if awk -v c="$carga" -v m="$CARGA_MAX" 'BEGIN{exit !(c>m)}'; then echo "ABORTO: carga $carga > $CARGA_MAX"; exit 3; fi
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001/healthz)" = 200 ] || { echo "ABORTO: producción no responde /healthz"; exit 3; }
}
guarda

mkdir -p "$SECRET_DIR" "$ESTADO_PG_DIR" "$KEYRING_DIR"
printf 'migrador\n' > "$SECRET_DIR/migrador-pass"; printf 'app\n' > "$SECRET_DIR/app-pass"; chmod 600 "$SECRET_DIR"/*
printf '{"medido":"%s","ok":true,"mas_viejo_s":0}\n' "$(date -u +%FT%TZ)" > "$ESTADO_PG_DIR/estado-pg-archivo.json"
node -e "const c=require('crypto');process.stdout.write(JSON.stringify({activeKeyId:'c9',keys:{c9:c.randomBytes(32).toString('base64')}}))" > "$KEYRING_DIR/senales.json"
node -e "const c=require('crypto');process.stdout.write(JSON.stringify({activeKeyId:'c9',keys:{c9:c.randomBytes(32).toString('base64')}}))" > "$KEYRING_DIR/keyring.json"
chown 1000:1000 "$KEYRING_DIR"/*.json 2>/dev/null || true; chmod 400 "$KEYRING_DIR"/*.json
WOO_SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
QA_USER=424242

# 1) Webhooks anonimizados desde recibos reales (base de producción en solo lectura).
PROD_DB="$(grep '^DB_PATH=' "$RAIZ/.env" | cut -d= -f2-)"
if [ -n "${C9_REUSAR:-}" ]; then
  cp "$C9_REUSAR/peticiones.json" "$WORK/peticiones.json"
  for c in A B C; do case " ${C9_CORRIDAS:-A B C} " in *" $c "*) ;; *) cp -r "$C9_REUSAR/$c" "$WORK/$c"; echo "reusa corrida $c de $C9_REUSAR";; esac; done
else
  node "$RAIZ/scripts/qa/c9/anonimizar.mjs" "$PROD_DB" "$WORK/peticiones.json" "$N" "$QA_USER"
fi

# 2) PostgreSQL + API de señales aislados.
"${COMPOSE[@]}" up -d pg
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q pg)" 2>/dev/null || true)" = healthy ] && break; sleep 1; done
"${COMPOSE[@]}" build migrate api >/dev/null
"${COMPOSE[@]}" run --rm migrate >/dev/null
sql() { "${COMPOSE[@]}" exec -T pg psql -U postgres -d plataforma -At -c "$1"; }
EMPRESA="$(sql "with e as (insert into core.companies(legal_name) values ('C9') returning id) select id from e")"
CML="$(sql "with a as (insert into core.channel_accounts(company_id,channel,external_account) values ('$EMPRESA','mercadolibre','$QA_USER') returning id) select id from a")"
CWOO="$(sql "with a as (insert into core.channel_accounts(company_id,channel,external_account) values ('$EMPRESA','woocommerce','https://c9.invalid') returning id) select id from a")"
export SENALES_KEYRING_FILE=/run/fusion-keyring/senales.json SENALES_CUENTAS="mercadolibre=$CML,woocommerce=$CWOO" SENALES_ORIGENES="127.0.0.1/32,172.16.0.0/12"
"${COMPOSE[@]}" up -d api
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$API_PORT/api/v2/health" && break; sleep 1; done

# 3) Instancia aislada del legado. `env -i` + cwd en el directorio de trabajo: no hereda el .env real.
arrancar_legado() { # arrancar_legado <corrida> <copia:on|off>
  local dir="$WORK/$1"; mkdir -p "$dir"
  local sombra=()
  [ "$2" = on ] && sombra=(SOMBRA_COPIA_ENABLED=true "SOMBRA_PLATAFORMA_URL=http://127.0.0.1:$API_PORT" "SOMBRA_KEYRING_FILE=$KEYRING_DIR/senales.json" "SOMBRA_IMPORTAR_CADA_MS=$IMPORT_MS")
  (cd "$dir" && env -i PATH="$PATH" HOME="$dir" \
     PORT="$LPORT" LISTEN_HOST=127.0.0.1 DB_PATH="$dir/legado.sqlite" DISABLE_CRONS=true \
     SESSION_SECRET=c9-sesion MOBILE_JWT_SECRET=c9-mobile-jwt-secret-0123456789abcdef ML_USER_ID="$QA_USER" \
     WOO_WEBHOOK_SECRET="$WOO_SECRET" ML_API_BASE=http://127.0.0.1:9 WOO_URL=https://c9.invalid WOO_CK=x WOO_CS=x \
     "${sombra[@]}" node "$RAIZ/server.js" > "$dir/legado.log" 2>&1) &
  LEGADO_PID=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$LPORT/healthz" && return 0; sleep 1; done
  echo "ABORTO: el legado de prueba no arrancó"; tail -20 "$dir/legado.log"; exit 4
}
parar_legado() {
  # El PID es el del subshell que lanzó node: se termina el árbol propio, nunca por patrón.
  pkill -P "$LEGADO_PID" 2>/dev/null || true; kill "$LEGADO_PID" 2>/dev/null || true; wait "$LEGADO_PID" 2>/dev/null || true; LEGADO_PID=""
  sleep 2
}

corrida() { # corrida <nombre> <copia>
  guarda
  echo "== corrida $1 (copia $2)"
  arrancar_legado "$1" "$2"
  node "$RAIZ/scripts/qa/c9/carga.mjs" "$WORK/peticiones.json" "http://127.0.0.1:$LPORT" "$DUR" "$WOO_SECRET" "$WORK/$1/carga.json" &
  local carga=$!
  if [ "$1" = C ]; then
    sleep "$PG_STOP"; echo "   PostgreSQL detenido $(date -u +%T)"; "${COMPOSE[@]}" stop pg >/dev/null
    sleep "$PG_CAIDO"; "${COMPOSE[@]}" start pg >/dev/null; echo "   PostgreSQL de vuelta $(date -u +%T)"
  fi
  wait "$carga"
  if [ "$1" = C ]; then
    for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$API_PORT/api/v2/health" && break; sleep 2; done
    echo "   esperando importación de pérdidas ${ESPERA_IMPORT}s"; sleep "$ESPERA_IMPORT"
  fi
  parar_legado
}

for c in ${C9_CORRIDAS:-A B C}; do case "$c" in A) corrida A off;; B) corrida B on;; C) corrida C on;; esac; done

# 4) Evaluación.
AUDIT="$(sql "select count(*) from audit.audit_events where action='shadow.loss_imported'" || echo -1)"
SENALES="$(sql "select count(*) from integrations.reconciliation_signals" || echo -1)"
RESULTADO=0
node - "$WORK" "$AUDIT" "$SENALES" "$TS" <<'JS' || RESULTADO=$?
const fs = require('fs'); const path = require('path');
const [work, audit, senales, ts] = process.argv.slice(2);
const Database = require(path.join(process.env.RAIZ_NODE_MODULES || '/opt/fusionbikes/herramientas/node_modules', 'better-sqlite3'));
const leer = (c) => JSON.parse(fs.readFileSync(path.join(work, c, 'carga.json'), 'utf8')).resumen;
const A = leer('A'), B = leer('B'), C = leer('C');
const errores = (c) => new Set(fs.readFileSync(path.join(work, c, 'legado.log'), 'utf8').split('\n')
  .filter((l) => /error/i.test(l) && !/^\[sombra\]/.test(l)).map((l) => l.replace(/\d+/g, '#').replace(/[0-9a-f]{12,}/gi, 'H').trim()));
const eA = errores('A');
const nuevos = (c) => [...errores(c)].filter((l) => !eA.has(l));
const db = new Database(path.join(work, 'C', 'legado.sqlite'), { readonly: true });
const perdidas = db.prepare("SELECT COUNT(*) n, SUM(shadow_imported_at IS NOT NULL) importadas FROM integration_events WHERE shadow_status='discarded' AND shadow_reason IN ('platform_unavailable','platform_timeout')").get();
const estadosC = db.prepare('SELECT shadow_status s, shadow_reason r, COUNT(*) n FROM integration_events GROUP BY 1,2').all();
db.close();
const mismosCodigos = (x) => JSON.stringify(Object.keys(x.codigos).sort()) === JSON.stringify(Object.keys(A.codigos).sort())
  && Object.keys(A.codigos).every((k) => x.codigos[k] === A.codigos[k]);
const lat = {
  B: { dp95: B.p95 - A.p95, dp99: B.p99 - A.p99 }, C: { dp95: C.p95 - A.p95, dp99: C.p99 - A.p99 },
};
const checks = {
  'E1-LAT-01 Δp95 B ≤ 25 ms': lat.B.dp95 <= 25, 'E1-LAT-01 Δp99 B ≤ 100 ms': lat.B.dp99 <= 100,
  'E1-LAT-01 Δp95 C ≤ 25 ms': lat.C.dp95 <= 25, 'E1-LAT-01 Δp99 C ≤ 100 ms': lat.C.dp99 <= 100,
  'E1-LAT-01 0 cambios de código HTTP (B)': mismosCodigos(B), 'E1-LAT-01 0 cambios de código HTTP (C, PG caído)': mismosCodigos(C),
  'E1-LAT-01 0 errores nuevos (B)': nuevos('B').length === 0, 'E1-LAT-01 0 errores nuevos (C)': nuevos('C').length === 0,
  'E1-LAT-01 ≥ 500 webhooks por corrida': [A, B, C].every((x) => x.n >= 500),
  'E1-PGDOWN-01 hubo pérdidas contadas fuera de PostgreSQL': perdidas.n > 0,
  'E1-PGDOWN-01 todas las pérdidas importadas al volver': perdidas.n > 0 && perdidas.importadas === perdidas.n,
  'E1-PGDOWN-01 un evento de auditoría por pérdida': Number(audit) === perdidas.n,
};
const ok = Object.values(checks).every(Boolean);
const evidencia = { ts, ok, resumen: { A, B, C }, deltas: lat, errores_nuevos: { B: nuevos('B'), C: nuevos('C') }, perdidas, auditoria_importaciones: Number(audit), senales_totales: Number(senales), estados_C: estadosC, checks,
  no_cubierto: 'E1-PGDOWN-01 también pide que los barridos reparen el 100 % de lo enumerable y que los envíos converjan: eso lo cubre el ensayo E1_TRAMO=2 (barridos contra simulador), no esta corrida.' };
fs.writeFileSync(path.join(work, 'evidencia.json'), JSON.stringify(evidencia, null, 2));
const md = [`# E1-LAT-01 / E1-PGDOWN-01 — corrida ${ts}`, '', `Resultado: **${ok ? 'verde' : 'ROJO'}**`, '',
  '| Corrida | n | p50 ms | p95 ms | p99 ms | códigos |', '|---|---|---|---|---|---|',
  ...[['A copia apagada', A], ['B copia encendida', B], ['C encendida + PG detenido', C]].map(([k, x]) => `| ${k} | ${x.n} | ${x.p50.toFixed(1)} | ${x.p95.toFixed(1)} | ${x.p99.toFixed(1)} | ${Object.entries(x.codigos).map(([c, n]) => `${c}×${n}`).join(' ')} |`),
  '', `Pérdidas en C: ${perdidas.n}, importadas ${perdidas.importadas}, eventos de auditoría ${audit}.`, '',
  ...Object.entries(checks).map(([k, v]) => `- ${v ? 'ok' : 'FALLA'} — ${k}`), '', `> ${evidencia.no_cubierto}`].join('\n');
fs.writeFileSync(path.join(work, 'evidencia.md'), md + '\n');
console.log(md);
process.exit(ok ? 0 : 1);
JS
if [ "${C9_EVIDENCIA_REPO:-0}" = 1 ]; then
  cp "$WORK/evidencia.md" "$RAIZ/docs/superpowers/evidence/e1/$(date -u +%Y-%m-%d)-E1-LAT-PGDOWN-$TS.md"
fi
exit $RESULTADO
