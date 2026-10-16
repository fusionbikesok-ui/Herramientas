
from app.storage import connection
from app.config import get_settings
from app.number_controls import configured_number
from app.inbox_media import CloudTransport, validate_media, TYPES
import os, json, uuid, zipfile, hashlib, sys
from datetime import datetime, timezone
from pathlib import Path
os.umask(0o077)
request=json.load(sys.stdin)
excluded={str(uuid.UUID(value)) for value in request.get('excluded_ids',[])}
settings=get_settings()
transport=CloudTransport(settings)
stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
target=Path('/tmp')/('fusion-media-backup-'+stamp+'.zip')
manifest={'format':2,'mode':'incremental','previous_archives':request.get('previous_archives',[]),'created_at':datetime.now(timezone.utc).isoformat(),'scope':'received_whatsapp_attachments','files':[],'unavailable':[]}
eligible="EXISTS(SELECT 1 FROM messages m WHERE m.media_id=a.id AND m.sender='customer' AND COALESCE(m.metadata->>'revoked','false')!='true')"
with connection() as c:
 c.execute('BEGIN READ ONLY')
 c.execute("SET LOCAL statement_timeout='5s'")
 rows=c.execute('SELECT a.id,a.number_id FROM inbox_media a WHERE '+eligible+' ORDER BY a.created_at,a.id').fetchall()
 c.execute('ROLLBACK')
summary={'registered':len(rows),'already_backed_up':sum(item['id'] in excluded for item in rows),'newly_downloaded':0,'cached_exported':0,'unavailable':0,'by_number':{}}
with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
 for item in rows:
  if item['id'] in excluded:continue
  with connection() as c:
   c.execute("SET statement_timeout='5s'")
   row=c.execute('SELECT a.* FROM inbox_media a WHERE a.id=%s AND '+eligible,(item['id'],)).fetchone()
  if not row: continue
  number=configured_number(str(row['number_id']),settings.whatsapp_numbers)
  if not number: raise RuntimeError('Unrecognized business number')
  suffix=number[-4:]
  counts=summary['by_number'].setdefault(suffix,{'saved':0,'unavailable':0})
  meta={k:row[k] for k in ['id','conversation_key','name','mime','kind','remote_id','number_id']}
  meta['created_at']=row['created_at'].isoformat()
  if row['content'] is None:
   try:
    content,mime=transport.download(row['remote_id'],row['number_id'])
    mime,name,kind=validate_media(content,mime,row['name'])
    with connection() as c:
     c.execute("SET statement_timeout='5s'")
     updated=c.execute('UPDATE inbox_media a SET content=%s,mime=%s,name=%s,kind=%s,size=%s WHERE a.id=%s AND a.content IS NULL AND '+eligible+' RETURNING a.id',(content,mime,name,kind,len(content),row['id'])).fetchone()
    if not updated:
     with connection() as c:
      refreshed=c.execute('SELECT a.content FROM inbox_media a WHERE a.id=%s AND '+eligible,(row['id'],)).fetchone()
     if not refreshed: continue
     if refreshed['content'] is not None:content=bytes(refreshed['content'])
    meta.update(mime=mime,name=name,kind=kind)
    summary['newly_downloaded']+=1
   except Exception as error:
    # Error text can contain provider URLs or IDs; keep only the class.
    meta['failure_type']=type(error).__name__
    manifest['unavailable'].append(meta)
    counts['unavailable']+=1
    summary['unavailable']+=1
    continue
  else:
   content=bytes(row['content'])
   summary['cached_exported']+=1
  media_id=str(uuid.UUID(row['id']))
  ext=TYPES[meta['mime']][1]
  relative=suffix+'/'+row['created_at'].strftime('%Y-%m')+'/'+media_id+ext
  meta.update(path=relative,bytes=len(content),sha256=hashlib.sha256(content).hexdigest(),business_number=number)
  archive.writestr(relative,content)
  manifest['files'].append(meta)
  counts['saved']+=1
 manifest['summary']=summary
 archive.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
 archive.writestr('LEEME.txt','Respaldo de adjuntos recibidos en Mensajería Fusion Bikes.\nCarpetas por número del negocio y mes; nombres únicos para evitar colisiones.\nEl manifiesto relaciona cada archivo con su conversación original, nombre y hash SHA-256.\nCopia incremental: contiene adjuntos nuevos. Conservar los ZIP anteriores para recuperar el historial de archivos. No contiene contraseñas ni un respaldo completo de la aplicación o del historial de texto.\nLos adjuntos no descargables figuran en unavailable; no están respaldados.\nContenido privado: conservar con acceso restringido.\n')
with zipfile.ZipFile(target) as check:
 if check.testzip() is not None:raise RuntimeError('ZIP verification failed')
 for entry in manifest['files']:
  if hashlib.sha256(check.read(entry['path'])).hexdigest()!=entry['sha256']:raise RuntimeError('Content verification failed')
summary.update(path=str(target),bytes=target.stat().st_size,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),verified=True)
summary['exported_ids']=[entry['id'] for entry in manifest['files']]
print(json.dumps(summary),flush=True)
