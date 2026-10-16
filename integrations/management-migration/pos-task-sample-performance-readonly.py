"""Thirty-second passive sample; no load generation or service changes."""
from pathlib import Path
import os,time,json,statistics,datetime,collections
def snapshot():
 cpu=list(map(int,Path('/proc/stat').read_text().splitlines()[0].split()[1:9]));processes={}
 for p in Path('/proc').iterdir():
  if not p.name.isdigit():continue
  try:
   s=(p/'stat').read_text();end=s.rfind(')');rest=s[end+2:].split();processes[p.name]=(s[s.find('(')+1:end],int(rest[11])+int(rest[12]),rest[19])
  except (OSError,ValueError,IndexError):pass
 return cpu,processes
first,procs=snapshot();prev=first;rows=[];start=time.monotonic()
for _ in range(30):
 time.sleep(1);current=list(map(int,Path('/proc/stat').read_text().splitlines()[0].split()[1:9]));d=[y-x for x,y in zip(prev,current)];total=max(sum(d),1);prev=current
 rows.append({'busy':100*(sum(d)-d[3]-d[4]-d[7])/total,'steal':100*d[7]/total,'iowait':100*d[4]/total})
last,after=snapshot();elapsed=time.monotonic()-start;by_name=collections.Counter();hz=os.sysconf('SC_CLK_TCK');cores=os.cpu_count()
for pid,(name,ticks,identity) in after.items():
 if pid in procs and procs[pid][2]==identity:by_name[name]+=max(0,ticks-procs[pid][1])/hz/elapsed/cores*100
print(json.dumps({'at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'VPS; passive short sample, not store hosting or peak-capacity test','seconds':round(elapsed,1),'cpu_busy_avg_percent':round(statistics.mean(x['busy'] for x in rows),1),'cpu_busy_median_percent':round(statistics.median(x['busy'] for x in rows),1),'cpu_busy_max_1s_percent':round(max(x['busy'] for x in rows),1),'cpu_steal_avg_percent':round(statistics.mean(x['steal'] for x in rows),1),'iowait_avg_percent':round(statistics.mean(x['iowait'] for x in rows),2),'persistent_process_groups_percent_total_cpu':{k:round(v,1) for k,v in by_name.most_common(6)}},indent=2))
