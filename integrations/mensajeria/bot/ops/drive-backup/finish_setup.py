"""Run on the VPS after OAuth; output contains only non-secret setup metadata."""
from pathlib import Path
import argparse,configparser,json,os,re,subprocess
import backup

NAME='VPS automático'
SETUP=backup.STATE/'drive-folder.json'

def configuration():
    p=backup.CONFIG
    if not p.exists() or p.stat().st_mode & 0o077:raise RuntimeError('missing_or_unprotected_configuration')
    cfg=configparser.ConfigParser(interpolation=None);cfg.read(p)
    if cfg['fusiondrive'].get('scope')!='drive.file':raise RuntimeError('unexpected_scope')
    token=json.loads(cfg['fusiondrive'].get('token','{}'))
    if not token.get('refresh_token'):raise RuntimeError('offline_token_missing')
    return cfg

def create_folder():
    cfg=configuration()
    if cfg['fusiondrive'].get('root_folder_id'):
        existing=backup.read_json(SETUP,{})
        if existing.get('id')!=cfg['fusiondrive']['root_folder_id']:raise RuntimeError('unexpected_root')
        return existing
    backup.rclone('mkdir',backup.REMOTE+NAME,timeout=120)
    values=json.loads(backup.rclone('lsjson',backup.REMOTE,'--dirs-only','--max-depth','1',timeout=120))
    matches=[v for v in values if v.get('IsDir') and v.get('Name')==NAME]
    if len(matches)!=1 or not re.fullmatch(r'[A-Za-z0-9_-]+',matches[0].get('ID','')):raise RuntimeError('ambiguous_folder')
    result={'id':matches[0]['ID'],'name':NAME,'scope':'drive.file'}
    backup.atomic_json(SETUP,result)
    return result

def set_root(folder):
    cfg=configuration();saved=backup.read_json(SETUP,{})
    if saved.get('id')!=folder or not re.fullmatch(r'[A-Za-z0-9_-]+',folder):raise RuntimeError('folder_not_created_by_this_app')
    current=cfg['fusiondrive'].get('root_folder_id')
    if current and current!=folder:raise RuntimeError('different_root_already_set')
    cfg['fusiondrive']['root_folder_id']=folder
    tmp=backup.CONFIG.with_suffix('.new')
    with tmp.open('w') as f:cfg.write(f);f.flush();os.fsync(f.fileno())
    os.chmod(tmp,0o600);os.replace(tmp,backup.CONFIG)
    # This read verifies the app still has access after the connector moves its folder.
    values=json.loads(backup.rclone('lsjson',backup.REMOTE,'--max-depth','1',timeout=120))
    return {'root_folder_id':folder,'read_verified':True,'entries':len(values),'scope':'drive.file'}

def activate():
    cfg=configuration();status=backup.read_json(backup.STATE/'status.json',{})
    if not cfg['fusiondrive'].get('root_folder_id'):raise RuntimeError('root_not_set')
    if not status.get('upload_verified') or not status.get('restore_tested'):raise RuntimeError('backup_and_restore_not_verified')
    units=['fusion-mensajeria-drive.service','fusion-mensajeria-drive.timer']
    for unit in units:
        source=backup.ROOT/unit;dest=Path('/etc/systemd/system')/unit
        if dest.exists() and dest.read_bytes()!=source.read_bytes():raise RuntimeError('unit_conflict')
    for unit in units:
        source=backup.ROOT/unit;dest=Path('/etc/systemd/system')/unit
        tmp=dest.with_suffix(dest.suffix+'.new');tmp.write_bytes(source.read_bytes());os.chmod(tmp,0o644);os.replace(tmp,dest)
    backup.command(['systemd-analyze','verify',*[str(Path('/etc/systemd/system')/v) for v in units]])
    backup.command(['systemctl','daemon-reload'])
    backup.command(['systemctl','enable','--now',units[1]])
    fields=backup.command(['systemctl','show',units[1],'-p','ActiveState','-p','UnitFileState','-p','NextElapseUSecRealtime','-p','LastTriggerUSec']).decode().strip()
    if 'ActiveState=active' not in fields or 'UnitFileState=enabled' not in fields:raise RuntimeError('timer_not_enabled')
    return {'timer':dict(line.split('=',1) for line in fields.splitlines()),'backup':status}

if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser();group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--create-folder',action='store_true');group.add_argument('--set-root');group.add_argument('--activate',action='store_true')
    args=parser.parse_args()
    try:
        result=create_folder() if args.create_folder else set_root(args.set_root) if args.set_root else activate()
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'ok':False,'error_type':type(exc).__name__,'error_code':str(exc) if isinstance(exc,RuntimeError) else 'setup_failed'}))
        raise SystemExit(1)
