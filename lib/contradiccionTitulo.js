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
const UNIDAD_VEL = '(?:v|vel(?:ocidad(?:es)?)?|speed)';
const CONTEXTO_ELECTRICO_GLOBAL = /\b(?:electric[oa]s?|ebike|e-bike|bateria|volts?|voltios?|\d+\s*(?:ah|mah)|cargador|led)\b/;
// Devuelve el CONJUNTO de velocidades que declara el texto ("8V" -> {8}; "6V/7V/8V" y "7/8V" -> {6,7,8}/{7,8}).
// Una lista o rango declara varias: solo hay contradicción si los conjuntos de ambos lados son disjuntos.
function velocidades(texto) {
  const n = normalizar(texto);
  if (!CONTEXTO_BICI.test(n)) return null;
  // En un producto eléctrico "12v/24v" es tensión: ahí solo valen las unidades explícitas (vel/speed), no la "v" pelada.
  const electrico = CONTEXTO_ELECTRICO_GLOBAL.test(n);
  const unidad = electrico ? '(?:vel(?:ocidad(?:es)?)?|speed)' : UNIDAD_VEL;
  const item = `\\d{1,2}(?:\\s*${UNIDAD_VEL})?`;
  const lista = new RegExp(`\\b${item}(?:\\s*(?:[/,\\-]|\\by\\b|\\bo\\b|\\bu\\b|\\ba\\b)\\s*${item})*(?![\\w])`, 'g');
  const velocidades = new Set();
  for (const match of n.matchAll(lista)) {
    const trozo = match[0];
    if (!new RegExp(`\\d\\s*${unidad}(?![a-z])`).test(trozo)) continue; // sin unidad no es velocidad
    const contexto = n.slice(Math.max(0, match.index - 24), match.index + trozo.length + 12);
    if (!electrico && CONTEXTO_ELECTRICO.test(contexto)) continue;
    const numeros = [...trozo.matchAll(/\d{1,2}/g)].map((m) => Number(m[0])).filter((v) => v >= 5 && v <= 30);
    for (const v of numeros) velocidades.add(v);
    const rango = trozo.match(/^(\d{1,2})\s*(?:v|vel\w*|speed)?\s*(?:-|a)\s*(\d{1,2})/);
    if (rango && numeros.length === 2) for (let v = Number(rango[1]); v <= Number(rango[2]) && v - Number(rango[1]) <= 4; v++) if (v >= 5 && v <= 30) velocidades.add(v);
  }
  return velocidades.size ? velocidades : null;
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
    const velMl = velocidades(mlTexto);
    const velWoo = velocidades(wooTexto);
    if (velMl && velWoo && ![...velMl].some((v) => velWoo.has(v))) motivos.push({ campo: 'velocidades', ml: [...velMl].join('/'), woo: [...velWoo].join('/') });
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

/**
 * Atributos que declara un texto, con las mismas reglas de extracción que `detectarContradiccion`.
 * Los usa la matriz de la pantalla "Catálogo y vínculos" para mostrar ambos lados fila por fila;
 * el veto sigue saliendo solo de `detectarContradiccion`.
 */
export function atributosDeTexto(texto, { talle = null, color = null } = {}) {
  const t = String(texto ?? '');
  const { talles, rodados } = atributosTalle(`${t} ${talle ?? ''}`, { numericMetadata: talle != null && talle !== '' });
  const vel = velocidades(t);
  return {
    transmision: transmision(t),
    velocidades: vel ? [...vel].sort((a, b) => a - b) : [],
    colores: colores(color || t),
    talles: [...talles].filter((v) => v !== 'u'),
    rodados: [...rodados],
  };
}
