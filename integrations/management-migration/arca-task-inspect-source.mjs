import https from 'node:https';
process.loadEnvFile('/opt/fusionbikes/herramientas/.env');
const origin=new URL(process.env.WOO_URL);
if(origin.protocol!=='https:'||!['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(origin.hostname))throw new Error('Wrong origin');
const auth=Buffer.from(`${process.env.WOO_CK}:${process.env.WOO_CS}`).toString('base64');
async function get(route){return new Promise((resolve,reject)=>{const req=https.get(new URL('/wp-json/wc/v3/fusion-herramientas/'+route,origin),{headers:{Authorization:'Basic '+auth,Accept:'application/json'},timeout:20000},res=>{let body='';res.on('data',c=>{body+=c;if(body.length>10000000)req.destroy(new Error('Size limit'));});res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('Source HTTP '+res.statusCode));try{resolve(JSON.parse(body));}catch{reject(new Error('Invalid JSON'));}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Timeout')));});}
const inventory=await get('migration-inventory');
const settings=await get('migration-export?resource=settings&page=1');
const arca=settings.rows.find(r=>r.name==='fusion_arca_settings'||r.option_name==='fusion_arca_settings');
const value=arca?.value||arca?.option_value||{};
console.log(JSON.stringify({inventory,arca_settings:Object.fromEntries(['environment','point','production_enabled','auto_enabled','auto_statuses'].map(k=>[k,value[k]])),settings_fields:arca?Object.keys(arca):[]},null,2));
