import subprocess
for args in [['node','--version'],['systemctl','show','fusion-management-validation.service','-p','User','-p','Group','-p','DynamicUser','-p','ReadOnlyPaths','-p','ReadWritePaths'],['stat','-c','%a %U %G','/opt/fusion-management-migration','/opt/fusion-management-migration/data']]:
 print(subprocess.run(args,capture_output=True,text=True,check=True).stdout.strip())
print(subprocess.run(['node','--input-type=module','-e',"import('node:sqlite').then(()=>console.log('native_sqlite_available')).catch(()=>console.log('native_sqlite_unavailable'))"],capture_output=True,text=True,check=True).stdout.strip())
