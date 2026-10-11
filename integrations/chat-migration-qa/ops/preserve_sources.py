"""Preserve only this task's source and durable operational notes, without touching app runtime."""
import hashlib
import json
from pathlib import Path
import os

source = Path('/opt/fusion-chat-migration-qa')
repo = Path('/opt/fusionbikes/herramientas')
target = repo/'integrations/chat-migration-qa'
files = [source/'PLAN.md',source/'README.md',source/'original-source-manifest.json']
files += list((source/'app').glob('native_*.py'))
files += [p for p in (source/'app/native_preview').iterdir() if p.is_file()]
files += [source/'tests/test_native_chat.py']
files += list((source/'ops').glob('*.py'))
records=[]
for file in files:
    relative = file.relative_to(source)
    destination = target/relative
    data = file.read_bytes()
    if destination.exists() and destination.read_bytes() != data:
        raise RuntimeError('Existing source differs; inspect before replacing: '+str(relative))
    destination.parent.mkdir(parents=True,exist_ok=True)
    if not destination.exists():
        with destination.open('xb') as stream:stream.write(data)
    records.append({'path':str(relative),'sha256':hashlib.sha256(data).hexdigest()})
plan = repo/'docs/superpowers/plans/2026-10-04-chat-migracion-qa.md'
if plan.exists() and plan.read_bytes() != (source/'PLAN.md').read_bytes():
    raise RuntimeError('Plan differs; preserve concurrent work')
if not plan.exists():plan.write_bytes((source/'PLAN.md').read_bytes())

def append(relative, marker, note):
    path=repo/relative
    before=path.read_bytes()
    if marker.encode() in before:return
    temporary=path.with_name(path.name+'.chat-migration-qa.tmp')
    with temporary.open('xb') as stream:stream.write(before+b'\n'+note.encode('utf-8')+b'\n')
    if path.read_bytes()!=before:
        temporary.unlink()
        raise RuntimeError('Concurrent documentation change: '+relative)
    os.replace(temporary,path)

append('docs/memory/modules/operations-vps.md','## Chat nativo: ensayo aislado del 2026-10-04',
'''## Chat nativo: ensayo aislado del 2026-10-04

- Proyecto independiente `/opt/fusion-chat-migration-qa`, Compose `fusion-chat-migration-qa`: API/worker con bot simulado, PostgreSQL y Redis propios. Sólo datos ficticios; no es producción ni una migración terminada.
- Red Docker interna sin puertos publicados ni salida a Internet; vista `/qa/` por túnel SSH ligado a loopback local. `qa.env` privado, nunca copiarlo al repositorio. Límites de memoria/CPU definidos por servicio.
- Fuente mantenida en `integrations/chat-migration-qa/`; allí están contratos, límites, reproducción de pruebas y comandos de inicio/parada. Plan: `docs/superpowers/plans/2026-10-04-chat-migracion-qa.md`.
- Respaldo previo del bot (código/configuración y dump PostgreSQL): `/opt/fusionbikes/backups/chat-migration/20261004T220310Z`; archivo e índice verificados, restauración completa pendiente.
- Los procesos, código y tráfico del bot original/Herramientas no se trasladaron. Master Control, checkout y plugins originales permanecen en su ubicación. No atribuir ahorro de carga de WordPress a este ensayo.
- Pendiente antes del corte: integración con sesión/permisos Herramientas, widget completo, datos/historial, leads y carrito abandonado, configuración/aprendizaje, WhatsApp/IA reales, notificaciones/retención y reversión. Diferencia previa entre test y lógica de derivación a Taller documentada en el README; no habilitar tráfico real asumiendo suite original verde.
''')
append('docs/superpowers/INDEX.md','### Chat nativo: ensayo QA de migración (2026-10-04)',
'''### Chat nativo: ensayo QA de migración (2026-10-04)

- `plans/2026-10-04-chat-migracion-qa.md`: vigente para el ensayo privado del chat; integración productiva pendiente. No modifica el estado de aceptación E0–E26.
- Fuente y límites: `integrations/chat-migration-qa/README.md`; operación en `docs/memory/modules/operations-vps.md`.
''')
print(json.dumps({'preserved_directory':str(target),'files':len(records),'runtime_restarted':False,'memory_updated':True}))
