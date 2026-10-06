from pathlib import Path
import json,sqlite3,subprocess
root=Path('/opt/fusion-management-migration');cache=root/'directory-cache'
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
print((cache/'status.json').read_text())
db=sqlite3.connect(f'file:{cache}/directory.sqlite?mode=ro',uri=True)
state={k:json.loads(v) for k,v in db.execute('SELECT key,value FROM state')}
print(json.dumps({'state':state,'counts':{t:db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in ['customers','orders','guests']},'earliest_order':db.execute('SELECT MIN(created_at) FROM orders').fetchone()[0],'mirror_orders':db.execute("SELECT COUNT(*) FROM orders WHERE json_extract(data,'$.is_ml_mirror')=1").fetchone()[0],'customer_documents':db.execute("SELECT COUNT(*) FROM customers WHERE json_extract(data,'$.document')<>''").fetchone()[0]}))
db.close()
print(subprocess.run(['systemctl','show','fusion-management-validation.service','-p','ActiveState','-p','SupplementaryGroups'],capture_output=True,text=True,check=True).stdout)
print(subprocess.run(['systemctl','show','fusion-management-directory-sync.timer','-p','ActiveState','-p','NextElapseUSecMonotonic'],capture_output=True,text=True,check=True).stdout)
