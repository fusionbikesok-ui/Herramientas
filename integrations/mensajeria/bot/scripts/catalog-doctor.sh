#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

echo "== Exportador seguro de catálogo =="
docker compose ps catalog-exporter

echo
echo "== Copia SQLite visible para Fabri IA =="
docker compose exec -T api python - <<'PY'
import json
from app.clients import local_catalog_status

status = local_catalog_status()
print(json.dumps(status, ensure_ascii=False, indent=2))
if not status.get("fresh"):
    raise SystemExit(1)
PY

echo
echo "== Prueba Venzo Atix desde SQLite =="
docker compose exec -T api python - <<'PY'
from app.catalog_sqlite import search_sqlite_catalog
from app.config import get_settings

settings = get_settings()
products = search_sqlite_catalog(
    settings.catalog_sqlite_path,
    settings.wordpress_base_url,
    "venzo atix talle m",
    3,
    settings.catalog_sqlite_max_age_seconds,
)
if not products:
    raise SystemExit("No se encontraron productos de prueba")
for product in products:
    print(product.get("name"), "stock=", product.get("stock_quantity"), "url=", product.get("url"))
PY

echo
echo "== Últimos eventos del exportador =="
docker compose logs --tail=20 catalog-exporter
