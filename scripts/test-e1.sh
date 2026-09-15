#!/bin/bash
# Ensayo contractual del tramo 1 de E1. Crea proyecto, Postgres y secretos efímeros; no toca E0.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PLATAFORMA="$RAIZ/plataforma"
TRABAJO="$(mktemp -d /tmp/fusion-e1.XXXXXX)"
export E1_PROJECT="fusion-e1-$$"
export SECRET_DIR="$TRABAJO/secretos"
export ESTADO_PG_DIR="$TRABAJO/estado-pg"
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
mkdir -p "$SECRET_DIR" "$ESTADO_PG_DIR"
printf 'migrador\n' > "$SECRET_DIR/migrador-pass"
printf 'app\n' > "$SECRET_DIR/app-pass"
chmod 600 "$SECRET_DIR"/*
printf '{"medido":"%s","ok":true,"mas_viejo_s":0}\n' "$(date -u +%FT%TZ)" > "$ESTADO_PG_DIR/estado-pg-archivo.json"

if [ "${E1_SKIP_UNIT:-0}" != 1 ]; then
  npm --prefix "$PLATAFORMA" run typecheck
  npm --prefix "$PLATAFORMA" test
fi
"${COMPOSE[@]}" up -d --build pg
for _ in $(seq 1 45); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q pg)" 2>/dev/null || true)" = healthy ] && break; sleep 1; done
"${COMPOSE[@]}" exec -T pg pg_isready -U postgres -q
"${COMPOSE[@]}" build migrate api worker scheduler
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d api worker scheduler
for _ in $(seq 1 45); do curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null
"${COMPOSE[@]}" stop worker >/dev/null
for _ in $(seq 1 45); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/api/v2/health")" = "503" ] && break; sleep 1; done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/api/v2/health")" = "503" ]
"${COMPOSE[@]}" start worker >/dev/null
for _ in $(seq 1 45); do curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:${API_PORT}/api/v2/health" >/dev/null
echo '{"tramo":"E1-1","resultado":"ok","escenarios":["SCH","AUD","Q","DUP","CAP","API","SVC"]}'
