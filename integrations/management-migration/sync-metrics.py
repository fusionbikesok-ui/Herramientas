"""Derived non-PII sales facts; reads existing order snapshot and bounded bridge GETs."""
from pathlib import Path
import base64,contextlib,datetime as dt,hashlib,json,os,re,shutil,sqlite3,sys,time,uuid,urllib.request,urllib.parse,urllib.error
from zoneinfo import ZoneInfo
ROOT=Path('/opt/fusion-management-migration');CACHE=ROOT/'directory-cache';ENV_FILE=Path('/opt/fusionbikes/herramientas/.env')
def now():return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z')
def expired(value,hours=24):
 try:return (dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(value.replace('Z','+00:00'))).total_seconds()>hours*3600
 except (ValueError,AttributeError):return True
def timezone(name):
 if re.fullmatch(r'[+-]\d{2}:\d{2}',name):return dt.timezone((1 if name[0]=='+' else -1)*dt.timedelta(hours=int(name[1:3]),minutes=int(name[4:6])))
 return ZoneInfo(name)
def fact(order,refund,zone):
 raw=order['created_at'];date=dt.datetime.fromisoformat(raw.rstrip('Z')).replace(tzinfo=dt.timezone.utc).astimezone(zone).date().isoformat()
 shipping=bool(order['shipping'].get('country'));address=order['shipping'] if shipping else order['billing']
 by_id={x['id']:x for x in (refund or {}).get('items',[])};items=[]
 for row in order['items']:
  ref=by_id.get(row['id'],{});qty=max(0,float(row['quantity'])-abs(float(ref.get('quantity',0))));amount=float(row['total'])-abs(float(ref.get('amount',0)))
  if not all(__import__('math').isfinite(x) for x in [qty,amount]):raise RuntimeError('non_finite_amount')
  items.append({'id':row['id'],'product_id':row.get('product_id') or 0,'variation_id':row.get('variation_id') or 0,'name':row['name'],'quantity':qty,'amount':amount})
 return {'id':order['id'],'status':order['status'],'date':date,'currency':order['currency'],'country':address.get('country') or 'Sin país','state':address.get('state') or 'Sin provincia','city':(address.get('city') or '').strip() or 'Sin ciudad','items':items,'unassigned':bool((refund or {}).get('unassigned')),'ml_mirror':order['is_ml_mirror']}
class SafeRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):raise RuntimeError('redirect_blocked')
def run():
 import fcntl
 assert (ROOT/'.task-owner').read_text()=='fusion-management-migration-20261004'
 lock=open(CACHE/'metrics.lock','a')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:lock.close();return
 started=now();status_path=CACHE/'metrics-status.json';db=None;source=None
 def status(state,**values):
  tmp=CACHE/'metrics-status.tmp';tmp.write_text(json.dumps({'state':state,'started_at':started,**values}));shutil.chown(tmp,group='fusion-management-read');tmp.chmod(0o640);os.replace(tmp,status_path)
 try:
  status('running');values={}
  for line in ENV_FILE.read_text().splitlines():
   if '=' in line and not line.lstrip().startswith('#'):
    k,v=line.split('=',1)
    if k.strip() in ['WOO_URL','WOO_CK','WOO_CS']:values[k.strip()]=v.strip().strip('"').strip("'")
  origin=urllib.parse.urlsplit(values['WOO_URL'])
  assert origin.scheme=='https' and origin.hostname in ['fusionbikes.com.ar','www.fusionbikes.com.ar'] and not origin.username and not origin.password and not origin.port
  auth='Basic '+base64.b64encode((values['WOO_CK']+':'+values['WOO_CS']).encode()).decode();opener=urllib.request.build_opener(SafeRedirect());requests=0
  def fetch(resource,ids=None):
   nonlocal requests
   url=f'https://{origin.hostname}/wp-json/wc/v3/fusion-herramientas/metrics-{resource}'
   if ids:url+='?'+urllib.parse.urlencode({'ids':','.join(str(x) for x in ids)})
   for attempt in range(3):
    try:
     req=urllib.request.Request(url,headers={'Authorization':auth,'Accept':'application/json','User-Agent':'Fusion-Metrics-Read-Sync/1'})
     with opener.open(req,timeout=40) as response:
      raw=response.read(10*1024*1024+1)
      if len(raw)>10*1024*1024:raise RuntimeError('response_limit')
      data=json.loads(raw)
     if not isinstance(data,dict) or data.get('schema')!=1:raise RuntimeError('invalid_schema')
     requests+=1;time.sleep(.5);return data
    except urllib.error.HTTPError as e:
     if e.code not in [429,500,502,503,504] or attempt==2:raise RuntimeError(f'woo_http_{e.code}') from None
    except (OSError,TimeoutError):
     if attempt==2:raise RuntimeError('woo_connection') from None
    time.sleep(2*(attempt+1))
  source=sqlite3.connect(f'file:{CACHE}/directory.sqlite?mode=ro',uri=True);source.execute('BEGIN')
  source_state={k:json.loads(v) for k,v in source.execute('SELECT key,value FROM state')}
  if source_state.get('orders_complete') is not True:raise RuntimeError('directory_incomplete')
  if source_state.get('amount_decimals')!=8:raise RuntimeError('directory_precision_pending')
  if expired(source_state.get('completed_at'),2):raise RuntimeError('directory_stale')
  # Only IDs are held for classification; raw contacts never enter the analytic cache.
  product_ids=set()
  for (raw,) in source.execute('SELECT data FROM orders'):
   for item in json.loads(raw)['items']:
    product_ids.update(int(item[k]) for k in ['product_id','variation_id'] if item.get(k))
  if len(product_ids)>100000:raise RuntimeError('product_limit')
  target=CACHE/'metrics.sqlite';staging=CACHE/'metrics-building.sqlite'
  if staging.exists():staging.unlink()
  db=sqlite3.connect(staging);staging.chmod(0o600)
  if target.exists():
   with contextlib.closing(sqlite3.connect(f'file:{target}?mode=ro',uri=True)) as previous:previous.backup(db)
  db.executescript('''CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,checked_at TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refunds(id INTEGER PRIMARY KEY,signature TEXT NOT NULL,checked_at TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY,status TEXT NOT NULL,date TEXT NOT NULL,currency TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS facts_filter ON facts(date,status,id);''')
  options=fetch('options');zone=timezone(options['timezone'])
  stored={r[0]:r[1] for r in db.execute('SELECT id,checked_at,data FROM products') if not json.loads(r[2]).get('exists') or 'virtual' in json.loads(r[2])}
  missing=sorted(pid for pid in product_ids if pid not in stored or expired(stored[pid]))
  for offset in range(0,len(missing),100):
   ids=missing[offset:offset+100];rows=fetch('products',ids)['rows']
   if sorted(r['id'] for r in rows)!=ids:raise RuntimeError('product_identity_mismatch')
   for row in rows:db.execute('INSERT OR REPLACE INTO products VALUES(?,?,?)',(row['id'],started,json.dumps(row,ensure_ascii=False)))
   db.commit();status('running',phase='products',downloaded=min(offset+100,len(missing)),expected=len(missing))
  refund_cache={r[0]:r[1:] for r in db.execute('SELECT id,signature,checked_at,data FROM refunds')};needed=[];signatures={};versions={}
  for ident,raw in source.execute('SELECT id,data FROM orders'):
   o=json.loads(raw)
   if not o['refunds']:continue
   signature=hashlib.sha256(json.dumps([o['modified_at'],o['refunds'],o['items']],sort_keys=True).encode()).hexdigest()
   signatures[ident]=signature;versions[ident]=o['modified_at']
   cached=refund_cache.get(ident)
   if not cached or cached[0]!=signature or expired(cached[1]):needed.append(ident)
  for offset in range(0,len(needed),25):
   ids=needed[offset:offset+25];rows=fetch('refunds',ids)['rows']
   if sorted(r['id'] for r in rows)!=sorted(ids):raise RuntimeError('refund_identity_mismatch')
   for row in rows:
    if not row.get('exists') or row['modified_at']!=versions[row['id']]:raise RuntimeError('refund_snapshot_changed_retry')
    db.execute('INSERT OR REPLACE INTO refunds VALUES(?,?,?,?)',(row['id'],signatures[row['id']],started,json.dumps(row)))
   db.commit();status('running',phase='refunds',downloaded=min(offset+25,len(needed)),expected=len(needed))
  refunds={r[0]:json.loads(r[1]) for r in db.execute('SELECT id,data FROM refunds')};db.execute('DELETE FROM facts');count=0;lines=0
  for (raw,) in source.execute('SELECT data FROM orders ORDER BY id'):
   o=json.loads(raw);f=fact(o,refunds.get(o['id']) if o['refunds'] else None,zone)
   db.execute('INSERT INTO facts VALUES(?,?,?,?,?)',(f['id'],f['status'],f['date'],f['currency'],json.dumps(f,ensure_ascii=False)));count+=1;lines+=len(f['items'])
  for (pid,) in db.execute('SELECT id FROM products').fetchall():
   if pid not in product_ids:db.execute('DELETE FROM products WHERE id=?',(pid,))
  snapshot={'generation':uuid.uuid4().hex,'completed_at':now(),'orders_at':source_state['orders_at'],'product_dimensions_at':db.execute('SELECT MIN(checked_at) FROM products').fetchone()[0],'orders':count,'lines':lines,'refund_orders':len(signatures),'read_only':True,'source_panel_version':'1.1.0','options':options}
  for k,v in snapshot.items():db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',(k,json.dumps(v)))
  db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',('amount_decimals',json.dumps(8)))
  db.commit()
  if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise RuntimeError('index_integrity')
  db.close();db=None;source.close();source=None
  shutil.chown(staging,group='fusion-management-read');staging.chmod(0o640);os.replace(staging,target)
  status('ok',completed_at=now(),orders=count,lines=lines,products=len(product_ids),refund_orders=len(signatures),requests=requests)
  print(json.dumps({'state':'ok','orders':count,'lines':lines,'products':len(product_ids),'refund_orders':len(signatures),'requests':requests}))
 except Exception as error:
  if db:db.close()
  if source:source.close()
  label=str(error) if isinstance(error,RuntimeError) and re.fullmatch(r'[a-z_0-9]+',str(error)) else 'sync_failed'
  status('error',error=label,previous_copy_available=(CACHE/'metrics.sqlite').exists());print(json.dumps({'state':'error','error':label}));raise SystemExit(1)
 finally:lock.close()
if __name__=='__main__':run()
