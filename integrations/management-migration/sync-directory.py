"""Rebuildable Woo read index. No writes to Woo, no commerce hooks, no mail."""
from pathlib import Path
import base64, contextlib, datetime as dt, json, os, re, shutil, sqlite3, sys, time, unicodedata
import urllib.request, urllib.parse, urllib.error

ROOT = Path('/opt/fusion-management-migration')
CACHE = ROOT / 'directory-cache'
DOC_KEYS = ['billing_dni_cuit','_billing_dni_cuit','billing_dni_afip','billing_dni','_billing_dni','dni','billing_cuit','_billing_cuit','cuit']
ENV_FILE=Path('/opt/fusionbikes/herramientas/.env')
BILLING_KEYS = ['first_name','last_name','company','address_1','address_2','city','state','postcode','country','email','phone']

def now(): return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z')
def text(value, limit=500): return str(value or '').strip()[:limit]
def norm(value):
 return ''.join(c for c in unicodedata.normalize('NFKD',text(value,20000).lower()) if not unicodedata.combining(c))
def digits(value): return re.sub(r'\D','',text(value))
def metadata(raw):
 return {x.get('key'):x.get('value') for x in raw.get('meta_data',[]) if isinstance(x,dict) and isinstance(x.get('value'),(str,int,float))}
def billing(raw): return {key:text(raw.get(key)) for key in BILLING_KEYS}
def document(raw):
 meta=metadata(raw)
 return next((digits(meta[k]) for k in DOC_KEYS if meta.get(k)), '')
def customer(raw):
 b=billing(raw.get('billing') or {}); ident=int(raw['id']); doc=document(raw)
 email=text(b.get('email') or raw.get('email'),190)
 if email.endswith('@pos.local'): email=''
 b['email']=email
 name=' '.join(filter(None,[b['first_name'] or text(raw.get('first_name')),b['last_name'] or text(raw.get('last_name'))])) or b['company'] or email or 'Cliente sin nombre'
 return {'key':f'woo:customer:{ident}','id':ident,'name':name,'email':email,'phone':b['phone'],'document':doc,'document_type':80 if len(doc)==11 else 96 if doc else 99,'billing':b,'source':'woocommerce','kind':'registered','marketing_consent':'unknown','modified_at':raw.get('date_modified_gmt')}
def order(raw):
 ident=int(raw['id']); b=billing(raw.get('billing') or {}); meta=metadata(raw)
 ml=text(meta.get('_ml_order_id'))
 items=[]
 for item in raw.get('line_items',[]):
  items.append({k:item.get(k) for k in ['id','product_id','variation_id','name','sku','quantity','subtotal','subtotal_tax','total','total_tax']})
 original=next((x.get('value') for x in raw.get('meta_data',[]) if x.get('key')=='_fbam_draft' and isinstance(x.get('value'),dict)),None)
 draft=None
 if original is not None:
  draft={key:text(original.get(key)) for key in ['service','first_name','last_name','dni','email','phone_code','phone_number','street','number','floor','apartment','destination','branch','observations']}
  draft['reviewed']=bool(original.get('reviewed'));draft['packages']=[{k:text(p.get(k)) for k in ['profile','saved','weight','height','width','depth','value']} for p in (original.get('packages') or [])[:20] if isinstance(p,dict)]
 shipping_document=next((text(meta[k]) for k in ['_shipping_dni','shipping_dni','_billing_dni','billing_dni','_billing_document_number','billing_document_number','_billing_dni_cuit'] if meta.get(k)),'')
 return {'id':ident,'number':text(raw.get('number') or ident),'customer_id':int(raw.get('customer_id') or 0),'status':text(raw.get('status')),'currency':text(raw.get('currency')),'created_at':text(raw.get('date_created_gmt')),'modified_at':text(raw.get('date_modified_gmt')),'billing':b,'shipping':billing(raw.get('shipping') or {}),'document':document(raw),'shipping_document':shipping_document,'shipping_methods':[text(i.get('method_title')) for i in raw.get('shipping_lines',[])],'andreani':{'draft':draft,'exported_at':text(meta.get('_fbam_exported_at')),'export_batch':text(meta.get('_fbam_export_batch'))},'total':text(raw.get('total')),'total_tax':text(raw.get('total_tax')),'shipping_total':text(raw.get('shipping_total')),'discount_total':text(raw.get('discount_total')),'payment_method':text(raw.get('payment_method')),'payment_method_title':text(raw.get('payment_method_title')),'items':items,'refunds':[{'id':int(r['id']),'total':text(r.get('total'))} for r in raw.get('refunds',[]) if r.get('id')],'ml_order_id':ml,'is_ml_mirror':bool(ml or meta.get('_fusion_arca_ml_origin')),'source':'woocommerce'}
def guest(o):
 b=o['billing']; name=' '.join(filter(None,[b['first_name'],b['last_name']])) or b['company'] or 'Comprador sin nombre'
 email=b['email'] if not b['email'].endswith('@pos.local') else ''
 return {'key':f"woo:order:{o['id']}",'id':0,'name':name,'email':email,'phone':b['phone'],'document':o['document'],'billing':b,'source':'woocommerce','kind':'guest_order' if not o['customer_id'] else 'order_contact','source_customer_id':o['customer_id'],'order_id':o['id'],'marketing_consent':'unknown','modified_at':o['modified_at']}
def customer_search(c):
 return norm(' '.join(text(c.get(k)) for k in ['name','email','phone','document']))+' '+digits(c.get('phone'))+' '+digits(c.get('document'))
def order_search(o):
 return norm(' '.join([str(o['id']),o['number'],o['ml_order_id'],o['document'],*o['billing'].values(),*[str(i.get(k) or '') for i in o['items'] for k in ['name','sku','product_id','variation_id']]]))+' '+digits(o['billing']['phone'])

class SafeRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): raise RuntimeError('redirect_blocked')

def run():
 import fcntl
 assert (ROOT/'.task-owner').read_text()=='fusion-management-migration-20261004'
 CACHE.mkdir(exist_ok=True)
 lock=open(CACHE/'sync.lock','a')
 try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: lock.close();print('directory_sync_already_running'); return
 # Existing service environment is read only in this root-owned sync process.
 values={}
 for line in ENV_FILE.read_text().splitlines():
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.split('=',1)
   if k.strip() in ['WOO_URL','WOO_CK','WOO_CS']: values[k.strip()]=v.strip().strip('"').strip("'")
 origin=urllib.parse.urlsplit(values['WOO_URL'])
 assert origin.scheme=='https' and origin.hostname in ['fusionbikes.com.ar','www.fusionbikes.com.ar'] and not origin.username and not origin.password and not origin.port
 auth='Basic '+base64.b64encode((values['WOO_CK']+':'+values['WOO_CS']).encode()).decode()
 opener=urllib.request.build_opener(SafeRedirect())
 requests_count=0
 def fetch(resource,params):
  nonlocal requests_count
  url=f'https://{origin.hostname}/wp-json/wc/v3/{resource}?'+urllib.parse.urlencode(params)
  for attempt in range(3):
   try:
    req=urllib.request.Request(url,headers={'Authorization':auth,'Accept':'application/json','User-Agent':'Fusion-Directory-Read-Sync/1'})
    with opener.open(req,timeout=40) as r:
     body=r.read(12*1024*1024+1)
     if len(body)>12*1024*1024: raise RuntimeError('response_limit')
     data=json.loads(body); total=int(r.headers.get('X-WP-Total',0)); pages=int(r.headers.get('X-WP-TotalPages',0))
    if not isinstance(data,list): raise RuntimeError('invalid_response')
    requests_count+=1; time.sleep(.6)
    return data,total,pages
   except urllib.error.HTTPError as e:
    if e.code not in [429,500,502,503,504] or attempt==2: raise RuntimeError(f'woo_http_{e.code}') from None
   except (TimeoutError,OSError):
    if attempt==2: raise RuntimeError('woo_connection') from None
   time.sleep(2*(attempt+1))
 def pages(resource,params,first=1):
  for page in range(first,10001):
   rows,total,count=fetch(resource,{**params,'per_page':100,'page':page})
   if total>1000000: raise RuntimeError('source_limit')
   yield rows,total,page
   if page>=count or not rows: return
  raise RuntimeError('page_limit')
 target=CACHE/'directory.sqlite'; staging=CACHE/'building.sqlite'
 started=now(); status_path=CACHE/'status.json';checkpoint_path=CACHE/'build-state.json'
 def status(state,**extra):
  tmp=CACHE/'status.tmp'; tmp.write_text(json.dumps({'state':state,'started_at':started,**extra}));os.chmod(tmp,0o640);os.replace(tmp,status_path)
 status('running')
 db=None
 try:
  checkpoint={}
  if staging.exists() and checkpoint_path.exists():
   checkpoint=json.loads(checkpoint_path.read_text())
   if checkpoint.get('shipping_fields_version')!=1 or checkpoint.get('amount_decimals')!=8 or (dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(checkpoint['started'].replace('Z','+00:00'))).total_seconds()>48*3600:checkpoint={}
  if staging.exists() and not checkpoint: staging.unlink() # owned disposable build only
  if checkpoint:started=checkpoint['started']
  db=sqlite3.connect(staging); os.chmod(staging,0o600)
  if target.exists() and not checkpoint:
   with contextlib.closing(sqlite3.connect(f'file:{target}?mode=ro',uri=True)) as previous: previous.backup(db)
  db.executescript('''CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY,search TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL,search TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id);
CREATE TABLE IF NOT EXISTS guests (order_id INTEGER PRIMARY KEY,search TEXT NOT NULL,data TEXT NOT NULL);''')
  saved={r[0]:json.loads(r[1]) for r in db.execute('SELECT key,value FROM state')}
  def old(key,hours):
   try:return (dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(saved[key].replace('Z','+00:00'))).total_seconds()>hours*3600
   except (KeyError,ValueError): return True
  full=checkpoint.get('full',old('full_orders_at',24*7) or saved.get('shipping_fields_version')!=1 or saved.get('amount_decimals')!=8 or '--full' in sys.argv)
  counts={}
  def save_state():
   for key,value in saved.items():db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',(key,json.dumps(value)))
   db.commit()
  def publish_copy():
   temporary=CACHE/'publish.sqlite'
   if temporary.exists():temporary.unlink()
   with contextlib.closing(sqlite3.connect(temporary)) as out:db.backup(out)
   shutil.chown(temporary,group='fusion-management-read');os.chmod(temporary,0o640);os.replace(temporary,target)
  if not checkpoint and old('customers_at',24):
   db.execute('DELETE FROM customers')
   total=0
   for rows,total,_ in pages('customers',{'role':'customer','orderby':'id','order':'asc','_fields':'id,first_name,last_name,email,billing,date_modified_gmt,meta_data'}):
    for raw in rows:
     c=customer(raw);db.execute('INSERT INTO customers VALUES(?,?,?)',(c['id'],customer_search(c),json.dumps(c,ensure_ascii=False)))
    status('running',phase='customers',downloaded=db.execute('SELECT COUNT(*) FROM customers').fetchone()[0],expected=total)
   if db.execute('SELECT COUNT(*) FROM customers').fetchone()[0]!=total: raise RuntimeError('customer_count_changed_retry')
   saved.update(customers_at=started,source_customers=total)
   if not target.exists():
    saved.update(orders_complete=False);save_state();publish_copy()
  params={'status':'any','orderby':'id','order':'asc','dates_are_gmt':'true','dp':8,'_fields':'id,number,customer_id,status,currency,date_created_gmt,date_modified_gmt,billing,shipping,shipping_lines,total,total_tax,shipping_total,discount_total,payment_method,payment_method_title,line_items,refunds,meta_data'}
  if full:
   params['before']=started.rstrip('Z')
   if not checkpoint:db.execute('DELETE FROM orders');db.execute('DELETE FROM guests')
  else:
   # Verify this source actually supports modified_after before relying on a delta.
   check,_,_=fetch('orders',{'per_page':1,'modified_after':'2099-01-01T00:00:00','_fields':'id'})
   if check: raise RuntimeError('modified_filter_unsupported')
   cursor=dt.datetime.fromisoformat(saved['orders_at'].replace('Z','+00:00'))-dt.timedelta(minutes=10)
   params['modified_after']=cursor.strftime('%Y-%m-%dT%H:%M:%S')
   params['modified_before']=started.rstrip('Z')
  downloaded=checkpoint.get('downloaded',0); total=0
  for rows,total,page in pages('orders',params,checkpoint.get('page',0)+1):
   for raw in rows:
    o=order(raw);db.execute('INSERT OR REPLACE INTO orders VALUES(?,?,?,?,?)',(o['id'],o['customer_id'],order_search(o),o['created_at'],json.dumps(o,ensure_ascii=False)))
   downloaded+=len(rows);save_state()
   checkpoint_path.write_text(json.dumps({'started':started,'page':page,'downloaded':downloaded,'full':full,'amount_decimals':8,'shipping_fields_version':1}));checkpoint_path.chmod(0o640)
   status('running',phase='orders',downloaded=downloaded,expected=total,full=full)
  if full and db.execute('SELECT COUNT(*) FROM orders').fetchone()[0]!=total: raise RuntimeError('order_count_changed_retry')
  # Materialize guests per source order: never merge homonyms or internal sales email.
  db.execute('DELETE FROM guests')
  for (raw,) in db.execute('SELECT o.data FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE c.id IS NULL'):
   o=json.loads(raw);c=guest(o);db.execute('INSERT INTO guests VALUES(?,?,?)',(o['id'],customer_search(c),json.dumps(c,ensure_ascii=False)))
  saved.update(orders_at=started,completed_at=now(),orders_complete=True,amount_decimals=8,shipping_fields_version=1)
  if full:saved.update(full_orders_at=started,source_orders_at_full=total)
  for key,value in saved.items():db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',(key,json.dumps(value)))
  db.commit()
  if db.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise RuntimeError('index_integrity')
  counts={table:db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in ['customers','orders','guests']}
  db.close();db=None
  shutil.chown(staging,group='fusion-management-read');os.chmod(staging,0o640);os.replace(staging,target)
  checkpoint_path.unlink(missing_ok=True)
  status('ok',completed_at=now(),counts=counts,requests=requests_count,full=full)
  print(json.dumps({'state':'ok','counts':counts,'requests':requests_count,'full':full}))
 except Exception as error:
  if db:db.close()
  # Error labels never contain URLs, payloads, contacts or credentials.
  label=str(error) if isinstance(error,RuntimeError) and re.fullmatch(r'[a-z_0-9]+',str(error)) else 'sync_failed'
  status('error',error=label,previous_copy_available=target.exists())
  print(json.dumps({'state':'error','error':label}));raise SystemExit(1)
 finally:
  try:shutil.chown(status_path,group='fusion-management-read');os.chmod(status_path,0o640)
  finally:lock.close()

if __name__=='__main__':run()
