import { Router } from 'express';
import { mlFetch } from '../lib/mlClient.js';
import { clavesNecesitanAtencion } from '../lib/mlMapeo.js';
import { partirClaveMl, extraerErrorMl } from '../lib/mlUtil.js';
import { aplanarItemMl } from '../lib/modelos/publicacionMl.js';
import {
  construirWC, construirMLdesdeApi, candidatosDeItem, derivarEstadoApi,
} from '../lib/matcherResolver.js';

// Solo interesan publicaciones matcheables (las cerradas son listings muertos).
const STATUSES_A_TRAER = ['active', 'paused'];
const MULTIGET_CHUNK = 20;   // ML permite hasta 20 ids por multiget
const SEARCH_LIMIT = 100;    // máximo por página de items/search
const CALL_DELAY_MS = 350;   // respeta rate limit (mlFetch ya tiene timeout)

// Estado del refresco de publicaciones (async, no bloqueante). El scan completo tarda
// 1-3 min y superaba el proxy_read_timeout de nginx (120s) → el POST devolvía HTML de
// error que el frontend no podía parsear. Ahora el POST arranca el trabajo y devuelve 202
// al toque; el frontend sondea GET /refrescar-ml/estado. Un solo refresco a la vez.
let _refresco = {
  running: false, scope: null, phase: null, done: 0, total: 0,
  error: null, resultado: null, actualizado_en: null, iniciado_en: null,
};

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
export async function refrescarPublicacionesMl(db, cfg, onProgress) {
  if (!mlCfgOk(cfg)) throw new Error('Configuración de MercadoLibre incompleta');

  // 1) Reunir todos los item_id (activos + pausados), sin duplicados
  onProgress?.({ phase: 'listando', done: 0, total: 0 });
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
      `/items?ids=${chunk.join(',')}&attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail,permalink,catalog_listing`
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
      filas.push(...aplanarItemMl(entry.body));
    }
    onProgress?.({ phase: 'trayendo', done: Math.min(i + MULTIGET_CHUNK, allIds.length), total: allIds.length });
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
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, thumbnail, permalink, catalogo, actualizado_en)
    VALUES (@clave, @item_id, @variation_id, @titulo, @status, @sub_status, @es_variante, @color, @talle, @seller_sku, @variations_texto, @thumbnail, @permalink, @catalogo, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, variation_id=excluded.variation_id, titulo=excluded.titulo,
      status=excluded.status, sub_status=excluded.sub_status, es_variante=excluded.es_variante, color=excluded.color,
      talle=excluded.talle, seller_sku=excluded.seller_sku, variations_texto=excluded.variations_texto,
      thumbnail=excluded.thumbnail, permalink=excluded.permalink, catalogo=excluded.catalogo, actualizado_en=excluded.actualizado_en
  `);
}

/**
 * Refresco ACOTADO: trae de ML solo los item_ids indicados (multiget directo, sin el
 * scan del catálogo completo) y hace upsert. A diferencia del refresco total, NUNCA
 * borra el resto del cache — un subconjunto no puede saber si las demás publicaciones
 * siguen vigentes. Devuelve { total, items, variaciones }.
 */
export async function refrescarPublicacionesMlAcotado(db, cfg, itemIds, onProgress) {
  if (!mlCfgOk(cfg)) throw new Error('Configuración de MercadoLibre incompleta');
  const ids = [...new Set((itemIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return { total: 0, items: 0, variaciones: 0 };

  const filas = [];
  for (let i = 0; i < ids.length; i += MULTIGET_CHUNK) {
    const chunk = ids.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetch(
      db, cfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail,permalink,catalog_listing`
    );
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      throw new Error(`ML multiget falló (status ${resp.status}) en chunk ${i}-${i + chunk.length}`);
    }
    for (const entry of resp.data) {
      if (entry.code !== 200 || !entry.body) continue;
      filas.push(...aplanarItemMl(entry.body));
    }
    onProgress?.({ phase: 'trayendo', done: Math.min(i + MULTIGET_CHUNK, ids.length), total: ids.length });
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
 * Escribe el SELLER_SKU de una publicación/variación en MercadoLibre.
 * Variaciones usan el endpoint puntual /items/{id}/variations/{varId} (evita la
 * revalidación del item completo, ej. límite de fotos). Devuelve { ok, status, saltado }.
 */
async function escribirSkuEnMl(db, cfg, clave, sku) {
  const { itemId, variationId } = partirClaveMl(clave);
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
  return { ok: false, status: resp.status, error: extraerErrorMl(resp) };
}

/**
 * Cruza el catálogo Woo (catalogo_cache) contra las publicaciones ML cacheadas
 * (ml_publicaciones_cache) y devuelve los ítems ya resueltos (candidatos + score +
 * decisión sugerida) para la fuente "API de ML". Es el cómputo caro que antes rehacía
 * cada dispositivo en un Web Worker; ahora se calcula una vez en el servidor.
 *
 * scope='atencion' → solo las publicaciones que necesitan atención (sin mapeo / a
 * re-mapear); cualquier otro valor → todas las cacheadas. Devuelve { items, total }.
 */
export function computarCandidatosApi(db, scope) {
  const catalogo = db.prepare('SELECT id_woo, nombre, sku, tipo, img, atributos_json FROM catalogo_cache').all();

  let pubs;
  if (scope === 'atencion') {
    const claves = clavesNecesitanAtencion(db);
    if (claves.length === 0) return { items: [], total: 0 };
    const placeholders = claves.map(() => '?').join(',');
    pubs = db.prepare(`
      SELECT clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo
      FROM ml_publicaciones_cache WHERE clave IN (${placeholders}) ORDER BY titulo
    `).all(...claves);
  } else {
    pubs = db.prepare(`
      SELECT clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo
      FROM ml_publicaciones_cache ORDER BY titulo
    `).all();
  }

  const { wcItems, indice, wcPorSku } = construirWC(catalogo);
  const { sinSku, conSkuValido } = construirMLdesdeApi(pubs, wcItems);
  const items = [...sinSku, ...conSkuValido];
  const candArr = items.map((it) => candidatosDeItem(it, wcItems, indice));
  const resueltos = derivarEstadoApi(items, candArr, wcPorSku);
  return { items: resueltos, total: resueltos.length };
}

// Cache en memoria del cruce por scope. Recorrer todo el catálogo por publicación es lo
// caro que se quiere evitar repetir; se recalcula solo si cambió la firma de los caches.
// Es un cache de proceso: se pierde al reiniciar, lo cual es correcto (fail-open, se
// recalcula).
const _cacheCandidatos = new Map(); // scope -> { firma, resultado }

// Hash barato (djb2, no criptográfico) de SOLO los campos del catálogo que afectan el
// matching: sku, nombre y atributos. DELIBERADAMENTE ignora stock/precio/actualizado_en,
// que el auto-sync bumpea cada ~15 min: si la firma dependiera de eso, el cruce completo
// (O(publicaciones × catálogo) con LCS) se recomputaría sin necesidad todo el tiempo.
function hashCatalogoMatching(db) {
  const rows = db.prepare('SELECT sku, nombre, atributos_json FROM catalogo_cache').all();
  let h = 5381;
  for (const r of rows) {
    const s = `${r.sku || ''}${r.nombre || ''}${r.atributos_json || ''}`;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return `${rows.length}:${h}`;
}

function firmaCandidatos(db) {
  // Catálogo: hash de campos relevantes al matching (NO stock — ver hashCatalogoMatching).
  const wc = hashCatalogoMatching(db);
  // Publicaciones ML: se refrescan a mano desde ML (no las toca el auto-sync de stock),
  // así que conteo + max(actualizado_en) alcanza para detectar un refresco.
  const ml = db.prepare('SELECT COUNT(*) n, MAX(actualizado_en) t FROM ml_publicaciones_cache').get();
  // Decisiones: afectan el subconjunto 'atencion' (una decisión saca la clave de la lista).
  const dec = db.prepare('SELECT COUNT(*) n, MAX(actualizado_en) t FROM sku_matcher_decisiones').get();
  return `wc:${wc}|ml:${ml.n}:${ml.t || ''}|dec:${dec.n}:${dec.t || ''}`;
}

// peek=true → NO computa ante un miss: devuelve vacío con cache:false al toque. Lo usa el
// warm-start al abrir la página, que sólo quiere saber si hay un resultado ya listo para
// retomar sin pagar el costo del cruce completo (objetivo: abrir el matcher nunca se traba).
function candidatosApiCacheado(db, scope, { peek = false } = {}) {
  const firma = firmaCandidatos(db);
  const hit = _cacheCandidatos.get(scope);
  if (hit && hit.firma === firma) return { ...hit.resultado, cache: true };
  if (peek) return { items: [], total: 0, cache: false };
  const resultado = computarCandidatosApi(db, scope);
  _cacheCandidatos.set(scope, { firma, resultado });
  return { ...resultado, cache: false };
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

  // Arranca el refresco de publicaciones y devuelve 202 sin bloquear (evita el timeout de
  // nginx). body { scope:'atencion' } → refresco acotado (rápido); sin scope → refresco total.
  // El progreso se consulta en GET /refrescar-ml/estado.
  router.post('/refrescar-ml', (req, res) => {
    if (_refresco.running) {
      return res.status(409).json({ ok: false, running: true, error: 'Ya hay un refresco en curso' });
    }
    const scope = req.body?.scope === 'atencion' ? 'atencion' : 'all';
    _refresco = {
      running: true, scope, phase: 'iniciando', done: 0, total: 0,
      error: null, resultado: null, actualizado_en: null, iniciado_en: now(),
    };
    const onProgress = (p) => { _refresco.phase = p.phase; _refresco.done = p.done || 0; _refresco.total = p.total || 0; };

    // Corre en background; el handler ya respondió. Si ML falla, queda registrado en _refresco.error.
    (async () => {
      try {
        let r;
        if (scope === 'atencion') {
          const itemIds = [...new Set(clavesNecesitanAtencion(db).map(c => String(c).split('|')[0]))];
          r = await refrescarPublicacionesMlAcotado(db, mlCfg, itemIds, onProgress);
        } else {
          r = await refrescarPublicacionesMl(db, mlCfg, onProgress);
        }
        _refresco.resultado = r;
        _refresco.actualizado_en = now();
      } catch (e) {
        _refresco.error = e.message;
      } finally {
        _refresco.running = false;
        _refresco.phase = _refresco.error ? 'error' : 'listo';
      }
    })();

    res.status(202).json({ ok: true, running: true, scope });
  });

  // Estado del refresco (para sondeo del frontend). Devuelve progreso y último resultado.
  router.get('/refrescar-ml/estado', (req, res) => {
    const { running, scope, phase, done, total, error, resultado, actualizado_en } = _refresco;
    res.json({ ok: true, running, scope, phase, done, total, error, resultado, actualizado_en });
  });

  // Mapeos huérfanos: decisiones activas cuya publicación ya no está en el cache (cerrada/
  // borrada o fuera del scan active+paused). No se borran — se listan para revisión manual.
  router.get('/huerfanos', (req, res) => {
    const filtro = `d.accion IN ('asignar','confirmar')
      AND d.clave NOT IN (SELECT clave FROM ml_publicaciones_cache)`;
    const total = db.prepare(`SELECT COUNT(*) n FROM sku_matcher_decisiones d WHERE ${filtro}`).get().n;
    const data = db.prepare(
      `SELECT d.clave, d.sku, d.wc_nombre FROM sku_matcher_decisiones d WHERE ${filtro} ORDER BY d.clave LIMIT 500`
    ).all();
    res.json({ ok: true, total, data });
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
    SELECT clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo, actualizado_en
    FROM ml_publicaciones_cache`;
  // Tope defensivo por defecto: por encima del MAX de publicaciones (20.000), así el
  // matcher sigue recibiendo el dataset completo, pero la respuesta nunca queda sin
  // límite. Se puede acotar con ?limit / ?offset.
  const PUBS_LIMIT_DEFAULT = 100000;
  router.get('/publicaciones', (req, res) => {
    const rawLimit = Number(req.query.limit);
    const rawOffset = Number(req.query.offset);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), PUBS_LIMIT_DEFAULT)
      : PUBS_LIMIT_DEFAULT;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    let rows;
    if (req.query.scope === 'atencion') {
      const claves = clavesNecesitanAtencion(db);
      if (claves.length === 0) {
        return res.json({ ok: true, data: [], actualizado: null, total: 0 });
      }
      const placeholders = claves.map(() => '?').join(',');
      rows = db.prepare(`${SELECT_PUBS} WHERE clave IN (${placeholders}) ORDER BY titulo LIMIT ? OFFSET ?`)
        .all(...claves, limit, offset);
    } else {
      rows = db.prepare(`${SELECT_PUBS} ORDER BY titulo LIMIT ? OFFSET ?`).all(limit, offset);
    }
    const actualizado = rows[0]?.actualizado_en ?? null;
    res.json({ ok: true, data: rows, actualizado, total: rows.length });
  });

  // Cruce ya resuelto para la fuente "API de ML": candidatos + score + decisión sugerida
  // por publicación, calculado server-side (antes lo rehacía cada dispositivo en un Web
  // Worker). El modo Excel NO usa este endpoint (el archivo no llega al servidor).
  // ?scope=atencion → solo las que necesitan atención. Cache corta por firma de caches.
  // ?peek=1 → si el cruce no está cacheado, NO lo computa: devuelve vacío con cache:false
  // al toque (para el warm-start al abrir la página, que sólo quiere saber si retomar).
  router.get('/candidatos', (req, res) => {
    try {
      const scope = req.query.scope === 'atencion' ? 'atencion' : 'all';
      const peek = req.query.peek === '1' || req.query.peek === 'true';
      const { items, total, cache } = candidatosApiCacheado(db, scope, { peek });
      const actualizado = db.prepare('SELECT MAX(actualizado_en) t FROM ml_publicaciones_cache').get().t ?? null;
      res.json({ ok: true, data: items, total, actualizado, scope, cache });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
