"""Bounded inventory of existing performance telemetry; no configuration changes."""
from pathlib import Path
import subprocess,json,time,os,re,datetime
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
def command(args,timeout=15):
 p=subprocess.run(args,text=True,capture_output=True,timeout=timeout)
 return {'ok':p.returncode==0,'output':p.stdout.strip()[:8000]} # Do not expose stderr/configuration secrets.
def cpu():return list(map(int,Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
a=cpu();time.sleep(1);b=cpu();d=[y-x for x,y in zip(a,b)]
mem={k:int(v.split()[0]) for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())}
result={'at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'VPS only; not store hosting','vcpus':os.cpu_count(),'cpu_busy_percent_1s':round(100*(sum(d)-d[3]-d[4])/max(sum(d),1),1),'cpu_iowait_percent_1s':round(100*d[4]/max(sum(d),1),1),'load_average':list(os.getloadavg()),'memory_available_percent':round(mem['MemAvailable']/mem['MemTotal']*100,1)}
result['containers']=command(['docker','stats','--no-stream','--format','{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'])
nginx_files=[Path('/etc/nginx/nginx.conf')]+list(Path('/etc/nginx/sites-enabled').glob('*'))+list(Path('/etc/nginx/conf.d').glob('*.conf'))
configs=[p.read_text(errors='replace') for p in nginx_files if p.is_file()]
result['nginx_telemetry']={'configured_request_timing':any('$request_time' in x or '$upstream_response_time' in x for x in configs),'management_vhost_found':any('herramientas.fusionbikes.com.ar' in x for x in configs),'access_logs_exist':bool(list(Path('/var/log/nginx').glob('*access*.log')))}
result['sync_timers']=command(['systemctl','list-timers','--all','--no-pager','--output=json'])
if result['sync_timers']['ok']:
 try:
  timers=json.loads(result['sync_timers']['output']);result['sync_timers']=[{'unit':x.get('unit'),'last':x.get('last'),'next':x.get('next')} for x in timers if re.search('fusion.*(directory|metrics|arca|catalog)',str(x.get('unit','')),re.I)]
 except:result['sync_timers']={'available':True}
states=[]
for p in r.glob('*status*.json'):
 try:
  s=json.loads(p.read_text());states.append({'file':p.name,**{k:s[k] for k in ['state','status','started_at','completed_at','requests','full','phase'] if k in s}})
 except:pass
result['existing_sync_status']=states
php="""require '/var/www/html/wp-load.php';global $wpdb;$v=$wpdb->get_results(\"SHOW VARIABLES WHERE Variable_name IN ('version','performance_schema','slow_query_log','long_query_time','log_output')\",ARRAY_A);$s=$wpdb->get_results(\"SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Questions','Slow_queries','Threads_connected','Threads_running','Max_used_connections')\",ARRAY_A);echo json_encode(['variables'=>$v,'status'=>$s]);"""
result['private_vps_fiscal_db']=command(['docker','exec','fusion-management-migration-php-1','php','-r',php],30)
print(json.dumps(result,ensure_ascii=False,indent=2))
