import subprocess,json
code='''<?php require '/var/www/html/wp-load.php';
$out=[];$p=\\FusionBikes\\ARCA\\Plugin::boot();
foreach(['wsfe','padron'] as $service){try{$r=new WP_REST_Request('POST');$r->set_header('Content-Type','application/json');$r->set_body(json_encode(['service'=>$service]));$result=$p->connection($r);$out[$service]=['connected'=>true,'point_ready'=>$result['point_ready']??null,'expires'=>$result['expires']??null];}catch(Throwable $e){$out[$service]=['connected'=>false,'error'=>$e->getMessage()];}}
echo json_encode($out,JSON_UNESCAPED_UNICODE);'''
r=subprocess.run(['docker','exec','-i','-u','www-data','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=100)
assert r.returncode==0,'Connection probe failed'
print(r.stdout)
if r.stderr:print('PHP diagnostics present (no raw SOAP output retained)')
