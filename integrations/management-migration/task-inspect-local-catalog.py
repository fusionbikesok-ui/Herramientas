from pathlib import Path
import subprocess
r=Path('/opt/fusion-management-migration')
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
code="""
import {createRequire} from 'node:module';
const require=createRequire('/opt/fusionbikes/herramientas/package.json');
const Database=require('better-sqlite3');
const db=new Database('/opt/fusionbikes/herramientas/data/fusion.sqlite',{readonly:true,fileMustExist:true});
const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%catalog%' OR name LIKE '%precio%' OR name='ean_sku')").all();
console.log(JSON.stringify({tables:names,columns:db.prepare('PRAGMA table_info(catalogo_cache)').all().map(x=>x.name),
counts:db.prepare('SELECT tipo,count(*) n,sum(stock>0) positive,min(actualizado_en) oldest,max(actualizado_en) latest FROM catalogo_cache GROUP BY tipo').all(),
sample:db.prepare("SELECT id_woo,nombre,sku,tipo,id_padre,stock,precio,regular_price,gtin,atributos_json,actualizado_en FROM catalogo_cache WHERE stock>0 AND tipo IN ('simple','variation') ORDER BY id_woo LIMIT 4").all()}));
db.close();
"""
p=subprocess.run(['node','--input-type=module','-e',code],check=True,capture_output=True,text=True)
print(p.stdout)
