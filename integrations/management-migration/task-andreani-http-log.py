import subprocess
p=subprocess.run(['journalctl','-u','fusion-management-validation.service','--since','5 minutes ago','--no-pager','-o','cat'],capture_output=True,text=True)
for line in p.stdout.splitlines():
 if 'andreani_csrf_check' in line:print(line)
