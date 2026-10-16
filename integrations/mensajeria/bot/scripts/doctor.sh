#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

bind_port="$(sed -n 's/^CHATBOT_BIND_PORT=//p' .env | tail -n 1)"
bind_port="${bind_port:-8091}"

echo "== Contenedores =="
docker compose ps

echo
echo "== Salud local =="
curl --fail --silent --show-error "http://127.0.0.1:${bind_port}/health"
echo

echo
echo "== Últimos eventos del worker =="
docker compose logs --tail=40 worker
