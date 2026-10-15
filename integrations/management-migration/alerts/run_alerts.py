"""Private scheduler: local settings/report -> existing WhatsApp runtime."""
from pathlib import Path
from datetime import datetime,timezone
import base64,json,subprocess,sys,os,fcntl,re,stat
from stock_alerts import validate_config,scheduled

ROOT=Path(__file__).resolve().parent
STATE=Path('/var/lib/fusion-management-validation')

def config_from_settings(base,value):
    if not isinstance(value,dict) or value.get('schema')!=1 or type(value.get('revision')) is not int or value['revision']<1:
        raise ValueError('invalid_alert_settings')
    if type(value.get('enabled')) is not bool or not isinstance(value.get('time'),str) or not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d',value['time']):
        raise ValueError('invalid_alert_settings')
    recipients=value.get('recipients')
    if not isinstance(recipients,list) or len(recipients)!=2:raise ValueError('invalid_recipients')
    clean=[]
    for i,r in enumerate(recipients):
        if not isinstance(r,dict) or r.get('id')!='operator'+str(i+1) or type(r.get('enabled')) is not bool:raise ValueError('invalid_recipient')
        clean.append({k:r.get(k) for k in ['name','phone','enabled']})
    hour,minute=map(int,value['time'].split(':'))
    cfg=dict(base,enabled=value['enabled'],hour=hour,minute=minute,recipients=clean)
    return validate_config(cfg)

def read_editable(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'r') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):raise ValueError('invalid_alert_settings_file')
        text=f.read(8193)
        if len(text)>8192:raise ValueError('alert_settings_too_large')
        return json.loads(text)

def save_status(result):
    result=dict(result,checked_at=datetime.now(timezone.utc).isoformat())
    temp=ROOT/'status.tmp';temp.write_text(json.dumps(result,ensure_ascii=False));os.chmod(temp,0o600);os.replace(temp,ROOT/'status.json')
    public={k:result[k] for k in ['state','reason','checked_at'] if k in result}
    if any(r.get('state') in {'failed','unknown','unknown_requires_review'} for r in result.get('recipients',[])):
        public.update(state='delivery_problem',reason='review_delivery')
    temp=STATE/'stock-alert-status.tmp';temp.write_text(json.dumps(public));os.chmod(temp,0o644);os.replace(temp,STATE/'stock-alert-status.json')

def execute(dry_run=False):
    with open(ROOT/'run.lock','a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'state':'already_running'}
        return execute_locked(dry_run)

def execute_locked(dry_run=False):
    cfg=config_from_settings(json.loads((ROOT/'alert_config.json').read_text()),read_editable(STATE/'stock-alert-settings.json'))
    if not dry_run:
        if not cfg['enabled']:return {'state':'disabled'}
        if not any(r['enabled'] for r in cfg['recipients']):return {'state':'no_recipients'}
        if not scheduled(datetime.now(timezone.utc),cfg):return {'state':'outside_schedule'}
    report=subprocess.run(['/usr/bin/node',str(ROOT/'report-snapshot.mjs')],capture_output=True,timeout=60)
    if report.returncode or len(report.stdout)>24*1024*1024:raise RuntimeError('local_report_unavailable')
    data=json.loads(report.stdout)
    payload=base64.b64encode(json.dumps({'report':data,'config':cfg,'dry_run':dry_run},ensure_ascii=False).encode()).decode()
    script=(ROOT/'stock_alerts.py').read_text()+'\nimport base64\n_input=json.loads(base64.b64decode('+repr(payload)+'))\ntry:\n print(json.dumps(run(_input["report"],_input["config"],dry_run=_input["dry_run"]),ensure_ascii=False))\nexcept Exception as _e:\n print(json.dumps({"state":"blocked","reason":str(_e) if isinstance(_e,ValueError) and re.fullmatch(r"[a-z0-9_]{1,100}",str(_e)) else type(_e).__name__}))\n'
    proc=subprocess.run(['docker','exec','-i','fusion-chatbot-api-1','python','-'],input=script.encode(),capture_output=True,timeout=160)
    if proc.returncode:raise RuntimeError('notification_runtime_failed')
    return dict(json.loads(proc.stdout),checked_at=datetime.now(timezone.utc).isoformat())

if __name__=='__main__':
    dry=sys.argv[1:]==['--dry-run']
    if sys.argv[1:] and not dry:raise SystemExit('Only --dry-run is supported')
    try:result=execute(dry)
    except Exception as e:result={'state':'blocked','reason':str(e) if isinstance(e,(RuntimeError,ValueError)) and re.fullmatch(r'[a-z0-9_]{1,100}',str(e)) else type(e).__name__}
    if not dry and result['state'] not in {'outside_schedule','disabled','no_recipients','already_running'}:
        try:save_status(result)
        except Exception:result=dict(result,status_storage_error=True)
    if dry or result['state'] not in {'outside_schedule','disabled','no_recipients'}:print(json.dumps(result,ensure_ascii=False))
    if result.get('state') in {'blocked','number_disconnected','template_pending_or_unavailable'} or any(r.get('state') in {'failed','unknown','unknown_requires_review'} for r in result.get('recipients',[])):raise SystemExit(1)
