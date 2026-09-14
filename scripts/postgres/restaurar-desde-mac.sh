#!/bin/bash
# Aceptación del nivel 2 de DR (PM-167): restaura la copia que SUBIÓ la Mac y demuestra que sirve.
#
# La Mac sube su copia con una clave aparte (usuario fusion-restore, rrsync -wo) a
# /opt/fusionbikes/qa/restore-mac/entrada. Este script NUNCA usa el repositorio de producción:
#   1. verifica los hashes de la copia contra el manifiesto que viajó con ella;
#   2. copia la entrada a un directorio de trabajo (la entrada queda intacta como evidencia);
#   3. `pgbackrest verify` sobre la copia;
#   4. restaura en un contenedor SIN RED con la imagen de producción y arranca sin archivado;
#   5. comprueba la marca que se insertó en producción antes del pull (marca-esperada) y que la base
#      salió de recuperación; mide el RTO;
#   6. escribe un registro JSON firmado (Ed25519) y borra el contenedor y los datos restaurados.
#
# Uso (root en el VPS): bash scripts/postgres/restaurar-desde-mac.sh
set -euo pipefail

RAIZ=/opt/fusionbikes/qa/restore-mac
ENTRADA="$RAIZ/entrada"
TRABAJO="$RAIZ/trabajo"
REGISTROS=/opt/fusionbikes/backups/pg-registros
IMAGEN=fusion-pg:local
CONTENEDOR=fusion-pg-restore-mac
CLAVE_REPO=/root/.config/fusion-pg/cipher-pass
DIR_SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
MARCA_ESPERADA="$(tr -d '\n' < "$RAIZ/marca-esperada")"
INICIO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# E0_ENSAYO=1: la entrada se armó en el VPS para probar este script; el registro no cuenta como aceptación.
if [ "${E0_ENSAYO:-0}" = "1" ]; then
  PRUEBA="ENSAYO del script con una copia armada en el VPS (no es la copia de la Mac)"
else
  PRUEBA="E0-OFF-01 restauracion desde la copia de la Mac"
fi

log() { echo "[$(date -u '+%H:%M:%S')] $*"; }
limpiar() {
  docker rm -f "$CONTENEDOR" >/dev/null 2>&1 || true
  [ "${E0_KEEP:-0}" = "1" ] || rm -rf "$TRABAJO"
}
trap limpiar EXIT

RESULTADO=falla; DETALLE=""; RTO=null; ARCHIVOS=0; MANIFIESTO_SHA=""; MARCA_ENCONTRADA=""
terminar() {
  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$REGISTROS"
  local reg="$REGISTROS/restore-mac-$ts.json"
  cat > "$reg" <<JSON
{"prueba":"$PRUEBA","inicio":"$INICIO","fin":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","resultado":"$RESULTADO","detalle":"$DETALLE","archivos_verificados":$ARCHIVOS,"manifiesto_sha256":"$MANIFIESTO_SHA","marca_esperada":"$MARCA_ESPERADA","marca_restaurada":"$MARCA_ENCONTRADA","rto_s":$RTO}
JSON
  bash "$DIR_SCRIPTS/firmar-registro.sh" firmar "$reg" >/dev/null
  bash "$DIR_SCRIPTS/firmar-registro.sh" verificar "$reg" >/dev/null && log "registro firmado: $reg"
  cat "$reg"; echo
  [ "$RESULTADO" = "ok" ]
}

[ -s "$ENTRADA/MANIFEST-fusion.sha256" ] || { DETALLE="la entrada no tiene manifiesto: la Mac no subió la copia"; terminar; exit 1; }

log "1/5 hashes de la copia subida contra su manifiesto"
if ! (cd "$ENTRADA" && sha256sum -c --quiet MANIFEST-fusion.sha256 >/dev/null 2>&1); then
  DETALLE="hashes distintos al manifiesto en la copia subida"; terminar; exit 1
fi
ARCHIVOS="$(wc -l < "$ENTRADA/MANIFEST-fusion.sha256" | tr -d ' ')"
MANIFIESTO_SHA="$(sha256sum "$ENTRADA/MANIFEST-fusion.sha256" | cut -d' ' -f1)"

log "2/5 copia de trabajo (la entrada queda intacta)"
rm -rf "$TRABAJO"
mkdir -p "$TRABAJO"/{repo,data,spool,log}
cp -a "$ENTRADA/." "$TRABAJO/repo/"
chown -R 999:999 "$TRABAJO"/{repo,data,spool,log}
chmod 700 "$TRABAJO/data"

docker rm -f "$CONTENEDOR" >/dev/null 2>&1 || true
docker run -d --name "$CONTENEDOR" --network none --init --memory 512m --cpus 0.5 \
  --security-opt no-new-privileges:true \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v "$TRABAJO/data:/var/lib/postgresql/data" \
  -v "$TRABAJO/repo:/var/lib/pgbackrest:ro" \
  -v "$TRABAJO/spool:/var/spool/pgbackrest" \
  -v "$TRABAJO/log:/var/log/pgbackrest" \
  -v "$CLAVE_REPO:/run/fusion-pg/cipher-pass:ro" \
  --entrypoint sleep "$IMAGEN" infinity >/dev/null

log "3/5 pgbackrest verify sobre la copia"
if ! docker exec "$CONTENEDOR" pgbr verify >/dev/null 2>&1; then
  DETALLE="pgbackrest verify falló sobre la copia de la Mac"; terminar; exit 1
fi

log "4/5 restauración (último punto disponible en la copia) y arranque sin archivado"
T0="$(date +%s)"
# Sin --type: pgBackRest recupera hasta el último WAL de la copia y promueve solo. `--target-action`
# no es válido sin un --type de objetivo (error 031, encontrado en el ensayo del 2026-09-14).
if ! SALIDA="$(docker exec "$CONTENEDOR" pgbr --pg1-path=/var/lib/postgresql/data/pgdata restore 2>&1)"; then
  DETALLE="pgbackrest restore falló: $(printf '%s' "$SALIDA" | grep -m1 'ERROR' | tr -d '"\\' | cut -c1-200)"; terminar; exit 1
fi
# postgres necesita la clave del repositorio para su restore_command (archive-get). El archivo es de
# root: se lee como root y se baja a postgres con gosu, igual que el entrypoint de producción.
docker exec -d "$CONTENEDOR" sh -c 'PGBACKREST_REPO1_CIPHER_PASS="$(tr -d "\n" < /run/fusion-pg/cipher-pass)"; export PGBACKREST_REPO1_CIPHER_PASS; exec gosu postgres postgres -D /var/lib/postgresql/data/pgdata -c archive_mode=off -c listen_addresses= >/var/log/pgbackrest/postgres-arranque.log 2>&1' >/dev/null
LISTA=0
for _ in $(seq 180); do
  if docker exec -u postgres "$CONTENEDOR" pg_isready -q >/dev/null 2>&1 && \
     [ "$(docker exec -u postgres "$CONTENEDOR" psql -Atqc 'select pg_is_in_recovery()' 2>/dev/null)" = "f" ]; then
    LISTA=1; break
  fi
  sleep 1
done
RTO=$(( $(date +%s) - T0 ))
[ "$LISTA" = "1" ] || { DETALLE="la base restaurada no salió de recuperación en 180 s"; terminar; exit 1; }

log "5/5 marca de verificación"
MARCA_ENCONTRADA="$(docker exec -u postgres "$CONTENEDOR" psql -Atqc "select marca from e0_verificacion where marca='$MARCA_ESPERADA'" 2>/dev/null || true)"
if [ "$MARCA_ENCONTRADA" != "$MARCA_ESPERADA" ]; then
  DETALLE="la marca $MARCA_ESPERADA no está en la base restaurada (¿la copia es anterior a la marca?)"; terminar; exit 1
fi

RESULTADO=ok
DETALLE="copia de la Mac verificada, restaurada y con la marca de producción; RTO ${RTO} s"
terminar
