from pathlib import Path
import zipfile,hashlib,json,re,subprocess
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
names=['gateway.mjs','assets/facturador.js','assets/management.css','mu-plugins/fusion-management.php','mu-plugins/fusion-arca-vps.php','arca-source.py','arca-transport.test.mjs','gateway.test.mjs','pos-vps.test.mjs']
names=[n for n in names if (r/n).is_file()]
with zipfile.ZipFile(r/'delivery-baseline.zip','w',zipfile.ZIP_DEFLATED) as z:
 for n in names:z.write(r/n,n)
print(json.dumps({'files':{n:hashlib.sha256((r/n).read_bytes()).hexdigest() for n in names}}))
env=Path('/opt/fusionbikes/herramientas/.env')
if env.exists():
 values=dict(re.findall(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$',env.read_text(),re.M))
 print(json.dumps({'smtp_configured':{k:bool(values.get(k,'').strip().strip('"').strip("'")) for k in ['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM']}}))
php="""require '/var/www/html/wp-load.php'; global $wpdb; $s=(array)get_option('fusion_arca_whatsapp',[]); echo json_encode(['whatsapp'=>array_intersect_key($s,array_flip(['enabled','automatic','source','ready'])),'invoices'=>$wpdb->get_results('SELECT environment,status,COUNT(*) count FROM '.$wpdb->prefix.'fusion_arca_invoices GROUP BY environment,status',ARRAY_A),'mail_implementation'=>(new ReflectionFunction('wp_mail'))->getFileName()]);"""
out=subprocess.check_output(['docker','exec','fusion-management-migration-php-1','php','-r',php],text=True,timeout=30);print(out)
