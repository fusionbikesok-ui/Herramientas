import json,subprocess,datetime,urllib.request,urllib.error,hashlib
from pathlib import Path
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
subprocess.run(['node','--test',str(r/'gateway.test.mjs')],check=True,timeout=30)
subprocess.run(['docker','exec','fusion-management-migration-php-1','php','-l','/var/www/html/wp-content/mu-plugins/fusion-management.php'],check=True,capture_output=True)
config=Path('/etc/nginx/sites-available/herramientas');before=config.read_text()
assert before.count('    location /herramientas/ {')==1
marker='    # Fusion management validation gateway (2026-10-04)'
block='''    # Fusion management validation gateway (2026-10-04)
    location = /herramientas/gestion-vps { return 302 /herramientas/gestion-vps/; }
    location ^~ /herramientas/gestion-vps/ {
        proxy_pass http://127.0.0.1:8212;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Fusion-Claim "";
        proxy_set_header X-Fusion-Signature "";
        proxy_hide_header Set-Cookie;
        proxy_read_timeout 30s;
    }

'''
backup=r/'backups'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup.mkdir(parents=True,mode=0o700)
(backup/'herramientas.nginx.conf').write_text(before)
if marker not in before:
    config.write_text(before.replace('    location /herramientas/ {',block+'    location /herramientas/ {',1))
try:
    subprocess.run(['nginx','-t'],check=True,capture_output=True)
    subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
except BaseException:
    config.write_text(before);subprocess.run(['nginx','-t'],check=True,capture_output=True);subprocess.run(['systemctl','reload','nginx'],check=True);raise
print(json.dumps({'entry':'https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/','nginx_backup':str(backup),'admin_only':True,'read_only':True,'main_app_restarted':False,'nginx_sha256':hashlib.sha256(config.read_bytes()).hexdigest()}))
