#!/usr/bin/env bash
# Corrida diaria del control de deriva (cron: deploy/servidor/cron.d/fusion-drift).
# Corre drift-vps.sh contra origin/master del checkout de prod y deja un resumen en
# /opt/fusionbikes/backups/estado-drift.json que lee lib/vigiaDrift.js. SOLO LECTURA sobre el código:
# lo único que escribe son el estado, el log y el `git fetch` (que toca solo .git).
# El estado no lleva secretos: solo rutas de archivos, conteos y SHAs.
#
# Variables (todas opcionales, para pruebas): REPO, REF, ESTADO, LOG_DIR, DRIFT_SCRIPT.
set -u
REPO="${REPO:-/opt/fusionbikes/herramientas}"
REF="${REF:-origin/master}"
ESTADO="${ESTADO:-/opt/fusionbikes/backups/estado-drift.json}"
LOG_DIR="${LOG_DIR:-/var/log/fusion}"
DRIFT_SCRIPT="${DRIFT_SCRIPT:-$REPO/scripts/ops/drift-vps.sh}"
LOG="$LOG_DIR/drift-vps.log"

mkdir -p "$LOG_DIR" "$(dirname "$ESTADO")"
# Rotación: la corrida anterior se archiva con su fecha y se borran las de más de 7 días.
if [ -s "$LOG" ]; then mv "$LOG" "$LOG.$(date -r "$LOG" +%F-%H%M%S)"; fi
find "$LOG_DIR" -maxdepth 1 -name 'drift-vps.log.*' -mtime +7 -delete 2>/dev/null

{
  echo "== $(date -u +%FT%TZ) drift-vps-cron REPO=$REPO REF=$REF"
  # Si el fetch falla (red, GitHub) se sigue con el último origin/master que haya y queda registrado.
  if ! git -C "$REPO" fetch origin master 2>&1; then echo "AVISO: git fetch falló; el resultado no es confiable (rc=2 fetch_fallido)"; touch "$LOG.fetch_fallido"; fi
} >"$LOG" 2>&1
FETCH_FALLO=0
if [ -e "$LOG.fetch_fallido" ]; then FETCH_FALLO=1; rm -f "$LOG.fetch_fallido"; fi

REPO="$REPO" REF="$REF" "$DRIFT_SCRIPT" >"$LOG.salida" 2>&1
RC=$?
cat "$LOG.salida" >>"$LOG"; rm -f "$LOG.salida"
echo "== rc=$RC" >>"$LOG"

REF_SHA="$(git -C "$REPO" rev-parse --short "$REF" 2>/dev/null || true)"
export RC REF_SHA LOG ESTADO FETCH_FALLO
python3 -I - <<'PY'
import json, os, re, datetime

rc = int(os.environ['RC'])
motivo = None
# Un fetch fallido deja origin/master desactualizado: un rc=0 no prueba nada, así que se informa como no medido.
if os.environ.get('FETCH_FALLO') == '1':
    rc, motivo = 2, 'fetch_fallido'
SECRETO = re.compile(r'\.env|secret|token|key|\.pem|credential', re.I)
lineas = open(os.environ['LOG'], encoding='utf-8', errors='replace').read().splitlines()
por_bloque, archivos, imagenes = {}, [], 0
for l in lineas:
    m = re.match(r'\s+\[([\w-]+)\]\s+([A-Z_]+)\s+(.*)$', l)
    if not m:
        continue
    bloque, tipo, ruta = m.groups()
    archivos.append(f'[{bloque}] {tipo} {"[ruta omitida]" if SECRETO.search(ruta) else ruta}')
    if bloque == 'imagenes':
        imagenes += 1
        continue
    b = por_bloque.setdefault(bloque, {'modificados': 0, 'solo_vps': 0, 'solo_repo': 0, 'otros': 0})
    clave = {'MODIFICADO': 'modificados', 'SOLO_EN_VPS': 'solo_vps', 'SOLO_EN_REPO': 'solo_repo'}.get(tipo, 'otros')
    b[clave] += 1

estado = {
    'ultimo_corrida': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'rc': rc,
    'motivo': motivo,
    'total': len(archivos),
    'por_bloque': por_bloque,
    'imagenes_distintas': imagenes,
    'muestra': archivos[:30],
    'ref_sha': os.environ.get('REF_SHA') or None,
}
destino = os.environ['ESTADO']
tmp = destino + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(estado, f, ensure_ascii=False, indent=2)
os.replace(tmp, destino)
PY
exit 0
