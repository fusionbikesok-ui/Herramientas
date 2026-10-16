from pathlib import Path
import sqlite3,json,io,zipfile,xml.etree.ElementTree as E
r=Path('/opt/fusion-management-migration')
def read(p):
 c=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;return c
state=read('/var/lib/fusion-management-validation/andreani.sqlite');directory=read(r/'directory-cache/directory.sqlite');metrics=read(r/'directory-cache/metrics.sqlite')
options=json.loads(metrics.execute("SELECT value FROM state WHERE key='options'").fetchone()[0]);settings=state.execute("SELECT value FROM settings WHERE key='bike_categories'").fetchone();cats=json.loads(settings[0]) if settings else [62]
print(json.dumps({'configured_bike_categories':cats,'category_names':[{k:c.get(k) for k in ['id','name','slug']} for c in options['categories'] if c['id'] in cats]},ensure_ascii=False))
ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
for batch in state.execute('SELECT id,created_at,file FROM batches ORDER BY created_at DESC LIMIT 2'):
 exported={}
 if batch['file']:
  with zipfile.ZipFile(io.BytesIO(batch['file'])) as z:
   for i in [1,2,3]:
    root=E.fromstring(z.read(f'xl/worksheets/sheet{i}.xml'))
    for row in root.findall('x:sheetData/x:row',ns):
     if int(row.attrib['r'])<3:continue
     cells={c.attrib['r'].rstrip('0123456789'):''.join(c.itertext()) for c in row}
     exported[cells.get('G','')]={key:cells.get(col) for key,col in [('saved','A'),('weight','B'),('height','C'),('width','D'),('depth','E')]}
 ids=[i[0] for i in state.execute('SELECT order_id FROM exports WHERE batch=? ORDER BY order_id',(batch['id'],))]
 print(json.dumps({'batch':batch['id'],'at':batch['created_at'],'orders':ids,'xlsx_dimensions':exported},ensure_ascii=False))
 for ident in ids:
  raw=directory.execute('SELECT data FROM orders WHERE id=?',(ident,)).fetchone()
  if not raw:continue
  o=json.loads(raw[0]);saved=state.execute('SELECT revision,data FROM drafts WHERE order_id=?',(ident,)).fetchone();d=json.loads(saved['data']) if saved else (o.get('andreani',{}).get('draft') or {})
  items=[]
  for item in o['items']:
   dims=[]
   for pid in [item['product_id'],item['variation_id']]:
    if not pid:continue
    p=metrics.execute('SELECT data FROM products WHERE id=?',(pid,)).fetchone();p=json.loads(p[0]) if p else {}
    dims.append({k:p.get(k) for k in ['id','exists','parent_id','virtual','category_ids']})
   items.append({'name':item['name'],'quantity':item['quantity'],'dimensions':dims})
  print(json.dumps({'order':ident,'draft_origin':'vps' if saved else 'woo','revision':saved['revision'] if saved else 0,'packages':d.get('packages'),'items':items},ensure_ascii=False))
