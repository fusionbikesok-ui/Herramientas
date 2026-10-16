import subprocess,json
code="""
import {createAndreani} from './andreani.mjs';import {DatabaseSync} from 'node:sqlite';
const id='678dcfd2-1bf2-427e-8b0a-d2e469ccaed7',db=new DatabaseSync('/var/lib/fusion-management-validation/andreani.sqlite',{readOnly:true});const row=db.prepare('SELECT by_user FROM batches WHERE id=?').get(id);db.close();
const handle=createAndreani();const result=await handle('download',{id},row.by_user);if(result.file.subarray(0,2).toString()!=='PK')throw Error('invalid XLSX');
let unauthorized=false;try{await handle('download',{id},'anonymous-qa');}catch(e){unauthorized=e.status===403;}if(!unauthorized)throw Error('privacy');console.log(JSON.stringify({corrected_file_readable:true,bytes:result.file.length,other_user_denied:true}));
"""
p=subprocess.run(['node','--input-type=module','-e',code],cwd='/opt/fusion-management-migration',capture_output=True,text=True,timeout=20);print(p.stdout);assert p.returncode==0,p.stderr
