"""Provision only the new private management runtime. No production service is edited."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.request
import zipfile

ROOT=Path('/opt/fusion-management-migration')
os.umask(0o077)
if (ROOT/'.task-owner').read_text()!='fusion-management-migration-20261004':raise RuntimeError('Wrong task directory')
downloads=ROOT/'downloads';downloads.mkdir(exist_ok=True,mode=0o755)
for name in ['mu-plugins','scripts','packages','downloads']:
    folder=ROOT/name
    if not folder.is_dir():raise RuntimeError('Missing source directory: '+name)
    folder.chmod(0o755)
    for item in folder.rglob('*'):
        item.chmod(0o755 if item.is_dir() else 0o644)
woo=downloads/'woocommerce.11.1.2.zip'
if not woo.exists():
    request=urllib.request.Request('https://downloads.wordpress.org/plugin/woocommerce.11.1.2.zip',headers={'User-Agent':'FusionBikes-Migration/1.0'})
    with urllib.request.urlopen(request,timeout=60) as response:
        if response.geturl().split('/')[2]!='downloads.wordpress.org':raise RuntimeError('Unexpected software download origin')
        body=response.read(100_000_001)
        if len(body)>100_000_000:raise RuntimeError('Software archive too large')
    with zipfile.ZipFile(__import__('io').BytesIO(body)) as archive:
        header=archive.read('woocommerce/woocommerce.php').decode()
        if 'Version: 11.1.2' not in header:raise RuntimeError('Unexpected Woo version')
    woo.write_bytes(body);woo.chmod(0o644)

image='fusion-management-migration:20261004'
build=subprocess.run(['docker','build','--pull','--tag',image,str(ROOT)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=600)
(ROOT/'build.log').write_text(build.stdout)
if build.returncode:raise RuntimeError('Image build failed; see task build.log')
mysql_image=subprocess.check_output(['docker','inspect','--format','{{.Image}}','fbpos-test-db'],text=True).strip()
envfile=ROOT/'runtime.env'
if not envfile.exists():
    dbpassword=secrets.token_hex(32)
    values={'MYSQL_DATABASE':'fusion_management','MYSQL_USER':'fusion_management','MYSQL_PASSWORD':dbpassword,
        'MYSQL_ROOT_PASSWORD':secrets.token_hex(32),'WORDPRESS_DB_HOST':'db:3306','WORDPRESS_DB_NAME':'fusion_management',
        'WORDPRESS_DB_USER':'fusion_management','WORDPRESS_DB_PASSWORD':dbpassword,
        'FUSION_MANAGEMENT_MODE':'validation','FUSION_MANAGEMENT_SIGNING_KEY':secrets.token_hex(32),
        'FUSION_MANAGEMENT_URL':'https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps', 'FUSION_MANAGEMENT_PREVIEW_KEY':secrets.token_hex(32)}
    for suffix in ['AUTH_KEY','SECURE_AUTH_KEY','LOGGED_IN_KEY','NONCE_KEY','AUTH_SALT','SECURE_AUTH_SALT','LOGGED_IN_SALT','NONCE_SALT']:
        values['WORDPRESS_'+suffix]=secrets.token_hex(48)
    envfile.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));envfile.chmod(0o600)
logging={'driver':'json-file','options':{'max-size':'5m','max-file':'2'}}
compose={'name':'fusion-management-migration','services':{
    'db':{'image':mysql_image,'pull_policy':'never','env_file':['runtime.env'],
        'command':['--innodb-buffer-pool-size=192M','--max-connections=40'],
        'volumes':['mysql_data:/var/lib/mysql'],'mem_limit':'512m','cpus':0.5,'restart':'unless-stopped','logging':logging,
        'healthcheck':{'test':['CMD-SHELL','mysqladmin ping --silent'],'interval':'5s','timeout':'3s','retries':24}},
    'php':{'image':image,'pull_policy':'never','env_file':['runtime.env'],
        'environment':{'WORDPRESS_CONFIG_EXTRA':"define('DISABLE_WP_CRON',true); define('DISALLOW_FILE_MODS',true); define('WP_HTTP_BLOCK_EXTERNAL',true); define('AUTOMATIC_UPDATER_DISABLED',true); define('WP_HOME',getenv('FUSION_MANAGEMENT_URL')); define('WP_SITEURL',getenv('FUSION_MANAGEMENT_URL')); define('WP_ENVIRONMENT_TYPE','staging');"},
        'volumes':['wp_data:/var/www/html','./mu-plugins:/var/www/html/wp-content/mu-plugins:ro','./scripts:/opt/fusion-scripts:ro','./packages:/opt/fusion-packages:ro','./downloads:/opt/fusion-downloads:ro'],
        'mem_limit':'512m','cpus':0.75,'restart':'unless-stopped','logging':logging,
        'depends_on':{'db':{'condition':'service_healthy'}},
        'healthcheck':{'test':['CMD-SHELL','test -f /var/www/html/wp-config.php && php -r \'exit(extension_loaded("soap") ? 0 : 1);\''],'interval':'5s','timeout':'3s','retries':24}}},
    'volumes':{'mysql_data':{},'wp_data':{}},'networks':{'default':{'internal':True}}}
(ROOT/'compose.json').write_text(json.dumps(compose,indent=2))
base=['docker','compose','--env-file',str(envfile),'-f',str(ROOT/'compose.json'),'-p','fusion-management-migration']
subprocess.run(base+['up','-d','--wait'],check=True,capture_output=True,timeout=150)
print(json.dumps({'root':str(ROOT),'image':image,'mysql_image':mysql_image,'network_internal':True,'published_ports':[],
    'woocommerce_archive_sha256':hashlib.sha256(woo.read_bytes()).hexdigest(),'mode':'validation','production_changed':False}))
