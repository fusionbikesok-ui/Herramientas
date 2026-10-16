#!/usr/bin/env bash
# Deriva entre lo que corre en el VPS y lo versionado en master. SOLO LECTURA.
#
#   scripts/ops/drift-vps.sh            # compara contra origin/master
#   REF=origin/master scripts/ops/drift-vps.sh
#   REPO=/ruta/al/checkout scripts/ops/drift-vps.sh
#   SOLO=management scripts/ops/drift-vps.sh   # un solo bloque (herramientas, management, chatbot, chat-qa, pos-test, archivos)
#
# Compara cada directorio en ejecución contra su carpeta del repo en $REF (ignorando CRLF y lo que cubra un
# .gitignore del repo) y los IDs de imagen de los contenedores contra deploy/INVENTARIO.md.
# Sale con 0 si no hay deriva, 1 si la hay (y lista los archivos), 2 si no pudo comparar.
# Ejecutar desde un checkout cuyos .gitignore sean los de $REF (normalmente master).
# Bloque herramientas: el «solo en repo» de integrations/*, deploy/* y scripts/ops desaparece cuando el checkout de prod
# se actualiza a un master que ya los incluye. Los «solo en VPS» que queden son trabajo sin versionar (ver INVENTARIO.md).
set -u
REPO="${REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"
REF="${REF:-origin/master}"
[ -n "$REPO" ] && git -C "$REPO" rev-parse --verify -q "$REF^{commit}" >/dev/null || { echo "No encuentro $REF en ${REPO:-?}" >&2; exit 2; }
export REPO REF SOLO="${SOLO:-}"
exec python3 - <<'PY'
import os, re, subprocess, sys

REPO, REF, SOLO = os.environ['REPO'], os.environ['REF'], os.environ.get('SOLO', '')

def git(*a, inp=None):
    return subprocess.run(['git', '-C', REPO, *a], input=inp, capture_output=True)

# (nombre del bloque, directorio en el VPS, carpeta del repo)
DIRS = [
    ('herramientas', '/opt/fusionbikes/herramientas', ''),
    ('management', '/opt/fusion-management-migration', 'integrations/management-migration'),
    ('chatbot', '/opt/fusion-chatbot', 'integrations/mensajeria/bot'),
    ('chat-qa', '/opt/fusion-chat-migration-qa', 'integrations/chat-migration-qa'),
    ('pos-test', '/opt/fusionbikes-pos-test/wp-content/plugins/fusion-bikes-pos',
     'integrations/pos-test/wp-content/plugins/fusion-bikes-pos'),
]
# Directorios que nunca son código (datos, dependencias, estado): se saltan al recorrer.
SALTAR = {'.git', 'node_modules', '__pycache__', '.pytest_cache'}

# (ruta en el VPS, ruta en el repo). Los symlinks de nginx se resuelven.
ARCHIVOS = [
    ('/etc/cron.d/fusion-backup', 'deploy/servidor/cron.d/fusion-backup'),
    ('/etc/cron.d/fusion-drift', 'deploy/servidor/cron.d/fusion-drift'),
    ('/opt/fusionbikes/backups/backup.sh', 'deploy/servidor/backups/backup.sh'),
    ('/opt/fusionbikes/backups/backup-db.mjs', 'deploy/servidor/backups/backup-db.mjs'),
    ('/opt/fusionbikes/backups/RESTAURAR.md', 'deploy/servidor/backups/RESTAURAR.md'),
    ('/etc/systemd/system/pm2-root.service', 'deploy/servidor/systemd/pm2-root.service'),
    ('/etc/systemd/system/fusion-firewall-3001.service', 'deploy/servidor/systemd/fusion-firewall-3001.service'),
    ('/usr/local/sbin/fusion-firewall-3001.sh', 'deploy/servidor/sbin/fusion-firewall-3001.sh'),
    ('/etc/systemd/system/fusion-estado-pg-copia.service', 'deploy/servidor/systemd/fusion-estado-pg-copia.service'),
    ('/etc/systemd/system/fusion-estado-pg-copia.timer', 'deploy/servidor/systemd/fusion-estado-pg-copia.timer'),
    ('/opt/fusionbikes/plataforma-prod/sombra-worker.override.yml', 'deploy/servidor/plataforma-prod/sombra-worker.override.yml'),
    ('/opt/fusionbikes-pos-test/docker-compose.yml', 'integrations/pos-test/docker-compose.yml'),
]
for n in ('fusion-chatbot', 'fusion-vision', 'fusionbikes', 'herramientas'):
    ARCHIVOS.append(('/etc/nginx/sites-enabled/' + n, 'deploy/servidor/nginx/sites-available/' + n))
SYSTEMD = ['fusion-management-validation.service', 'fusion-management-directory-sync.service',
           'fusion-management-directory-sync.timer', 'fusion-management-metrics-sync.service',
           'fusion-management-metrics-sync.timer', 'fusion-arca-backup.service', 'fusion-arca-backup.timer',
           'fusion-arca-egress.service', 'fusion-arca-outbox.service', 'fusion-arca-outbox.timer',
           'fusion-arca-source.service', 'fusion-stock-whatsapp.service', 'fusion-stock-whatsapp.timer']
for u in SYSTEMD:
    ARCHIVOS.append(('/etc/systemd/system/' + u, 'deploy/systemd/' + u))
d = '/etc/systemd/system/fusion-management-validation.service.d'
if os.path.isdir(d):
    for f in sorted(os.listdir(d)):
        ARCHIVOS.append((os.path.join(d, f), 'deploy/systemd/fusion-management-validation.service.d/' + f))

def norm(b):
    return b.replace(b'\r\n', b'\n')

def blob(path):
    r = git('show', f'{REF}:{path}')
    return norm(r.stdout) if r.returncode == 0 else None

def leer(p):
    try:
        with open(p, 'rb') as f:
            return norm(f.read())
    except OSError:
        return None

def ignorados(rutas):
    """Rutas (del repo) que cubre un .gitignore. check-ignore --no-index usa los .gitignore del checkout."""
    if not rutas:
        return set()
    r = git('check-ignore', '--no-index', '--stdin', '-z', inp='\0'.join(rutas).encode() + b'\0')
    return {x.decode() for x in r.stdout.split(b'\0') if x}

deriva = []   # (bloque, tipo, ruta)
resumen = []

def bloque(nombre, vps, repo):
    prefijo = repo + '/' if repo else ''
    ls = git('ls-tree', '-r', '--name-only', REF, '--', repo or '.')
    if ls.returncode != 0:
        print(f'[{nombre}] no puedo leer {repo or "/"} en {REF}', file=sys.stderr); sys.exit(2)
    versionados = {x[len(prefijo):] for x in ls.stdout.decode().splitlines() if x.startswith(prefijo)}
    if not os.path.isdir(vps):
        deriva.append((nombre, 'FALTA_EN_VPS', vps)); return
    en_vps = set()
    for raiz, dirs, archivos in os.walk(vps):
        dirs[:] = [x for x in dirs if x not in SALTAR]
        for a in archivos:
            p = os.path.join(raiz, a)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            en_vps.add(os.path.relpath(p, vps))
    solo_vps = sorted(en_vps - versionados)
    ign = ignorados([prefijo + r for r in solo_vps])
    n = {'mod': 0, 'solo_vps': 0, 'solo_repo': 0, 'ign': 0}
    for r in sorted(en_vps & versionados):
        a, b = leer(os.path.join(vps, r)), blob(prefijo + r)
        if a != b:
            deriva.append((nombre, 'MODIFICADO', prefijo + r)); n['mod'] += 1
    for r in solo_vps:
        if prefijo + r in ign:
            n['ign'] += 1
        else:
            deriva.append((nombre, 'SOLO_EN_VPS', prefijo + r)); n['solo_vps'] += 1
    for r in sorted(versionados - en_vps):
        deriva.append((nombre, 'SOLO_EN_REPO', prefijo + r)); n['solo_repo'] += 1
    resumen.append(f'{nombre}: {len(en_vps & versionados)} comparados, {n["mod"]} modificados, '
                   f'{n["solo_vps"]} solo en VPS, {n["solo_repo"]} solo en repo, {n["ign"]} ignorados')

for nombre, vps, repo in DIRS:
    if SOLO and SOLO != nombre:
        continue
    bloque(nombre, vps, repo)

if not SOLO or SOLO == 'archivos':
    ok = 0
    for vps, repo in ARCHIVOS:
        a, b = leer(vps), blob(repo)
        if a is None:
            deriva.append(('archivos', 'FALTA_EN_VPS', vps))
        elif b is None:
            deriva.append(('archivos', 'SIN_VERSIONAR', f'{vps} (esperado en {repo})'))
        elif a != b:
            deriva.append(('archivos', 'MODIFICADO', f'{vps} != {repo}'))
        else:
            ok += 1
    resumen.append(f'archivos: {ok}/{len(ARCHIVOS)} idénticos')

# ---- imágenes de contenedores contra deploy/INVENTARIO.md ----
if not SOLO or SOLO == 'imagenes':
    inv = blob('deploy/INVENTARIO.md')
    esperado = {}
    if inv is None:
        deriva.append(('imagenes', 'SIN_INVENTARIO', f'deploy/INVENTARIO.md no está en {REF}'))
    else:
        for l in inv.decode().splitlines():
            m = re.match(r'\|\s*([\w.-]+)\s*\|[^|]*\|\s*(sha256:[0-9a-f]{12,64})\s*\|', l)
            if m:
                esperado[m.group(1)] = m.group(2)
        r = subprocess.run(['docker', 'ps', '--format', '{{.Names}}'], capture_output=True, text=True)
        if r.returncode != 0:
            deriva.append(('imagenes', 'NO_PUDE_LEER_DOCKER', r.stderr.strip()))
        else:
            ok = 0
            for c in r.stdout.split():
                real = subprocess.run(['docker', 'inspect', '-f', '{{.Image}}', c], capture_output=True, text=True).stdout.strip()
                exp = esperado.get(c)
                if exp is None:
                    deriva.append(('imagenes', 'SIN_ANOTAR', f'{c} corre {real}'))
                elif not (real == exp or real.startswith(exp) or exp.startswith(real)):
                    deriva.append(('imagenes', 'IMAGEN_DISTINTA', f'{c}: corre {real}, inventario {exp}'))
                else:
                    ok += 1
            for c in sorted(set(esperado) - set(r.stdout.split())):
                deriva.append(('imagenes', 'NO_CORRE', f'{c} está en el inventario pero no corre'))
            resumen.append(f'imagenes: {ok} coinciden con el inventario')

print(f'drift-vps contra {REF} ({git("rev-parse", "--short", REF).stdout.decode().strip()})')
for l in resumen:
    print('  ' + l)
if deriva:
    print(f'\nDERIVA: {len(deriva)} diferencias')
    for b, t, p in deriva:
        print(f'  [{b}] {t:<16} {p}')
    sys.exit(1)
print('\nSin deriva.')
PY
