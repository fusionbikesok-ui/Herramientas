"""Private fiscal bridge. Fixed Woo routes; local catalogue; no customer communications."""
import hashlib,hmac,http.server,json,os,re,sqlite3,ssl,time,urllib.request,urllib.error
from pathlib import Path

ORIGIN='https://fusionbikes.com.ar/wp-json/wc/v3/'
CATALOGUE='/opt/fusionbikes/herramientas/data/fusion.sqlite'
class BridgeError(Exception):pass
def woo(route,method='GET',data=None):
 body=json.dumps(data).encode() if data is not None else None
 req=urllib.request.Request(ORIGIN+route,data=body,method=method,headers={'Authorization':'Basic '+os.environ['ARCA_WOO_AUTH'],'Accept':'application/json','Content-Type':'application/json'})
 # No redirects: never forward Woo credentials to a new destination.
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 try:
  with urllib.request.build_opener(NoRedirect,urllib.request.HTTPSHandler(context=ssl.create_default_context())).open(req,timeout=20) as r:
   raw=r.read(8*1024*1024+1)
   if len(raw)>8*1024*1024:raise BridgeError('Respuesta de la tienda demasiado grande.')
   return json.loads(raw)
 except (urllib.error.URLError,ValueError):raise BridgeError('No se pudo verificar la tienda. No se debe emitir hasta recuperar la conexión.')
def gate():
 data=woo('fusion-herramientas/fiscal-cutover');s=data.get('settings')
 if data.get('active') is not True or data.get('ready') is not True or not isinstance(s,dict) or s.get('environment')!='production' or s.get('production_enabled') is not False or s.get('auto_enabled') is not False:
  raise BridgeError('La emisión de la tienda no está detenida. Se bloqueó el VPS para evitar dos emisores.')
 return {'source_stopped':True}
def product_ids(value):
 if not isinstance(value,list) or len(value)>150 or any(type(i)!=int or i<1 or i>2**53-1 for i in value):raise BridgeError('Productos inválidos.')
 return sorted(set(value))
def products(ids):
 ids=product_ids(ids)
 if not ids:return []
 with sqlite3.connect('file:'+CATALOGUE+'?mode=ro',uri=True) as c:
  c.row_factory=sqlite3.Row
  rows=[dict(r) for r in c.execute('SELECT id_woo,nombre,sku,tipo,id_padre,stock,categorias_json FROM catalogo_cache WHERE id_woo IN ('+','.join('?'*len(ids))+')',ids)]
  parents=[r['id_padre'] for r in rows if r['id_padre'] and r['id_padre'] not in ids]
  if parents:rows.extend(dict(r) for r in c.execute('SELECT id_woo,nombre,sku,tipo,id_padre,stock,categorias_json FROM catalogo_cache WHERE id_woo IN ('+','.join('?'*len(parents))+')',parents))
 for r in rows:
  cats=json.loads(r.pop('categorias_json') or '[]')
  r['category_ids']=[int(x['id'] if isinstance(x,dict) else x) for x in cats if (isinstance(x,dict) and str(x.get('id','')).isdigit()) or str(x).isdigit()]
 with sqlite3.connect('file:/opt/fusion-management-migration/directory-cache/metrics.sqlite?mode=ro',uri=True) as c:
  for r in rows:
   item=c.execute('SELECT data FROM products WHERE id=?',(r['id_padre'] or r['id_woo'],)).fetchone()
   if item:r['category_ids']=json.loads(item[0]).get('category_ids',r['category_ids'])
 return rows
def order(order_id):
 if type(order_id)!=int or not 0<order_id<2**53:raise BridgeError('Pedido inválido.')
 o=woo('orders/'+str(order_id)+'?dp=8')
 if o.get('id')!=order_id:raise BridgeError('La tienda devolvió otro pedido.')
 refunds=[woo('orders/'+str(order_id)+'/refunds/'+str(int(r['id']))+'?dp=8') for r in o.get('refunds',[])]
 ids=[int(l.get('variation_id') or l.get('product_id') or 0) for l in o.get('line_items',[])];ids=[i for i in ids if i]
 return {'order':o,'refunds':refunds,'products':products(ids)}
def dispatch(data):
 if not isinstance(data,dict):raise BridgeError('Solicitud inválida.')
 action=data.get('action')
 if action=='gate':return gate()
 if action=='order':return order(data.get('id'))
 if action=='products':return products(data.get('ids'))
 if action=='sync_invoice':
  record=data.get('record')
  if not isinstance(record,dict) or record.get('status')!='authorized':raise BridgeError('Comprobante no autorizado.')
  return woo('fusion-herramientas/fiscal-receipt','POST',{'record':record})
 raise BridgeError('Acción no disponible.')
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.connection.settimeout(35)
  try:
   if self.path!='/api':return self.reply(404,{'message':'Ruta no disponible.'})
   size=int(self.headers.get('Content-Length','0'))
   if not 0<size<=524288:return self.reply(413,{'message':'Tamaño inválido.'})
   body=self.rfile.read(size);stamp=self.headers.get('X-Arca-Time','')
   signature=hmac.new(os.environ['ARCA_PROXY_PASSWORD'].encode(),stamp.encode()+b'\n'+body,hashlib.sha256).hexdigest()
   if not stamp.isdigit() or abs(time.time()-int(stamp))>20 or not hmac.compare_digest(signature,self.headers.get('X-Arca-Signature','')):return self.reply(403,{'message':'Sin autorización.'})
   result=dispatch(json.loads(body));self.reply(200,{'ok':True,'data':result})
  except BridgeError as e:self.reply(409,{'ok':False,'message':str(e)})
  except Exception:self.reply(503,{'ok':False,'message':'El puente fiscal no respondió; revisá la conexión antes de emitir.'})
 def reply(self,status,data):
  raw=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
if __name__=='__main__':
 http.server.ThreadingHTTPServer((os.environ['ARCA_PROXY_BIND'],8216),Handler).serve_forever()
