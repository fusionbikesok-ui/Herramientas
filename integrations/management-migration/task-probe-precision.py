from pathlib import Path
import json,sqlite3,urllib.request,base64
r=Path('/opt/fusion-management-migration');db=sqlite3.connect(f'file:{r}/directory-cache/directory.sqlite?mode=ro',uri=True)
ident=db.execute("SELECT id FROM orders WHERE data LIKE '%Sales de rehidrataci%' AND created_at LIKE '2023-03-18%' LIMIT 1").fetchone()[0];db.close()
env={}
for line in Path('/opt/fusionbikes/herramientas/.env').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1)
  if k.strip() in ['WOO_CK','WOO_CS']:env[k.strip()]=v.strip().strip('\"').strip("'")
auth='Basic '+base64.b64encode((env['WOO_CK']+':'+env['WOO_CS']).encode()).decode()
for dp in [0,8]:
 req=urllib.request.Request(f'https://fusionbikes.com.ar/wp-json/wc/v3/orders/{ident}?_fields=id,line_items&dp={dp}',headers={'Authorization':auth})
 with urllib.request.urlopen(req,timeout=40) as response:data=json.load(response)
 print(json.dumps({'id':ident,'dp':dp,'items':[{'id':i['id'],'total':i['total']} for i in data['line_items']]}))
