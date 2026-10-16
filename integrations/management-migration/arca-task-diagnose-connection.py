import subprocess,json
code='''<?php require '/var/www/html/wp-load.php';
$p=json_decode(file_get_contents('/opt/fusion-arca-private/proxy.json'),true);
$s=@stream_socket_client('tcp://'.$p['host'].':8215',$errno,$errstr,5);
echo json_encode(['tcp'=>(bool)$s,'errno'=>$errno,'error'=>$errstr])."\\n";if($s)fclose($s);
$url='https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';
$opts=apply_filters('fusion_arca_soap_options',['exceptions'=>true,'trace'=>false,'connection_timeout'=>15,'cache_wsdl'=>WSDL_CACHE_NONE,'stream_context'=>stream_context_create(['ssl'=>['verify_peer'=>true,'verify_peer_name'=>true,'ciphers'=>'DEFAULT:!DH']])],$url);
try{new SoapClient($url,$opts);echo 'WSDL OK';}catch(Throwable $e){echo $e->getMessage();}
'''
r=subprocess.run(['docker','exec','-i','-u','www-data','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=50)
print(r.stdout)
print(subprocess.check_output(['systemctl','is-active','fusion-arca-egress.service'],text=True).strip())
