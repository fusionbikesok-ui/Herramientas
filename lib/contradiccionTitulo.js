const COLORES = ['negro', 'blanco', 'rojo', 'azul', 'verde', 'amarillo', 'naranja', 'gris', 'plata', 'dorado', 'rosa', 'violeta', 'celeste'];

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
  return normalizar(texto).match(/\b(\d{1,2}x\d{1,2})\b/)?.[1] ?? null;
}

function velocidades(texto) {
  return normalizar(texto).match(/\b(\d{1,3})\s*(?:v|vel(?:ocidades?)?|speed)\b/)?.[1] ?? null;
}

function colores(texto) {
  const n = normalizar(texto);
  return COLORES.filter((c) => new RegExp(`\\b${c}\\b`).test(n));
}

function talle(texto) {
  const n = normalizar(texto);
  if (/\b(?:talle|size)\s*u(?:nico)?\b|\b(?:u|unico)\b/.test(n)) return 'u';
  const rodado = n.match(/\b(?:rodado|r)\s*(\d{2})\b/);
  if (rodado) return `rodado ${rodado[1]}`;
  const numero = n.match(/\b(?:talle|size)\s*(\d{1,2})\b/);
  if (numero) return numero[1];
  const letras = n.match(/\b(?:talle|size)\s*(xs|xl|s|m|l)\b/);
  if (letras) return letras[1];
  if (/^(xs|xl|s|m|l|u)$/.test(n.trim())) return n.trim();
  return null;
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
  const talleMlExtraido = talle(talleMl || mlTexto);
  const talleWoo = talle(wooTexto);
  motivoSiDistinto(motivos, talleCampo(talleMlExtraido), talleMlExtraido, talleWoo);
  return { contradice: motivos.length > 0, motivos };
}

function talleCampo(value) {
  return value?.startsWith('rodado ') ? 'rodado' : 'talle';
}

export function contradiccionDeClave(db, clave, sku) {
  const pub = db.prepare(`SELECT titulo,color,talle,variations_texto FROM ml_publicaciones_cache WHERE clave=?`).get(clave);
  const woo = db.prepare(`SELECT nombre FROM catalogo_cache WHERE sku=? ORDER BY stock ASC, id_woo ASC LIMIT 1`).get(sku);
  if (!pub || !woo?.nombre) return { contradice: false, motivos: [] };
  return detectarContradiccion({ tituloMl: pub.titulo, nombreWoo: woo.nombre, colorMl: pub.color, talleMl: pub.talle, variacionesMl: pub.variations_texto });
}
