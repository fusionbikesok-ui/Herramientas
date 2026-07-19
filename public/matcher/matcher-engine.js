/* ── MOTOR DE MATCHING (factorizado) ──
   Funciones puras, sin DOM. Las usa tanto la página del matcher (public/matcher/index.html)
   como el Web Worker (matcher-worker.js) para el cómputo caro de candidatos.
   Se expone como `MatcherEngine` en window/self, o vía module.exports en Node (tests). */
(function(root){
"use strict";
const EQUIV={gray:'gris',grey:'gris',black:'negro',white:'blanco',red:'rojo',blue:'azul',green:'verde',yellow:'amarillo',orange:'naranja',purple:'violeta',pink:'rosa',brown:'marron'};
const COLORES=new Set(['negro','blanco','rojo','azul','verde','amarillo','naranja','violeta','rosa','gris','marron','celeste','teal','dorado','plateado','dark','brush','fluo','turquesa','bordo','beige','crema','lima','coral','fucsia','cobre','grafito','antracita','oliva','arena','vino','mostaza','salmon','menta','lavanda',
  // Ampliación data-driven (H-07): términos de color/acabado reales de las publicaciones ML
  // que antes caían mal clasificados como talle.
  'lila','marino','navy','plata','acero','bronce','cromado','titanio','titanium','ceniza','perlado','metalizado','multicolor','transparente','indigo','agua','aqua','petroleo','caramelo','cappuccino','castano','musgo','rosado','burgundy','borravino','terracota','ocre','mate','matte']);
const TALLE_RE=/^(xxs|xs|s|m|l|xl|xxl|xxxl|xxxxxl|\d{2,3}|un|unico)$/;

function norm(t){if(!t&&t!==0)return '';t=String(t).toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'');for(const e in EQUIV)t=t.replace(new RegExp('\\b'+e+'\\b','g'),EQUIV[e]);return t.replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();}
function toks(t){return new Set(norm(t).split(' ').filter(x=>x));}
function extraerAtributos(varStr){
  if(!varStr)return{colores:new Set(),talles:new Set()};
  const lower=String(varStr).toLowerCase().trim();
  if(lower.includes('/')){
    const partes=lower.split('/').map(p=>norm(p).trim()).filter(Boolean);
    const colores=new Set(),talles=new Set();
    for(const parte of partes){const tks=parte.split(/\s+/).filter(Boolean);if(tks.length&&tks.every(t=>TALLE_RE.test(t))){tks.forEach(t=>talles.add(t));}else{tks.forEach(t=>colores.add(t));}}
    if(colores.size||talles.size)return{colores,talles};
  }
  const tks=norm(lower).split(' ').filter(Boolean);const skip=new Set(['eu','un','cm','mm']);
  return{colores:new Set(tks.filter(t=>COLORES.has(t))),talles:new Set(tks.filter(t=>!COLORES.has(t)&&!skip.has(t)))};
}
function extraerAtributosWC(nombre){
  if(!nombre)return{colores:new Set(),talles:new Set()};
  const lower=String(nombre).toLowerCase().trim();
  let suffix=lower;
  const emDash=lower.lastIndexOf('—');const hyphen=lower.lastIndexOf(' - ');const at=Math.max(emDash,hyphen);
  if(at>0)suffix=lower.slice(at+1).trim();
  if(suffix.includes('/')){
    const partes=suffix.split('/').map(p=>norm(p).trim()).filter(Boolean);
    const colores=new Set(),talles=new Set();
    for(const parte of partes){const tks=parte.split(/\s+/).filter(Boolean);if(tks.length&&tks.every(t=>TALLE_RE.test(t))){tks.forEach(t=>talles.add(t));}else{tks.forEach(t=>colores.add(t));}}
    if(colores.size||talles.size)return{colores,talles};
  }
  const tks=norm(lower).split(' ').filter(Boolean);const skip=new Set(['eu','un','cm','mm']);
  return{colores:new Set(tks.filter(t=>COLORES.has(t))),talles:new Set(tks.filter(t=>!COLORES.has(t)&&!skip.has(t)))};
}
// Atributos estructurados de una variación WC (atributos_json = [{name,option}]).
// Preferido sobre parsear el nombre: color/talle vienen del atributo declarado en WC,
// así nombres sin el sufijo "— color / talle" ya no pierden esos atributos.
function extraerAtributosDeAttrsWC(atributosJson){
  if(!atributosJson)return null;
  let arr;try{arr=typeof atributosJson==='string'?JSON.parse(atributosJson):atributosJson;}catch(e){return null;}
  if(!Array.isArray(arr)||!arr.length)return null;
  const colores=new Set(),talles=new Set();const skip=new Set(['eu','un','cm','mm']);
  for(const a of arr){
    const nm=norm(a&&a.name||''),val=norm(a&&a.option||'');
    if(!val)continue;
    const esColor=/\bcolor\b/.test(nm),esTalle=/\b(talle|talla|size|medida)\b/.test(nm);
    for(const t of val.split(' ').filter(Boolean)){
      if(skip.has(t))continue;
      if(esColor)colores.add(t);
      else if(esTalle)talles.add(t);
      else if(COLORES.has(t))colores.add(t);
      else if(TALLE_RE.test(t))talles.add(t);
      else talles.add(t);
    }
  }
  if(!colores.size&&!talles.size)return null;
  return{colores,talles};
}
function attrScore(v){return v===true?2:v===false?0:1;}
function lcsLen(a,b){const m=a.length,n=b.length;if(!m||!n)return 0;let prev=new Int32Array(n+1);for(let i=1;i<=m;i++){const cur=new Int32Array(n+1),ai=a.charCodeAt(i-1);for(let j=1;j<=n;j++){cur[j]=ai===b.charCodeAt(j-1)?prev[j-1]+1:Math.max(prev[j],cur[j-1]);}prev=cur;}return prev[n];}
function ratio(a,b){const la=a.length,lb=b.length;if(!la&&!lb)return 1;if(!la||!lb)return 0;return 2*lcsLen(a,b)/(la+lb);}
function tsr(a,b){const sa=new Set(a.split(' ').filter(x=>x)),sb=new Set(b.split(' ').filter(x=>x));const inter=[...sa].filter(x=>sb.has(x)).sort(),dA=[...sa].filter(x=>!sb.has(x)).sort(),dB=[...sb].filter(x=>!sa.has(x)).sort();const t0=inter.join(' '),t1=inter.concat(dA).join(' ').trim(),t2=inter.concat(dB).join(' ').trim();return Math.max(ratio(t0,t1),ratio(t0,t2),ratio(t1,t2));}
function intersecta(a,b){for(const x of a)if(b.has(x))return true;return false;}

function construirWC(items){
  const wcItems=[];const wcPorSku={};
  for(const r of items){
    if(!r.sku||!String(r.sku).trim())continue;
    const sku=String(r.sku).trim();
    const nombre=String(r.nombre||'');
    const tipo=String(r.tipo||'simple');
    // Preferir atributos estructurados de WC; caer al parseo del nombre si no hay (H-06).
    const attrs=extraerAtributosDeAttrsWC(r.atributos_json)||extraerAtributosWC(nombre);
    const item={sku,nombre,tipo,color:[...attrs.colores].join(' '),talle:[...attrs.talles].join('/'),img:String(r.img||''),baseNorm:norm(nombre),colorToks:attrs.colores,talleToks:attrs.talles};
    wcItems.push(item);wcPorSku[sku]=item;
  }
  const indice={};
  wcItems.forEach((w,i)=>{for(const t of new Set(w.baseNorm.split(' ').filter(x=>x))){(indice[t]||(indice[t]=[])).push(i);}});
  return{wcItems,indice,wcPorSku};
}

// Convierte los campos color/talle estructurados de ML (path API) en sets de tokens
// compatibles con el motor (mismo vocabulario COLORES / TALLE_RE que el path Excel).
function ctDesdeApi(color,talle){
  const colores=new Set(),talles=new Set();
  norm(color).split(' ').filter(Boolean).forEach(t=>{ if(COLORES.has(t))colores.add(t); else talles.add(t); });
  norm(talle).split(' ').filter(Boolean).forEach(t=>{ if(COLORES.has(t))colores.add(t); else if(TALLE_RE.test(t))talles.add(t); });
  return {colores,talles};
}

// Prefiltro por tokens en común (índice invertido) + scoring LCS/tsr contra hasta
// TOPE candidatos. Es la parte cara del matching (por eso se cachea / se manda al worker).
const TOPE_CANDIDATOS=50;
function getCandidatos(tn,esVar,varStr,ctOverride,wcItems,indice){
  const ct=ctOverride||(esVar?extraerAtributos(varStr):{colores:new Set(),talles:new Set()});
  const tks=new Set(tn.split(' ').filter(x=>x));
  const cuenta={};
  for(const t of tks)if(indice[t])for(const p of indice[t])cuenta[p]=(cuenta[p]||0)+1;
  const candPos=Object.keys(cuenta).sort((a,b)=>cuenta[b]-cuenta[a]).slice(0,TOPE_CANDIDATOS).map(Number);
  const scored=[];
  for(const pos of candPos){
    const w=wcItems[pos],sm=tsr(tn,w.baseNorm);
    const cOk=ct.colores.size?intersecta(ct.colores,w.colorToks):null;
    const tOk=ct.talles.size?intersecta(ct.talles,w.talleToks):null;
    let bonus=0;if(cOk)bonus+=0.5;if(tOk)bonus+=0.5;
    scored.push({sf:esVar?sm*(1+bonus)/2:sm,cOk,tOk,w});
  }
  scored.sort((a,b)=>{const la=attrScore(a.cOk)+attrScore(a.tOk),lb=attrScore(b.cOk)+attrScore(b.tOk);return lb!==la?lb-la:b.sf-a.sf;});
  return scored.slice(0,8).map(s=>({score:+s.sf.toFixed(3),color_ok:s.cOk,talle_ok:s.tOk,wc_sku:s.w.sku,wc_nombre:s.w.nombre,wc_tipo:s.w.tipo,wc_color:s.w.color,wc_talle:s.w.talle,wc_img:s.w.img}));
}

// Cómputo caro para un ítem ML: sólo depende de título/atributos, NO del seller_sku actual.
function candidatosDeItem(ml,wcItems,indice){
  const tn=norm(ml.ml_title);
  return getCandidatos(tn,ml.ml_es_variante,ml.ml_variations,ml._ct,wcItems,indice);
}

// Hash acumulado simple (DJB2) para firmas de cache livianas.
function djb2(str){let h=5381;for(let i=0;i<str.length;i++){h=((h*33)^str.charCodeAt(i))>>>0;}return h>>>0;}

const api={EQUIV,COLORES,TALLE_RE,norm,toks,extraerAtributos,extraerAtributosWC,extraerAtributosDeAttrsWC,attrScore,lcsLen,ratio,tsr,intersecta,construirWC,ctDesdeApi,getCandidatos,candidatosDeItem,djb2,TOPE_CANDIDATOS};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
else root.MatcherEngine=api;
})(typeof self!=='undefined'?self:this);
