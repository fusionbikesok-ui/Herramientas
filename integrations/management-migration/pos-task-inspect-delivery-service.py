from pathlib import Path
import subprocess,json
r=Path('/opt/fusion-management-migration')
print(subprocess.check_output(['systemctl','show','fusion-management-validation','-p','User','-p','Group','-p','ProtectSystem','-p','ReadWritePaths','-p','StateDirectory'],text=True))
print('nodemailer_exists',Path('/opt/fusionbikes/herramientas/node_modules/nodemailer/package.json').exists())
print('backup_script')
print((r/'scripts/arca-backup.py').read_text())
print('smtp_parser',subprocess.check_output(['node','-e',"const fs=require('fs');const {parseEnv}=require('node:util');const c=parseEnv(fs.readFileSync('/opt/fusionbikes/herramientas/.env','utf8'));console.log(JSON.stringify({parser:true,host:!!c.SMTP_HOST,port:c.SMTP_PORT,secure:c.SMTP_SECURE,from:!!c.SMTP_FROM}));"],text=True))
