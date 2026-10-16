"""Validate original ML order JSON before importing; preview by default.

Accepts an array of original orders, {results:[...]}, or one original order.
Does not accept payment reports or WooCommerce mirrors as original ML sales.
"""
import argparse,datetime as dt,json,math,os,tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

def normalize(o,seller):
 if str((o.get('seller') or {}).get('id') or '')!=str(seller):raise ValueError('cuenta_vendedora_no_coincide')
 ident=str(o.get('id') or '')
 if not ident.isdigit() or len(ident)>30:raise ValueError('venta_id_invalida')
 when=dt.datetime.fromisoformat(str(o.get('date_created') or '').replace('Z','+00:00'))
 if when.tzinfo is None:raise ValueError('fecha_sin_zona')
 status=o.get('status');currency=o.get('currency_id')
 if status not in ['paid','cancelled','partially_refunded','confirmed','payment_required','payment_in_process','partially_paid','pending_cancel']:raise ValueError('estado_no_reconocido')
 if currency not in ['ARS','USD','BRL','MXN','CLP','COP','UYU','PEN']:raise ValueError('moneda_no_reconocida')
 updated=dt.datetime.fromisoformat(str(o.get('last_updated') or o.get('date_last_updated') or o['date_created']).replace('Z','+00:00'))
 if updated.tzinfo is None:raise ValueError('version_sin_zona')
 state='valid' if status=='paid' else 'cancelled' if status=='cancelled' else 'pending'
 payments=o.get('payments') or []
 refund=any(p.get('status') in ['partially_refunded','refunded','charged_back','in_mediation'] or float(p.get('transaction_amount_refunded') or p.get('amount_refunded') or 0)>0 for p in payments)
 if (refund and state!='cancelled') or status=='partially_refunded':state='review'
 items=[]
 for line in o.get('order_items') or []:
  item=line.get('item') or {};listing=str(item.get('id') or '');qty=float(line['quantity']);price=float(line['unit_price'])
  if not listing or not math.isfinite(qty) or qty<=0 or not math.isfinite(price*qty) or price<0:raise ValueError('linea_invalida')
  items.append({'name':str(item.get('title') or 'Sin nombre')[:500],'listing':listing[:80],'variation':str(item.get('variation_id') or ''),
   'sku':str(item.get('seller_sku') or '')[:150],'variant':', '.join(str(v.get('value_name') or '') for v in item.get('variation_attributes') or [])[:300],
   'quantity':qty,'amount':round(qty*price,8) if state!='review' else None})
 if not items:raise ValueError('venta_sin_items')
 return {'id':ident,'seller':str(seller),'pack':str(o.get('pack_id') or ''),'date':when.astimezone(ZoneInfo('America/Argentina/Buenos_Aires')).date().isoformat(),
  'currency':currency,'status':status,'saleState':state,'items':items,'source':'Mercado Libre · orden original','updated_at':updated.astimezone(dt.timezone.utc).isoformat(),'refundsKnown':state!='review'}

def preview(raw,seller,previous):
 data=raw if isinstance(raw,list) else raw.get('results') if 'results' in raw else [raw]
 if not isinstance(data,list) or len(data)>50000:raise ValueError('archivo_invalido_o_demasiado_grande')
 result={};errors=[];duplicates=0
 for n,o in enumerate(data,1):
  try:
   r=normalize(o,seller);old=result.get(r['id'])
   if old:
    if old!=r:raise ValueError('dos_versiones_de_la_misma_venta_en_el_archivo')
    duplicates+=1
   result[r['id']]=r
  except (TypeError,ValueError,KeyError):errors.append({'fila':n,'error':'Revisar vendedor, identificador, fecha, moneda, estado e importes; no se importó esta venta.'})
 old={o['id']:o for o in previous.get('orders',[])};new=sum(k not in old for k in result);changed=sum(k in old and old[k]!=v for k,v in result.items());same=sum(k in old and old[k]==v for k,v in result.items())
 for k,v in result.items():
  if k in old and old[k].get('source')=='Mercado Libre · orden original' and v['updated_at']<old[k].get('updated_at',''):errors.append({'venta':k,'error':'El archivo contiene una versión anterior a la archivada.'})
 return list(result.values()),{'nuevas':new,'actualizadas':changed,'sin_cambios':same,'duplicadas_identicas':duplicates,'errores':errors[:50],'total_errores':len(errors)}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('file',type=Path);p.add_argument('--seller',required=True);p.add_argument('--target',type=Path,default=Path('/opt/fusion-management-migration/directory-cache/ml-sales.json'));p.add_argument('--apply',action='store_true');args=p.parse_args()
 if args.file.stat().st_size>40*1024*1024:raise SystemExit('Archivo demasiado grande; dividir por períodos.')
 if os.name!='nt':
  import fcntl
  lock=open(args.target.with_suffix('.lock'),'a');fcntl.flock(lock,fcntl.LOCK_EX)
 previous=json.loads(args.target.read_text(encoding='utf-8')) if args.target.exists() else {'orders':[],'windows':[]};records,report=preview(json.loads(args.file.read_text(encoding='utf-8-sig')),args.seller,previous)
 if args.apply:
  if report['total_errores']:raise SystemExit(json.dumps({**report,'aplicado':False}))
  orders={o['id']:o for o in previous['orders']};orders.update({o['id']:o for o in records});out={**previous,'schema':1,'state':'partial','orders':list(orders.values()),'updated_at':dt.datetime.now(dt.timezone.utc).isoformat()}
  fd,name=tempfile.mkstemp(prefix='.ml-import-',dir=args.target.parent)
  try:
   with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(out,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
   os.chmod(name,0o640)
   if os.name!='nt':
    import shutil
    shutil.chown(name,group='fusion-management-read')
   os.replace(name,args.target)
  finally:
   if Path(name).exists():Path(name).unlink()
 print(json.dumps({**report,'aplicado':args.apply},ensure_ascii=False))
