/**
 * Subida del código universal (GTIN/EAN, campo nativo de Woo `global_unique_id`)
 * a WooCommerce. Compartido entre `routes/codigos.js` (POST /api/codigos/asignar)
 * y `routes/inventario.js` (POST /api/inventario/sesiones/:id/asociar) — los dos
 * routers tienen permisos distintos (`lib/permisos.js`), así que la lógica se
 * extrae acá en vez de que un router llame al otro.
 * Ver docs/superpowers/specs/2026-08-21-subir-ean-a-woo-design.md.
 */

import axios from 'axios';

const now = () => new Date().toISOString();

// GTIN válido: dígitos, longitudes GS1 soportadas y dígito de control correcto.
// Se comparte entre las herramientas que enseñan/suben códigos para que no haya
// una herramienta que acepte un código que otra rechaza.
function gtinCheckOk(code) {
  const n = code.length;
  let sum = 0;
  for (let i = n - 2; i >= 0; i -= 1) {
    const d = code.charCodeAt(i) - 48;
    const mult = ((n - 2 - i) % 2 === 0) ? 3 : 1;
    sum += d * mult;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (code.charCodeAt(n - 1) - 48);
}

export function looksLikeGtin(value) {
  const code = String(value || '').trim();
  if (!/^[0-9]+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;
  return gtinCheckOk(code);
}

/**
 * PATCH puntual a Woo que preserva el motivo real del rechazo (ej. GTIN
 * duplicado en otro producto). No usamos wooFetch porque su contrato descarta
 * el body de error; acá lo necesitamos para mostrarle al usuario por qué Woo
 * no aceptó el código.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function patchGlobalUniqueId(cfg, path, gtin) {
  if (!String(cfg.url || '').startsWith('https://')) {
    return { ok: false, error: 'WooCommerce URL debe usar HTTPS' };
  }
  const url = cfg.url.replace(/\/$/, '') + '/wp-json/wc/v3' + path;
  const resp = await axios.request({
    url,
    method: 'patch',
    data: { global_unique_id: gtin },
    auth: { username: cfg.ck, password: cfg.cs },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (resp.status < 200 || resp.status >= 300) {
    const d = resp.data || {};
    return { ok: false, error: d.message || d.code || `error ${resp.status}` };
  }
  return { ok: true };
}

/**
 * Endpoint de Woo correcto según el tipo de la fila de catalogo_cache.
 * Rechaza el padre `variable` (no lleva código propio) y la variación sin
 * `id_padre` resuelto (no se puede armar la ruta).
 * @returns {{ path: string } | { error: string }}
 */
export function endpointParaProducto(fila) {
  if (fila.tipo === 'variable') {
    return { error: 'Un producto variable (padre) no lleva código; usá sus variaciones' };
  }
  if (fila.tipo === 'variation') {
    if (!fila.id_padre) {
      return { error: 'Variación sin id_padre; no se puede resolver el endpoint de Woo' };
    }
    return { path: `/products/${fila.id_padre}/variations/${fila.id_woo}` };
  }
  return { path: `/products/${fila.id_woo}` };
}

/**
 * Sube el `global_unique_id` a Woo para la fila dada.
 *
 * No valida el formato del código (ej. `looksLikeEan`) ni decide fail-open vs
 * fail-closed — eso es responsabilidad de cada caller: `/api/codigos/asignar`
 * es fail-closed (si esto falla, no toca la DB); `/api/inventario/.../asociar`
 * es fail-open a propósito (si esto falla, la asociación local igual se hace,
 * decisión de negocio 2026-08-21: el trabajo físico del operario no se
 * descarta por un error de Woo).
 *
 * `motivo: 'no_endpoint'` distingue el rechazo local (padre variable / variación
 * sin id_padre, nunca se llamó a Woo) del rechazo de Woo o la falla de red,
 * para que el caller pueda elegir el status HTTP correcto (400 vs 502).
 *
 * @returns {Promise<{ ok: boolean, error?: string, motivo?: string }>}
 */
export async function subirGtinAWoo(cfg, fila, gtin) {
  const endpoint = endpointParaProducto(fila);
  if (endpoint.error) return { ok: false, error: endpoint.error, motivo: 'no_endpoint' };
  try {
    const woo = await patchGlobalUniqueId(cfg, endpoint.path, gtin);
    if (!woo.ok) return { ok: false, error: `WooCommerce rechazó el código: ${woo.error}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `No se pudo contactar a WooCommerce: ${e.message}` };
  }
}

/**
 * Al confirmar la subida (Woo ya aceptó el PATCH): persiste
 * `catalogo_cache.gtin`, siembra/actualiza `ean_sku` (para Consulta de
 * Precios) y borra la fila `ean_sku` huérfana del código previo si era
 * distinto — para que no siga resolviendo al código viejo.
 */
export function persistirGtinConfirmado(db, fila, gtin, sku) {
  const gtinPrevio = String(fila.gtin || '').trim();
  const ahora = now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE catalogo_cache SET gtin = ?, actualizado_en = ? WHERE id_woo = ?')
      .run(gtin, ahora, fila.id_woo);
    if (gtinPrevio && gtinPrevio !== gtin) {
      db.prepare('DELETE FROM ean_sku WHERE ean = ?').run(gtinPrevio);
    }
    if (sku) {
      db.prepare(`
        INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
        ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
      `).run(gtin, sku, ahora);
    }
  });
  tx();
}
