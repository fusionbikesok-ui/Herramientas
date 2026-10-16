from pathlib import Path
import subprocess,json
stage=Path('/opt/fusion-management-migration/arca-production-stage');container='fusion-management-migration-php-1'
for name in ['fiscal-cutover.php','fusion-arca-vps.php','runtime/mu-plugins/fusion-management.php','adapter/woo-mirror.php','adapter/test-plan.php','adapter/test-wordpress.php']:
 r=subprocess.run(['docker','exec','-i',container,'php','-l'],input=(stage/name).read_text(),text=True,capture_output=True);print(name,r.returncode,r.stdout.strip());assert r.returncode==0,r.stderr
subprocess.run(['docker','exec',container,'mkdir','-p','/tmp/arca-adapter'],check=True)
for p in (stage/'adapter').glob('*.php'):subprocess.run(['docker','cp',str(p),container+':/tmp/arca-adapter/'+p.name],check=True)
r=subprocess.run(['docker','exec',container,'php','/tmp/arca-adapter/test-plan.php'],text=True,capture_output=True);print(r.stdout);assert r.returncode==0,r.stderr
subprocess.run(['node','--check',str(stage/'runtime/gateway.mjs')],check=True)
print('stage syntax and pure mirror tests passed')
for name in ['fiscal-cutover.php','fiscal-cutover.test.php']:
 subprocess.run(['docker','cp',str(stage/name),container+':/tmp/'+name],check=True)
r=subprocess.run(['docker','exec',container,'php','/tmp/fiscal-cutover.test.php'],text=True,capture_output=True);print(r.stdout);assert r.returncode==0,r.stderr
