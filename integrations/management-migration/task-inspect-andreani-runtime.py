import subprocess,json
from pathlib import Path
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
for cmd in [['docker','exec','fusion-management-migration-php-1','php','-r','echo json_encode(["zip"=>class_exists("ZipArchive"),"dom"=>class_exists("DOMDocument"),"mbstring"=>extension_loaded("mbstring"),"intl"=>extension_loaded("intl"),"signing_key_present"=>strlen((string)getenv("FUSION_MANAGEMENT_SIGNING_KEY"))>=64]);'],['systemctl','cat','fusion-management-validation.service']]:
 p=subprocess.run(cmd,capture_output=True,text=True,check=True);print(p.stdout)
