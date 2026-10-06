#!/bin/bash
# Entrypoint de PostgreSQL + pgBackRest (E0). Lee la clave de cifrado del repositorio desde un
# archivo montado (producción) y la exporta para postgres y su archive_command; en el ensayo llega
# ya como variable de entorno. Sin clave no arranca: un repositorio sin cifrar no es aceptable.
set -euo pipefail
if [ -z "${PGBACKREST_REPO1_CIPHER_PASS:-}" ] && [ -r /run/fusion-pg/cipher-pass ]; then
  PGBACKREST_REPO1_CIPHER_PASS="$(tr -d '\n' < /run/fusion-pg/cipher-pass)"
  export PGBACKREST_REPO1_CIPHER_PASS
fi
if [ -z "${PGBACKREST_REPO1_CIPHER_PASS:-}" ]; then
  echo "fusion-entrypoint: falta la clave de cifrado del repositorio (/run/fusion-pg/cipher-pass)" >&2
  exit 1
fi
exec docker-entrypoint.sh "$@"
