"""One-time rclone OAuth setup; secrets remain in root-only files."""
from pathlib import Path
import configparser,fcntl,json,os,re,subprocess,time

ROOT=Path('/root/.config/fusion-mensajeria-drive')
CONFIG=ROOT/'rclone.conf'

def status(**value):
    path=ROOT/'oauth-status.json';tmp=path.with_suffix('.new')
    tmp.write_text(json.dumps(value),encoding='utf-8');os.chmod(tmp,0o600);os.replace(tmp,path)

def main():
    os.umask(0o077)
    with (ROOT/'oauth.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if CONFIG.exists():raise RuntimeError('configuration_already_exists')
        client=json.loads((ROOT/'oauth-client.json').read_text())['installed']
        if client['project_id']!='fusion-bikes-backup-511719':raise RuntimeError('unexpected_project')
        env=dict(os.environ,RCLONE_DRIVE_CLIENT_ID=client['client_id'],RCLONE_DRIVE_CLIENT_SECRET=client['client_secret'],RCLONE_DRIVE_SCOPE='drive.file')
        log=ROOT/'oauth-private.log'
        with log.open('wb') as output:
            process=subprocess.Popen(['/usr/bin/rclone','--config',str(ROOT/'authorize-temporary.conf'),'authorize','drive','--auth-no-open-browser'],env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT)
            deadline=time.monotonic()+1800;published=False
            try:
                while process.poll() is None:
                    if time.monotonic()>deadline:raise TimeoutError('authorization_timeout')
                    if not published:
                        match=re.search(r'http://127\.0\.0\.1:53682/auth\?state=[A-Za-z0-9_=-]+',log.read_text(errors='replace'))
                        if match:status(waiting_for_google=True,auth_url=match.group(0),scope='drive.file');published=True
                    time.sleep(0.5)
                if process.returncode:raise RuntimeError('authorization_failed')
            finally:
                if process.poll() is None:
                    process.terminate();process.wait(timeout=10)
        body=log.read_text(errors='replace');token=None;decoder=json.JSONDecoder()
        for match in re.finditer(r'\{',body):
            try:value,_=decoder.raw_decode(body[match.start():])
            except ValueError:continue
            if isinstance(value,dict) and value.get('refresh_token') and value.get('access_token'):token=value;break
        if token is None:raise RuntimeError('missing_offline_token')
        cfg=configparser.ConfigParser(interpolation=None)
        cfg['fusiondrive']={'type':'drive','client_id':client['client_id'],'client_secret':client['client_secret'],'scope':'drive.file','token':json.dumps(token)}
        tmp=CONFIG.with_suffix('.new')
        with tmp.open('w') as f:cfg.write(f);f.flush();os.fsync(f.fileno())
        os.chmod(tmp,0o600);os.replace(tmp,CONFIG)
        status(authorized=True,scope='drive.file',refresh_token_saved=True)
        log.unlink()

if __name__=='__main__':
    try:main()
    except Exception as exc:
        status(authorized=False,error_type=type(exc).__name__)
        raise SystemExit(1)
