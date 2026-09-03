import express from 'express';
import {
  esNoVendible,
  esFaltante,
  esMultiPublicacion,
  esActivaMl,
} from '../lib/cobertura.js';
import {
  resumenMarcas, progresoHoy, seguirDondeQuede, tocarSesion, productosDeMarca,
  construirIndiceMlSinSku, candidatosDeProducto, buscarMlManual, calcularSinStock,
} from '../lib/coberturaCola.js';
import {
  escribirSkuEnMl, desvincularSkuEnMl, pausarPublicacionMl, getEstadoPush,
} from '../lib/matcherPush.js';
import { generarCSVHayQuePublicar } from '../lib/csv.js';
import { partirClaveMl } from '../lib/mlUtil.js';
import { dispararRefrescoMl, estadoRefrescoMl } from './matcher.js';
import { requireAdmin } from '../lib/auth.js';
import { precioContado } from '../lib/mlPrecios.js';
import { filasDeVinculos, cargarDescartes, senalesVigentes, logSync } from './sync.js';

/**
 * Cruza el catálogo de WooCommerce (catalogo_cache) contra las publicaciones de ML
 * en vivo (ml_publicaciones_cache) y devuelve, ya procesado, todo lo que la página
 * de Cobertura necesita para pintar sus pestañas. Antes esta lógica (joins/filtros)
 * vivía replicada en el cliente; ahora es la única fuente de verdad en el backend.
 *
 * Es espejo exacto del cruce que hacía el front sobre la fuente "API de ML":
 *  - skusEnML: SKUs (seller_sku) presentes en cualquier publicación (activa o pausada).
 *  - conteoPorSku: cantidad de publicaciones por seller_sku (multi-publicación).
 *  - en_ambos: publicaciones cuyo seller_sku coincide con un SKU de WC.
 *  - solo_ml: publicaciones sin seller_sku o cuyo SKU no existe en WC.
 *  - pausadas: las de en_ambos con status distinto de activo.
 *  - faltantes / multiPub / excluidos: reglas de lib/cobertura.js sobre el catálogo WC.
 */
export function computarCruce(db) {
  const wcProductos = db.prepare('SELECT * FROM catalogo_cache').all();
  const mlRows = db.prepare(`
    SELECT item_id, variation_id, titulo, status, seller_sku, variations_texto
    FROM ml_publicaciones_cache
  `).all();
  const excluidosArr = db.prepare('SELECT id_woo FROM cobertura_exclusiones').all();
  const excluidosSet = new Set(excluidosArr.map((e) => e.id_woo));

  // Normalizar publicaciones ML al mismo shape que usaba el cliente.
  const mlItems = mlRows.map((p) => ({
    ml_item_id: String(p.item_id),
    ml_variation_id: p.variation_id ? String(p.variation_id) : '',
    ml_title: p.titulo || '(sin título)',
    ml_sku: (p.seller_sku || '').trim(),
    ml_status: p.status || '',
    ml_variante: p.variations_texto || '',
  }));

  // Índices: SKUs presentes en ML y conteo de publicaciones por SKU.
  const skusEnML = new Set();
  const conteoPorSku = new Map();
  const pubsPorSku = new Map();
  for (const m of mlItems) {
    if (!m.ml_sku) continue;
    skusEnML.add(m.ml_sku);
    conteoPorSku.set(m.ml_sku, (conteoPorSku.get(m.ml_sku) || 0) + 1);
    if (!pubsPorSku.has(m.ml_sku)) pubsPorSku.set(m.ml_sku, []);
    pubsPorSku.get(m.ml_sku).push(m);
  }

  // Índice WC por SKU.
  const wcPorSku = new Map();
  for (const p of wcProductos) {
    const s = String(p.sku || '').trim();
    if (s) wcPorSku.set(s, p);
  }

  // EN AMBOS: publicación ML cuyo SKU existe en WC.
  const en_ambos = [];
  for (const m of mlItems) {
    if (!m.ml_sku) continue;
    const wc = wcPorSku.get(m.ml_sku);
    if (!wc) continue;
    en_ambos.push({
      nombre: wc.nombre,
      sku: wc.sku,
      stock_wc: wc.stock,
      // Campos de catalogo_cache: así el frontend puede filtrar/ordenar estas filas
      // con el mismo set de criterios que las pestañas basadas en el catálogo WC.
      marca: wc.marca ?? null,
      categorias_json: wc.categorias_json ?? null,
      precio: wc.precio ?? null,
      img: wc.img ?? null,
      gtin: wc.gtin ?? null,
      actualizado_en: wc.actualizado_en ?? null,
      ml_title: m.ml_title,
      ml_item_id: m.ml_item_id,
      ml_var_id: m.ml_variation_id,
      ml_status: m.ml_status,
      ml_variante: m.ml_variante,
    });
  }

  // SOLO ML: sin SKU o SKU inexistente en WC. No tiene contraparte en catalogo_cache,
  // así que los campos de WC (marca/categorias/precio/…) quedan en null: no aplican.
  const solo_ml = mlItems
    .filter((m) => !m.ml_sku || !wcPorSku.has(m.ml_sku))
    .map((m) => ({
      ...m,
      marca: null,
      categorias_json: null,
      precio: null,
      img: null,
      gtin: null,
      actualizado_en: null,
    }));

  // PAUSADAS: de en_ambos, las que no están activas.
  const pausadas = en_ambos.filter((r) => !esActivaMl(r.ml_status));

  // FALTANTES / EXCLUIDOS / MULTI-PUBLICACIÓN: reglas canónicas sobre WC.
  const faltantes = wcProductos.filter((p) => esFaltante(p, skusEnML, excluidosSet));
  const excluidos = wcProductos.filter((p) => excluidosSet.has(p.id_woo));
  const multiPub = wcProductos
    .filter((p) => esMultiPublicacion(p, conteoPorSku, excluidosSet))
    .map((p) => {
      const sku = String(p.sku || '').trim();
      const pubs = pubsPorSku.get(sku) || [];
      return {
        ...p,
        conteo: conteoPorSku.get(sku) || 0,
        publicaciones: pubs.map((m) => ({
          ml_item_id: m.ml_item_id,
          ml_variation_id: m.ml_variation_id,
          ml_variante: m.ml_variante,
        })),
      };
    });

  return {
    en_ambos,
    solo_ml,
    pausadas,
    faltantes,
    excluidos,
    multiPub,
    resumen: {
      total_ambos: en_ambos.length,
      total_solo_ml: solo_ml.length,
      total_pausadas: pausadas.length,
      total_faltantes: faltantes.length,
      total_excluidos: excluidos.length,
      total_multipub: multiPub.length,
      total_ml_pubs: mlItems.length,
      total_wc: wcProductos.length,
    },
  };
}

/**
 * Pausa una publicación de ML con la advertencia de variaciones hermanas (ver el hallazgo
 * ALTO del revisor sobre routes/cobertura.js:pausar): ML no tiene pausado por variación, así
 * que pausar una variación pausa TODA la publicación. Si la clave es una variación con
 * hermanas y el llamador no mandó `{ confirmado: true }`, corta con 409 y el conteo de
 * variaciones afectadas — nunca ejecuta el pausado "a ciegas". Devuelve { status, body }.
 */
async function pausarConAdvertencia(db, mlCfg, clave, body) {
  const { itemId, variationId } = partirClaveMl(clave);
  if (!itemId) return { status: 400, body: { ok: false, error: 'clave inválida' } };
  let variacionesAfectadas = 0;
  if (variationId) {
    variacionesAfectadas = db.prepare(`
      SELECT COUNT(*) n FROM ml_publicaciones_cache
      WHERE item_id = ? AND variation_id IS NOT NULL AND variation_id != '' AND variation_id != ?
    `).get(itemId, variationId).n;
    if (variacionesAfectadas > 0 && body?.confirmado !== true) {
      return {
        status: 409,
        body: {
          ok: false, requiere_confirmacion: true, variaciones_afectadas: variacionesAfectadas,
          error: `ML no permite pausar una variación individual: esto pausaría toda la publicación, arrastrando ${variacionesAfectadas} variación(es) más. Reenviá con { confirmado: true } para continuar.`,
        },
      };
    }
  }
  // try/catch por consistencia con las dos ramas de /vinculos/:clave/deshacer (mlFetch LANZA
  // ante fallo de transporte, no siempre devuelve {ok:false}): acá la excepción es inocua —
  // no hubo ningún DELETE previo que restaurar, el estado local ya es el correcto tal cual
  // está — pero dejar los tres caminos con el mismo patrón evita que el próximo que lea el
  // código tenga que deducir cuál try/catch importa y cuál es cosmético.
  let resultado;
  try {
    resultado = await pausarPublicacionMl(db, mlCfg, itemId);
  } catch (e) {
    resultado = { ok: false, error: e.message };
  }
  if (!resultado.ok) return { status: 502, body: { ok: false, error: resultado.error, fail_closed: true } };
  return { status: 200, body: { ok: true, estado: 'paused', variaciones_afectadas: variacionesAfectadas } };
}

/**
 * Valida y persiste una decisión "confirmar" de Cobertura sobre una clave ML — camino
 * compartido entre POST /productos/:id_woo/confirmar y POST /solo-ml/:clave/vincular (son el
 * mismo trabajo al revés). Dos guardas agregadas tras hallazgos del revisor:
 *  - La clave tiene que existir en ml_publicaciones_cache: sin esto, una pestaña vieja tras
 *    un refresco que cerró publicaciones podía escribir una decisión hacia una clave muerta
 *    que después fallaba en el push sin que nadie lo supiera en el momento.
 *  - BLOQUEANTE: si la clave YA tiene una decisión viva (cualquier accion) apuntando a OTRO
 *    sku, se rechaza con 409 en vez de pisarla en silencio — ese pisado silencioso era
 *    exactamente el escenario grave del hallazgo (A pierde su vínculo sin aviso porque B lo
 *    confirmó primero contra la misma publicación).
 *
 * Concurrencia optimista (Matcher unificado, entrega 1): la cola está priorizada, así que dos
 * personas trabajando al mismo tiempo probablemente vean primero las mismas publicaciones.
 * `db.prepare().get()` seguido de `.run()` es 100% síncrono (better-sqlite3, sin `await` en el
 * medio) — no hay ventana real de carrera entre el SELECT de `existente` y el INSERT/UPDATE de
 * abajo dentro de este proceso, así que "revalidar antes de escribir" ya está garantizado por
 * el orden del código, sin necesitar transacción ni lock explícito. Cuando SÍ hay conflicto
 * real (otra persona ya lo resolvió con OTRO sku), el 409 devuelve QUIÉN (confirmado_por) y QUÉ
 * (accion/sku/wc_nombre) para que el frontend muestre "Ya lo resolvió Fulano: vinculado a
 * MLA123" y avanza solo — nunca un 409 mudo.
 * `origen: 'cobertura'` distingue estas decisiones de las que escribe el Matcher ML→WC
 * (routes/matcher.js) — necesario para que "resueltos hoy" (progresoHoy) no se infle con
 * trabajo de la otra herramienta (hallazgo del revisor).
 */
function confirmarDecisionCobertura(db, clave, sku, wcNombre, confirmadoPor) {
  const existePublicacion = db.prepare('SELECT 1 FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
  if (!existePublicacion) {
    return { ok: false, status: 400, error: 'La publicación de ML ya no existe en caché (refrescá e intentá de nuevo)' };
  }
  const existente = db.prepare(
    'SELECT sku, accion, wc_nombre, confirmado_por FROM sku_matcher_decisiones WHERE clave = ?'
  ).get(clave);
  if (existente && existente.accion === 'omitir') {
    return {
      ok: false, status: 409,
      error: 'Esta publicación fue descartada del matcher (omitir) y no se puede confirmar desde acá',
    };
  }
  if (existente && existente.sku && existente.sku !== sku) {
    // La cola está priorizada: es probable que dos personas —o la misma con el celular y la
    // compu— vean lo mismo arriba. Distinguir "fuiste vos en otra pestaña" de "fue otro" evita
    // el mensaje absurdo de leer "Ya lo resolvió joaco" siendo Joaco (hallazgo del revisor).
    const propio = existente.confirmado_por && existente.confirmado_por === confirmadoPor;
    return {
      ok: false, status: 409, ya_resuelto: true,
      resuelto_por: existente.confirmado_por || null,
      propio: !!propio,
      accion: existente.accion, sku: existente.sku, wc_nombre: existente.wc_nombre,
      error: propio
        ? `Ya lo resolviste en otra pestaña: vinculado a ${existente.sku}`
        : existente.confirmado_por
          ? `Ya lo resolvió ${existente.confirmado_por}: vinculado a ${existente.sku}`
          : `Esta publicación ya está vinculada al SKU ${existente.sku}`,
    };
  }
  db.prepare(`
    INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
    VALUES (@clave, @sku, @wc_nombre, 'confirmar', 'cobertura', @confirmado_por, @ts)
    ON CONFLICT(clave) DO UPDATE SET
      sku = excluded.sku, wc_nombre = excluded.wc_nombre, accion = excluded.accion,
      origen = excluded.origen, confirmado_por = excluded.confirmado_por, actualizado_en = excluded.actualizado_en
  `).run({ clave, sku, wc_nombre: wcNombre, confirmado_por: confirmadoPor || null, ts: new Date().toISOString() });
  return { ok: true };
}

export function coberturaRouter(db, cfg) {
  const router = express.Router();
  const mlCfg = cfg?.ml ?? cfg;

  function now() { return new Date().toISOString(); }

  // UM1 convierte Cobertura en consulta histórica. Sus botones anteriores podían
  // escribir decisiones, seller_sku o pausas sin caso, responsable, operación durable
  // ni retención de ventas. Incluso el refresco manual se mueve a Guardia/cron: una
  // pantalla retirada no debe poder consumir presupuesto de ML ni crear estados nuevos.
  router.use((req, res, next) => {
    const esLectura = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    // El refresco manual es la misma lectura completa que usa Guardia ML; se conserva
    // como alias compatible, sin habilitar vínculos, pausas ni decisiones legacy.
    if (esLectura || (req.method === 'POST' && req.path === '/actualizar-ml')) return next();
    return res.status(410).json({
      ok: false,
      error: 'Cobertura legacy quedó en modo consulta para evitar vínculos fuera de Guardia ML',
      migracion: 'Abrí Guardia ML, tomá el caso y resolvelo desde la comparación MercadoLibre ↔ WooCommerce.',
    });
  });

  // Cruce WC × ML ya procesado para todas las pestañas de Cobertura (fuente "API de ML").
  // Un solo round-trip y un snapshot consistente de los caches; reemplaza el cruce que
  // el cliente hacía a mano con /api/woo/catalogo + /api/matcher/publicaciones.
  router.get('/cruce', (req, res) => {
    res.json({ ok: true, ...computarCruce(db) });
  });

  // Slices individuales (mismo cruce) — útiles para consumo puntual y para tests.
  router.get('/faltantes', (req, res) => {
    const { faltantes, excluidos } = computarCruce(db);
    res.json({ ok: true, data: faltantes, excluidos, total: faltantes.length });
  });

  // NOTA: GET /multi-publicacion "accionable" (con las 4 acciones) se define más abajo, en
  // la sección de Cobertura accionable — reemplaza este slice liviano de computarCruce.
  // /cruce sigue exponiendo `multiPub` para quien solo quiera el dato crudo.

  router.get('/pausadas', (req, res) => {
    const { pausadas } = computarCruce(db);
    res.json({ ok: true, data: pausadas, total: pausadas.length });
  });

  router.get('/', (req, res) => {
    // Productos en AMBOS: catalogo_cache JOIN sku_matcher_decisiones por SKU
    const enAmbos = db.prepare(`
      SELECT
        c.id_woo, c.nombre, c.sku, c.stock as stock_wc, c.tipo,
        d.clave, d.wc_nombre, d.accion,
        m.cantidad_ml as stock_ml
      FROM catalogo_cache c
      JOIN sku_matcher_decisiones d ON d.sku = c.sku AND d.accion != 'omitir'
      LEFT JOIN ml_stock_estado m ON m.clave = d.clave
      WHERE c.sku IS NOT NULL AND c.sku != ''
      ORDER BY c.nombre
    `).all();

    // Solo en WC: productos sin ningún match en ML (activo).
    // Antes esto usaba un NOT EXISTS correlacionado por cada fila de catalogo_cache
    // (~4900 x ~4900 = escaneo cruzado, ~853ms medidos). Ahora traemos los SKUs con
    // decisión activa a un Set en memoria y filtramos en JS: mismo resultado, unos ms.
    const skusDecididos = new Set(
      db.prepare(
        "SELECT DISTINCT sku FROM sku_matcher_decisiones WHERE accion != 'omitir' AND sku IS NOT NULL AND sku != ''"
      ).all().map((d) => d.sku)
    );

    const soloWc = db.prepare(`
      SELECT c.id_woo, c.nombre, c.sku, c.stock, c.tipo, c.categorias_json
      FROM catalogo_cache c
      WHERE c.tipo != 'variable'
      ORDER BY c.nombre
    `).all()
      .filter((c) => c.sku == null || c.sku === '' || !skusDecididos.has(c.sku))
      .map(({ categorias_json, ...row }) => ({
        ...row,
        no_vendible: esNoVendible({ categorias_json }) ? 1 : 0,
      }));

    // Solo en ML: matches que apuntan a un SKU que ya no existe en WC
    const soloMl = db.prepare(`
      SELECT d.clave, d.sku, d.wc_nombre, d.accion, m.cantidad_ml as stock_ml
      FROM sku_matcher_decisiones d
      LEFT JOIN ml_stock_estado m ON m.clave = d.clave
      WHERE d.accion != 'omitir'
        AND (d.sku IS NULL OR d.sku = ''
          OR NOT EXISTS (
            SELECT 1 FROM catalogo_cache c WHERE c.sku = d.sku
          )
        )
      ORDER BY d.wc_nombre
    `).all();

    res.json({
      ok: true,
      en_ambos: enAmbos,
      solo_wc: soloWc,
      solo_ml: soloMl,
      resumen: {
        total_ambos: enAmbos.length,
        total_solo_wc: soloWc.length,
        total_solo_ml: soloMl.length,
      }
    });
  });

  // ── Exclusiones manuales "solo local" ──────────────────────────────────────
  // Productos WC que no deben publicarse en ML (venta solo en el local físico) y
  // por lo tanto no cuentan como faltantes de cobertura.

  router.get('/exclusiones', (req, res) => {
    const data = db.prepare(
      'SELECT id_woo, sku, nombre, motivo, creado_en FROM cobertura_exclusiones ORDER BY nombre'
    ).all();
    res.json({ ok: true, data });
  });

  router.post('/exclusiones', (req, res) => {
    const { id_woo, sku, nombre } = req.body || {};
    if (id_woo == null || id_woo === '') {
      return res.status(400).json({ ok: false, error: 'id_woo requerido' });
    }
    db.prepare(`
      INSERT INTO cobertura_exclusiones (id_woo, sku, nombre, motivo, creado_en)
      VALUES (@id_woo, @sku, @nombre, 'solo_local', @creado_en)
      ON CONFLICT(id_woo) DO UPDATE SET
        sku = excluded.sku, nombre = excluded.nombre
    `).run({
      id_woo: Number(id_woo),
      sku: sku || null,
      nombre: nombre || null,
      creado_en: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  router.delete('/exclusiones/:id_woo', (req, res) => {
    const info = db.prepare('DELETE FROM cobertura_exclusiones WHERE id_woo = ?')
      .run(Number(req.params.id_woo));
    res.json({ ok: true, borrado: info.changes });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  // Cobertura accionable (matcher inverso WC → ML) — pantalla de entrada, cola por marca,
  // acciones sobre un producto, búsqueda manual, historial/deshacer, multi-publicación,
  // solo ML, hay que publicarlo y sin stock.
  // ═══════════════════════════════════════════════════════════════════════════════════

  function getProducto(id_woo) {
    return db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = ?').get(Number(id_woo));
  }

  // Pantalla de entrada: liviana a propósito (marcas con conteo/valor, NO el universo
  // entero) — es justo lo que el payload de 1 MB de GET / rompía. Requisito explícito.
  router.get('/resumen', (req, res) => {
    const { marcas, total_pendientes, total_valor } = resumenMarcas(db);
    const progreso = progresoHoy(db);
    // Por usuario (migración 012): "seguir donde quedé" ya no es un singleton compartido.
    const retomar = seguirDondeQuede(db, req.user?.id);
    const conteoPorSkuResumen = new Map();
    for (const r of db.prepare("SELECT seller_sku FROM ml_publicaciones_cache WHERE seller_sku IS NOT NULL AND seller_sku != ''").all()) {
      conteoPorSkuResumen.set(r.seller_sku, (conteoPorSkuResumen.get(r.seller_sku) || 0) + 1);
    }
    const excluidosResumen = new Set(db.prepare('SELECT id_woo FROM cobertura_exclusiones').all().map((e) => e.id_woo));
    const otras = {
      hay_que_publicarlo: db.prepare('SELECT COUNT(*) n FROM cobertura_hay_que_publicar').get().n,
      // Conteo de PRODUCTOS con multi-publicación (no de publicaciones individuales); "marcar
      // correcta" es por publicación y no reduce este conteo — es solo para orientar, la
      // lista real vive en GET /multi-publicacion.
      multi_publicacion: db.prepare('SELECT * FROM catalogo_cache').all()
        .filter((p) => esMultiPublicacion(p, conteoPorSkuResumen, excluidosResumen)).length,
      // Mismo criterio EXACTO que GET /solo-ml (sin seller_sku Y sin decisión viva) — si acá
      // se contara distinto, la tarjeta de entrada mostraría un número que la lista real
      // nunca puede alcanzar (incoherencia de conteo señalada por el revisor).
      solo_ml: db.prepare(`
        SELECT COUNT(*) n FROM ml_publicaciones_cache p
        WHERE COALESCE(p.seller_sku,'') = ''
          AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave)
      `).get().n,
      // Mismo criterio EXACTO que GET /sin-stock (ver esa ruta) — antes este conteo no
      // descontaba cubiertos en ML, excluidos ni no-vendibles, así que mostraba un número
      // mayor al de la lista real (incoherencia señalada por el revisor).
      sin_stock: calcularSinStock(db).length,
    };
    res.json({
      ok: true,
      total_pendientes, total_valor,
      marcas: marcas.slice(0, 10),
      total_marcas: marcas.length,
      seguir_donde_quede: retomar,
      progreso_hoy: progreso,
      otras_secciones: otras,
      // "última actualización: hace X" (requisito §9 del plan de flujo) — se lee de la
      // COLUMNA real, no del estado en memoria de dispararRefrescoMl: así sigue disponible
      // sin forzar ningún refresco (incluso recién arrancado el server) y sobrevive un
      // restart, a diferencia de un contador solo en memoria.
      ultima_actualizacion_ml: db.prepare('SELECT MAX(actualizado_en) t FROM ml_publicaciones_cache').get().t ?? null,
      refresco_ml_en_curso: estadoRefrescoMl().running,
    });
  });

  // Botón "Actualizar desde ML" (plan de flujo §1 y §9): fuerza el refresco de TODO el
  // universo de publicaciones ML (ml_publicaciones_cache completo) que alimenta el matcher
  // inverso — no solo las "sin seller_sku": esas se derivan de la misma tabla, así que
  // refrescar solo un subconjunto dejaría stale, por ejemplo, publicaciones que acaban de
  // ganar o perder su seller_sku desde otro lado (el Matcher ML→WC, el push automático).
  // Comparte candado con el Matcher (dispararRefrescoMl) — ver el comentario en
  // routes/matcher.js sobre por qué NO tiene un candado propio. `manual:true` (dentro de
  // refrescarPublicacionesMl) solo saltea el COOLDOWN, nunca el presupuesto de
  // lib/mlLimites.js (reservarCupo se llama siempre, ver lib/mlClient.js).
  router.post('/actualizar-ml', (req, res) => {
    const r = dispararRefrescoMl(db, mlCfg, 'all');
    res.status(r.ok ? 202 : 409).json(r);
  });

  // Estado/resultado del refresco forzado (sondeo). Mismo estado compartido que
  // GET /api/matcher/refrescar-ml/estado — un solo refresco a la vez, se vea desde donde se vea.
  router.get('/actualizar-ml/estado', (req, res) => {
    res.json({ ok: true, ...estadoRefrescoMl() });
  });

  // Todas las marcas (para "ver todas" desde la pantalla de entrada).
  router.get('/marcas', (req, res) => {
    res.json({ ok: true, ...resumenMarcas(db) });
  });

  // Cola de trabajo de una marca, paginada (la tarjeta siguiente no espera al universo
  // entero). Al pedirla se toca la sesión: es la marca "en trabajo" para "seguir donde quedé".
  router.get('/marcas/:marca/cola', (req, res) => {
    const marca = req.params.marca;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    tocarSesion(db, marca, req.user?.id);
    const { total, items } = productosDeMarca(db, marca, { limit, offset });
    const mlIndex = construirIndiceMlSinSku(db);
    const data = items.map((prod) => ({
      ...prod,
      salteado: !!prod.salteado_en,
      ...candidatosDeProducto(prod, mlIndex),
    }));
    res.json({ ok: true, marca, total, data });
  });

  // Búsqueda manual entre publicaciones ML sin SKU para UN producto puntual — mismo diff
  // estructurado que los candidatos sugeridos (la interfaz reusa el mismo componente).
  // Disponible siempre, no solo cuando el motor no encuentra nada (parte del flujo, no un
  // extra de segunda clase).
  router.get('/productos/:id_woo/buscar-ml', (req, res) => {
    const prod = getProducto(req.params.id_woo);
    if (!prod) return res.status(404).json({ ok: false, error: 'producto no encontrado' });
    const mlIndex = construirIndiceMlSinSku(db);
    const data = buscarMlManual(prod, mlIndex, req.query.q, 20);
    res.json({ ok: true, data });
  });

  // Confirmar vínculo: reusa el camino de escritura ya probado (sku_matcher_decisiones +
  // pushSkusPendientes/escribirSkuEnMl), sin inventar uno nuevo. Si ML no responde, la
  // decisión igual queda guardada — el push automático la toma después (cron). Por eso la
  // respuesta distingue explícitamente 'vinculado' (ML confirmó) de 'pendiente_sync'
  // (guardado, todavía no efectivizado): son dos mensajes a propósito distintos.
  router.post('/productos/:id_woo/confirmar', async (req, res) => {
    const prod = getProducto(req.params.id_woo);
    if (!prod) return res.status(404).json({ ok: false, error: 'producto no encontrado' });
    const { ml_clave } = req.body || {};
    const sku = String(prod.sku || '').trim();
    if (!ml_clave || !sku) {
      return res.status(400).json({ ok: false, error: 'ml_clave y un producto con SKU son requeridos' });
    }
    // Se persiste la decisión ANTES de intentar el push: si ML no responde, el usuario no
    // se frena (regla no negociable del encargo) y el cron la va a tomar en su próximo ciclo.
    const decision = confirmarDecisionCobertura(db, ml_clave, sku, prod.nombre, req.user?.username);
    if (!decision.ok) {
      // ya_resuelto: concurrencia optimista (entrega 1 Matcher unificado) — otra persona
      // confirmó esta misma clave con OTRO sku antes que nosotros. El body ya trae quién y
      // qué, para que el frontend muestre "Ya lo resolvió Fulano: vinculado a X" y avance
      // solo, en vez de un 409 mudo.
      return res.status(decision.status).json({
        ok: false, error: decision.error,
        ...(decision.ya_resuelto ? {
          ya_resuelto: true, resuelto_por: decision.resuelto_por, propio: !!decision.propio,
          accion: decision.accion, sku: decision.sku, wc_nombre: decision.wc_nombre,
        } : {}),
      });
    }
    // Se saca de "salteado" si estaba: ya se decidió, no vuelve a aparecer en la tanda.
    db.prepare('DELETE FROM cobertura_salteados WHERE id_woo = ?').run(prod.id_woo);

    let resultado;
    try {
      resultado = await escribirSkuEnMl(db, mlCfg, ml_clave, sku, { manual: true });
    } catch (e) {
      resultado = { ok: false, status: 0, error: e.message };
    }
    if (resultado.ok) {
      res.json({ ok: true, estado: 'vinculado', clave: ml_clave, sku });
    } else {
      res.json({ ok: true, estado: 'pendiente_sync', clave: ml_clave, sku, motivo: resultado.error || 'ML no respondió, se reintenta solo' });
    }
  });

  // "Solo local": mapea 1:1 con cobertura_exclusiones (no hay campo nuevo, regla 3).
  router.post('/productos/:id_woo/descartar', (req, res) => {
    const prod = getProducto(req.params.id_woo);
    if (!prod) return res.status(404).json({ ok: false, error: 'producto no encontrado' });
    db.prepare(`
      INSERT INTO cobertura_exclusiones (id_woo, sku, nombre, motivo, creado_en)
      VALUES (@id_woo, @sku, @nombre, 'solo_local', @creado_en)
      ON CONFLICT(id_woo) DO UPDATE SET sku = excluded.sku, nombre = excluded.nombre
    `).run({ id_woo: prod.id_woo, sku: prod.sku, nombre: prod.nombre, creado_en: now() });
    db.prepare('DELETE FROM cobertura_salteados WHERE id_woo = ?').run(prod.id_woo);
    res.json({ ok: true, estado: 'descartado' });
  });

  // "Hay que publicarlo": sin candidato usable, o mandado ahí a mano desde la tarjeta.
  router.post('/productos/:id_woo/publicar', (req, res) => {
    const prod = getProducto(req.params.id_woo);
    if (!prod) return res.status(404).json({ ok: false, error: 'producto no encontrado' });
    const valor = Number(prod.precio || 0) * Number(prod.stock || 0);
    db.prepare(`
      INSERT INTO cobertura_hay_que_publicar (id_woo, sku, nombre, marca, valor, creado_en)
      VALUES (@id_woo, @sku, @nombre, @marca, @valor, @creado_en)
      ON CONFLICT(id_woo) DO UPDATE SET valor = excluded.valor
    `).run({ id_woo: prod.id_woo, sku: prod.sku, nombre: prod.nombre, marca: prod.marca || null, valor, creado_en: now() });
    db.prepare('DELETE FROM cobertura_salteados WHERE id_woo = ?').run(prod.id_woo);
    res.json({ ok: true, estado: 'hay_que_publicarlo' });
  });

  // Saltear: NO es terminal — vuelve al final de la MISMA tanda (ver productosDeMarca).
  router.post('/productos/:id_woo/saltear', (req, res) => {
    const prod = getProducto(req.params.id_woo);
    if (!prod) return res.status(404).json({ ok: false, error: 'producto no encontrado' });
    db.prepare(`
      INSERT INTO cobertura_salteados (id_woo, marca, creado_en) VALUES (@id_woo, @marca, @ts)
      ON CONFLICT(id_woo) DO UPDATE SET creado_en = excluded.creado_en
    `).run({ id_woo: prod.id_woo, marca: prod.marca || null, ts: now() });
    res.json({ ok: true, estado: 'salteado' });
  });

  // ── Historial y deshacer ────────────────────────────────────────────────────────────

  router.get('/historial', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // origen = 'cobertura': el historial de ESTA herramienta no mezcla vínculos hechos desde
    // el Matcher ML→WC (misma tabla, distinto origen) — mismo criterio que progresoHoy.
    const vinculados = db.prepare(`
      SELECT clave, sku, wc_nombre, actualizado_en,
             (SELECT seller_sku FROM ml_publicaciones_cache p WHERE p.clave = d.clave) AS seller_sku_actual
      FROM sku_matcher_decisiones d
      WHERE accion = 'confirmar' AND origen = 'cobertura' AND (wc_nombre LIKE @q OR sku LIKE @q)
      ORDER BY actualizado_en DESC LIMIT @limit
    `).all({ q, limit }).map((r) => ({
      tipo: 'vinculo', clave: r.clave, sku: r.sku, nombre: r.wc_nombre, fecha: r.actualizado_en,
      // Distinción explícita, mismo criterio que /confirmar: qué mostrar depende de si ML
      // ya tiene el SKU al día o si sigue pendiente de que el cron lo escriba.
      pendiente_sync: r.seller_sku_actual !== r.sku,
    }));
    const descartados = db.prepare(`
      SELECT id_woo, sku, nombre, creado_en FROM cobertura_exclusiones
      WHERE (nombre LIKE @q OR sku LIKE @q) ORDER BY creado_en DESC LIMIT @limit
    `).all({ q, limit }).map((r) => ({
      tipo: 'descarte', id_woo: r.id_woo, sku: r.sku, nombre: r.nombre, fecha: r.creado_en,
    }));
    const data = [...vinculados, ...descartados].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, limit);
    res.json({ ok: true, data });
  });

  // Deshacer un vínculo: vuelve el producto a 'pendiente'. Si el push a ML ya se
  // efectivizó (seller_sku en caché == sku de la decisión), dispara la desvinculación —
  // FAIL-CLOSED (ver desvincularSkuEnMl): si ML no confirma, NO se toca nada localmente y
  // se devuelve el error, para no dejar un estado a mitad de camino (local libre, ML todavía
  // con el SKU viejo) que es exactamente el riesgo de "vínculo equivocado" que el diseño
  // entero de Cobertura vino a evitar.
  router.post('/vinculos/:clave/deshacer', async (req, res) => {
    const clave = req.params.clave;
    // origen = 'cobertura': no se deshace desde acá un vínculo hecho por el Matcher ML→WC
    // (misma tabla, otra herramienta, otro flujo de decisión) — mismo criterio que historial/progreso.
    const decision = db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave = ? AND accion = 'confirmar' AND origen = 'cobertura'").get(clave);
    if (!decision) return res.status(404).json({ ok: false, error: 'vínculo no encontrado' });
    // Deshacer lo PROPIO, o ser admin (hallazgo del revisor). Este endpoint, cuando el vínculo
    // ya se efectivizó, llama desvincularSkuEnMl: borra el mapeo local Y escribe en la
    // publicación de ML en vivo — exactamente lo mismo que "desvincular", que sí es admin-only.
    // Sin esta guarda, cualquier no-admin con matcher:write podía deshacer un vínculo ajeno, de
    // hoy o de hace un mes. Las decisiones anteriores a la migración 013 no tienen
    // `confirmado_por`: quedan solo para admin, que es el default seguro.
    if (!req.user?.is_admin && decision.confirmado_por !== req.user?.username) {
      return res.status(403).json({
        ok: false,
        error: decision.confirmado_por
          ? `este vínculo lo confirmó ${decision.confirmado_por}; solo puede deshacerlo esa persona o un administrador`
          : 'este vínculo es anterior al registro de autoría; solo un administrador puede deshacerlo',
      });
    }
    const cacheRow = db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    const yaEfectivizado = cacheRow && cacheRow.seller_sku === decision.sku;

    if (yaEfectivizado) {
      // try/catch: mlFetch LANZA ante fallo de transporte (lib/mlClient.js — throw e después
      // de _registrarErrorMl), no siempre devuelve { ok:false }. Sin esto, un cable de red
      // tirado saltaba directo a un 500 sin pasar por la guarda de abajo — inocuo acá (el
      // DELETE todavía no ocurrió), pero se envuelve igual para que los tres caminos de
      // desvinculación de este endpoint sean consistentes (ver el bloque post-delete más abajo,
      // donde SÍ importa) y nadie tenga que deducir cuál es cuál.
      let resultado;
      try {
        resultado = await desvincularSkuEnMl(db, mlCfg, clave);
      } catch (e) {
        resultado = { ok: false, error: e.message };
      }
      if (!resultado.ok) {
        // Detectar bloqueo de Guardia y devolver 409 (migración requerida)
        if (resultado.bloqueado_por_guardia) {
          return res.status(409).json({ ok: false, error: resultado.error, bloqueado_por_guardia: true });
        }
        return res.status(502).json({ ok: false, error: resultado.error || 'ML no confirmó la desvinculación', fail_closed: true });
      }
      db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(clave);
      return res.json({ ok: true, estado: 'pendiente' });
    }

    // ALTO corregido (revisor): en el snapshot que acabamos de leer el push todavía no había
    // escrito el SKU, pero pushSkusPendientes corre cada 10 min y puede estar escribiendo
    // esta MISMA clave en este instante — hay una ventana entre nuestro SELECT y el DELETE de
    // abajo. Cortar de entrada si el push está corriendo evita la carrera en el caso común
    // (más barato que esperar el mutex entero); el re-chequeo posterior al DELETE cubre el
    // resto de la ventana (push que arranca justo después de este chequeo).
    if (getEstadoPush().running) {
      return res.status(409).json({
        ok: false, error: 'Hay un push a ML en curso, reintentá en unos segundos', fail_closed: true, push_en_curso: true,
      });
    }

    db.prepare("DELETE FROM sku_matcher_decisiones WHERE clave = ? AND accion = 'confirmar'").run(clave);

    // Re-chequeo POST-delete: si el push ganó la carrera (escribió el SKU en ML DESPUÉS de
    // nuestro SELECT pero ANTES/DURANTE nuestro DELETE), local ya dice "sin decisión" pero ML
    // sigue con el SKU viejo — exactamente la asimetría que este endpoint existe para evitar.
    // FAIL-CLOSED: se intenta desvincular; si ML no confirma, se restaura la decisión local
    // (vuelve a coincidir con la realidad de ML) y se devuelve el error, en vez de dejar local
    // "pendiente" mintiendo que el producto está libre.
    const cacheRowPost = db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    if (cacheRowPost && cacheRowPost.seller_sku === decision.sku) {
      // 🟡 corregido (revisor): mlFetch LANZA ante fallo de transporte (no siempre devuelve
      // {ok:false}) — sin este try/catch, una excepción acá saltaba directo al error handler
      // genérico (500) SIN pasar por la restauración de abajo: la decisión ya estaba borrada
      // (DELETE de la línea de arriba, fuera de este bloque, ya se ejecutó) y ML seguía con el
      // SKU escrito — exactamente la divergencia que este endpoint entero existe para evitar,
      // solo que alcanzable con un cable de red en vez de un 4xx de ML. Silencioso además: la
      // caché queda con el seller_sku, el producto deja de contar como faltante y nadie lo
      // vuelve a ver.
      let resultado;
      try {
        resultado = await desvincularSkuEnMl(db, mlCfg, clave);
      } catch (e) {
        resultado = { ok: false, error: e.message };
      }
      if (!resultado.ok) {
        // Restaurar la decisión ya borrada (para mantener sincronía con ML)
        db.prepare(`
          INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
          VALUES (?, ?, ?, 'confirmar', 'cobertura', ?, ?)
          ON CONFLICT(clave) DO UPDATE SET
            sku=excluded.sku, wc_nombre=excluded.wc_nombre, accion=excluded.accion,
            origen=excluded.origen, confirmado_por=excluded.confirmado_por,
            actualizado_en=excluded.actualizado_en
        `).run(clave, decision.sku, decision.wc_nombre, decision.confirmado_por, now());
        // Detectar bloqueo de Guardia y devolver 409 (migración requerida)
        if (resultado.bloqueado_por_guardia) {
          return res.status(409).json({ ok: false, error: resultado.error, bloqueado_por_guardia: true });
        }
        return res.status(502).json({ ok: false, error: resultado.error || 'ML no confirmó la desvinculación', fail_closed: true });
      }
    }
    res.json({ ok: true, estado: 'pendiente' });
  });

  // ── Vínculos (absorbido de public/vinculos/index.html, Matcher unificado entrega 1) ────
  // Buscar producto (detalle + señales) y Sospechosos, más reasignar/desvincular. Se movió
  // la SUPERFICIE (rutas) bajo el permiso único `matcher`; el motor (filasDeVinculos,
  // cargarDescartes, senalesVigentes, logSync) se sigue calculando en routes/sync.js —ahí
  // también lo usa GET /api/sync/dashboard para `vinculos_sospechosos`— y se reusa vía
  // export, no se duplica. POST /api/sync/desvincular (routes/sync.js) NO se tocó ni se
  // movió: lo sigue usando public/sync-detalle/index.html (herramienta Sync ML, permiso
  // aparte), que es un consumidor distinto del mismo botón conceptual.

  // Detalle de un producto de WC y TODAS las publicaciones de ML mapeadas a su SKU.
  router.get('/vinculos/:sku', (req, res) => {
    const sku = String(req.params.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'sku requerido' });

    const prod = db.prepare(`
      SELECT sku, nombre, stock, regular_price, img FROM catalogo_cache
      WHERE sku = ? AND sku <> '' ORDER BY stock ASC, id_woo ASC LIMIT 1
    `).get(sku);
    if (!prod) return res.status(404).json({ ok: false, error: 'SKU no encontrado en el catálogo' });

    const filas = filasDeVinculos(db, { sku });
    const descartes = cargarDescartes(db);

    const publicaciones = filas.map(f => ({
      clave: f.clave, item_id: f.item_id, variation_id: f.variation_id,
      titulo: f.titulo, status: f.status, sub_status: f.sub_status,
      color: f.color, talle: f.talle, variations_texto: f.variations_texto,
      seller_sku: f.seller_sku, decision_sku: f.sku,
      thumbnail: f.thumbnail, permalink: f.permalink,
      precio_ml: f.precio, precio_actualizado_en: f.precio_actualizado_en,
      stock_ml: f.available_quantity, stock_sincronizado: f.cantidad_ml,
      senales: senalesVigentes(f, descartes),
    }));

    res.json({
      ok: true,
      producto: {
        sku: prod.sku, nombre: prod.nombre, stock: prod.stock, img: prod.img,
        // precio_lista sale de regular_price (LISTA real), no de precio (VIGENTE) — mismo
        // criterio que precio_contado (ver REGLA en CLAUDE.md sobre precios de venta ML).
        precio_lista: prod.regular_price,
        precio_contado: prod.regular_price > 0 ? precioContado(prod.regular_price) : null,
      },
      publicaciones,
    });
  });

  // Listado de vínculos con señales vigentes, ordenado por severidad (alta primero). Se
  // junta conceptualmente con Problemas — es el mismo tipo de trabajo ("cosas que el sistema
  // marca como raras"), no un flujo de decidir sí/no como la cola principal.
  router.get('/vinculos-sospechosos', (req, res) => {
    const descartes = cargarDescartes(db);
    const data = [];
    for (const f of filasDeVinculos(db)) {
      const senales = senalesVigentes(f, descartes);
      if (senales.length === 0) continue;
      data.push({
        clave: f.clave, sku: f.sku, item_id: f.item_id,
        titulo: f.titulo, wc_nombre: f.wc_nombre, thumbnail: f.thumbnail, permalink: f.permalink,
        precio_ml: f.precio, precio_wc: f.precio_wc, senales,
      });
    }
    data.sort((a, b) => {
      const peor = (x) => (x.senales.some(s => s.peso === 'alta') ? 0 : 1);
      return peor(a) - peor(b) || b.senales.length - a.senales.length;
    });
    res.json({ ok: true, data });
  });

  // Marcar una señal como revisada y correcta. Guarda el VALOR: si el dato cambia, reaparece.
  router.post('/vinculos/revisado', (req, res) => {
    const { clave, senal, valor } = req.body || {};
    if (!clave || typeof clave !== 'string') return res.status(400).json({ ok: false, error: 'clave requerida' });
    if (!senal || typeof senal !== 'string') return res.status(400).json({ ok: false, error: 'senal requerida' });
    if (valor == null || typeof valor !== 'string') return res.status(400).json({ ok: false, error: 'valor requerido' });
    const pub = db.prepare('SELECT 1 FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    if (!pub) return res.status(400).json({ ok: false, error: 'La clave no existe en el caché de publicaciones' });

    db.prepare(`
      INSERT INTO ml_vinculos_revisados (clave, senal, valor_revisado, revisado_por, revisado_en)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(clave, senal) DO UPDATE SET
        valor_revisado=excluded.valor_revisado, revisado_por=excluded.revisado_por, revisado_en=excluded.revisado_en
    `).run(clave, senal, valor, req.user?.username ?? null, now());
    res.json({ ok: true });
  });

  // Reasignar el vínculo a otro SKU. Mismo statement que usa el matcher para sus decisiones.
  // NO es admin-only (a diferencia de desvincular): reasignar corrige un vínculo equivocado
  // asignándolo al SKU correcto, es trabajo normal de la cola, no una acción destructiva.
  router.post('/vinculos/reasignar', (req, res) => {
    const body = req.body || {};
    const { clave, sku } = body;
    if (!clave || typeof clave !== 'string') return res.status(400).json({ ok: false, error: 'clave requerida' });
    if (!sku || typeof sku !== 'string') return res.status(400).json({ ok: false, error: 'sku requerido' });
    if (!Object.prototype.hasOwnProperty.call(body, 'expected_sku')) {
      return res.status(400).json({ ok: false, error: 'expected_sku requerido (string o null)' });
    }
    const expectedSku = body.expected_sku == null ? null : String(body.expected_sku).trim();
    if (body.expected_sku != null && !expectedSku) {
      return res.status(400).json({ ok: false, error: 'expected_sku debe ser un string no vacío o null' });
    }
    const pub = db.prepare('SELECT 1 FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    if (!pub) return res.status(400).json({ ok: false, error: 'La clave no existe en el caché de publicaciones' });
    const prod = db.prepare("SELECT nombre FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1").get(sku);
    if (!prod) return res.status(400).json({ ok: false, error: 'El SKU no existe en el catálogo' });

    // Control optimista explícito: expected_sku es el snapshot que vio el cliente (null si
    // no había decisión). Una decisión moderna SÍ puede cambiar deliberadamente cuando el
    // snapshot coincide; si otra pestaña/persona ganó antes, devuelve 409 y no pisa nada.
    const resultado = db.transaction(() => {
      const existente = db.prepare('SELECT sku, confirmado_por, wc_nombre, accion FROM sku_matcher_decisiones WHERE clave = ?').get(clave);
      const skuActual = existente?.sku || null;
      if (skuActual !== expectedSku) return { conflicto: true, existente, skuActual };

      db.prepare(`
        INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
        VALUES (?, ?, ?, 'confirmar', 'cobertura', ?, ?)
        ON CONFLICT(clave) DO UPDATE SET
          sku=excluded.sku, wc_nombre=excluded.wc_nombre, accion=excluded.accion,
          origen=excluded.origen, confirmado_por=excluded.confirmado_por,
          actualizado_en=excluded.actualizado_en
      `).run(clave, sku, prod.nombre, req.user?.username ?? null, now());
      // Los descartes valían para el vínculo anterior, no para el nuevo.
      db.prepare('DELETE FROM ml_vinculos_revisados WHERE clave = ?').run(clave);
      return { conflicto: false, skuAnterior: skuActual };
    })();

    if (resultado.conflicto) {
      const existente = resultado.existente || {};
      const propio = existente.confirmado_por && existente.confirmado_por === req.user?.username;
      return res.status(409).json({
        ok: false,
        ya_resuelto: true,
        resuelto_por: existente.confirmado_por || null,
        propio: !!propio,
        accion: existente.accion || null,
        expected_sku: expectedSku,
        sku_actual: resultado.skuActual,
        sku: resultado.skuActual,
        wc_nombre: existente.wc_nombre,
        error: propio
          ? `el vínculo cambió en otra pestaña: ahora apunta a ${resultado.skuActual}`
          : existente.confirmado_por
            ? `el vínculo cambió; ${existente.confirmado_por} lo dejó en ${resultado.skuActual}`
            : `el vínculo cambió: ahora apunta a ${resultado.skuActual}`,
      });
    }
    logSync(db, { direccion: 'wc_ml', clave, sku, estado: 'remapeo_requerido', error: 'reasignada manualmente desde el Matcher (Vínculos)' });
    res.json({ ok: true, clave, sku_anterior: resultado.skuAnterior, sku });
  });

  // ADMIN-ONLY (permiso único `matcher`, entrega 1): desvincular (borrar el mapeo para que
  // se vuelva a linkear) es la otra excepción, junto con pausar. Equivalente conceptual de
  // POST /api/sync/desvincular (que NO se tocó, sigue siendo el que usa Sync ML Detalle, otro
  // consumidor con otro permiso) pero expuesto acá con el gate admin que pide esta entrega.
  router.post('/vinculos/:clave/desvincular', requireAdmin, (req, res) => {
    const clave = req.params.clave;
    const info = db.transaction(() => {
      const r = db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(clave);
      db.prepare('DELETE FROM ml_vinculos_revisados WHERE clave = ?').run(clave);
      return r;
    })();
    logSync(db, { direccion: 'wc_ml', clave, estado: 'remapeo_requerido', error: 'desvinculada manualmente desde el Matcher para re-mapear' });
    res.json({ ok: true, borradas: info.changes });
  });

  router.delete('/exclusiones/:id_woo/revertir', (req, res) => {
    const info = db.prepare('DELETE FROM cobertura_exclusiones WHERE id_woo = ?').run(Number(req.params.id_woo));
    if (!info.changes) return res.status(404).json({ ok: false, error: 'no encontrado' });
    res.json({ ok: true, estado: 'pendiente' });
  });

  // ── Hay que publicarlo ──────────────────────────────────────────────────────────────

  router.get('/hay-que-publicar', (req, res) => {
    const data = db.prepare('SELECT * FROM cobertura_hay_que_publicar ORDER BY valor DESC').all();
    res.json({ ok: true, data, total: data.length });
  });

  router.patch('/hay-que-publicar/:id_woo', (req, res) => {
    const { tachado } = req.body || {};
    const info = db.prepare('UPDATE cobertura_hay_que_publicar SET tachado = ? WHERE id_woo = ?')
      .run(tachado ? 1 : 0, Number(req.params.id_woo));
    if (!info.changes) return res.status(404).json({ ok: false, error: 'no encontrado' });
    res.json({ ok: true });
  });

  // Revierte "hay que publicarlo" a pendiente (vuelve a la cola de su marca).
  router.delete('/hay-que-publicar/:id_woo', (req, res) => {
    const info = db.prepare('DELETE FROM cobertura_hay_que_publicar WHERE id_woo = ?').run(Number(req.params.id_woo));
    if (!info.changes) return res.status(404).json({ ok: false, error: 'no encontrado' });
    res.json({ ok: true, estado: 'pendiente' });
  });

  router.get('/hay-que-publicar/export.csv', (req, res) => {
    const data = db.prepare('SELECT * FROM cobertura_hay_que_publicar ORDER BY valor DESC').all();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hay-que-publicar.csv"');
    res.send(generarCSVHayQuePublicar(data));
  });

  // ── Multi-publicación (>2 publicaciones por SKU, umbral existente de lib/cobertura.js) ──

  router.get('/multi-publicacion', (req, res) => {
    const conteoPorSku = new Map();
    const pubsPorSku = new Map();
    for (const r of db.prepare(`
      SELECT item_id, variation_id, clave, seller_sku, status, available_quantity
      FROM ml_publicaciones_cache WHERE seller_sku IS NOT NULL AND seller_sku != ''
    `).all()) {
      conteoPorSku.set(r.seller_sku, (conteoPorSku.get(r.seller_sku) || 0) + 1);
      if (!pubsPorSku.has(r.seller_sku)) pubsPorSku.set(r.seller_sku, []);
      pubsPorSku.get(r.seller_sku).push(r);
    }
    const excluidos = new Set(db.prepare('SELECT id_woo FROM cobertura_exclusiones').all().map((e) => e.id_woo));
    // "Marcar correcta" SUPRIME la publicación de la lista (migración 007, texto literal:
    // "para que no vuelva a aparecer" — el usuario lo pidió así). Un flag que la fila ignora
    // no cumple eso; corregido tras el hallazgo del revisor (el test anterior verificaba el
    // flag, no la desaparición — el nombre del test mentía).
    const marcadas = new Set(db.prepare("SELECT clave FROM cobertura_marcados_correcto WHERE seccion = 'multi_publicacion'").all().map((r) => r.clave));
    const productos = db.prepare('SELECT * FROM catalogo_cache').all()
      .filter((p) => esMultiPublicacion(p, conteoPorSku, excluidos))
      .map((p) => {
        const sku = String(p.sku).trim();
        const todas = pubsPorSku.get(sku) || [];
        const pubs = todas
          .filter((pub) => !marcadas.has(pub.clave))
          .map((pub) => ({
            clave: pub.clave, item_id: pub.item_id, variation_id: pub.variation_id,
            status: pub.status, stock: pub.available_quantity,
            // "sin_stock_ml" (antes mal llamado "sobreventa"): esta publicación puntual no
            // tiene stock cargado en ML. NO es sobreventa — sobreventa es lo contrario: ML
            // ofreciendo MÁS stock del que hay físicamente en WC (ver `sobreventa` a nivel
            // de producto, más abajo). Con el nombre viejo, la publicación agotada se pintaba
            // de riesgo y la que de verdad sobrevendía pasaba limpia (hallazgo del revisor).
            sin_stock_ml: !(Number(pub.available_quantity) > 0),
          }));
        if (!pubs.length) return null; // todo lo que había se marcó correcto: no hay nada que revisar
        // Sobreventa REAL a nivel de producto: la suma de lo que ML ofrece en TODAS sus
        // publicaciones activas (visibles, sin marcar-correcta) supera el stock físico único
        // de WC — el mismo stock se está prometiendo más de una vez.
        const stockMlActivo = todas
          .filter((pub) => pub.status === 'active')
          .reduce((acc, pub) => acc + (Number(pub.available_quantity) || 0), 0);
        const sobreventa = stockMlActivo > Number(p.stock || 0);
        return { id_woo: p.id_woo, nombre: p.nombre, sku, stock_wc: p.stock, sobreventa, publicaciones: pubs };
      })
      .filter(Boolean);
    res.json({ ok: true, data: productos, total: productos.length });
  });

  router.post('/multi-publicacion/:clave/marcar-correcta', (req, res) => {
    db.prepare(`
      INSERT INTO cobertura_marcados_correcto (clave, seccion, marcado_en) VALUES (?, 'multi_publicacion', ?)
      ON CONFLICT(clave) DO UPDATE SET marcado_en = excluded.marcado_en
    `).run(req.params.clave, now());
    res.json({ ok: true });
  });

  // ALTO corregido (revisor): ML no permite pausar una variación individual — PUT
  // /items/{itemId} pausa la publicación ENTERA, arrastrando a todas sus variaciones
  // hermanas (incluidas las bien vinculadas y vendiendo). En Multi-publicación el usuario ve
  // una fila por CLAVE (variación incluida) y cree pausar solo esa. Resolución elegida: NO
  // pausar en silencio — si la clave es una variación con hermanas, se exige confirmación
  // explícita (`{ confirmado: true }` en el body) y se informa cuántas variaciones arrastra
  // ANTES de ejecutar. Sin confirmación, 409 con el conteo — nunca 200 con un efecto que el
  // usuario no pidió.
  //
  // ADMIN-ONLY (permiso único `matcher`, entrega 1): pausar/desvincular son las dos
  // excepciones — Joaco (no-admin) trabaja la cola completa pero no estas dos acciones. El
  // backend las rechaza con `requireAdmin`, no confía en que el frontend las esconda.
  router.post('/multi-publicacion/:clave/pausar', requireAdmin, async (req, res) => {
    const r = await pausarConAdvertencia(db, mlCfg, req.params.clave, req.body);
    res.status(r.status).json(r.body);
  });

  router.post('/multi-publicacion/:clave/desvincular', requireAdmin, async (req, res) => {
    // Mismo try/catch que los otros caminos de escritura a ML de este router: mlFetch LANZA
    // ante fallo de transporte, no devuelve {ok:false}. Acá la excepción no produce
    // divergencia (el DELETE local ocurre recién después de que ML confirma, así que un throw
    // deja las dos puntas intactas), pero sin esto la respuesta es un 500 genérico en vez del
    // 502 con fail_closed — y el frontend, que distingue esos casos para no mentir sobre la
    // causa, mostraría el mensaje equivocado.
    let resultado;
    try {
      resultado = await desvincularSkuEnMl(db, mlCfg, req.params.clave);
    } catch (e) {
      resultado = { ok: false, error: e.message };
    }
    if (!resultado.ok) {
      // Detectar bloqueo de Guardia y devolver 409 (migración requerida)
      if (resultado.bloqueado_por_guardia) {
        return res.status(409).json({ ok: false, error: resultado.error, bloqueado_por_guardia: true });
      }
      return res.status(502).json({ ok: false, error: resultado.error, fail_closed: true });
    }
    db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(req.params.clave);
    res.json({ ok: true });
  });

  // ── Solo ML (publicaciones sin seller_sku) ──────────────────────────────────────────

  router.get('/solo-ml', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // Mismo criterio que construirIndiceMlSinSku (BLOQUEANTE corregido): sin seller_sku Y sin
    // decisión viva en sku_matcher_decisiones (omitidas por el Matcher, o ya confirmadas para
    // otro SKU con el push todavía pendiente) — ver el comentario extenso en lib/coberturaCola.js.
    const FILTRO = `
      FROM ml_publicaciones_cache p
      WHERE COALESCE(p.seller_sku,'') = '' AND p.titulo LIKE @q
        AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave)
        AND p.clave NOT IN (SELECT clave FROM cobertura_marcados_correcto WHERE seccion = 'solo_ml')`;
    const total = db.prepare(`SELECT COUNT(*) n ${FILTRO}`).get({ q }).n;
    const rows = db.prepare(`
      SELECT p.clave, p.item_id, p.variation_id, p.titulo, p.status, p.thumbnail, p.precio, p.available_quantity
      ${FILTRO}
      ORDER BY p.titulo LIMIT @limit OFFSET @offset
    `).all({ q, limit, offset });
    res.json({ ok: true, data: rows, total });
  });

  router.post('/solo-ml/:clave/marcar-correcta', (req, res) => {
    db.prepare(`
      INSERT INTO cobertura_marcados_correcto (clave, seccion, marcado_en) VALUES (?, 'solo_ml', ?)
      ON CONFLICT(clave) DO UPDATE SET marcado_en = excluded.marcado_en
    `).run(req.params.clave, now());
    res.json({ ok: true });
  });

  // ADMIN-ONLY (permiso único `matcher`, entrega 1): pausar una publicación es una de las
  // dos excepciones — Joaco (no-admin) tiene acceso a toda la cola pero no a esta acción. El
  // backend la rechaza, no confía en que el frontend la esconda.
  router.post('/solo-ml/:clave/pausar', requireAdmin, async (req, res) => {
    const r = await pausarConAdvertencia(db, mlCfg, req.params.clave, req.body);
    res.status(r.status).json(r.body);
  });

  // Vincular una publicación "solo ML" a un producto web (el mismo trabajo al revés):
  // mismo camino de escritura (escribirSkuEnMl), mismo criterio fail-open que /confirmar.
  router.post('/solo-ml/:clave/vincular', async (req, res) => {
    const { id_woo } = req.body || {};
    const prod = getProducto(id_woo);
    if (!prod) return res.status(400).json({ ok: false, error: 'id_woo inválido' });
    const sku = String(prod.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'el producto no tiene SKU' });
    const clave = req.params.clave;
    const decision = confirmarDecisionCobertura(db, clave, sku, prod.nombre, req.user?.username);
    if (!decision.ok) {
      return res.status(decision.status).json({
        ok: false, error: decision.error,
        ...(decision.ya_resuelto ? {
          ya_resuelto: true, resuelto_por: decision.resuelto_por, propio: !!decision.propio,
          accion: decision.accion, sku: decision.sku, wc_nombre: decision.wc_nombre,
        } : {}),
      });
    }
    let resultado;
    try {
      resultado = await escribirSkuEnMl(db, mlCfg, clave, sku, { manual: true });
    } catch (e) {
      resultado = { ok: false, status: 0, error: e.message };
    }
    // Detectar bloqueo de Guardia y devolver 409 (migración requerida)
    if (!resultado.ok && resultado.bloqueado_por_guardia) {
      return res.status(409).json({ ok: false, error: resultado.error, bloqueado_por_guardia: true });
    }
    res.json({ ok: true, estado: resultado.ok ? 'vinculado' : 'pendiente_sync', clave, sku });
  });

  // ── Sin stock (lista aparte, por si reponen — no se mezcla con la cola principal) ──────

  router.get('/sin-stock', (req, res) => {
    const data = calcularSinStock(db);
    res.json({ ok: true, data, total: data.length });
  });

  return router;
}
