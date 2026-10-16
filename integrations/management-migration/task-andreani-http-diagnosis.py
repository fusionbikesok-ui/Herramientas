from pathlib import Path
import subprocess,json
r=Path('/opt/fusion-management-migration');s=(r/'gateway.mjs').read_text();needle="if(req.headers.origin!==origin||!csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||''))return"
replacement="if(req.headers.origin!==origin||!csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||''))console.warn(JSON.stringify({andreani_csrf_check:true,origin_ok:req.headers.origin===origin,origin_present:!!req.headers.origin,token_present:!!req.headers['x-fusion-csrf'],token_valid:csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||'')})); "+needle
assert needle in s
(r/'gateway.mjs').write_text(s.replace(needle,replacement));subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True)
print(json.dumps({'temporary_boolean_diagnostics':True}))
