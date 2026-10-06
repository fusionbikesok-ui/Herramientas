export interface ItemMl { ml_title: string; ml_es_variante: boolean; ml_variations?: string; color?: string; talle?: string; _ct?: Atributos; }
export interface ItemWoo { sku: string; nombre: string; tipo: string; color: string; talle: string; img: string; baseNorm: string; colorToks: Set<string>; talleToks: Set<string>; colorOriginal: string; talleOriginal: string; }
export interface IndiceWoo { wcItems: ItemWoo[]; indice: Record<string, number[]>; }
interface Atributos { colores: Set<string>; talles: Set<string>; }
interface Resultado { pos: number; score: number; color_ok: boolean | null; talle_ok: boolean | null; wc_sku: string; wc_nombre: string; wc_tipo: string; wc_color: string; wc_talle: string; wc_img: string; }
// Marca por atributo (enmienda de interfaz 2026-09-24, spec bandeja §2): la API de T5 la devuelve
// TAL CUAL, sin traducir. 'equivalente' es una coincidencia después de normalizar (mismo criterio de
// color_ok/talle_ok: intersecta() ya normaliza vía norm()/COLORES, así que dos valores que matchean acá
// pueden no ser textualmente idénticos, p.ej. "negro" ML contra "negro mate" candidato comparten el
// token "negro" — 'equivalente', no 'coincide' a secas, cuando el texto crudo difiere).
export interface AtributoComparado { nombre: 'color' | 'talle'; marca: 'coincide' | 'difiere' | 'falta' | 'equivalente'; valorMl: string; valorCandidato: string; valorMlOriginal: string; valorCandidatoOriginal: string }
export interface Candidato { variantId: string; rank: number; puntaje: number; explicacion: { atributos: AtributoComparado[] } }

const EQUIV: Record<string, string> = { gray: 'gris', grey: 'gris', black: 'negro', white: 'blanco', red: 'rojo', blue: 'azul', green: 'verde', yellow: 'amarillo', orange: 'naranja', purple: 'violeta', pink: 'rosa', brown: 'marron' };
const COLORES = new Set('negro blanco rojo azul verde amarillo naranja violeta rosa gris marron celeste teal dorado plateado dark brush fluo turquesa bordo beige crema lima coral fucsia cobre grafito antracita oliva arena vino mostaza salmon menta lavanda lila marino navy plata acero bronce cromado titanio titanium ceniza perlado metalizado multicolor transparente indigo agua aqua petroleo caramelo cappuccino castano musgo rosado burgundy borravino terracota ocre mate matte'.split(' '));
const TALLE_RE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|xxxxxl|\d{2,3}|un|unico)$/;
export function norm(t: unknown): string { if (!t && t !== 0) return ''; let s = String(t).toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, ''); for (const e in EQUIV) s = s.replace(new RegExp('\\b' + e + '\\b', 'g'), EQUIV[e]!); return s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
export function toks(t: unknown): Set<string> { return new Set(norm(t).split(' ').filter(Boolean)); }
export function extraerAtributos(v?: string): Atributos { return atributosTexto(v, false); }
export function extraerAtributosWC(v?: string): Atributos { return atributosTexto(v, true); }
function atributosTexto(value: string | undefined, wc: boolean): Atributos { if (!value) return { colores: new Set(), talles: new Set() }; const lower = String(value).toLowerCase().trim(); let suffix = lower; if (wc) { const at = Math.max(lower.lastIndexOf('—'), lower.lastIndexOf(' - ')); if (at > 0) suffix = lower.slice(at + 1).trim(); } if (suffix.includes('/')) { const colores = new Set<string>(), talles = new Set<string>(); for (const p of suffix.split('/').map(x => norm(x).trim()).filter(Boolean)) { const ts = p.split(/\s+/).filter(Boolean); (ts.length && ts.every(t => TALLE_RE.test(t)) ? ts : []).forEach(t => talles.add(t)); if (!(ts.length && ts.every(t => TALLE_RE.test(t)))) ts.forEach(t => colores.add(t)); } if (colores.size || talles.size) return { colores, talles }; } const skip = new Set(['eu', 'un', 'cm', 'mm']); const ts = norm(lower).split(' ').filter(Boolean); return { colores: new Set(ts.filter(t => COLORES.has(t))), talles: new Set(ts.filter(t => !COLORES.has(t) && !skip.has(t))) }; }
export const ATRIBUTOS_NO_VARIANTE = new Set(['marca', 'tipo de producto', 'tipo de articulo', 'tipo de montaje', 'genero', 'diseno', 'compuesto', 'body', 'material del cuadro', 'installment']);
export function extraerAtributosDeAttrsWC(json: unknown): Atributos | null { if (!json) return null; let arr: any; try { arr = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; } if (!Array.isArray(arr) || !arr.length) return null; const colores = new Set<string>(), talles = new Set<string>(), skip = new Set(['eu', 'un', 'cm', 'mm']); for (const a of arr) { const nm = norm(a?.name || ''), val = norm(a?.option || ''); if (!val || ATRIBUTOS_NO_VARIANTE.has(nm)) continue; const esColor = /\bcolor\b/.test(nm), esTalle = /\b(talle|talla|size|medida)\b/.test(nm); for (const t of val.split(' ').filter(Boolean)) { if (skip.has(t)) continue; if (esColor) colores.add(t); else if (esTalle || COLORES.has(t) === false) talles.add(t); else colores.add(t); } } return colores.size || talles.size ? { colores, talles } : null; }
export function attrScore(v: boolean | null): number { return v === true ? 2 : v === false ? 0 : 1; }
export function lcsLen(a: string, b: string): number { const m=a.length,n=b.length;if(!m||!n)return 0;let p=new Int32Array(n+1);for(let i=1;i<=m;i++){const c=new Int32Array(n+1),x=a.charCodeAt(i-1);for(let j=1;j<=n;j++)c[j]=x===b.charCodeAt(j-1)?p[j-1]!+1:Math.max(p[j]!,c[j-1]!);p=c}return p[n]!; }
export function ratio(a:string,b:string):number{const x=a.length,y=b.length;if(!x&&!y)return 1;if(!x||!y)return 0;return 2*lcsLen(a,b)/(x+y)}
export function tsr(a:string,b:string):number{const A=new Set(a.split(' ').filter(Boolean)),B=new Set(b.split(' ').filter(Boolean)),i=[...A].filter(x=>B.has(x)).sort(),da=[...A].filter(x=>!B.has(x)).sort(),db=[...B].filter(x=>!A.has(x)).sort(),t0=i.join(' '),t1=i.concat(da).join(' ').trim(),t2=i.concat(db).join(' ').trim();return Math.max(ratio(t0,t1),ratio(t0,t2),ratio(t1,t2))}
export function intersecta(a:Set<string>,b:Set<string>):boolean{for(const x of a)if(b.has(x))return true;return false}
/** Lo que dice el catálogo Woo, sin normalizar (para mostrarlo tal cual): las opciones de atributo de color/talle, o
 *  el sufijo del título si no hay atributos. Nunca decide el matching: eso lo hacen los tokens de arriba. */
function originalesWC(json: unknown, nombre: string): { colorOriginal: string; talleOriginal: string } {
  let arr: any = null; try { arr = typeof json === 'string' ? JSON.parse(json) : json; } catch { arr = null; }
  const c: string[] = [], t: string[] = [];
  if (Array.isArray(arr)) for (const a of arr) { const nm = norm(a?.name || ''), op = String(a?.option ?? '').trim(); if (!op || ATRIBUTOS_NO_VARIANTE.has(nm)) continue; if (/\bcolor\b/.test(nm)) c.push(op); else if (/\b(talle|talla|size|medida)\b/.test(nm)) t.push(op); }
  if (!c.length && !t.length) { const i = Math.max(nombre.lastIndexOf('—'), nombre.lastIndexOf(' - ')); const suf = i > 0 ? nombre.slice(i + 1).replace(/^[\s-]+/, '').trim() : ''; return { colorOriginal: suf, talleOriginal: suf }; }
  return { colorOriginal: c.join(' / '), talleOriginal: t.join(' / ') };
}
export function construirWC(items: any[]): IndiceWoo { const wcItems:ItemWoo[]=[];const indice:Record<string,number[]>={};for(const r of items){if(!r.sku||!String(r.sku).trim())continue;const attrs=extraerAtributosDeAttrsWC(r.atributos_json)||extraerAtributosWC(String(r.nombre||''));const w={sku:String(r.sku).trim(),nombre:String(r.nombre||''),tipo:String(r.tipo||'simple'),color:[...attrs.colores].join(' '),talle:[...attrs.talles].join('/'),img:String(r.img||''),baseNorm:norm(r.nombre),colorToks:attrs.colores,talleToks:attrs.talles,...originalesWC(r.atributos_json,String(r.nombre||''))};const n=wcItems.push(w)-1;for(const t of new Set(w.baseNorm.split(' ').filter(Boolean)))(indice[t]||(indice[t]=[])).push(n)}return{wcItems,indice} }
export function construirWCIndex(items:any[]):IndiceWoo{return construirWC(items)}
// NOTA: contradiccionAtributo (lib/matcherEngine.js) no se portó acá — es de Recepción
// (lib/ingresoMatcher.js), compara contra lo declarado en un documento con canonToken()
// (negra/negro, 700x25c/700x25), y candidatosDe/getCandidatos de esta tarea no lo usan
// (usan intersecta() directo, como el legado). No lo agregues sin portar canonToken también.
export function ctDesdeApi(color:unknown,talle:unknown):Atributos{const c=new Set<string>(),t=new Set<string>();norm(color).split(' ').filter(Boolean).forEach(x=>COLORES.has(x)?c.add(x):t.add(x));norm(talle).split(' ').filter(Boolean).forEach(x=>COLORES.has(x)?c.add(x):TALLE_RE.test(x)&&t.add(x));return{colores:c,talles:t}}
export function getCandidatos(tn:string,esVar:boolean,varStr:string|undefined,override:Atributos|undefined,wcItems:ItemWoo[],indice:Record<string,number[]>):Resultado[]{const ct=override||(esVar?extraerAtributos(varStr):{colores:new Set(),talles:new Set()}),cuenta:Record<string,number>={};for(const t of new Set(tn.split(' ').filter(Boolean))){const posiciones=indice[t];if(posiciones)for(const p of posiciones)cuenta[p]=(cuenta[p]||0)+1}const pos=Object.keys(cuenta).sort((a,b)=>cuenta[b]!-cuenta[a]!).slice(0,50).map(Number),sc=pos.map(p=>{const w=wcItems[p]!,sm=tsr(tn,w.baseNorm),c=ct.colores.size?intersecta(ct.colores,w.colorToks):null,t=ct.talles.size?intersecta(ct.talles,w.talleToks):null,bonus=(c===true?.5:0)+(t===true?.5:0);return{sf:esVar?sm*(1+bonus)/2:sm,cOk:c,tOk:t,w,p}});sc.sort((a,b)=>{const x=attrScore(a.cOk)+attrScore(a.tOk),y=attrScore(b.cOk)+attrScore(b.tOk);return y!==x?y-x:b.sf-a.sf});return sc.slice(0,8).map(s=>({pos:s.p,score:+s.sf.toFixed(3),color_ok:s.cOk,talle_ok:s.tOk,wc_sku:s.w!.sku,wc_nombre:s.w!.nombre,wc_tipo:s.w!.tipo,wc_color:s.w!.color,wc_talle:s.w!.talle,wc_img:s.w!.img}))}
export function candidatosDeItem(ml:ItemMl,wc:ItemWoo[],indice:Record<string,number[]>):Resultado[]{return getCandidatos(norm(ml.ml_title),ml.ml_es_variante,ml.ml_variations,ml._ct,wc,indice)}
export function djb2(str:string):number{let h=5381;for(let i=0;i<str.length;i++)h=((h*33)^str.charCodeAt(i))>>>0;return h>>>0}

/**
 * Marca de un atributo (color o talle), comparando los tokens normalizados de la publicación ML
 * (`ct`) contra los del candidato Woo (`wc`): mismo criterio que color_ok/talle_ok de getCandidatos
 * (intersecta(), no igualdad exacta), pero acá se queda con el detalle que color_ok/talle_ok
 * descartan (los valores en sí, para mostrarlos) y distingue 'coincide' (mismo texto normalizado
 * exacto) de 'equivalente' (intersectan pero no son el mismo conjunto — p.ej. "negro" contra
 * "negro mate").
 */
function marcarAtributo(nombre: 'color' | 'talle', ml: Set<string>, wc: Set<string>, mlOriginal: string, wcOriginal: string): AtributoComparado {
  // Mismo criterio que color_ok/talle_ok de getCandidatos: null (acá 'falta') sólo cuando el lado ML
  // no declaró nada para este atributo — si ML declaró y el candidato no, intersecta() contra un
  // conjunto vacío da false ('difiere'), no 'falta' (un candidato sin el dato no es lo mismo que un
  // dato que coincide, y hay que verlo como diferencia para que salte a la vista).
  const valorMl = [...ml].sort().join(' '), valorCandidato = [...wc].sort().join(' ');
  const o = { valorMlOriginal: mlOriginal, valorCandidatoOriginal: wcOriginal };
  if (!ml.size) return { nombre, marca: 'falta', valorMl, valorCandidato, ...o };
  if (!intersecta(ml, wc)) return { nombre, marca: 'difiere', valorMl, valorCandidato, ...o };
  return { nombre, marca: valorMl === valorCandidato ? 'coincide' : 'equivalente', valorMl, valorCandidato, ...o };
}

export function candidatosDe(ml:ItemMl,woo:any[],indice:IndiceWoo,n=3):Candidato[]{
  const ct = ml._ct || (ml.ml_es_variante ? extraerAtributos(ml.ml_variations) : { colores: new Set<string>(), talles: new Set<string>() });
  return candidatosDeItem(ml,indice.wcItems,indice.indice).slice(0,n).map((x,i)=>{
    const w = indice.wcItems[x.pos]; // por posición: un SKU repetido en wcItems no puede confundir el ítem.
    const atributos: AtributoComparado[] = w
      ? [marcarAtributo('color', ct.colores, w.colorToks, ml.color ?? ml.ml_variations ?? '', w.colorOriginal),
         marcarAtributo('talle', ct.talles, w.talleToks, ml.talle ?? ml.ml_variations ?? '', w.talleOriginal)]
      : [];
    return { variantId: x.wc_sku, rank: i + 1, puntaje: x.score, explicacion: { atributos } };
  });
}
