import { Router } from 'express';
import { mlFetch } from '../lib/mlClient.js';
import { clavesNecesitanAtencion } from '../lib/mlMapeo.js';

// Solo interesan publicaciones matcheables (las cerradas son listings muertos).
const STATUSES_A_TRAER = ['active', 'paused'];
const MULTIGET_CHUNK = 20;   // ML permite hasta 20 ids por multiget
const SEARCH_LIMIT = 100;    // máximo por página de items/search
const CALL_DELAY_MS = 350;   // respeta rate limit (mlFetch ya tiene timeout)

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function now() {
  return new Date().toISOString();
}

function mlCfgOk(cfg) {
  return cfg?.clientId && cfg?.clientSecret && cfg?.userId;
}

/**
 * Extrae de un array de attribute_combinations (o attributes) el value_name del
 * primer atributo cuyo id esté en la lista `ids`.
 */
function attrValor(attrs, ids) {
  if (!Array.isArray(attrs)) return '';
  for (const id of ids) {
    const a = attrs.find(x => x.id === id);
    if (a && a.value_name) return String(a.value_name).trim();
  }
  return '';
}

/**
 * Lista TODOS los item_id del vendedor para un status dado.
 *
 * Usa paginación `search_type=scan` (scroll): la paginación por offset de ML topa
 * en 1000 resultados, pero el vendedor tiene miles de pausadas. El scan no tiene
 * ese límite — se itera con scroll_id hasta que no vengan más resultados.
 */
async function listarItemIds(db, cfg, status) {
  const ids = [];
  let scrollId = null;
  const MAX_PAGINAS = 200; // guarda: 200 × 100 = 20.000 items máximo por status
  for (let pag = 0; pag < MAX_PAGINAS; pag++) {
    const scrollParam = scrollId ? `&scroll_id=${encodeURIComponent(scrollId)}` : '';
    const resp = await mlFetch(
      db, cfg, 'get',
      `/users/${cfg.userId}/items/search?search_type=scan&status=${status}&limit=${SEARCH_LIMIT}${scrollParam}`
    );
    // Fallo de API (429/500/etc.): abortar en vez de devolver una lista parcial
    // — el llamador reemplaza el cache de forma atómica y una lista incompleta
    // borraría publicaciones válidas del cache.
    if (resp.status !== 200) {
      throw new Error(`ML scan falló (status ${resp.status}) para status=${status}`);
    }
    const results = resp.data.results ?? [];
    if (results.length === 0) break;
    ids.push(...results);
    scrollId = resp.data.scroll_id;
    if (!scrollId) break;
    await sleep(CALL_DELAY_MS);
  }
  return ids;
}

/**
 * Trae todas las publicaciones activas/pausadas del vendedor desde la API de ML,
 * extrae atributos estructurados (COLOR, SIZE) y SELLER_SKU, y las cachea.
 * Devuelve { total, items, variaciones }.
 */
export async function refrescarPublicacionesMl(db, cfg) {
  if (!mlCfgOk(cfg)) throw new Error('Configuración de MercadoLibre incompleta');

  // 1) Reunir todos los item_id (activos + pausados), sin duplicados
  const idSet = new Set();
  for (const st of STATUSES_A_TRAER) {
    const ids = await listarItemIds(db, cfg, st);
    ids.forEach(id => idSet.add(id));
    await sleep(CALL_DELAY_MS);
  }
  const allIds = [...idSet];

  // 2) Multiget de a 20 con los atributos necesarios
  const filas = [];
  for (let i = 0; i < allIds.length; i += MULTIGET_CHUNK) {
    const chunk = allIds.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetch(
      db, cfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail`
    );
    // Fallo del multiget: abortar. Reconstruir el cache con chunks faltantes
    // borraría publicaciones válidas sin aviso.
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      throw new Error(`ML multiget falló (status ${resp.status}) en chunk ${i}-${i + chunk.length}`);
    }
    for (const entry of resp.data) {
      // entry.code !== 200 por-ítem: ítem borrado/no accesible en ML — se excluye
      // legítimamente (no es un fallo de fetch del chunk completo).
      if (entry.code !== 200 || !entry.body) continue;
      filas.push(...aplanarItem(entry.body));
    }
    await sleep(CALL_DELAY_MS);
  }

  // 3) Reemplazar el cache de forma atómica
  const upsert = prepararUpsertCache(db);
  const ts = now();
  const tx = db.transaction((rows) => {
    // Limpiar publicaciones que ya no están activas/pausadas
    db.prepare('DELETE FROM ml_publicaciones_cache').run();
    for (const f of rows) upsert.run({ ...f, actualizado_en: ts });
  });
  tx(filas);

  const variaciones = filas.filter(f => f.es_variante === 1).length;
  return { total: filas.length, items: allIds.length, variaciones };
}

/** Statement de upsert al cache de publicaciones (compartido entre refresco total y acotado). */
function prepararUpsertCache(db) {
  return db.prepare(`
    INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, thumbnail, actualizado_en)
    VALUES (@clave, @item_id, @variation_id, @titulo, @status, @sub_status, @es_variante, @color, @talle, @seller_sku, @variations_texto, @thumbnail, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, variation_id=excluded.variation_id, titulo=excluded.titulo,
      status=excluded.status, sub_status=excluded.sub_status, es_variante=excluded.es_variante, color=excluded.color,
      talle=excluded.talle, seller_sku=excluded.seller_sku, variations_texto=excluded.variations_texto,
      thumbnail=excluded.thumbnail, actualizado_en=excluded.actualizado_en
  `);
}

/**
 * Refresco ACOTADO: trae de ML solo los item_ids indicados (multiget directo, sin el
 * scan del catálogo completo) y hace upsert. A diferencia del refresco total, NUNCA
 * borra el resto del cache — un subconjunto no puede saber si las demás publicaciones
 * siguen vigentes. Devuelve { total, items, variaciones }.
 */
export async function refrescarPublicacionesMlAcotado(db, cfg, itemIds) {
  if (!mlCfgOk(cfg)) throw new Error('Configuración de MercadoLibre incompleta');
  const ids = [...new Set((itemIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return { total: 0, items: 0, variaciones: 0 };

  const filas = [];
  for (let i = 0; i < ids.length; i += MULTIGET_CHUNK) {
    const chunk = ids.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetch(
      db, cfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail`
    );
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      throw new Error(`ML multiget falló (status ${resp.status}) en chunk ${i}-${i + chunk.length}`);
    }
    for (const entry of resp.data) {
      if (entry.code !== 200 || !entry.body) continue;
      filas.push(...aplanarItem(entry.body));
    }
    await sleep(CALL_DELAY_MS);
  }

  const upsert = prepararUpsertCache(db);
  const ts = now();
  const tx = db.transaction((rows) => {
    for (const f of rows) upsert.run({ ...f, actualizado_en: ts });
  });
  tx(filas);

  const variaciones = filas.filter(f => f.es_variante === 1).length;
  return { total: filas.length, items: ids.length, variaciones };
}

/**
 * Convierte un item de ML (con o sin variaciones) en filas del cache.
 * Una fila por variación; para simples, una sola fila con variation_id = ''.
 */
function aplanarItem(body) {
  const itemId = String(body.id);
  const titulo = body.title || '';
  const thumbnail = body.secure_thumbnail || body.thumbnail || '';
  const status = body.status || '';
  // sub_status es a nivel item (array, ej. ["out_of_stock"]); se denormaliza en cada fila.
  const subStatus = Array.isArray(body.sub_status) ? body.sub_status.join(',') : (body.sub_status || '');
  const vars = Array.isArray(body.variations) ? body.variations : [];

  if (vars.length === 0) {
    // Producto simple — SKU en attributes (SELLER_SKU) o seller_custom_field
    const sku = attrValor(body.attributes, ['SELLER_SKU']) || (body.seller_custom_field ? String(body.seller_custom_field).trim() : '');
    return [{
      clave: `${itemId}|`,
      item_id: itemId,
      variation_id: '',
      titulo,
      status,
      sub_status: subStatus,
      es_variante: 0,
      color: '',
      talle: '',
      seller_sku: sku,
      variations_texto: '',
      thumbnail,
    }];
  }

  return vars.map(v => {
    const varId = String(v.id);
    const color = attrValor(v.attribute_combinations, ['COLOR', 'MAIN_COLOR']);
    const talle = attrValor(v.attribute_combinations, ['SIZE', 'FRAME_SIZE', 'FILTRABLE_SIZE']);
    const sku = attrValor(v.attributes, ['SELLER_SKU']) || (v.seller_custom_field ? String(v.seller_custom_field).trim() : '');
    const combo = (v.attribute_combinations || [])
      .map(a => a.value_name).filter(Boolean).join(' / ');
    return {
      clave: `${itemId}|${varId}`,
      item_id: itemId,
      variation_id: varId,
      titulo,
      status,
      sub_status: subStatus,
      es_variante: 1,
      color,
      talle,
      seller_sku: sku,
      variations_texto: combo,
      thumbnail,
    };
  });
}

/**
 * Escribe el SELLER_SKU de una publicación/variación en MercadoLibre.
 * Variaciones usan el endpoint puntual /items/{id}/variations/{varId} (evita la
 * revalidación del item completo, ej. límite de fotos). Devuelve { ok, status, saltado }.
 */
async function escribirSkuEnMl(db, cfg, clave, sku) {
  const [itemId, variationId] = String(clave).split('|');
  if (!itemId || !sku) return { ok: false, status: 0, error: 'clave o sku inválido' };

  // Idempotencia: si ML ya tiene ese SKU, no reescribir
  const cacheRow = db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
  if (cacheRow && (cacheRow.seller_sku || '') === sku) return { ok: true, status: 200, saltado: true };

  const path = variationId
    ? `/items/${itemId}/variations/${variationId}`
    : `/items/${itemId}`;
  const body = { attributes: [{ id: 'SELLER_SKU', value_name: sku }] };

  const resp = await mlFetch(db, cfg, 'put', path, body);
  if (resp.status === 200) {
    db.prepare('UPDATE ml_publicaciones_cache SET seller_sku = ? WHERE clave = ?').run(sku, clave);
    return { ok: true, status: 200 };
  }
  const causa = Array.isArray(resp.data?.cause) && resp.data.cause.length
    ? resp.data.cause.map(c => c.message || c.code).join(' | ')
    : (resp.data?.message || `HTTP ${resp.status}`);
  return { ok: false, status: resp.status, error: causa };
}

export function matcherRouter(db, cfg) {
  const router = Router();
  const mlCfg = cfg?.ml ?? cfg;

  router.get('/decisiones', (req, res) => {
    const rows = db.prepare('SELECT clave, sku, wc_nombre, accion FROM sku_matcher_decisiones').all();
    const data = {};
    for (const row of rows) data[row.clave] = { sku: row.sku, wc_nombre: row.wc_nombre, accion: row.accion };
    res.json({ ok: true, data });
  });

  router.post('/decisiones', (req, res) => {
    const { decisiones } = req.body;
    if (!decisiones || typeof decisiones !== 'object') {
      return res.status(400).json({ ok: false, error: 'decisiones requeridas' });
    }
    const now = new Date().toISOString();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
    );
    const upsertAll = db.transaction((entries) => {
      for (const [clave, d] of entries) {
        if (d && d.accion) stmt.run(clave, d.sku || null, d.wc_nombre || null, d.accion, now);
      }
    });
    upsertAll(Object.entries(decisiones));
    res.json({ ok: true });
  });

  // Trae las publicaciones desde la API de ML y las cachea.
  // body { scope:'atencion' } → refresco acotado a las publicaciones sin mapeo /
  // a re-mapear (rápido); sin scope → refresco total del catálogo.
  router.post('/refrescar-ml', async (req, res) => {
    try {
      let r;
      if (req.body?.scope === 'atencion') {
        const itemIds = [...new Set(clavesNecesitanAtencion(db).map(c => String(c).split('|')[0]))];
        r = await refrescarPublicacionesMlAcotado(db, mlCfg, itemIds);
      } else {
        r = await refrescarPublicacionesMl(db, mlCfg);
      }
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Escribe el SKU de UNA decisión en la publicación de ML (usado al confirmar)
  router.post('/push-sku', async (req, res) => {
    const { clave, sku } = req.body || {};
    if (!clave || !sku || !/^FB-\d+$/.test(String(sku))) {
      return res.status(400).json({ ok: false, error: 'clave y sku (FB-xxx) requeridos' });
    }
    try {
      const r = await escribirSkuEnMl(db, mlCfg, clave, sku);
      res.json({ ok: r.ok, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Escribe en ML las decisiones mapeadas pendientes, en LOTES (evita el timeout de
  // nginx de 120s). El frontend llama repetido hasta que restantes = 0.
  const LOTE_PUSH = 120;
  router.post('/push-skus-pendientes', async (req, res) => {
    const wherePend = `
      FROM sku_matcher_decisiones d
      JOIN ml_publicaciones_cache p ON p.clave = d.clave
      WHERE d.accion IN ('asignar','confirmar')
        AND d.sku LIKE 'FB-%'
        AND p.status = 'active'
        AND COALESCE(p.seller_sku,'') <> d.sku`;

    const lote = db.prepare(`SELECT d.clave, d.sku ${wherePend} LIMIT ${LOTE_PUSH}`).all();

    let escritos = 0, errores = 0;
    const fallos = [];
    for (const p of lote) {
      try {
        const r = await escribirSkuEnMl(db, mlCfg, p.clave, p.sku);
        if (r.ok) escritos++;
        else { errores++; if (fallos.length < 20) fallos.push({ clave: p.clave, sku: p.sku, error: r.error }); }
      } catch (e) {
        errores++; if (fallos.length < 20) fallos.push({ clave: p.clave, sku: p.sku, error: e.message });
      }
      await sleep(CALL_DELAY_MS);
    }
    const restantes = db.prepare(`SELECT COUNT(*) n ${wherePend}`).get().n;
    res.json({ ok: true, procesados: lote.length, escritos, errores, restantes, fallos });
  });

  // Cuántas decisiones tienen SKU pendiente de escribir en ML
  router.get('/push-skus-pendientes/count', (req, res) => {
    const r = db.prepare(`
      SELECT COUNT(*) n FROM sku_matcher_decisiones d
      JOIN ml_publicaciones_cache p ON p.clave = d.clave
      WHERE d.accion IN ('asignar','confirmar') AND d.sku LIKE 'FB-%'
        AND p.status = 'active' AND COALESCE(p.seller_sku,'') <> d.sku
    `).get();
    res.json({ ok: true, pendientes: r.n });
  });

  // Lee las publicaciones cacheadas.
  // ?scope=atencion → solo las que necesitan atención (sin mapeo / a re-mapear).
  const SELECT_PUBS = `
    SELECT clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, actualizado_en
    FROM ml_publicaciones_cache`;
  router.get('/publicaciones', (req, res) => {
    let rows;
    if (req.query.scope === 'atencion') {
      const claves = clavesNecesitanAtencion(db);
      if (claves.length === 0) {
        return res.json({ ok: true, data: [], actualizado: null, total: 0 });
      }
      const placeholders = claves.map(() => '?').join(',');
      rows = db.prepare(`${SELECT_PUBS} WHERE clave IN (${placeholders}) ORDER BY titulo`).all(...claves);
    } else {
      rows = db.prepare(`${SELECT_PUBS} ORDER BY titulo`).all();
    }
    const actualizado = rows[0]?.actualizado_en ?? null;
    res.json({ ok: true, data: rows, actualizado, total: rows.length });
  });

  return router;
}
