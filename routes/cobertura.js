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
import { generarCSVHayQuePublicar } from '../lib/csv.js';
import { dispararRefrescoMl, estadoRefrescoMl } from './matcher.js';
import { precioContado } from '../lib/mlPrecios.js';
import { filasDeVinculos, cargarDescartes, senalesVigentes } from './sync.js';
import { FILTRO_MARKETPLACE } from '../lib/identidadProductos.js';

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
  // Sólo lo que se vende por el marketplace. Un ítem cuyo `channels` no incluye "marketplace"
  // es un LINK DE PAGO de Mercado Pago: no se vende por ML, no se prepara, no tiene producto de
  // Woo detrás y su stock es 99.999 por diseño. Contarlos acá los muestra como publicaciones
  // sin vincular y sin stock controlado, que es ruido que el usuario tiene que descartar a mano
  // cada vez. Al 2026-09-12 son 139 (111 activas) de 6.917.
  //
  // Es la TERCERA vez que este mismo ruido hay que tapar: guardiaMl.js ya los excluye
  // (ahí los 67 casos abiertos eran todos links de pago) y identidadProductos.js definió
  // FILTRO_MARKETPLACE para lo mismo. Se reusa esa constante en lugar de escribir otra.
  const mlRows = db.prepare(`
    SELECT item_id, variation_id, titulo, status, seller_sku, variations_texto
    FROM ml_publicaciones_cache
    WHERE ${FILTRO_MARKETPLACE}
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

export function coberturaRouter(db, cfg) {
  const router = express.Router();
  const mlCfg = cfg?.ml ?? cfg;

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
          AND ${FILTRO_MARKETPLACE}
          AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave)
      `).get().n,
      // Mismo criterio EXACTO que GET /sin-stock (ver esa ruta) — antes este conteo no
      // descontaba cubiertos en ML, excluidos ni no-vendibles, así que mostraba un número
      // mayor al de la lista real (incoherencia señalada por el revisor).
      sin_stock: calcularSinStock(db).length,
      // Mismo criterio EXACTO que GET /vinculos-sospechosos: vínculos ya hechos con al menos
      // una señal vigente (precio/stock/título no coinciden) sin descartar. Antes vivía solo
      // en /vinculos/, una pantalla huérfana que apuntaba a un endpoint ya migrado — no tenía
      // ninguna entrada de navegación real.
      sospechosos: (() => {
        const descartes = cargarDescartes(db);
        let n = 0;
        for (const fila of filasDeVinculos(db, { ordenar: false })) {
          if (senalesVigentes(fila, descartes).length > 0) n++;
        }
        return n;
      })(),
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
        AND ${FILTRO_MARKETPLACE}
        AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave)
        AND p.clave NOT IN (SELECT clave FROM cobertura_marcados_correcto WHERE seccion = 'solo_ml')`;
    const total = db.prepare(`SELECT COUNT(*) n ${FILTRO}`).get({ q }).n;
    // Orden por urgencia real, no alfabético: activa+con stock vendible YA sin SKU (riesgo de
    // sobreventa, es el motivo original de este cambio) primero; pausadas al final porque no
    // están perdiendo ventas ahora mismo. Sin esto, con ~1500 pausadas y una decena de activas
    // mezcladas alfabéticamente, un operador tiene que scrollear casi todo para encontrar lo
    // que realmente urge.
    const rows = db.prepare(`
      SELECT p.clave, p.item_id, p.variation_id, p.titulo, p.status, p.thumbnail, p.precio, p.available_quantity
      ${FILTRO}
      ORDER BY
        CASE WHEN p.status = 'active' AND COALESCE(p.available_quantity, 0) > 0 THEN 0
             WHEN p.status = 'active' THEN 1
             ELSE 2 END,
        p.available_quantity DESC,
        p.titulo
      LIMIT @limit OFFSET @offset
    `).all({ q, limit, offset });
    res.json({ ok: true, data: rows, total });
  });

  // ── Sin stock (lista aparte, por si reponen — no se mezcla con la cola principal) ──────

  router.get('/sin-stock', (req, res) => {
    const data = calcularSinStock(db);
    res.json({ ok: true, data, total: data.length });
  });

  return router;
}
