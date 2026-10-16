from pathlib import Path
import subprocess
r=Path('/opt/fusion-management-migration')
for name in ['import-result.log','initialize-error.log']:
    if (r/name).is_file():
        lines=(r/name).read_text().splitlines()
        print(name)
        for line in lines:
            if 'Uncaught' in line or 'Fatal error' in line or 'thrown in' in line:print(line[:600])
print(subprocess.run(['systemctl','is-active','fusion-management-validation.service'],capture_output=True,text=True).stdout)
