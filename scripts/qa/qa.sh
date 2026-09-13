#!/bin/bash
# Entorno QA bajo demanda (plan docs/superpowers/plans/2026-09-13-qa-bajo-demanda.md, paso 5).
#
#   scripts/qa/qa.sh up [rama]   snapshot anonimizado + build de la rama + levantar + /healthz
#   scripts/qa/qa.sh down        bajar y borrar snapshot, certificados, secretos y código
#   scripts/qa/qa.sh status      estado de los contenedores y tiempo encendido
#
# QA sólo escucha en 127.0.0.1:3101. Túnel para mirarlo: ssh -L 3101:127.0.0.1:3101 root@VPS
# Ambos procesos corren con `timeout 8h`: se apagan solos aunque nadie ejecute `down`.
set -euo pipefail

REPO="/opt/fusionbikes/herramientas"
QA_DIR="${QA_DIR:-/opt/fusionbikes/qa}"
QA_BUILD_DIR="$QA_DIR/build"
PROD_DB="$REPO/data/fusion.sqlite"
PROD_ENV="$REPO/.env"
CLAVE_QA="/root/.config/fusion-qa/clave"
COMPOSE=(docker compose -f "$REPO/deploy/qa/docker-compose.yml" -p fusion-qa)
export QA_DIR QA_BUILD_DIR

log() { echo "[qa $(date -u '+%H:%M:%S')] $*"; }

limpiar_archivos() {
  rm -rf "$QA_BUILD_DIR" "$QA_DIR/data" "$QA_DIR/certs" "$QA_DIR/uploads" "$QA_DIR/qa.env"
}

generar_certificados() {
  local d="$QA_DIR/certs"
  mkdir -p "$d"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=fusion-qa-ca" \
    -keyout "$d/ca-key.pem" -out "$d/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=qa-simulador" \
    -keyout "$d/simulador-key.pem" -out "$d/simulador.csr" 2>/dev/null
  printf 'subjectAltName=DNS:qa-simulador\n' > "$d/ext.cnf"
  openssl x509 -req -in "$d/simulador.csr" -CA "$d/ca.pem" -CAkey "$d/ca-key.pem" -CAcreateserial \
    -days 2 -extfile "$d/ext.cnf" -out "$d/simulador.pem" 2>/dev/null
  rm -f "$d/ca-key.pem" "$d/simulador.csr" "$d/ext.cnf" "$d/ca.srl"
  # El contenedor corre como usuario node: necesita leer la clave del simulador.
  chmod 644 "$d"/*.pem
}

generar_env() {
  local f="$QA_DIR/qa.env"
  local umask_anterior; umask_anterior=$(umask)
  umask 077
  {
    echo "# Generado por scripts/qa/qa.sh up — secretos aleatorios de un solo uso, nunca de producción."
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "MOBILE_JWT_SECRET=$(openssl rand -hex 32)"
    echo "ML_CLIENT_ID=qa-client"
    echo "ML_CLIENT_SECRET=$(openssl rand -hex 16)"
    echo "ML_USER_ID=$(grep -m1 '^ML_USER_ID=' "$PROD_ENV" | cut -d= -f2- || echo 1)"
    echo "WOO_CK=ck_qa_$(openssl rand -hex 12)"
    echo "WOO_CS=cs_qa_$(openssl rand -hex 12)"
    echo "APP_URL=http://127.0.0.1:3101"
  } > "$f"
  chmod 600 "$f"   # lo lee docker compose como root; nunca entra al contexto de build
  umask "$umask_anterior"
}

# Ninguna variable de QA puede tener el mismo valor que una de producción, salvo las que no son
# secretas por definición. Compara sin imprimir valores.
verificar_sin_credenciales_reales() {
  node - "$QA_DIR/qa.env" "$PROD_ENV" <<'EOF'
const fs = require('fs');
const leer = f => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n')
  .filter(l => /^[A-Z_][A-Z0-9_]*=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const [qa, prod] = process.argv.slice(2).map(leer);
const noSecretas = new Set(['ML_USER_ID', 'PORT', 'NODE_ENV', 'APP_URL']);
const valoresProd = new Map();
for (const [k, v] of Object.entries(prod)) if (v.length >= 6 && !noSecretas.has(k)) valoresProd.set(v, k);
const choques = Object.entries(qa).filter(([k, v]) => !noSecretas.has(k) && valoresProd.has(v)).map(([k]) => k);
if (choques.length) { console.error(`ERROR: variables de QA con valores de producción: ${choques.join(', ')}`); process.exit(1); }
console.log(`sin credenciales de producción en QA (${Object.keys(qa).length} variables revisadas)`);
EOF
}

esperar_healthz() {
  for _ in $(seq 1 60); do
    if curl -fsS -m 3 -o /dev/null http://127.0.0.1:3101/healthz; then return 0; fi
    if [ "$("${COMPOSE[@]}" ps -q qa-app | xargs -r docker inspect -f '{{.State.Running}}' 2>/dev/null)" = "false" ]; then
      "${COMPOSE[@]}" logs --tail 30 qa-app >&2; return 1
    fi
    sleep 3
  done
  return 1
}

cmd_up() {
  local rama="${1:-$(git -C "$REPO" rev-parse --abbrev-ref HEAD)}"
  if [ -n "$("${COMPOSE[@]}" ps -q 2>/dev/null)" ]; then
    log "QA ya está encendido; bajalo primero con: scripts/qa/qa.sh down"; exit 1
  fi
  [ -s "$CLAVE_QA" ] || { log "falta la clave de QA en $CLAVE_QA"; exit 1; }
  local T0; T0=$(date +%s)

  limpiar_archivos
  mkdir -p "$QA_BUILD_DIR" "$QA_DIR/data" "$QA_DIR/uploads"
  log "código: rama $rama ($(git -C "$REPO" rev-parse --short "$rama"))"
  git -C "$REPO" archive "$rama" | tar -x -C "$QA_BUILD_DIR"

  log "snapshot anonimizado (~80 s)"
  QA_CLAVE="$(cat "$CLAVE_QA")" nice -n 10 node "$REPO/scripts/qa/snapshot-anonimizado.mjs" "$PROD_DB" "$QA_DIR/data/fusion.sqlite"

  # El snapshot deja ml_oauth_token vacío (el token real nunca sale de producción). Sin fila, la
  # app no llega a llamar a ML y los flujos de ML no se pueden probar: se siembra un token falso
  # que sólo acepta el simulador.
  node -e "
    const D = require('$REPO/node_modules/better-sqlite3');
    const db = new D('$QA_DIR/data/fusion.sqlite');
    const vence = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    db.prepare('INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en) VALUES (1, ?, ?, ?, ?)')
      .run('APP_USR-QA', 'TG-QA', vence, new Date().toISOString());
    db.close();
  "

  generar_certificados
  generar_env
  verificar_sin_credenciales_reales
  # Usuario node (uid 1000) del contenedor escribe base, sesiones y uploads.
  chown -R 1000:1000 "$QA_DIR/data" "$QA_DIR/uploads"

  log "build y arranque"
  "${COMPOSE[@]}" up -d --build 2>&1 | tail -3
  if ! esperar_healthz; then log "QA no respondió /healthz; se baja"; cmd_down; exit 1; fi

  local ip; ip=$(curl -s -4 -m 5 ifconfig.me || true)
  if [ -n "$ip" ] && curl -s -m 5 -o /dev/null "http://$ip:3101/healthz"; then
    log "ERROR: el puerto 3101 responde desde la IP pública; se baja"; cmd_down; exit 1
  fi
  log "QA listo en http://127.0.0.1:3101 en $(( $(date +%s) - T0 )) s (usuarios: los de producción, clave en $CLAVE_QA). Se apaga solo en 8 h."
}

cmd_down() {
  "${COMPOSE[@]}" down --remove-orphans 2>&1 | tail -2 || true
  limpiar_archivos
  docker image rm fusion-qa-app:local >/dev/null 2>&1 || true
  # No se hace `docker builder prune`: la caché de build es compartida con otros proyectos del VPS
  # (chatbot, fusion-vision) y no se puede filtrar sólo la de QA. La de QA es chica y acelera el próximo up.
  log "QA apagado; snapshot, certificados, secretos y código borrados"
}

cmd_status() {
  local ids; ids=$("${COMPOSE[@]}" ps -q 2>/dev/null || true)
  if [ -z "$ids" ]; then log "QA apagado"; return 0; fi
  docker inspect -f '{{.Name}} {{.State.Status}} desde {{.State.StartedAt}} {{if .State.Health}}salud={{.State.Health.Status}}{{end}}' $ids
  docker stats --no-stream --format '{{.Name}} cpu {{.CPUPerc}} ram {{.MemUsage}}' $ids
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "Uso: $0 up [rama] | down | status"; exit 2 ;;
esac
