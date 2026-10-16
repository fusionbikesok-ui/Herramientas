#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "Falta Docker. Instalalo desde la documentación oficial y volvé a ejecutar este script."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Falta Docker Compose v2."
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Falta openssl para generar las claves privadas."
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  api_key="$(openssl rand -hex 32)"
  callback_secret="$(openssl rand -hex 32)"
  postgres_password="$(openssl rand -hex 24)"
  verify_token="$(openssl rand -hex 24)"

  sed -i "s|^FUSION_API_KEY=.*$|FUSION_API_KEY=$api_key|" .env
  sed -i "s|^FUSION_CALLBACK_SECRET=.*$|FUSION_CALLBACK_SECRET=$callback_secret|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*$|POSTGRES_PASSWORD=$postgres_password|" .env
  sed -i "s|^DATABASE_URL=.*$|DATABASE_URL=postgresql://fusion_chatbot:$postgres_password@postgres:5432/fusion_chatbot|" .env
  sed -i "s|^META_VERIFY_TOKEN=.*$|META_VERIFY_TOKEN=$verify_token|" .env
  chmod 600 .env
  echo "Se creó .env con claves aleatorias. Completá Meta, los Phone Number ID y AI_MODEL antes de activar WhatsApp."
fi

docker compose config >/dev/null
docker compose up -d --build
docker compose ps

bind_port="$(sed -n 's/^CHATBOT_BIND_PORT=//p' .env | tail -n 1)"
bind_port="${bind_port:-8091}"

echo
echo "Servicio iniciado en http://127.0.0.1:${bind_port}"
echo "Siguiente paso: configurar Nginx/SSL y probar https://bot.fusionbikes.com.ar/health"
