import axios from 'axios';
import express from 'express';
import { normalizarProductoWc, normalizarVariacionWc, filaCatalogo } from '../lib/modelos/producto.js';
import { mapConLimite } from '../lib/concurrencia.js';

const MAX_PAGES = 200; // 200 × 100 items = 20.000 productos máximo por refresco

// Máximo de productos variables cuyos endpoints de variaciones se consultan en paralelo.
// Antes se recorrían en serie (una request tras otra), lo que con catálogos grandes hacía
// que el POST /catalogo/recargar superara el proxy_read_timeout de nginx (~120s) y se cayera
// el request. Se acota la concurrencia (mismo patrón que Sync ML con ML_CONCURRENCIA_MAX) para
// no dispararlas todas de golpe y evitar rate-limits/carga en WooCommerce.
const WOO_CONCURRENCIA_MAX = 4;

export async function wooFetch(cfg, path, method = 'get', body = null) {
  if (!cfg.url.startsWith('https://')) {
    throw new Error('WooCommerce URL debe usar HTTPS');
  }
  const url = cfg.url.replace(/\/$/, '') + '/wp-json/wc/v3' + path;
  const resp = await axios.request({
    url,
    method,
    data: body ?? undefined,
    auth: { username: cfg.ck, password: cfg.cs },
    timeout: 20000, // sin timeout, una request colgada congela el sync y toma el candado
    validateStatus: () => true
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`WooCommerce API error ${resp.status}`);
  }
  return resp;
}

export async function refrescarCatalogo(db, cfg) {
  const crudos = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const resp = await wooFetch(cfg, `/products?per_page=100&page=${page}&status=any`);
    if (!resp.data.length) break;
    crudos.push(...resp.data);
    if (resp.data.length < 100) break;
    page++;
  }

  const productos = crudos.map(normalizarProductoWc);

  // Fetch variations for variable products (they have their own SKUs and aren't returned by /products).
  // Se paraleliza por producto con concurrencia acotada (WOO_CONCURRENCIA_MAX): la paginación de
  // variaciones de un mismo padre sigue siendo serial (cada página depende de la anterior), pero los
  // distintos padres se consultan en paralelo. Cada tarea captura su propio error y lo devuelve, así
  // un producto que falla no frena a los demás; los errores se re-lanzan al final para conservar el
  // comportamiento observable anterior (recargar falla si alguna llamada a WC falla).
  //
  // OJO: no hay cancelación anticipada. A diferencia del loop serial anterior (que cortaba en el
  // primer error), ante un fallo las demás tareas en vuelo y las pendientes de la cola siguen
  // ejecutándose hasta drenar todo el lote — es decir, se pueden disparar hasta WOO_CONCURRENCIA_MAX
  // requests en paralelo aun cuando WC ya está fallando (ej. 429/5xx), amplificando la carga. El
  // corte es fail-closed de la ESCRITURA, no de las llamadas HTTP: recién se aborta antes de la
  // transacción de persistencia (más abajo), no de las requests a WC. Aceptado por simplicidad.
  const variableProds = crudos.filter(p => p.type === 'variable');
  const resultadosVar = await mapConLimite(variableProds, WOO_CONCURRENCIA_MAX, async (vp) => {
    const padre = normalizarProductoWc(vp);
    const variaciones = [];
    try {
      let vpage = 1;
      while (vpage <= 20) {
        const vresp = await wooFetch(cfg, `/products/${vp.id}/variations?per_page=100&page=${vpage}&status=any`);
        if (!vresp.data.length) break;
        for (const v of vresp.data) {
          if (!v.sku) continue;
          variaciones.push(normalizarVariacionWc(v, padre));
        }
        if (vresp.data.length < 100) break;
        vpage++;
      }
      return { variaciones };
    } catch (e) {
      return { variaciones, error: e };
    }
  });

  const errorVar = resultadosVar.find(r => r.error);
  if (errorVar) throw errorVar.error;
  for (const r of resultadosVar) {
    for (const v of r.variaciones) productos.push(v);
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, marca, gtin, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @marca, @gtin, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre = excluded.nombre, sku = excluded.sku, tipo = excluded.tipo,
      id_padre = excluded.id_padre, stock = excluded.stock,
      categorias_json = excluded.categorias_json, img = excluded.img, precio = excluded.precio,
      atributos_json = excluded.atributos_json, marca = excluded.marca, gtin = excluded.gtin,
      actualizado_en = excluded.actualizado_en
  `);
  // Borrar de catalogo_cache los productos que ya no existen en WooCommerce (borrados
  // permanentemente, o pasados a un estado que "status=any" no devuelve). El upsert de
  // arriba solo agrega/actualiza, nunca borra — así que un producto eliminado en WC quedaba
  // como fila fantasma para siempre. Encontrado en un incidente real (2026-07-25): dos
  // productos borrados hacía tiempo (404 al día de hoy en la API de WC) seguían en
  // catalogo_cache con el mismo SKU que un producto real vigente, y el sync de stock a ML
  // terminaba oscilando entre el valor real y el de la fila fantasma según el orden interno
  // de SQLite en cada corrida — WooCommerce no permite SKUs duplicados de verdad, así que
  // ver el "mismo SKU" en más de una fila acá siempre es un residuo de un borrado, nunca un
  // caso de negocio legítimo.
  const idsActuales = productos.map(p => p.id_woo).filter(id => id != null);
  // Fail-closed: un fetch que trae 0 productos (WooCommerce respondiendo 200 con body vacío
  // por un problema propio — mantenimiento, permisos degradados, etc. — sin que wooFetch lo
  // trate como error) NO debe interpretarse como "se borró todo el catálogo real". En SQL,
  // "id_woo NOT IN (<conjunto vacío>)" es siempre verdadero, así que sin este guard la poda
  // de abajo borraría el 100% de catalogo_cache. Se omite la poda (y el upsert, que de todos
  // modos no tendría nada que escribir) y se avisa — mucho más seguro que perder todo el
  // stock local de golpe.
  if (idsActuales.length === 0) {
    console.warn('[woo] refrescarCatalogo: WooCommerce devolvió 0 productos, se omite la poda de catalogo_cache por seguridad (posible corte/permiso, no un catálogo real vacío).');
    return 0;
  }
  const tx = db.transaction((rows, idsVigentes) => {
    for (const p of rows) {
      upsert.run(filaCatalogo(p, now));
    }
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _catalogo_ids_vigentes (id_woo INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM _catalogo_ids_vigentes');
    const insertId = db.prepare('INSERT OR IGNORE INTO _catalogo_ids_vigentes (id_woo) VALUES (?)');
    for (const id of idsVigentes) insertId.run(id);
    db.prepare('DELETE FROM catalogo_cache WHERE id_woo NOT IN (SELECT id_woo FROM _catalogo_ids_vigentes)').run();
    db.exec('DROP TABLE _catalogo_ids_vigentes');
  });
  tx(productos, idsActuales);

  // H-08: chequeo de calidad de datos WC — avisa (no bloquea) problemas upstream que
  // ensucian el sync/matcher. Los productos 'variable' (padres) no tienen SKU a propósito,
  // se excluyen del conteo de SKU vacío.
  const negs = db.prepare('SELECT COUNT(*) n FROM catalogo_cache WHERE stock<0').get().n;
  const sinSku = db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE tipo<>'variable' AND COALESCE(sku,'')=''").get().n;
  // Un SKU repetido en más de un producto/variación no debería pasar nunca en WooCommerce
  // (SKU es único ahí) — si aparece acá es señal de un residuo de borrado que la limpieza de
  // arriba no alcanzó a cubrir (ej. un refresh viejo que falló a mitad de camino). Se avisa
  // para investigar, ya no se espera que ocurra en operación normal.
  const skusDup = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT sku FROM catalogo_cache WHERE COALESCE(sku,'')<>'' GROUP BY sku HAVING COUNT(*)>1
    )
  `).get().n;
  if (negs || sinSku || skusDup) {
    console.warn(`[woo] calidad catálogo: ${negs} con stock negativo, ${sinSku} sin SKU (no-variable), ${skusDup} SKU repetidos en más de un producto. Revisar en WooCommerce.`);
  }

  return productos.length;
}

// Tope defensivo por defecto: bien por encima del catálogo real (~miles) y del MAX
// de refresco (20.000), así que no trunca a ningún consumidor actual (matcher, etc.)
// pero evita una respuesta sin límite si la tabla crece sin control.
const CATALOGO_LIMIT_DEFAULT = 100000;

export function getCatalogo(db, { limit = CATALOGO_LIMIT_DEFAULT, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM catalogo_cache LIMIT ? OFFSET ?').all(limit, offset);
}

// Parsea ?limit / ?offset opcionales; si no vienen (o son inválidos) usa el tope alto.
function parsePaginado(query) {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, CATALOGO_LIMIT_DEFAULT)
    : CATALOGO_LIMIT_DEFAULT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit: Math.floor(limit), offset };
}

export function wooRouter(db, cfg) {
  const router = express.Router();

  router.get('/test', async (req, res) => {
    try {
      const resp = await wooFetch(cfg, '/products?per_page=1&status=any');
      res.json({ ok: true, total: resp.headers['x-wp-total'] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/catalogo', (req, res) => {
    res.json({ ok: true, data: getCatalogo(db, parsePaginado(req.query)) });
  });

  router.post('/catalogo/recargar', async (req, res) => {
    try {
      const total = await refrescarCatalogo(db, cfg);
      res.json({ ok: true, total });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Actualiza stock de una lista de productos directamente en WooCommerce
  // Body: { updates: [{id_woo, sku, stock_nuevo}] }
  router.post('/stock/aplicar', async (req, res) => {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ ok: false, error: 'updates requerido' });
    }
    const resultados = [];
    for (const u of updates) {
      if (!u.id_woo || u.stock_nuevo == null) {
        resultados.push({ sku: u.sku, ok: false, error: 'faltan id_woo o stock_nuevo' });
        continue;
      }
      try {
        const resp = await wooFetch(cfg, `/products/${u.id_woo}`, 'patch', { stock_quantity: u.stock_nuevo });
        if (resp.status && resp.status !== 200) throw new Error(`WC status ${resp.status}`);
        db.prepare('UPDATE catalogo_cache SET stock=?, actualizado_en=? WHERE id_woo=?')
          .run(u.stock_nuevo, new Date().toISOString(), u.id_woo);
        resultados.push({ sku: u.sku, ok: true, stock_nuevo: u.stock_nuevo });
      } catch (e) {
        resultados.push({ sku: u.sku, ok: false, error: e.message });
      }
    }
    const errores = resultados.filter(r => !r.ok).length;
    res.json({ ok: errores === 0, aplicados: resultados.filter(r => r.ok).length, errores, resultados });
  });

  return router;
}
