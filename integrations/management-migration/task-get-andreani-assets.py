from pathlib import Path
import hashlib,json,urllib.request,zipfile
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004';d=r/'andreani-assets';d.mkdir(mode=0o750,exist_ok=True)
for name in ['EnvioMasivoExcelPaquetes.xlsx','catalog.json']:
 with urllib.request.urlopen('https://fusionbikes.com.ar/wp-content/plugins/fusion-andreani-masivo/data/'+name,timeout=45) as response:raw=response.read(15*1024*1024+1)
 assert len(raw)<15*1024*1024
 (d/name).write_bytes(raw)
 if name.endswith('.json'):
  data=json.loads(raw);print(json.dumps({'catalog_counts':{k:len(v) for k,v in data.items()}}))
 else:
  with zipfile.ZipFile(d/name) as z:assert z.testzip() is None;print(json.dumps({'template_parts':len(z.namelist())}))
 print(json.dumps({'file':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}))
