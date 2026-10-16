"""Read existing ML sales from the operational cache; never touches orders, stock or OAuth.

The archive is append/update, not a mirror: removing an operational cache row cannot erase sales history.
This source alone NEVER certifies monthly coverage or API backfill to 2023.
"""
import argparse,datetime as dt,json,math,os,sqlite3,tempfile,importlib.util
from pathlib import Path
from zoneinfo import ZoneInfo

_spec=importlib.util.spec_from_file_location('ml_original_normalizer',Path(__file__).with_name('import-ml-json.py'))
_original=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_original)

def project(order,items):
 if order.get('datos_ml_json'):
  raw=json.loads(order['datos_ml_json']);seller=(raw.get('seller') or {}).get('id')
  if not seller or str(raw.get('id'))!=str(order['external_id']):raise ValueError('identidad_original_invalida')
  result=_original.normalize(raw,seller);result['source']='Mercado Libre · registro operativo'
  for item in result['items']:
   matches=[i for i in items if item.get('sku') and str(i.get('sku') or '').strip()==item['sku'].strip()]
   if len(result['items'])==len(items)==1:matches=items
   if len(matches)==1:
    item['product_id']=matches[0].get('producto_woo_id') or 0;item['sku']=item.get('sku') or matches[0].get('sku') or ''
  return result
 raw=order.get('creado_fuente_en')
 if not raw:raise ValueError('fecha_ausente')
 instant=dt.datetime.fromisoformat(raw.replace('Z','+00:00'))
 if instant.tzinfo is None:raise ValueError('fecha_sin_zona')
 date=instant.astimezone(ZoneInfo('America/Argentina/Buenos_Aires')).date().isoformat()
 ident=str(order['external_id'])
 if not ident.isdigit() or len(ident)>30:raise ValueError('identidad_invalida')
 status=order.get('estado_canal') or '';payment=order.get('pago_estado') or '';commercial=order.get('estado_comercial') or ''
 state='valid' if status=='paid' else 'pending'
 if status in ['cancelled','canceled'] or commercial in ['cancelado','fallido']:state='cancelled'
 if status=='refunded' or payment=='refunded' or commercial=='reembolsado':state='refunded'
 if status=='partially_refunded' or payment in ['partially_refunded','charged_back','in_mediation']:state='review'
 if not status:state='review'
 rows=[]
 for item in items:
  qty=float(item['cantidad']);price=item.get('precio_unitario_centavos')
  if not math.isfinite(qty) or qty<0:raise ValueError('cantidad_invalida')
  if price is not None and (not math.isfinite(float(price)*qty) or float(price)<0):raise ValueError('importe_invalido')
  # The source keeps paid item price. A partial refund cannot be spread by guessing.
  amount=round(float(price)*qty/100,8) if price is not None and state!='review' else None
  rows.append({'name':str(item.get('nombre') or 'Sin nombre')[:500],'sku':str(item.get('sku') or '')[:150],
   'product_id':item.get('producto_woo_id') or 0,'quantity':qty,'amount':amount})
 return {'id':ident,'date':date,'currency':order.get('moneda') or 'ARS','status':status,'saleState':state,'items':rows,
  'pack':str(order.get('numero_visible') or '') if str(order.get('numero_visible') or '')!=ident else '',
  'source':'Mercado Libre · registro operativo','updated_at':order.get('actualizado_en') or '',
  'refundsKnown':state not in ['review'],'country':'','state':'','city':''}

def sync(source,target):
 with sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True) as db:
  db.row_factory=sqlite3.Row;db.execute('BEGIN')
  names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  if not {'gestion_pedidos','gestion_pedido_items'}<=names:raise ValueError('cache_ml_no_disponible')
  columns={r[1] for r in db.execute('PRAGMA table_info(gestion_pedidos)')};metadata=',datos_ml_json' if 'datos_ml_json' in columns else ''
  orders=[dict(r) for r in db.execute("SELECT id,external_id,numero_visible,estado_canal,estado_comercial,pago_estado,moneda,creado_fuente_en,actualizado_en"+metadata+" FROM gestion_pedidos WHERE fuente='mercadolibre'")]
  projected=[];rejected=0
  for order in orders:
   items=[dict(r) for r in db.execute('SELECT producto_woo_id,sku,nombre,cantidad,precio_unitario_centavos FROM gestion_pedido_items WHERE pedido_id=? ORDER BY id',(order['id'],))]
   try:
    if not items:raise ValueError('sin_items')
    projected.append(project(order,items))
   except (ValueError,TypeError,KeyError):rejected+=1
 previous=json.loads(target.read_text()) if target.exists() else {'orders':[],'windows':[]}
 by_id={o['id']:o for o in previous['orders']}
 for order in projected:
  old=by_id.get(order['id'])
  if not old or (old.get('source')=='Mercado Libre · registro operativo' and order['updated_at']>=old.get('updated_at','')):by_id[order['id']]=order
 now=dt.datetime.now(dt.timezone.utc).isoformat()
 out={**previous,'schema':1,'orders':sorted(by_id.values(),key=lambda o:(o['date'],o['id'])),'state':'partial','updated_at':now,'error':None,'rejected':rejected,'source':'existing_local_cache'}
 target.parent.mkdir(parents=True,exist_ok=True)
 fd,name=tempfile.mkstemp(prefix='.ml-sales-',dir=target.parent)
 try:
  with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(out,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
  os.chmod(name,0o640)
  if os.name!='nt':
   import shutil
   shutil.chown(name,group='fusion-management-read')
  os.replace(name,target)
 finally:
  if Path(name).exists():Path(name).unlink()
 return {'state':'partial','source_orders':len(orders),'archived_orders':len(by_id),'rejected':rejected,'earliest':min((o['date'] for o in by_id.values()),default=None),'latest':max((o['date'] for o in by_id.values()),default=None)}

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,default=Path('/opt/fusionbikes/herramientas/data/fusion.sqlite'));parser.add_argument('--target',type=Path,default=Path('/opt/fusion-management-migration/directory-cache/ml-sales.json'));args=parser.parse_args()
 if os.name!='nt':
  import fcntl
  lock=open(args.target.with_suffix('.lock'),'a');fcntl.flock(lock,fcntl.LOCK_EX)
 try:print(json.dumps(sync(args.source,args.target)))
 except Exception as e:print(json.dumps({'state':'error','error':str(e) if isinstance(e,ValueError) else 'no_se_pudo_actualizar_cache_ml'}));raise SystemExit(1)
