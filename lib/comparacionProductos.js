/*
 * lib/comparacionProductos.js — compara los dos productos de catálogo de un aviso de migración
 * (GET /products/{viejo} y /products/{nuevo}) contra los atributos de la publicación propia.
 * Las lecturas se cachean en sqlite: abrir la pantalla nunca dispara una llamada por render.
 */
import { mlFetch } from './mlClient.js';

const TTL_MS = 6 * 3600e3;

export function asegurarTablaProductos(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ml_productos_cache (
    product_id TEXT PRIMARY KEY, http_status INTEGER NOT NULL, status TEXT, nombre TEXT,
    atributos_json TEXT, leido_en TEXT NOT NULL)`);
}

async function leerProducto(db, mlCfg, id) {
  const hit = db.prepare('SELECT * FROM ml_productos_cache WHERE product_id=?').get(id);
  if (hit && Date.now() - Date.parse(hit.leido_en) < TTL_MS) return { ...hit, cache: true };
  let r;
  try { r = await mlFetch(db, mlCfg, 'get', `/products/${id}`); } catch (e) { return { error: e?.message || 'error' }; }
  if (r.status !== 200 && r.status !== 404) return { error: `ML respondió ${r.status}` };
  const d = r.data || {};
  const fila = {
    product_id: id, http_status: r.status, status: r.status === 200 ? d.status || null : null, nombre: d.name || null,
    atributos_json: r.status === 200 ? JSON.stringify(Array.isArray(d.attributes) ? d.attributes.map((a) => ({ id: a.id, name: a.name, value_name: a.value_name ?? null })) : []) : null,
    leido_en: new Date().toISOString(),
  };
  db.prepare(`INSERT OR REPLACE INTO ml_productos_cache (product_id,http_status,status,nombre,atributos_json,leido_en)
    VALUES (@product_id,@http_status,@status,@nombre,@atributos_json,@leido_en)`).run(fila);
  return fila;
}

const parse = (j) => { try { const a = JSON.parse(j); return Array.isArray(a) ? a : []; } catch { return []; } };
const mapa = (lista) => new Map(lista.filter((a) => a?.id).map((a) => [a.id, a]));
const norm = (v) => (v == null || v === '' ? null : String(v).trim().toLowerCase());

function vista(id, p) {
  return {
    id, nombre: p.nombre || null, borrado: p.http_status === 404, activo: p.status === 'active',
    link: p.status === 'active' ? `https://www.mercadolibre.com.ar/p/${id}` : null,
  };
}

export async function compararProductos(db, mlCfg, cambio, publicacion) {
  asegurarTablaProductos(db);
  const viejo = cambio.valor_anterior ? await leerProducto(db, mlCfg, cambio.valor_anterior) : null;
  const nuevo = cambio.valor_nuevo ? await leerProducto(db, mlCfg, cambio.valor_nuevo) : null;
  if (viejo?.error || nuevo?.error) return { ok: false, error: viejo?.error || nuevo?.error };
  const av = mapa(parse(viejo?.atributos_json)), an = mapa(parse(nuevo?.atributos_json)), ap = mapa(parse(publicacion?.atributos_json));
  const ids = [...new Set([...av.keys(), ...an.keys()])];
  const diferencias = [];
  let comparables = 0, noCoinciden = 0;
  for (const id of ids) {
    const v = norm(av.get(id)?.value_name), n = norm(an.get(id)?.value_name), p = norm(ap.get(id)?.value_name);
    if (v === n && (p === null || p === v)) continue;
    const coincideNuevo = p !== null && n !== null ? p === n : null;
    if (coincideNuevo !== null) { comparables += 1; if (!coincideNuevo) noCoinciden += 1; }
    diferencias.push({
      atributo: id, nombre: (an.get(id) || av.get(id)).name || id,
      viejo: av.get(id)?.value_name ?? null, nuevo: an.get(id)?.value_name ?? null, publicacion: ap.get(id)?.value_name ?? null,
      coincide_nuevo: coincideNuevo,
    });
  }
  for (const id of ids) { // atributos iguales en ambos productos que la publicación contradice también cuentan
    if (diferencias.some((d) => d.atributo === id)) continue;
    const n = norm(an.get(id)?.value_name), p = norm(ap.get(id)?.value_name);
    if (n !== null && p !== null) comparables += 1;
  }
  const veredicto = nuevo?.http_status === 404 ? 'no_coincide' : comparables === 0 ? 'sin_datos' : noCoinciden ? 'no_coincide' : 'coincide';
  return { ok: true, viejo: vista(cambio.valor_anterior, viejo || {}), nuevo: vista(cambio.valor_nuevo, nuevo || {}), diferencias, veredicto };
}
