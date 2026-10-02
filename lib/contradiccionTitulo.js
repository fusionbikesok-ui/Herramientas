const COLORES = ['negro', 'blanco', 'rojo', 'azul', 'verde', 'amarillo', 'naranja', 'gris', 'plata', 'dorado', 'rosa', 'violeta', 'celeste', 'marron', 'beige', 'turquesa', 'bordo'];

function normalizar(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[×x]/g, 'x');
}

function textoVariaciones(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return ''; }
}

function transmision(texto) {
  return normalizar(texto).match(/\b(\d{1,2})\s*x\s*(\d{1,2})\b/)?.slice(1).join('x') ?? null;
}

function velocidades(texto) {
  return normalizar(texto).match(/\b(\d{1,3})\s*(?:v|vel(?:ocidades?)?|speed)\b/)?.[1] ?? null;
}

function colores(texto) {
  const n = normalizar(texto);
  return COLORES.filter((c) => new RegExp(`\\b${c}\\b`).test(n));
}

function atributosTalle(texto, { numericLoose = false } = {}) {
  const n = normalizar(texto);
  const talles = new Set();
  const rodados = new Set();
  if (/\b(?:talle|size)\s*u(?:nico)?\b|\b(?:u|unico)\b/.test(n)) talles.add('u');
  for (const match of n.matchAll(/\b(?:talle|size)\s*(xs|xl|s|m|l|\d{1,2})\b/g)) talles.add(match[1]);
  for (const match of n.matchAll(/\b(?:rodado|r)\s*(\d{2})\b|\b(\d{2})\s*["”]/g)) rodados.add(match[1] || match[2]);
  if (numericLoose && /^\d{1,2}$/.test(n.trim())) rodados.add(n.trim());
  if (/^(xs|xl|s|m|l|u)$/.test(n.trim())) talles.add(n.trim());
  return { talles, rodados };
}

function motivoSiDistinto(motivos, campo, ml, woo) {
  if (ml && woo && ml !== 'u' && woo !== 'u' && ml !== woo) motivos.push({ campo, ml, woo });
}

export function detectarContradiccion({ tituloMl, nombreWoo, colorMl = null, talleMl = null, variacionesMl = null } = {}) {
  const mlTexto = `${tituloMl ?? ''} ${textoVariaciones(variacionesMl)}`;
  const wooTexto = nombreWoo ?? '';
  const motivos = [];
  motivoSiDistinto(motivos, 'transmision', transmision(mlTexto), transmision(wooTexto));
  motivoSiDistinto(motivos, 'velocidades', velocidades(mlTexto), velocidades(wooTexto));
  const coloresMl = colores(colorMl || mlTexto);
  const coloresWoo = colores(wooTexto);
  if (coloresMl.length && coloresWoo.length && !coloresMl.some((c) => coloresWoo.includes(c))) {
    motivos.push({ campo: 'color', ml: coloresMl.join('/'), woo: coloresWoo.join('/') });
  }
  const attrsMl = atributosTalle(talleMl || mlTexto, { numericLoose: talleMl != null && talleMl !== '' });
  const attrsWoo = atributosTalle(wooTexto);
  const mlTalle = [...attrsMl.talles].find((v) => v !== 'u');
  const wooTalle = [...attrsWoo.talles].find((v) => v !== 'u');
  if (mlTalle && wooTalle) motivoSiDistinto(motivos, 'talle', mlTalle, wooTalle);
  const mlRodado = [...attrsMl.rodados][0];
  const wooRodado = [...attrsWoo.rodados][0];
  if (mlRodado && wooRodado && mlRodado !== wooRodado) motivos.push({ campo: 'rodado', ml: mlRodado, woo: wooRodado });
  // Un talle ML numérico suele ser el rodado. Es compatible si coincide con el rodado o
  // con un talle numérico declarado por Woo; nunca se compara contra el talle de letras.
  if (mlRodado && !mlTalle && wooRodado && mlRodado !== wooRodado) {
    const wooNumerico = [...attrsWoo.talles].find((v) => /^\d+$/.test(v));
    if (wooNumerico !== mlRodado) {
      const ya = motivos.find((m) => m.campo === 'rodado');
      if (!ya) motivos.push({ campo: 'rodado', ml: mlRodado, woo: wooRodado });
    }
  }
  return { contradice: motivos.length > 0, motivos };
}

export function contradiccionDeClave(db, clave, sku) {
  const pub = db.prepare(`SELECT titulo,color,talle,variations_texto FROM ml_publicaciones_cache WHERE clave=?`).get(clave);
  const woo = db.prepare(`SELECT nombre FROM catalogo_cache WHERE sku=? ORDER BY stock ASC, id_woo ASC LIMIT 1`).get(sku);
  if (!pub || !woo?.nombre) return { contradice: false, motivos: [] };
  return detectarContradiccion({ tituloMl: pub.titulo, nombreWoo: woo.nombre, colorMl: pub.color, talleMl: pub.talle, variacionesMl: pub.variations_texto });
}
