import json, subprocess, os
from pathlib import Path
root=Path('/opt/fusion-management-migration')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
root.chmod(0o755)
for name in ['gateway.mjs','gateway.test.mjs']:(root/name).chmod(0o644)
subprocess.run(['node','--test',str(root/'gateway.test.mjs')],check=True,timeout=30)
container='fusion-management-migration-php-1'
info=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]
ip=next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
import ipaddress
assert ipaddress.ip_address(ip).is_private
(root/'gateway.env').write_text('FUSION_MANAGEMENT_UPSTREAM='+ip+'\n');(root/'gateway.env').chmod(0o600)
service=Path('/etc/systemd/system/fusion-management-validation.service')
content='''[Unit]
Description=Fusion management migration validation gateway
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=/opt/fusion-management-migration
EnvironmentFile=/opt/fusion-management-migration/runtime.env
EnvironmentFile=/opt/fusion-management-migration/gateway.env
ExecStart=/usr/bin/node /opt/fusion-management-migration/gateway.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=128M
CPUQuota=25%
[Install]
WantedBy=multi-user.target
'''
if service.exists() and 'Fusion management migration validation gateway' not in service.read_text():raise RuntimeError('Unowned service')
service.write_text(content)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now',service.name],check=True,capture_output=True)
subprocess.run(['systemctl','restart',service.name],check=True)
print(json.dumps({'gateway':'127.0.0.1:8212','php_internal':ip,'admin_session_required':True,'mode':'read_only_validation'}))
