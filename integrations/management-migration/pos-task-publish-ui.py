from pathlib import Path
import subprocess,shutil,os,json
r=Path('/opt/fusion-management-migration');s=r/'pos-stage-v2';b=r/'backups/pos-ui-20261006';b.mkdir(exist_ok=True,mode=0o700)
for name in ['pos.js','catalog-ui.js']:
 src=s/'assets'/name;target=r/'assets'/name
 subprocess.run(['node','--check',str(src)],check=True)
 if not (b/name).exists():shutil.copy2(target,b/name)
 temp=target.with_suffix('.next');shutil.copy2(src,temp);os.replace(temp,target)
subprocess.run(['docker','exec','fusion-management-migration-php-1','php','-r',"require '/var/www/html/wp-load.php'; echo json_encode(['pos_enabled'=>(bool)get_option('fusion_pos_vps_enabled'), 'arca_enabled'=>(bool)get_option('fusion_arca_vps_enabled'),'arca_production'=>(bool)\\FusionBikes\\ARCA\\Plugin::settings()['production_enabled']]);"],check=True,timeout=30)
print(json.dumps({'ui_updated':True,'service_restarted':False}))
