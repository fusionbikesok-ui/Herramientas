from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess
root=Path('/opt/fusion-management-migration');stage=root/'arca-production-stage';private=Path('/etc/fusion-arca-private')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
os.umask(0o077);stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup=root/'backups'/('arca-operational-'+stamp);backup.mkdir(mode=0o700)
baseline=json.loads((stage/'runtime-baseline.json').read_text())
names=['gateway.mjs','mu-plugins/fusion-management.php','assets/facturador.js']
for name in names:
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==baseline[name], 'Runtime changed: '+name
 p=backup/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,p)
env=subprocess.run(['node','--input-type=module','-e',"process.loadEnvFile('/opt/fusionbikes/herramientas/.env');if(new URL(process.env.WOO_URL).hostname!=='fusionbikes.com.ar')throw Error('origin');process.stdout.write(Buffer.from(process.env.WOO_CK+':'+process.env.WOO_CS).toString('base64'))"],capture_output=True,text=True)
assert env.returncode==0 and env.stdout,'Woo bridge configuration unavailable'
(private/'source.env').write_text('ARCA_WOO_AUTH='+env.stdout+'\n'+(private/'proxy.env').read_text());(private/'source.env').chmod(0o600)
dest=Path('/opt/fusion-arca-egress');dest.chmod(0o755);shutil.copy2(stage/'arca-source.py',dest/'arca-source.py');(dest/'arca-source.py').chmod(0o644)
unit=Path('/etc/systemd/system/fusion-arca-source.service');assert not unit.exists(),'Source helper already installed'
unit.write_text('''[Unit]
Description=Private Woo fiscal bridge for Fusion ARCA
After=docker.service network-online.target
Requires=docker.service
[Service]
DynamicUser=yes
EnvironmentFile=/etc/fusion-arca-private/source.env
ExecStart=/usr/bin/python3 /opt/fusion-arca-egress/arca-source.py
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=128M
TasksMax=40
UMask=0077
[Install]
WantedBy=multi-user.target
''');unit.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','fusion-arca-source.service'],capture_output=True,check=True)
adapter=root/'mu-plugins/arca-adapter';adapter.mkdir(mode=0o755,exist_ok=True);adapter.chmod(0o755)
shutil.copy2(stage/'adapter/woo-mirror.php',adapter/'woo-mirror.php');(adapter/'woo-mirror.php').chmod(0o644)
shutil.copy2(stage/'fusion-arca-vps.php',root/'mu-plugins/fusion-arca-vps.php');(root/'mu-plugins/fusion-arca-vps.php').chmod(0o644)
settings=json.loads((private/'source-settings.json').read_text());assert '@' in settings['email'] and '<redacted>' not in json.dumps(settings),'Incomplete fiscal settings';settings['production_enabled']=False;settings['auto_enabled']=False;settings['auto_statuses']=[];settings['bicycle_categories']=','.join(settings['bicycle_categories']) if isinstance(settings['bicycle_categories'],list) else settings['bicycle_categories'];settings['point']=int(settings['point'])
(private/'settings-stage.json').write_text(json.dumps(settings));os.chown(private/'settings-stage.json',0,33);(private/'settings-stage.json').chmod(0o440)
php="""<?php require '/var/www/html/wp-load.php';$old=get_option('fusion_arca_settings');file_put_contents('/tmp/arca-old-settings.json',json_encode($old));$s=json_decode(file_get_contents('/opt/fusion-arca-private/settings-stage.json'),true);update_option('fusion_arca_settings',$s,false);update_option('fusion_arca_vps_enabled',false,false);update_option('woocommerce_custom_orders_table_enabled','no');update_option('woocommerce_custom_orders_table_data_sync_enabled','no');echo json_encode(['production_enabled'=>\\FusionBikes\\ARCA\\Plugin::settings()['production_enabled'],'point'=>\\FusionBikes\\ARCA\\Plugin::settings()['point']]);"""
r=subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php'],input=php,text=True,capture_output=True);assert r.returncode==0,'WP preparation failed';print(r.stdout)
subprocess.run(['docker','cp','fusion-management-migration-php-1:/tmp/arca-old-settings.json',str(backup/'settings.json')],capture_output=True,check=True)
for name in names:
 temp=root/(name+'.arca-new');temp.write_bytes((stage/'runtime'/name).read_bytes());temp.chmod(0o644);temp.replace(root/name)
subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True)
result={'prepared':True,'emission_enabled':False,'backup':str(backup),'changed':names+['mu-plugins/fusion-arca-vps.php','mu-plugins/arca-adapter/woo-mirror.php']}
(root/'arca-operational-release.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
