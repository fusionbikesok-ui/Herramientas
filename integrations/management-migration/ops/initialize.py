import json, subprocess
from pathlib import Path
root=Path('/opt/fusion-management-migration')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
base=['docker','compose','--env-file',str(root/'runtime.env'),'-f',str(root/'compose.json'),'-p','fusion-management-migration']
for plugin in ['','woocommerce/woocommerce.php','fusion-bikes-pos-v2/fusion-bikes-pos.php','fusion-facturacion-arca/fusion-facturacion-arca.php','fusion-taller/fusion-taller.php']:
    result=subprocess.run(base+['exec','-T','-u','www-data','php','php','/opt/fusion-scripts/install.php',plugin],capture_output=True,text=True,timeout=120)
    if result.returncode:
        (root/'initialize-error.log').write_text(result.stdout+result.stderr)
        raise RuntimeError('Runtime initialization failed; inspect initialize-error.log')
    print(result.stdout[-2500:])
