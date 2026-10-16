from pathlib import Path
import hashlib,json,subprocess
r=Path('/opt/fusion-management-migration');release=r/'return-web-release.json';out=json.loads(release.read_text());assert out['phase']=='vps_stopped';b=Path(out['backup'])
source=json.loads((b/'source-final.json').read_text())
read=r'''<?php require '/var/www/html/wp-load.php';global $wpdb;$out=[];foreach(['invoices','series','ml_sales','whatsapp'] as $n){$out['arca_'.$n]=$wpdb->get_results('SELECT * FROM '.$wpdb->prefix.'fusion_arca_'.$n,ARRAY_A);if($wpdb->last_error)throw new RuntimeException('Unable to read '.$n);}echo wp_json_encode($out);'''
x=subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php'],input=read,text=True,capture_output=True,timeout=60);assert x.returncode==0,x.stderr[-1000:];local=json.loads(x.stdout);(b/'vps-final.json').write_text(json.dumps(local,ensure_ascii=False))
def canonical(value):
 if isinstance(value,str):
  try:return json.loads(value)
  except ValueError:return value
 return value
def canonrow(row,ignore_actor=False):
 return {k:canonical(v) for k,v in row.items() if not(ignore_actor and k=='created_by')}
diff=[];counts={}
for name in source:
 a=source[name];v=local[name];counts[name]={'web':len(a),'vps':len(v)}
 print('Columns',name,sorted(a[0]) if a else [], sorted(v[0]) if v else [])
 if name in ['arca_series','arca_whatsapp']:
  aa=sorted(json.dumps(canonrow(x),sort_keys=True,ensure_ascii=False) for x in a);vv=sorted(json.dumps(canonrow(x),sort_keys=True,ensure_ascii=False) for x in v)
  if aa!=vv:diff.append([name,'row-set-difference'])
  continue
 aa={str(x['id']):x for x in a};vv={str(x['id']):x for x in v}
 for i in sorted(set(aa)|set(vv)):
  if i not in aa or i not in vv:diff.append([name,i,'missing']);continue
  for k in set(aa[i])|set(vv[i]):
   if name=='arca_invoices' and k=='created_by' and int(i)>172:continue
   if canonical(aa[i].get(k))!=canonical(vv[i].get(k)):diff.append([name,i,k])
out.update({'counts':counts,'differences':diff});release.write_text(json.dumps(out,indent=2));print('Comparison',json.dumps({'counts':counts,'differences':diff,'pos':out['pos']}));assert not diff,'History differs'
code=r'''<?php require '/var/www/html/wp-load.php';global $wpdb;$s=\FusionBikes\ARCA\Plugin::settings();if(get_option('fusion_arca_vps_enabled')||$s['production_enabled'])throw new RuntimeException('VPS still active');$c=new \FusionBikes\ARCA\Client('production',$s['cuit']);$out=[];
foreach([15,16] as $point)foreach([1=>'A',6=>'B',3=>'NC_A',8=>'NC_B'] as $type=>$label){$reply=$c->call('FECompUltimoAutorizado',['PtoVta'=>$point,'CbteTipo'=>$type]);$n=\FusionBikes\ARCA\Diagnostics::last_number($reply,$point,$type);$scope=hash('sha256','production|'.$s['cuit'].'|'.$point.'|'.$type);$local=(int)$wpdb->get_var($wpdb->prepare("SELECT COALESCE(MAX(number),0) FROM ".\FusionBikes\ARCA\Plugin::table()." WHERE environment='production' AND status='authorized' AND scope=%s",$scope));$out[$point][$label]=['arca'=>$n,'history'=>$local];if($n!==$local)throw new RuntimeException('Number mismatch '.$point.' '.$label);}
echo wp_json_encode($out);'''
x=subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php'],input=code,text=True,capture_output=True,timeout=120);assert x.returncode==0,x.stderr[-1500:];out['numbering']=json.loads(x.stdout)
out['phase']='reconciled_web_still_disabled';out['fiscal_sha256']=hashlib.sha256((b/'source-final.json').read_bytes()).hexdigest();release.write_text(json.dumps(out,indent=2))
subprocess.run(['systemctl','disable','--now','fusion-arca-outbox.timer'],check=True,capture_output=True)
print('READY_FOR_WEB',json.dumps(out))
