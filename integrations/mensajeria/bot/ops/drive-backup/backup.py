"""Private, incremental WhatsApp media archive; runs independently on the VPS."""
from __future__ import annotations
import argparse, fcntl, hashlib, json, os, re, subprocess, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path('/opt/fusion-chatbot/ops/drive-backup')
STATE=Path('/var/lib/fusion-mensajeria-drive')
CONFIG=Path('/root/.config/fusion-mensajeria-drive/rclone.conf')
CONTAINER='fusion-chatbot-api-1'
REMOTE='fusiondrive:'

def atomic_json(path, value):
    tmp=path.with_suffix(path.suffix+'.new')
    with tmp.open('w',encoding='utf-8') as f:
        json.dump(value,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
    os.chmod(tmp,0o600);os.replace(tmp,path)

def read_json(path, default):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default

def command(args, *, data=None, timeout=120):
    result=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
    if result.returncode:
        # Do not include stderr: provider errors may contain personal URLs or tokens.
        raise RuntimeError('command_failed:'+Path(args[0]).name+':'+str(result.returncode))
    return result.stdout

def rclone(*args, timeout=1800):
    return command(['/usr/bin/rclone','--config',str(CONFIG),'--contimeout','15s','--timeout','2m','--retries','3',*args],timeout=timeout)

def hashes(path):
    sha=hashlib.sha256();md5=hashlib.md5()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):
            sha.update(chunk);md5.update(chunk)
    return {'sha256':sha.hexdigest(),'md5':md5.hexdigest()}

def check_archive(path):
    with zipfile.ZipFile(path) as z:
        if z.testzip() is not None:raise RuntimeError('zip_corrupt')
        manifest=json.loads(z.read('manifest.json'))
        seen=set()
        for item in manifest['files']:
            name=item['path']
            if not re.fullmatch(r'(4819|2035)/\d{4}-\d{2}/[a-f0-9-]{36}\.[a-z0-9]+',name) or name in seen:
                raise RuntimeError('invalid_archive_path')
            seen.add(name)
            content=z.read(name)
            if len(content)!=item['bytes'] or hashlib.sha256(content).hexdigest()!=item['sha256']:
                raise RuntimeError('archive_content_mismatch')
        return manifest

def remote_matches(metadata, size, digest):
    cloud_hashes={key.lower():value for key,value in metadata.get('Hashes',{}).items()}
    return not metadata.get('IsDir',True) and metadata.get('Size')==size and cloud_hashes.get('md5','').lower()==digest['md5']

def create_pending(ledger):
    request={'excluded_ids':list(ledger.get('media',{})), 'previous_archives':[v['name'] for v in ledger.get('archives',[])]}
    code=(ROOT/'export_media.py').read_text(encoding='utf-8')
    result=json.loads(command(['docker','exec','-i',CONTAINER,'python','-c',code],data=json.dumps(request).encode(),timeout=2400))
    temporary=result['path']
    if not re.fullmatch(r'/tmp/fusion-media-backup-\d{8}T\d{6}Z-[a-f0-9]{8}\.zip',temporary):
        raise RuntimeError('unexpected_export_path')
    local=STATE/'staging'/Path(temporary).name
    command(['docker','cp',CONTAINER+':'+temporary,str(local)],timeout=180)
    os.chmod(local,0o600)
    digest=hashes(local)
    if digest['sha256']!=result['sha256'] or local.stat().st_size!=result['bytes']:
        raise RuntimeError('container_transfer_mismatch')
    manifest=check_archive(local)
    # Only the exact generated temporary archive is removed, after verification.
    command(['docker','exec',CONTAINER,'python','-c','from pathlib import Path; Path('+repr(temporary)+').unlink(missing_ok=True)'])
    today=datetime.now(ZoneInfo('America/Argentina/Buenos_Aires')).strftime('%Y-%m-%d')
    suffix=Path(temporary).stem.rsplit('-',1)[-1]
    name='Mensajeria-'+today+'-'+suffix+'.zip'
    pending={'name':name,'local_name':local.name,'date_argentina':today,'bytes':local.stat().st_size,'hashes':digest,'summary':manifest['summary']}
    atomic_json(STATE/'pending.json',pending)
    return pending

def commit(ledger, pending, manifest, cloud):
    item={'name':pending['name'],'id':cloud.get('ID'),'sha256':pending['hashes']['sha256'],'bytes':pending['bytes'],'date_argentina':pending['date_argentina']}
    archives=[v for v in ledger.get('archives',[]) if v['name']!=item['name']]+[item]
    media=dict(ledger.get('media',{}))
    for entry in manifest['files']:
        media[entry['id']]={'archive':pending['name'],'path':entry['path'],'sha256':entry['sha256']}
    return {'version':1,'archives':archives,'media':media,'last_verified_at':datetime.now(timezone.utc).isoformat()}

def perform(prepare_only=False, restore_test=False):
    ledger=read_json(STATE/'ledger.json',{'version':1,'archives':[],'media':{}})
    pending=read_json(STATE/'pending.json',None) or create_pending(ledger)
    if not re.fullmatch(r'fusion-media-backup-\d{8}T\d{6}Z-[a-f0-9]{8}\.zip',pending['local_name']):raise RuntimeError('invalid_staging_path')
    local=STATE/'staging'/pending['local_name']
    manifest=check_archive(local)
    if hashes(local)!=pending['hashes']:raise RuntimeError('staging_hash_mismatch')
    if prepare_only:
        print(json.dumps({'prepared':True,'name':pending['name'],'bytes':pending['bytes'],'summary':pending['summary']}));return
    if not CONFIG.exists() or CONFIG.stat().st_mode & 0o077:raise RuntimeError('missing_or_unprotected_drive_config')
    destination=REMOTE+pending['name']
    rclone('copyto',str(local),destination,'--immutable','--checksum')
    cloud=json.loads(rclone('lsjson',destination,'--stat','--hash',timeout=120))
    if not remote_matches(cloud,pending['bytes'],pending['hashes']):raise RuntimeError('drive_verification_failed')
    if restore_test:
        restored=STATE/'staging'/(local.stem+'-restore.zip')
        rclone('copyto',destination,str(restored),'--checksum')
        if hashes(restored)!=pending['hashes']:raise RuntimeError('restore_hash_mismatch')
        check_archive(restored);restored.unlink()
    updated=commit(ledger,pending,manifest,cloud)
    atomic_json(STATE/'ledger.json',updated)
    status={'last_attempt':datetime.now(timezone.utc).isoformat(),'last_success':updated['last_verified_at'],'upload_verified':True,'complete':not manifest['unavailable'],'archive':pending['name'],'drive_file_id':cloud.get('ID'),'new_files':len(manifest['files']),'total_archived_files':len(updated['media']),'unavailable':len(manifest['unavailable']),'restore_tested':restore_test,'bytes':pending['bytes']}
    atomic_json(STATE/'status.json',status)
    (STATE/'pending.json').unlink();local.unlink()
    print(json.dumps(status))

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('--prepare-only',action='store_true');parser.add_argument('--restore-test',action='store_true');args=parser.parse_args()
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700);(STATE/'staging').mkdir(exist_ok=True,mode=0o700)
    with (STATE/'run.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:print('{"already_running":true}');return 0
        try:perform(args.prepare_only,args.restore_test)
        except Exception as exc:
            status=read_json(STATE/'status.json',{})
            status.update(last_attempt=datetime.now(timezone.utc).isoformat(),upload_verified=False,error_type=type(exc).__name__,error_code=str(exc) if isinstance(exc,RuntimeError) else 'backup_failed')
            atomic_json(STATE/'status.json',status)
            print(json.dumps({'upload_verified':False,'error_type':status['error_type'],'error_code':status['error_code']}));return 1
    return 0

if __name__=='__main__':sys.exit(main())
