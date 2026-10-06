#!/bin/sh
set -eu
# Los secretos quedan 0600 root en el host. Sólo este proceso inicial los lee; luego baja a node.
if [ -n "${PG_PASSWORD_FILE:-}" ] && [ -r "$PG_PASSWORD_FILE" ]; then
  PG_PASSWORD="$(tr -d '\r\n' < "$PG_PASSWORD_FILE")"
  export PG_PASSWORD
  unset PG_PASSWORD_FILE
fi
[ -n "${PG_PASSWORD:-}" ] || { echo 'falta PG_PASSWORD_FILE o PG_PASSWORD' >&2; exit 1; }
exec gosu node "$@"
