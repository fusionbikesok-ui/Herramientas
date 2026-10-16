from pathlib import Path
import json,sqlite3,subprocess
r=Path('/opt/fusion-management-migration');p=r/'directory-cache/metrics-status.json'
print(p.read_text() if p.exists() else 'no_status')
print(subprocess.run(['systemctl','show','fusion-management-metrics-sync.service','--property=ActiveState,SubState,ExecMainStatus'],capture_output=True,text=True).stdout)
p=r/'directory-cache/metrics.sqlite'
if p.exists():
 d=sqlite3.connect(f'file:{p}?mode=ro',uri=True);s={k:json.loads(v) for k,v in d.execute('SELECT key,value FROM state')};o=s.pop('options');print(json.dumps(s));print(json.dumps({'bikes':[c for c in o['categories'] if 'BICICLET' in c['name'].upper()],'refund_months':d.execute("SELECT substr(date,1,7),COUNT(*) FROM facts WHERE id IN (SELECT id FROM refunds) GROUP BY substr(date,1,7) ORDER BY 1 DESC LIMIT 8").fetchall()}));d.close()
