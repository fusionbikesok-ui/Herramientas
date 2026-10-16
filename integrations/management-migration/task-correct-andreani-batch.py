from pathlib import Path
import sqlite3,json,subprocess,hashlib,hmac,base64,time,urllib.request,io,zipfile,uuid,datetime,os
from xml.dom import minidom
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
source_batch='ec2234ea-4624-4a19-a791-49a405a4a1be';ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
def ro(p):
 db=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;return db
private=ro('/var/lib/fusion-management-validation/andreani.sqlite');directory=ro(r/'directory-cache/directory.sqlite');metrics=ro(r/'directory-cache/metrics.sqlite')
batch=private.execute('SELECT * FROM batches WHERE id=?',(source_batch,)).fetchone();assert batch and batch['file']
ids=[70554,70567,70569,70585,70601,70611,70622,70632,70641,70642,70643,70644,70654,70655,70658,70659]
orders=[];products={}
for ident in ids:
 o=json.loads(directory.execute('SELECT data FROM orders WHERE id=?',(ident,)).fetchone()[0]);saved=private.execute('SELECT data FROM drafts WHERE order_id=?',(ident,)).fetchone()
 if saved:o['andreani']['draft']=json.loads(saved[0])
 orders.append(o)
 for i in o['items']:
  for pid in [i['product_id'],i['variation_id']]:
   if pid and str(pid) not in products:products[str(pid)]=json.loads(metrics.execute('SELECT data FROM products WHERE id=?',(pid,)).fetchone()[0])
settings=private.execute("SELECT value FROM settings WHERE key='bike_categories'").fetchone()
payload={'action':'draft','orders':orders,'products':products,'settings':{'bike_categories':json.loads(settings[0]) if settings else [62]},'options':json.loads(metrics.execute("SELECT value FROM state WHERE key='options'").fetchone()[0])}
key=next(l.split('=',1)[1].strip() for l in (r/'runtime.env').read_text().splitlines() if l.startswith('FUSION_MANAGEMENT_SIGNING_KEY='));info=json.loads(subprocess.check_output(['docker','inspect','fusion-management-migration-php-1'],text=True))[0];ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress'];uri='/fusion-andreani-worker/worker.php';body=json.dumps(payload).encode();claim=base64.b64encode(json.dumps({'user':batch['by_user'],'method':'POST','uri':uri,'time':int(time.time()),'sha256':hashlib.sha256(body).hexdigest()}).encode()).decode()
req=urllib.request.Request('http://'+ip+uri,data=body,headers={'Content-Type':'application/json','X-Fusion-Claim':claim,'X-Fusion-Signature':hmac.new(key.encode(),claim.encode(),'sha256').hexdigest()})
with urllib.request.urlopen(req,timeout=30) as response:data=json.load(response)
assert data['success'];rows={str(o['number']):o for o in data['data']};assert len(rows)==16
output=io.BytesIO();changed=[];total=0
with zipfile.ZipFile(io.BytesIO(batch['file'])) as original,zipfile.ZipFile(output,'w') as result:
 for entry in original.infolist():
  content=original.read(entry.filename)
  if entry.filename in [f'xl/worksheets/sheet{i}.xml' for i in [1,2,3]]:
   doc=minidom.parseString(content);sheet_changed=False
   for row in doc.getElementsByTagNameNS(ns,'row'):
    if int(row.getAttribute('r'))<3:continue
    total+=1;cells={c.getAttribute('r').rstrip('0123456789'):c for c in row.getElementsByTagNameNS(ns,'c')}
    def value(c):return ''.join(n.data for el in c.childNodes for n in ([el] if el.nodeType==el.TEXT_NODE else el.childNodes) if n.nodeType==n.TEXT_NODE) if c.getAttribute('t')!='inlineStr' else ''.join(n.data for el in c.getElementsByTagNameNS(ns,'t') for n in el.childNodes if n.nodeType==n.TEXT_NODE)
    ref=value(cells['G']);assert ref.startswith('FB-');draft=rows[ref[3:]]['draft'];parcels=draft['packages'];assert len(parcels)==1
    p=parcels[0]
    if p['profile_mode']!='auto' or value(cells['A']):continue
    changes={}
    for col,keyname in [('B','weight'),('C','height'),('D','width'),('E','depth')]:
     before=value(cells[col]);after=str(p[keyname])
     if before!=after:
      v=cells[col].getElementsByTagNameNS(ns,'v')[0];assert len(v.childNodes)==1 and v.firstChild.nodeType==v.TEXT_NODE;v.firstChild.data=after;changes[keyname]={'before':before,'after':after}
    if changes:changed.append({'order':ref,'changes':changes});sheet_changed=True
   if sheet_changed:content=doc.toxml(encoding='UTF-8',standalone=True)
  result.writestr(entry,content)
assert total==16 and len(changed)==11,(total,len(changed))
# Verify that all non-dimension cells and every other workbook part are preserved.
with zipfile.ZipFile(io.BytesIO(batch['file'])) as before,zipfile.ZipFile(io.BytesIO(output.getvalue())) as after:
 for name in before.namelist():
  if before.read(name)==after.read(name):continue
  assert name.startswith('xl/worksheets/sheet')
  a=minidom.parseString(before.read(name));b=minidom.parseString(after.read(name));ac=a.getElementsByTagNameNS(ns,'c');bc=b.getElementsByTagNameNS(ns,'c');assert len(ac)==len(bc)
  for x,y in zip(ac,bc):
   if x.toxml()==y.toxml():continue
   assert x.getAttribute('r')==y.getAttribute('r') and x.getAttribute('r').rstrip('0123456789') in ['B','C','D','E'] and int(x.getAttribute('r')[1:])>=3
correction=str(uuid.uuid4());at=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z');filename='Fusion-Andreani-20261005-180307-corregido.xlsx'
private.close();directory.close();metrics.close()
db=sqlite3.connect('/var/lib/fusion-management-validation/andreani.sqlite',timeout=5)
db.execute('INSERT INTO batches(id,created_at,by_user,filename,file) VALUES(?,?,?,?,?)',(correction,at,batch['by_user'],filename,output.getvalue()));db.commit();db.close()
report={'source_batch':source_batch,'correction_batch':correction,'url':'https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/andreani/download?id='+correction,'filename':filename,'rows':total,'corrected_bicycles':len(changed),'changed':changed,'only_dimension_cells_changed':True,'production_drafts_or_export_marks_changed':False}
(r/'andreani-package-correction.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));os.chmod(r/'andreani-package-correction.json',0o600)
print(json.dumps(report,ensure_ascii=False))
