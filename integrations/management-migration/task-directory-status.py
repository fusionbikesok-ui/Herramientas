from pathlib import Path
import json,sqlite3,subprocess
root=Path('/opt/fusion-management-migration/directory-cache')
if (root/'status.json').exists():print((root/'status.json').read_text())
print(subprocess.run(['systemctl','show','fusion-management-directory-sync.service','-p','ActiveState','-p','Result'],capture_output=True,text=True,check=True).stdout)
if (root/'directory.sqlite').exists():
 db=sqlite3.connect(f'file:{root}/directory.sqlite?mode=ro',uri=True)
 print(json.dumps({'orders':db.execute('SELECT COUNT(*) FROM orders').fetchone()[0],'customers':db.execute('SELECT COUNT(*) FROM customers').fetchone()[0],'guests':db.execute('SELECT COUNT(*) FROM guests').fetchone()[0],'earliest':db.execute('SELECT MIN(created_at) FROM orders').fetchone()[0],'quick_check':db.execute('PRAGMA quick_check').fetchone()[0]}));db.close()
