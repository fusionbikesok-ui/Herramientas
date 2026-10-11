from pathlib import Path
import datetime,json,subprocess,sys,zipfile,xml.etree.ElementTree as E,shutil
r=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve();assert stage.parent==r and stage.name.startswith('andreani-stage-');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
container='fusion-management-migration-php-1';temp='/tmp/'+stage.name
def run(args,**kw):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=45,**kw)
run(['docker','exec',container,'mkdir','-p',temp]);run(['docker','cp',str(stage/'andreani'),container+':'+temp+'/andreani']);run(['docker','cp',str(stage/'andreani-worker-test.php'),container+':'+temp+'/test.php'])
for f in ['worker.php','includes/class-phone.php','includes/class-address.php','includes/class-data.php','includes/class-exporter.php']:run(['docker','exec',container,'php','-l',temp+'/andreani/'+f])
result=run(['docker','exec',container,'php',temp+'/test.php',temp+'/andreani',temp+'/qa.xlsx']);print(result.stdout)
run(['docker','cp',container+':'+temp+'/qa.xlsx',str(stage/'qa.xlsx')])
ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(stage/'andreani/data/EnvioMasivoExcelPaquetes.xlsx') as original,zipfile.ZipFile(stage/'qa.xlsx') as export:
 assert set(original.namelist())==set(export.namelist())
 changed=[n for n in original.namelist() if original.read(n)!=export.read(n)];assert sorted(changed)==[f'xl/worksheets/sheet{i}.xml' for i in [1,2,3]]
 for name in changed:
  a=E.fromstring(original.read(name));b=E.fromstring(export.read(name));aa=a.find('x:sheetData',ns);bb=b.find('x:sheetData',ns)
  assert len(bb)==4
  for i in [0,1]:assert E.tostring(aa[i])==E.tostring(bb[i])
  assert E.tostring(a.find('x:dataValidations',ns))==E.tostring(b.find('x:dataValidations',ns))
  for row in list(bb)[2:]:
   cells={c.attrib['r'].rstrip('0123456789'):c for c in row};assert cells['F'].find('x:v',ns).text=='30000';assert cells['J'].attrib['t']=='inlineStr';assert cells['G'].find('x:is/x:t',ns).text.startswith('FB-QA-');assert not row.findall('.//x:f',ns)
   if 'S' in cells:
    order_number=cells['G'].find('x:is/x:t',ns).text.removeprefix('FB-').rsplit('-B',1)[0]
    assert cells['S'].find('x:is/x:t',ns).text=='Pedido #'+order_number+'; =HYPERLINK("test")'
print(json.dumps({'template_parts_preserved':True,'sheets_tested':3,'rows':6,'formula_cells':0}))
target='/var/www/html/fusion-andreani-worker'
exists=subprocess.run(['docker','exec',container,'test','-d',target],capture_output=True).returncode==0
if exists:
 backup=r/'backups'/('andreani-worker-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700);run(['docker','cp',container+':'+target,str(backup/'worker')])
run(['docker','exec',container,'mkdir','-p',target]);run(['docker','cp',str(stage/'andreani')+'/.',container+':'+target])
print(json.dumps({'worker_installed_internal':True,'qa_xlsx':str(stage/'qa.xlsx')}))
