const COLORES = ['negro', 'blanco', 'rojo', 'azul', 'verde', 'amarillo', 'naranja', 'gris', 'plata', 'dorado', 'rosa', 'violeta', 'celeste', 'marron', 'beige', 'turquesa', 'bordo'];
const CONTEXTO_BICI = /\b(?:bici(?:cleta)?|mtb|gravel|ruta|rodado|transmision|velocidades?|cassette|cambios|groupset|shimano|sram|drivetrain)\b/;
const CONTEXTO_PRODUCTO = /\b(?:bici(?:cleta)?|mtb|gravel|ruta|casco|calzado|zapatilla|remera|campera|guante|short|maillot)\b/;
const CONTEXTO_ELECTRICO = /\b(?:volt|bateria|ah|mah|luz|led|cargador)\b/;
const CONTEXTO_CUADRO = /\b(?:cuadro|frame|frame_size|size)\b/;

function normalizar(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[×x]/g, 'x');
}
function textoVariaciones(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return ''; }
}
function transmision(texto) {
  const n = normalizar(texto);
  if (!CONTEXTO_BICI.test(n)) return null;
  const match = n.match(/\b([1-3])\s*x\s*(5|6|7|8|9|10|11|12|13)\b/);
  return match ? `${match[1]}x${match[2]}` : null;
}
function velocidades(texto) {
  const n = normalizar(texto);
  if (!CONTEXTO_BICI.test(n)) return null;
  for (const match of n.matchAll(/\b(\d{1,2})\s*(?:v|vel(?:ocidad(?:es)?)?|speed)\b/g)) {
    const contexto = n.slice(Math.max(0, match.index - 24), match.index + match[0].length + 12);
    const numero = Number(match[1]);
    if (numero >= 5 && numero <= 30 && !CONTEXTO_ELECTRICO.test(contexto)) return String(numero);
  }
  return null;
}
function colores(texto) {
  const n = normalizar(texto);
  return COLORES.filter((c) => new RegExp(`\\b${c}\\b`).test(n));
}
function atributosTalle(texto, { numericMetadata = false } = {}) {
  const n = normalizar(texto);
  const talles = new Set();
  const rodados = new Set();
  if (/\b(?:talle|size)\s*u(?:nico)?\b|\b(?:u|unico)\b/.test(n)) talles.add('u');
  for (const match of n.matchAll(/\b(?:talle|size)\s*(xs|xl|s|m|l|\d{1,2})\b/g)) talles.add(match[1]);
  if (numericMetadata && /^\d{1,2}$/.test(n.trim())) talles.add(n.trim());
  for (const match of n.matchAll(/\b(?:rodado|rod|r)\s*(\d{2})\b/g)) rodados.add(match[1]);
  for (const match of n.matchAll(/\b(\d{2})\s*["”]/g)) {
    const antes = n.slice(Math.max(0, match.index - 18), match.index);
    if (CONTEXTO_BICI.test(n) && !CONTEXTO_CUADRO.test(antes)) rodados.add(match[1]);
  }
  return { talles, rodados };
}
function motivoSiDistinto(motivos, campo, ml, woo) {
  if (ml && woo && ml !== 'u' && woo !== 'u' && ml !== woo) motivos.push({ campo, ml, woo });
}

export function detectarContradiccion({ tituloMl, nombreWoo, colorMl = null, talleMl = null, variacionesMl = null } = {}) {
  const mlTexto = `${tituloMl ?? ''} ${textoVariaciones(variacionesMl)}`;
  const wooTexto = nombreWoo ?? '';
  const motivos = [];
  const contextoBici = CONTEXTO_BICI.test(normalizar(mlTexto)) || CONTEXTO_BICI.test(normalizar(wooTexto));
  if (contextoBici) {
    motivoSiDistinto(motivos, 'transmision', transmision(mlTexto), transmision(wooTexto));
    motivoSiDistinto(motivos, 'velocidades', velocidades(mlTexto), velocidades(wooTexto));
  }
  const coloresMl = colores(colorMl || mlTexto);
  const coloresWoo = colores(wooTexto);
  const contextoProducto = CONTEXTO_PRODUCTO.test(normalizar(mlTexto)) && CONTEXTO_PRODUCTO.test(normalizar(wooTexto));
  if (contextoProducto && coloresMl.length && coloresWoo.length && !coloresMl.some((c) => coloresWoo.includes(c))) {
    motivos.push({ campo: 'color', ml: coloresMl.join('/'), woo: coloresWoo.join('/') });
  }
  if (!contextoProducto) return { contradice: motivos.length > 0, motivos };
  const attrsMl = atributosTalle(`${mlTexto} ${talleMl ?? ''}`, { numericMetadata: talleMl != null && talleMl !== '' });
  const attrsWoo = atributosTalle(wooTexto);
  const mlTalle = [...attrsMl.talles].find((v) => v !== 'u');
  const wooTalle = [...attrsWoo.talles].find((v) => v !== 'u');
  if (mlTalle && wooTalle) motivoSiDistinto(motivos, 'talle', mlTalle, wooTalle);
  const mlRodado = [...attrsMl.rodados][0];
  const wooRodado = [...attrsWoo.rodados][0];
  if (mlRodado && wooRodado && mlRodado !== wooRodado) motivos.push({ campo: 'rodado', ml: mlRodado, woo: wooRodado });
  return { contradice: motivos.length > 0, motivos };
}

export function contradiccionDeClave(db, clave, sku) {
  const pub = db.prepare('SELECT titulo,color,talle,variations_texto FROM ml_publicaciones_cache WHERE clave=?').get(clave);
  const woo = db.prepare('SELECT nombre FROM catalogo_cache WHERE sku=? ORDER BY stock ASC, id_woo ASC LIMIT 1').get(sku);
  if (!pub || !woo?.nombre) return { contradice: false, motivos: [] };
  return detectarContradiccion({ tituloMl: pub.titulo, nombreWoo: woo.nombre, colorMl: pub.color, talleMl: pub.talle, variacionesMl: pub.variations_texto });
}
