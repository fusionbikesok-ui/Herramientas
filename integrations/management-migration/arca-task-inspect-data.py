from pathlib import Path
import sqlite3,json,os
for name in ['/opt/fusionbikes/herramientas/data/fusion.sqlite','/opt/fusion-management-migration/directory-cache/metrics.sqlite']:
 p=Path(name)
 if not p.exists():continue
 print(name,oct(p.stat().st_mode & 0o777),p.stat().st_gid)
 c=sqlite3.connect('file:'+name+'?mode=ro',uri=True)
 for table in ['catalogo_cache','products']:
  if c.execute('SELECT 1 FROM sqlite_master WHERE name=?',(table,)).fetchone():
   print(table,[r[1] for r in c.execute('PRAGMA table_info('+table+')')])
   if table=='products':
    r=c.execute('SELECT data FROM products WHERE id=70393').fetchone()
    if r:print('product_data_keys',list(json.loads(r[0])))
 c.close()
