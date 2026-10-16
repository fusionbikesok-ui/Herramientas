from pathlib import Path
import datetime,hashlib,json,os,secrets,shutil,subprocess
root=Path('/opt/fusion-management-migration');private=Path('/etc/fusion-arca-private');os.umask(0o077)
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
stage=root/'arca-connection-stage';assert stage.is_dir()
backup=root/'backups'/('arca-connection-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
info=json.loads(subprocess.check_output(['docker','inspect','fusion-management-migration-php-1']))[0]
old_ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
volume=Path(next(m['Source'] for m in info['Mounts'] if m['Destination']=='/var/www/html'))
client=volume/'wp-content/plugins/fusion-facturacion-arca/includes/class-client.php'
before=client.read_bytes();(backup/'class-client.php').write_bytes(before);shutil.copy2(root/'compose.json',backup/'compose.json')
code=before.decode();old="return new \\SoapClient($url, ['exceptions'=>true, 'trace'=>false, 'connection_timeout'=>15, 'cache_wsdl'=>WSDL_CACHE_MEMORY,\n            'stream_context'=>$this->soap_context($url)]);"
new="return new \\SoapClient($url, apply_filters('fusion_arca_soap_options', ['exceptions'=>true, 'trace'=>false, 'connection_timeout'=>15, 'cache_wsdl'=>WSDL_CACHE_MEMORY,\n            'stream_context'=>$this->soap_context($url)], $url));"
assert old in code,'SOAP client baseline differs';code=code.replace(old,new,1)
network=json.loads(subprocess.check_output(['docker','network','inspect','fusion-management-migration_default']))[0]
bind=network['IPAM']['Config'][0]['Gateway'];assert bind=='172.16.6.1'
password=secrets.token_hex(32)
private.chmod(0o750);os.chown(private,0,33)
for name in ['produccion.crt','produccion.key']:
 os.chown(private/name,0,33);(private/name).chmod(0o440)
(private/'proxy.json').write_text(json.dumps({'host':bind,'password':password}));os.chown(private/'proxy.json',0,33);(private/'proxy.json').chmod(0o440)
(private/'proxy.env').write_text('ARCA_PROXY_BIND='+bind+'\nARCA_PROXY_PASSWORD='+password+'\n');(private/'proxy.env').chmod(0o600)
target=Path('/opt/fusion-arca-egress');target.mkdir(mode=0o755,exist_ok=True)
shutil.copy2(stage/'arca-egress.py',target/'arca-egress.py');(target/'arca-egress.py').chmod(0o644)
unit=Path('/etc/systemd/system/fusion-arca-egress.service');assert not unit.exists(),'Existing proxy unit'
unit.write_text('''[Unit]
Description=Restricted HTTPS access to ARCA for Fusion invoicing
After=docker.service network-online.target
Requires=docker.service
[Service]
DynamicUser=yes
EnvironmentFile=/etc/fusion-arca-private/proxy.env
ExecStart=/usr/bin/python3 /opt/fusion-arca-egress/arca-egress.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=64M
TasksMax=40
UMask=0077
[Install]
WantedBy=multi-user.target
''');unit.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','fusion-arca-egress.service'],check=True,capture_output=True)
client.write_text(code);client.chmod(0o644)
mu=root/'mu-plugins/fusion-arca-credentials.php';assert not mu.exists();shutil.copy2(stage/'fusion-arca-credentials.php',mu);mu.chmod(0o644)
compose=json.loads((root/'compose.json').read_text());mount='/etc/fusion-arca-private:/opt/fusion-arca-private:ro';assert mount not in compose['services']['php']['volumes'];compose['services']['php']['volumes'].append(mount)
(root/'compose.json').write_text(json.dumps(compose,indent=2)+'\n')
cmd=['docker','compose','--env-file',str(root/'runtime.env'),'-f',str(root/'compose.json'),'-p','fusion-management-migration','up','-d','--no-deps','--wait','php']
result=subprocess.run(cmd,capture_output=True,text=True,timeout=90)
if result.returncode:raise RuntimeError('PHP recreation failed; use connection backup')
newinfo=json.loads(subprocess.check_output(['docker','inspect','fusion-management-migration-php-1']))[0];ip=next(iter(newinfo['NetworkSettings']['Networks'].values()))['IPAddress'];assert ip==old_ip,'Gateway upstream IP changed'
php="""<?php require '/var/www/html/wp-load.php';
$s=\\FusionBikes\\ARCA\\Plugin::settings();$cert=openssl_x509_read(file_get_contents(FUSION_ARCA_CERT_PROD));$fingerprint=openssl_x509_fingerprint($cert);
$ta=json_decode(file_get_contents('/opt/fusion-arca-private/ta-wsfe.json'),true);$cache='fusion_arca_ta_'.md5('production|'.$s['cuit'].'|'.$fingerprint);
if($ta['expires_at']>time()+120)set_transient($cache,['Token'=>$ta['Token'],'Sign'=>$ta['Sign']],(int)$ta['expires_at']-time()-120);
echo json_encode(['ticket_cache_imported'=>true,'production_enabled'=>$s['production_enabled']]);"""
r=subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php'],input=php,text=True,capture_output=True,timeout=30);assert r.returncode==0,'Credential cache setup failed';print(r.stdout)
print(json.dumps({'installed':True,'backup':str(backup),'private_credentials':str(private),'outbound_hosts':['wsaa.afip.gov.ar','servicios1.afip.gov.ar','aws.afip.gov.ar'],'docker_network_internal':True,'php_ip_preserved':True}))
(root/'arca-connection-release.json').write_text(json.dumps({'backup':str(backup),'client_before':hashlib.sha256(before).hexdigest(),'client_after':hashlib.sha256(client.read_bytes()).hexdigest(),'point':15},indent=2)+'\n')
