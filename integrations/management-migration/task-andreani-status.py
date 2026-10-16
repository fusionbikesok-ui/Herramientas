from pathlib import Path
import sqlite3,json,subprocess
r=Path('/opt/fusion-management-migration')
for name in ['directory','metrics']:
 c=sqlite3.connect(f'file:{r}/directory-cache/{name}.sqlite?mode=ro',uri=True)
 state={k:json.loads(v) for k,v in c.execute('SELECT key,value FROM state')}
 print(json.dumps({'cache':name,**{k:state.get(k) for k in ['orders_at','completed_at','orders_complete','shipping_fields_version','orders','lines']},'option_keys':list(state.get('options',{}))}))
 if name=='metrics':print(json.dumps({'products':c.execute('SELECT COUNT(*) FROM products').fetchone()[0],'missing_virtual':c.execute("SELECT COUNT(*) FROM products WHERE json_extract(data,'$.exists')=1 AND json_type(data,'$.virtual') IS NULL").fetchone()[0]}))
 c.close()
for name in ['directory','metrics']:
 p=subprocess.run(['systemctl','show',f'fusion-management-{name}-sync.service','--property=ActiveState,SubState,Result'],capture_output=True,text=True)
 print(name,p.stdout.strip())
