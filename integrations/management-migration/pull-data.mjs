import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
process.loadEnvFile('/opt/fusionbikes/herramientas/.env');
const origin = new URL(process.env.WOO_URL);
if (origin.protocol !== 'https:' || !['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(origin.hostname) || origin.username || origin.password || origin.port) throw new Error('Unexpected shop');
const auth = Buffer.from(`${process.env.WOO_CK}:${process.env.WOO_CS}`).toString('base64');
const base='/wp-json/wc/v3/fusion-herramientas';
function get(path, authenticated=true) {
  return new Promise((resolve,reject)=>{
    const req=https.get(new URL(path,origin),{headers:{Accept:'application/json',...(authenticated?{Authorization:'Basic '+auth}:{})},timeout:20000},res=>{
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>10_000_000)req.destroy(new Error('Response too large'));else chunks.push(chunk);});
      res.on('end',()=>{const raw=Buffer.concat(chunks);try{resolve({status:res.statusCode,data:JSON.parse(raw),raw});}catch{reject(new Error('Invalid shop JSON'));}});
    });req.on('timeout',()=>req.destroy(new Error('Shop timeout')));req.on('error',reject);
  });
}
const anonymous=await get(base+'/migration-inventory',false);
if(![401,403].includes(anonymous.status))throw new Error('Anonymous inventory not denied');
const inventory=await get(base+'/migration-inventory');
if(inventory.status!==200||inventory.data.schema!==1)throw new Error('Inventory unavailable: '+inventory.status);
const folder='/opt/fusion-management-migration/data/'+new Date().toISOString().replaceAll(/[:.]/g,'-');
fs.mkdirSync(folder,{recursive:true,mode:0o700});fs.chmodSync('/opt/fusion-management-migration/data',0o700);
fs.writeFileSync(folder+'/inventory.json',inventory.raw,{mode:0o600});
const manifest={created_at:new Date().toISOString(),source:origin.origin,consistent_cutover_snapshot:false,resources:{}};
const resources=Object.entries(inventory.data.tables).filter(([,value])=>value.exists).map(([name])=>name).concat(['settings','pos_quotes','pos_drafts']);
for(const resource of resources){
  const pages=[];let count=0;
  for(let page=1;page<=1000;page++){
    const result=await get(base+'/migration-export?resource='+resource+'&page='+page);
    if(result.status!==200||result.data.resource!==resource||result.data.page!==page||!Array.isArray(result.data.rows))throw new Error('Export failed: '+resource+' page '+page+' HTTP '+result.status);
    const name=resource+'-'+page+'.json';fs.writeFileSync(folder+'/'+name,result.raw,{mode:0o600});
    pages.push({file:name,sha256:crypto.createHash('sha256').update(result.raw).digest('hex'),rows:result.data.rows.length});count+=result.data.rows.length;
    if(!result.data.more)break;
    if(page===1000)throw new Error('Export page limit');
  }
  const expected=inventory.data.tables[resource]?.rows ?? (resource==='pos_quotes'?inventory.data.pos_quotes:resource==='pos_drafts'?inventory.data.pos_drafts:null);
  if(expected!==null&&expected!==count)throw new Error('Source changed during export: '+resource);
  manifest.resources[resource]={count,pages};
}
const after=await get(base+'/migration-inventory');
if(after.status!==200||JSON.stringify(after.data.tables)!==JSON.stringify(inventory.data.tables))throw new Error('Source counts changed; keep incomplete export for review');
fs.writeFileSync(folder+'/manifest.json',JSON.stringify(manifest,null,2),{mode:0o600});
fs.writeFileSync('/opt/fusion-management-migration/data/latest-path',folder,{mode:0o600});
console.log(JSON.stringify({folder,anonymous_denied:true,inventory:inventory.data,counts:Object.fromEntries(Object.entries(manifest.resources).map(([key,value])=>[key,value.count])),snapshot_only:true}));
