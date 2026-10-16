from pathlib import Path
import hashlib,json,os,urllib.request
root=Path('/opt/fusion-management-migration');repo=Path('/opt/fusionbikes/herramientas')
result=json.loads((root/'home-navigation/result.json').read_text())
home=repo/'public/home/index.html'
assert hashlib.sha256(home.read_bytes()).hexdigest()==result['candidate_sha256']
os.utime(home,None)
request=urllib.request.Request('http://127.0.0.1:3001/home/',headers={'If-Modified-Since':'Thu, 24 Sep 2026 14:00:02 GMT'})
with urllib.request.urlopen(request,timeout=10) as r:
    assert r.status==200 and r.read()==home.read_bytes()
    print(json.dumps({'conditional_status':r.status,'last_modified':r.headers.get('Last-Modified')}))
p=repo/'docs/memory/modules/operations-vps.md';s=p.read_text()
s=s.replace('Publicación estática sin reinicio ni migraciones.','Publicación estática sin reinicio ni migraciones; conservar permisos pero actualizar mtime al publicar HTML para que If-Modified-Since reciba la versión nueva.')
p.write_text(s)
