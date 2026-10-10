/**
 * Fase D, pantalla "Catálogo y vínculos": lecturas que la API arma sobre Identidad.
 * Solo lectura; las escrituras viven en lib/identidadProductos.js.
 */

import { atributosDeTexto, contradiccionDeClave } from './contradiccionTitulo.js';
import { tokensQ, coincideTokens, normTexto as norm } from './textoBusqueda.js';
import { claveGtin } from './gtin.js';
import { saludPipelineEventos, webhooksWooCaidos } from './wooWebhooks.js';
import { frenaIdentidad } from './proteccionIdentidad.js';
import { clavesDePedidoRetenido, retencionResuelta } from './guardiaMl.js';
import { listarPausasIdentidad } from './pausasIdentidad.js';
import {
  conciliacionIdentidad, conflictosDeBolsaCompartida, conflictosDeIdentificador, clavesEsperandoProteccion,
  estadoIdentidadProductos, listarColasIdentidad, listarOperacionesIdentidad, obtenerCasoIdentidad,
  publicacionesSinRespaldoWoo,
} from './identidadProductos.js';

const DIA_MS = 86400000;
const ESTADOS_CERRADOS = ['resuelto', 'verificado', 'exceptuado'];

/**
 * Plata en juego de cada caso abierto: unidades vendidas en ML en los últimos 30 días POR ESA PUBLICACIÓN
 * (`ml_key`, no por SKU) × stock actual del producto Woo. Sin producto Woo o sin stock conocido la plata es 0
 * y el orden cae a la antigüedad del caso.
 * Devuelve un Map(ml_key → fila) ya ordenado: plata desc y, con empate, `primera_deteccion_en` asc.
 */
export function plataEnJuego(db, { ahora = new Date(), dias = 30 } = {}) {
  const desde = new Date(ahora.getTime() - dias * DIA_MS).toISOString();
  const casos = db.prepare(`SELECT c.id AS caso_id, c.ml_key, c.primera_deteccion_en,
      COALESCE(
        (SELECT cc.stock FROM productos_fusion p JOIN catalogo_cache cc ON cc.id_woo=p.primary_woo_id WHERE p.id=c.producto_id),
        (SELECT cc.stock FROM sku_matcher_decisiones d JOIN catalogo_cache cc ON cc.sku=d.sku AND cc.sku<>''
           WHERE d.clave=c.ml_key AND d.accion IN ('asignar','confirmar') LIMIT 1)
      ) AS stock_woo
    FROM identidad_casos c
    WHERE c.direccion='ml_fusion' AND c.estado NOT IN (${ESTADOS_CERRADOS.map(() => '?').join(',')})`).all(...ESTADOS_CERRADOS);
  const ventas = new Map(db.prepare(`SELECT i.ml_key, COALESCE(SUM(i.cantidad),0) AS unidades
    FROM gestion_pedido_items i JOIN gestion_pedidos p ON p.id=i.pedido_id
    WHERE p.fuente='mercadolibre' AND p.estado_comercial<>'cancelado' AND i.ml_key IS NOT NULL
      AND COALESCE(p.creado_fuente_en,p.importado_en)>=?
    GROUP BY i.ml_key`).all(desde).map((r) => [r.ml_key, r.unidades]));
  const filas = casos.map((c) => {
    const unidades = ventas.get(c.ml_key) ?? 0;
    const stock = c.stock_woo == null ? null : Number(c.stock_woo);
    return { caso_id: c.caso_id, ml_key: c.ml_key, unidades_30d: unidades, stock_woo: stock,
      plata: stock == null ? 0 : unidades * Math.max(stock, 0), primera_deteccion_en: c.primera_deteccion_en };
  });
  filas.sort((a, b) => b.plata - a.plata || String(a.primera_deteccion_en).localeCompare(String(b.primera_deteccion_en)));
  return new Map(filas.map((f) => [f.ml_key, f]));
}

const SEMAFORO_TEXTO = { verde: 'Coincide', rojo: 'Difiere', ambar: 'Falta', gris: 'No aplica' };

function filaMatriz(campo, etiqueta, ml, candidato, semaforo, texto = SEMAFORO_TEXTO[semaforo]) {
  return { campo, etiqueta, ml: ml ?? null, candidato: candidato ?? null, semaforo, texto };
}

/** Compara dos listas de valores ya normalizados. Vacías de ambos lados = no aplica. */
function compararListas(ml, cand, rojo) {
  if (!ml.length && !cand.length) return 'gris';
  if (!ml.length || !cand.length) return 'ambar';
  if (rojo) return 'rojo';
  return ml.some((v) => cand.includes(v)) && ml.length === cand.length ? 'verde' : 'ambar';
}

/**
 * Matriz de atributos de una publicación contra el producto Woo candidato (por SKU).
 * Semáforo (siempre con texto): rojo = veto (mismo criterio que `contradiccionDeClave`, así coincide con lo
 * que bloquea el backend), ámbar = falta un dato o difiere solo en el formato, verde = coincide, gris = no aplica.
 * El GTIN se compara aparte (`claveGtin`) y, si difiere, es ámbar y marca `leve`: no es veto.
 */
export function matrizAtributos(db, clave, sku) {
  const pub = db.prepare('SELECT titulo,color,talle,variations_texto,seller_sku,gtin FROM ml_publicaciones_cache WHERE clave=?').get(clave);
  const woo = db.prepare('SELECT nombre,sku,gtin FROM catalogo_cache WHERE sku=? ORDER BY stock ASC, id_woo ASC LIMIT 1').get(sku);
  if (!pub || !woo) return { veto: false, leve: false, motivos: [], filas: [] };
  const { contradice, motivos } = contradiccionDeClave(db, clave, sku);
  const rojoDe = (campo) => motivos.some((m) => m.campo === campo);
  const textoMl = `${pub.titulo ?? ''} ${pub.variations_texto ?? ''}`;
  const ml = atributosDeTexto(textoMl, { talle: pub.talle, color: pub.color });
  const cand = atributosDeTexto(woo.nombre ?? '');
  const filas = [];

  filas.push(filaMatriz('titulo', 'Título', pub.titulo, woo.nombre,
    norm(pub.titulo) === norm(woo.nombre) ? 'verde' : 'ambar', norm(pub.titulo) === norm(woo.nombre) ? 'Coincide' : 'Falta'));
  const skuMl = norm(pub.seller_sku); const skuCand = norm(woo.sku);
  filas.push(filaMatriz('sku', 'SKU', pub.seller_sku, woo.sku, !skuMl ? 'ambar' : skuMl === skuCand ? 'verde' : 'rojo',
    !skuMl ? 'Falta' : skuMl === skuCand ? 'Coincide' : 'Difiere'));

  const gMl = claveGtin(pub.gtin); const gCand = claveGtin(woo.gtin);
  const gSem = !gMl && !gCand ? 'gris' : !gMl || !gCand ? 'ambar' : gMl === gCand ? 'verde' : 'ambar';
  filas.push(filaMatriz('gtin', 'GTIN', pub.gtin, woo.gtin, gSem, gSem === 'ambar' && gMl && gCand ? 'Difiere' : SEMAFORO_TEXTO[gSem]));

  const lista = (campo, etiqueta, mlVals, candVals) => {
    const a = mlVals.map(String).map(norm); const b = candVals.map(String).map(norm);
    const sem = compararListas(a, b, rojoDe(campo));
    filas.push(filaMatriz(campo, etiqueta, mlVals.join('/') || null, candVals.join('/') || null, sem));
  };
  lista('color', 'Color', ml.colores, cand.colores);
  lista('talle', 'Talle', ml.talles, cand.talles);
  lista('rodado', 'Rodado', ml.rodados, cand.rodados);
  lista('transmision', 'Transmisión', ml.transmision ? [ml.transmision] : [], cand.transmision ? [cand.transmision] : []);
  lista('velocidades', 'Velocidades', ml.velocidades, cand.velocidades);

  const leve = filas.some((f) => f.campo === 'gtin' && f.semaforo === 'ambar' && f.texto === 'Difiere');
  return { veto: contradice, leve, motivos, filas };
}

// ── Cola ────────────────────────────────────────────────────────────────────────────────────────────────────

export const FILTROS_COLA = ['abiertos', 'salteados', 'intervencion', 'pausadas'];

/** Salteo vigente de un caso: vale mientras el caso no cambie de versión (cualquier cambio lo devuelve a la cola). */
/** Último evento de caso de una lista de tipos, por caso: { evento, actor, detalle, creado_en }. Una sola consulta para la cola. */
function ultimoEventoPorCaso(db, eventos, casoId = null) {
  const marcas = eventos.map(() => '?').join(',');
  const filtroCaso = casoId == null ? '' : ' AND entidad_id=?';
  const params = casoId == null ? eventos : [...eventos, casoId];
  return new Map(db.prepare(`SELECT entidad_id,evento,actor,detalle_json,creado_en FROM identidad_historial
    WHERE entidad_tipo='caso' AND evento IN (${marcas})${filtroCaso}
      AND id IN (SELECT MAX(id) FROM identidad_historial WHERE entidad_tipo='caso' AND evento IN (${marcas})${filtroCaso} GROUP BY entidad_id)`)
    .all(...params, ...params).map((r) => [r.entidad_id, { ...r, detalle: safeJson(r.detalle_json) }]));
}
const EVENTOS_SALTEO = ['caso_salteado', 'salteo_deshecho'];
// Un salteo vale mientras el último evento de salteo sea 'caso_salteado' con la misma versión; 'salteo_deshecho' lo anula.
export function salteoVigente(db, caso) {
  const ev = ultimoEventoPorCaso(db, EVENTOS_SALTEO, caso.id).get(caso.id);
  return ev ? actorSiVigente(ev, caso.expected_version) : null;
}
function actorSiVigente(ev, version) {
  if (ev.evento !== 'caso_salteado') return null;
  return ev.detalle?.expected_version === version ? ev.actor : null;
}

const EVENTOS_NINGUNO = ['ninguno_sirve', 'ninguno_sirve_deshecho'];
/** "Ninguno sirve" (tecla x): vigente si el último evento es 'ninguno_sirve' y la evidencia no cambió desde entonces.
 *  Cuando cambia el evidence_fingerprint (p. ej. aparece un candidato automático nuevo) vuelve a la cola sola. */
export function ningunoVigente(db, caso) {
  const ev = ultimoEventoPorCaso(db, EVENTOS_NINGUNO, caso.id).get(caso.id);
  if (!ev || ev.evento !== 'ninguno_sirve') return null;
  return ev.detalle?.evidence_fingerprint === caso.evidencia_fingerprint ? ev : null;
}

const LIMITE_COLA = 50;
const LIMITE_COLA_MAX = 200;

/**
 * Cola de casos de la pantalla. Orden: plata en juego desc, antigüedad asc. Cada fila trae lo que la tarjeta muestra:
 * título, motivo, plata y los chips PAUSADA / HERMANAS n / INTERVENCIÓN.
 * Sin N+1: casos, publicaciones, hermanas y salteos salen de consultas únicas; el filtro `q` se aplica antes de armar
 * cada fila y la paginación (`limit`/`offset`) después de ordenar. `total` es el de antes de paginar.
 */
export function colaCasos(db, { filtro = 'abiertos', q = '', limit = LIMITE_COLA, offset = 0, ahora = new Date() } = {}) {
  if (!FILTROS_COLA.includes(filtro)) return { ok: false, code: 'INVALID_INPUT', error: `filtro inválido: ${FILTROS_COLA.join(', ')}` };
  const lim = Math.min(Math.max(parseInt(limit, 10) || LIMITE_COLA, 1), LIMITE_COLA_MAX);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const tokens = tokensQ(q);
  const plata = plataEnJuego(db, { ahora });
  const casos = db.prepare(`SELECT c.id,c.ml_key,c.clasificacion,c.estado,c.responsable,c.primera_deteccion_en,c.expected_version,c.evidencia_fingerprint,
      p.item_id,p.titulo,p.status
    FROM identidad_casos c LEFT JOIN ml_publicaciones_cache p ON p.clave=c.ml_key
    WHERE c.direccion='ml_fusion' AND c.estado NOT IN (${ESTADOS_CERRADOS.map(() => '?').join(',')})`).all(...ESTADOS_CERRADOS);
  const activasPorItem = new Map(db.prepare("SELECT item_id,COUNT(*) n FROM ml_publicaciones_cache WHERE status='active' GROUP BY item_id")
    .all().map((r) => [r.item_id, r.n]));
  const ultimoSalteo = ultimoEventoPorCaso(db, EVENTOS_SALTEO);
  const ultimoNinguno = ultimoEventoPorCaso(db, EVENTOS_NINGUNO);

  const filas = [];
  for (const c of casos) {
    if (!coincideTokens(tokens, [c.ml_key, c.titulo, c.clasificacion])) continue;   // q antes de enriquecer
    const ev = ultimoSalteo.get(c.id);
    const salteado = ev ? actorSiVigente(ev, c.expected_version) : null;
    // "Ninguno sirve" saca el caso de la cola mientras la evidencia no cambie (se compara con el fingerprint del caso).
    const nv = ultimoNinguno.get(c.id);
    if (nv?.evento === 'ninguno_sirve' && nv.detalle?.evidence_fingerprint === c.evidencia_fingerprint) continue;
    const pausada = c.status === 'paused';
    const incluye = filtro === 'salteados' ? !!salteado
      : filtro === 'intervencion' ? c.estado === 'intervencion'
      : filtro === 'pausadas' ? pausada && !salteado
      : !salteado && c.estado !== 'intervencion';
    if (!incluye) continue;
    const p = plata.get(c.ml_key);
    const propiaActiva = c.status === 'active' ? 1 : 0;
    filas.push({
      caso_id: c.id, ml_key: c.ml_key, titulo: c.titulo ?? null, motivo: c.clasificacion, estado: c.estado,
      responsable: c.responsable, plata: p?.plata ?? 0, unidades_30d: p?.unidades_30d ?? 0, stock_woo: p?.stock_woo ?? null,
      primera_deteccion_en: c.primera_deteccion_en, salteado_por: salteado,
      chips: { pausada, hermanas: Math.max((activasPorItem.get(c.item_id) ?? 0) - propiaActiva, 0), intervencion: c.estado === 'intervencion' },
    });
  }
  filas.sort((a, b) => b.plata - a.plata || String(a.primera_deteccion_en).localeCompare(String(b.primera_deteccion_en)));
  return { ok: true, filtro, total: filas.length, limit: lim, offset: off, data: filas.slice(off, off + lim) };
}

// ── Detalle ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Detalle de un caso: lo OBSERVADO en ML y lo que MANDA la regla (dos datos separados), y la matriz contra el
 * candidato elegido (`sku`) o, sin elegir, contra el producto actual del caso. Los candidatos no vienen preseleccionados.
 */
function ningunoVigenteDetalle(db, caso) {
  const ev = ningunoVigente(db, caso);
  return ev ? { motivo: ev.detalle?.motivo ?? null, nota: ev.detalle?.nota ?? null, por: ev.actor, desde: ev.creado_en } : null;
}

export function detalleCaso(db, id, { sku = null } = {}) {
  const caso = obtenerCasoIdentidad(db, id);
  if (!caso) return null;
  const pub = caso.publicacion;
  const regla = caso.ml_key ? frenaIdentidad(db, caso.ml_key) : { frena: false, motivo: null };
  const stockWoo = caso.producto?.stock_woo ?? null;
  const reglaStock = regla.frena ? 0 : (stockWoo == null ? null : Number(stockWoo));
  const observadoStock = pub?.available_quantity == null ? null : Number(pub.available_quantity);
  const skuMatriz = sku || caso.producto?.sku_woo || null;
  return {
    caso,
    observado_ml: { estado: pub?.status ?? null, cantidad: observadoStock, observado_en: pub?.actualizado_en ?? null },
    regla: { frena: regla.frena, motivo: regla.motivo, stock_esperado: reglaStock },
    ml_no_refleja_regla: reglaStock != null && observadoStock != null && reglaStock !== observadoStock,
    matriz: skuMatriz && caso.ml_key ? matrizAtributos(db, caso.ml_key, skuMatriz) : null,
    marca: marcaDeClave(db, caso.ml_key),
    // Link de pago sobre una publicación que no está en el marketplace: la pantalla muestra el aviso (X1 del checklist).
    link_de_pago_sin_marketplace: pub?.es_marketplace === false,
    // "Ninguno sirve" vigente (o null): motivo, nota y quién lo marcó. Vuelve a null si cambia la evidencia.
    ninguno_sirve: ningunoVigenteDetalle(db, caso),
    // `expected_sku` de no sincronizar / link de pago es el SKU de la decisión vigente (null si no hay vínculo activo).
    vinculo_vigente: vinculoVigente(db, caso.ml_key),
    // Otras variaciones del mismo ítem: lo que pausa la variante (b) y lo que pide confirmar una corrección.
    hermanas_item: hermanasDeItem(db, pub?.item_id, caso.ml_key),
    // `nota_texto` solo en 'nota_agregada': el historial guarda nota_id y el texto sale de identidad_notas.
    notas: db.prepare(`SELECT h.evento, h.actor, h.creado_en, h.detalle_json, n.nota AS nota_texto
      FROM identidad_historial h
      LEFT JOIN identidad_notas n ON h.evento = 'nota_agregada' AND n.id = CAST(json_extract(h.detalle_json, '$.nota_id') AS INTEGER)
      WHERE h.entidad_tipo='caso' AND h.entidad_id=? ORDER BY h.id DESC LIMIT 100`).all(caso.id)
      .map((h) => ({ evento: h.evento, actor: h.actor, creado_en: h.creado_en, detalle: h.detalle_json ? safeJson(h.detalle_json) : null,
        ...(h.evento === 'nota_agregada' ? { nota_texto: h.nota_texto ?? null } : {}) })),
  };
}

const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

export function vinculoVigente(db, clave) {
  const d = db.prepare("SELECT sku,accion,actualizado_en FROM sku_matcher_decisiones WHERE clave=? AND accion IN ('asignar','confirmar') AND TRIM(COALESCE(sku,''))<>''").get(clave);
  return d ? { sku: d.sku, accion: d.accion, desde: d.actualizado_en } : null;
}

export function hermanasDeItem(db, itemId, clave) {
  if (!itemId) return [];
  return db.prepare("SELECT clave,variation_id,titulo,status,available_quantity FROM ml_publicaciones_cache WHERE item_id=? AND clave<>? ORDER BY clave").all(itemId, clave);
}

/** Marca "no sincronizar" / link de pago vigente de la clave, si la hay. */
export function marcaDeClave(db, clave) {
  const d = db.prepare("SELECT origen,confirmado_por,actualizado_en FROM sku_matcher_decisiones WHERE clave=? AND accion='omitir'").get(clave);
  if (!d) return null;
  const variante = /^no_sincronizar_([abc])$/.exec(d.origen || '')?.[1] ?? null;
  return { tipo: variante ? 'no_sincronizar' : (d.origen === 'link_de_pago' ? 'link_de_pago' : 'omitir'), variante,
    por: d.confirmado_por, desde: d.actualizado_en };
}

// ── Estado (franja de salud) ────────────────────────────────────────────────────────────────────────────────

/** Indicadores de salud de Identidad: los mismos que mostraba `GET /api/identidad-productos/resumen`. */
export function estadoSalud(db) {
  const colas = listarColasIdentidad(db);
  const c = conciliacionIdentidad(db);
  // El contador de operaciones de Identidad incluye las canceladas (guardadas como 'fallida'): acá se excluyen.
  const salud = estadoIdentidadProductos(db);
  const opsCanceladas = db.prepare(`SELECT COUNT(*) n FROM identidad_operaciones
    WHERE estado='fallida' AND ultimo_error LIKE 'cancelada:%'`).get().n;
  const opsPendientes = salud.operaciones_pendientes - opsCanceladas;
  return {
    // Franja Estado (Fase D): lectura y modo explícitos para que la pantalla no tenga que adivinar nombres de columnas.
    salud: { ...salud, operaciones_pendientes: opsPendientes, operaciones_canceladas: opsCanceladas,
      sano: !salud.degradado && salud.urgentes === 0 && opsPendientes === 0,
      ultima_lectura_confiable: salud.ultimo_scan_confiable_en ?? null,
      error_lectura: salud.ultimo_scan_error ?? null,
      modo: salud.modo ?? null,
      escrituras_remotas: salud.escrituras_remotas_habilitadas === 1 },
    conciliacion: { ...c, exacta: c.conciliado },
    conflictos_bolsa: conflictosDeBolsaCompartida(db),
    sin_respaldo_woo: publicacionesSinRespaldoWoo(db),
    conflictos_gtin: conflictosDeIdentificador(db),
    esperando_proteccion: clavesEsperandoProteccion(db),
    webhooks_woo_caidos: webhooksWooCaidos(db),
    pipeline_eventos: saludPipelineEventos(db),
    colas: { ml_to_fusion: colas.ml_to_fusion.length, woo_to_ml: colas.woo_to_ml.length },
  };
}

// ── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Publicaciones ML vinculadas a un producto: decisiones `asignar`/`confirmar` sobre el SKU Woo del producto
 * (`productos_fusion.primary_woo_id` → `catalogo_cache.sku`), con título y estado de la cache de ML.
 * Devuelve null si el producto no existe (la ruta responde 404). Sin SKU Woo → lista vacía.
 */
export function publicacionesDeProducto(db, productoId) {
  const p = db.prepare(`SELECT p.id, w.sku FROM productos_fusion p
    LEFT JOIN catalogo_cache w ON w.id_woo=p.primary_woo_id WHERE p.id=?`).get(Number(productoId));
  if (!p) return null;
  if (!String(p.sku ?? '').trim()) return [];
  return db.prepare(`SELECT pc.clave, pc.titulo, pc.status FROM sku_matcher_decisiones d
    JOIN ml_publicaciones_cache pc ON pc.clave=d.clave
    WHERE d.sku=? AND d.accion IN ('asignar','confirmar') ORDER BY pc.clave`).all(p.sku);
}

/**
 * Cancelación de una operación de identidad. identidad_operaciones NO tiene estado 'cancelada' en su CHECK
 * (082/091): las cancelaciones (no-op de Fase B y cancelación explícita) quedan como `estado='fallida'` con
 * `ultimo_error` que empieza con 'cancelada:'. Esa es la única señal; una 'fallida' sin el prefijo es fallida real.
 */
const PREFIJO_CANCELADA = 'cancelada:';
const esCanceladaOp = (o) => o.estado === 'fallida' && String(o.ultimo_error ?? '').startsWith(PREFIJO_CANCELADA);

/** Motivo legible de la cancelación: 'sin_cambio_sku' si sku_anterior == sku_objetivo; si no, el texto tras el prefijo; o null. */
export function motivoCancelacion(o) {
  if (!esCanceladaOp(o)) return null;
  const sa = String(o.sku_anterior ?? '').trim();
  if (sa !== '' && sa === String(o.sku_objetivo ?? '').trim()) return 'sin_cambio_sku';
  const texto = String(o.ultimo_error).slice(PREFIJO_CANCELADA.length).trim();
  return texto || null;
}

/** Estados de operación que piden acción del operador (la lista de `operaciones`). Cubren todo el CHECK salvo
 *  'completada' (sección `completadas`) y las canceladas (guardadas como 'fallida', sección `canceladas`). */
const ESTADOS_ACCIONABLES = new Set(['fallida', 'intervencion', 'bloqueada_impacto', 'pendiente', 'procesando', 'verificando', 'shadow']);
const LIMITE_EJECUCION = { defecto: 50, maximo: 200 };

/** Parámetros de `GET /ejecucion` ya normalizados: `q` string (o ''), `limite` 1..200 (default 50), offsets >= 0.
 *  Valores inválidos (no numéricos, <1 en limite, arrays en q) caen al default; nunca lanzan. */
export function parametrosEjecucion(query = {}) {
  const entero = (v) => { const n = typeof v === 'string' ? Number.parseInt(v, 10) : NaN; return Number.isFinite(n) ? n : null; };
  const l = entero(query.limite);
  const limite = l == null || l < 1 ? LIMITE_EJECUCION.defecto : Math.min(l, LIMITE_EJECUCION.maximo);
  const offset = (v) => { const n = entero(v); return n == null || n < 0 ? 0 : n; };
  return {
    q: typeof query.q === 'string' ? query.q.trim() : '',
    limite,
    completadas_offset: offset(query.completadas_offset),
    canceladas_offset: offset(query.canceladas_offset),
  };
}

/** Operaciones en ML (correcciones de SKU y pausas). `estado` expone 'cancelada' (derivado); `estado_db` es el valor guardado.
 *  Secciones: `operaciones` = solo accionables (sin límite); `completadas` y `canceladas` = { total, items } paginados
 *  (más recientes primero por actualizada_en, id). `total` es anterior a paginar y ya filtrado por `q`.
 *  `q`: tokens por espacios, cada uno debe aparecer (AND, case-insensitive, sin acentos) en SKU (sku_anterior, sku_objetivo, fusion_sku),
 *  clave/MLA (ml_key, item_id), título (caché de ML y nombre_canonico); se aplica a operaciones y pausas;
 *  se aplica a operaciones y pausas. Contadores globales (no dependen de `q`): `fallidas` (ops y pausas reales),
 *  `canceladas_total` (ops canceladas + pausas 'cancelada') y `pausas_con_riesgo`. */
export function ejecucion(db, { q = '', limite = LIMITE_EJECUCION.defecto, completadas_offset = 0, canceladas_offset = 0 } = {}) {
  const tokens = tokensQ(q);
  const coincide = (campos) => coincideTokens(tokens, campos);
  // Item y título de la publicación en caché (ambos null si la clave no está cacheada).
  const publicacionDe = (clave) => db.prepare('SELECT item_id, titulo FROM ml_publicaciones_cache WHERE clave=?').get(clave) ?? {};

  // Metadatos de cada operación (sin variaciones: se calculan solo para lo que se devuelve).
  const todas = listarOperacionesIdentidad(db).map((o) => {
    const pub = publicacionDe(o.ml_key);
    return { o, item: pub.item_id ?? null, titulo: pub.titulo ?? null, cancelada: esCanceladaOp(o) };
  });
  const variacionesPorItem = new Map();
  const presentar = ({ o, item, cancelada }) => {
    // Memo por ítem: todas sus variaciones; cada operación se excluye a sí misma al filtrar.
    if (!variacionesPorItem.has(item)) variacionesPorItem.set(item, hermanasDeItem(db, item, ''));
    return {
      ...o,
      estado: cancelada ? 'cancelada' : o.estado,
      estado_db: o.estado,
      motivo_cancelacion: motivoCancelacion(o),
      variaciones: variacionesPorItem.get(item).filter((h) => h.clave !== o.ml_key).map(({ clave, titulo, status }) => ({ clave, titulo, status })),
    };
  };
  // Título: el de la publicación en caché (ml_publicaciones_cache) y el nombre canónico del producto (campo que devuelve la operación).
  const enBusqueda = (t) => coincide([t.o.sku_anterior, t.o.sku_objetivo, t.o.fusion_sku, t.o.ml_key, t.item, t.titulo, t.o.nombre_canonico]);
  const recientesPrimero = (a, b) => (String(b.o.actualizada_en) < String(a.o.actualizada_en) ? -1
    : String(b.o.actualizada_en) > String(a.o.actualizada_en) ? 1 : b.o.id - a.o.id);
  const paginar = (lista, offset) => ({ total: lista.length, items: lista.slice(offset, offset + limite).map(presentar) });

  const buscadas = todas.filter(enBusqueda);
  const accionables = buscadas.filter((t) => !t.cancelada && ESTADOS_ACCIONABLES.has(t.o.estado));
  const completadas = buscadas.filter((t) => !t.cancelada && t.o.estado === 'completada').sort(recientesPrimero);
  const canceladas = buscadas.filter((t) => t.cancelada).sort(recientesPrimero);

  const pausasTodas = listarPausasIdentidad(db);
  // Cada pausa trae `titulo` (de la publicación en caché, null si no hay) y `variaciones` (hermanas del ítem, [] si no tiene).
  const pausas = pausasTodas.filter((p) => coincide([p.ml_key, p.item_id, publicacionDe(p.ml_key).titulo]))
    .map((p) => ({ ...p, titulo: publicacionDe(p.ml_key).titulo ?? null,
      variaciones: hermanasDeItem(db, p.item_id, p.ml_key).map(({ clave, titulo, status }) => ({ clave, titulo, status })) }));
  const opsCanceladas = todas.filter((t) => t.cancelada).length;
  return {
    operaciones: accionables.map(presentar),
    completadas: paginar(completadas, completadas_offset),
    canceladas: paginar(canceladas, canceladas_offset),
    pausas,
    fallidas: todas.filter((t) => !t.cancelada && t.o.estado === 'fallida').length + pausasTodas.filter((p) => p.estado === 'fallida').length,
    canceladas_total: opsCanceladas + pausasTodas.filter((p) => p.estado === 'cancelada').length,
    pausas_con_riesgo: pausasTodas.filter((p) => p.riesgo).length,
  };
}

// ── Retenidas ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Importe de un pedido retenido: suma de `unit_price × quantity` de sus ítems. Si falta algún precio o cantidad,
 * o el JSON no se lee, devuelve null (no se inventa un total). Nunca lanza.
 */
export function importeDePedido(items) {
  if (!Array.isArray(items) || !items.length) return null;
  let total = 0;
  for (const oi of items) {
    const precio = Number(oi?.unit_price); const cant = Number(oi?.quantity);
    if (oi?.unit_price == null || oi?.quantity == null || !Number.isFinite(precio) || !Number.isFinite(cant)) return null;
    total += precio * cant;
  }
  return Math.round(total * 100) / 100;
}

/** Ventas retenidas; `se_vuelve_a_retener` avisa si la causa sigue (liberarla a mano no alcanza: el cron la retiene de nuevo).
 *  `titulo`: de la primera publicación del pedido en la cache de ML, o del ítem del pedido; `importe`: ver `importeDePedido`. */
export function retenidas(db) {
  return db.prepare("SELECT * FROM guardia_ml_pedidos_retenidos WHERE estado='retenido' ORDER BY creado_en").all().map((fila) => {
    const claves = clavesDePedidoRetenido(fila);
    const items = safeJson(fila.items_json) ?? [];
    const tituloPub = claves.length ? db.prepare('SELECT titulo FROM ml_publicaciones_cache WHERE clave=?').get(claves[0].clave)?.titulo : null;
    const tituloItem = Array.isArray(items) ? items[0]?.item?.title : null;
    const { items_json: _crudo, ...resto } = fila;
    return { ...resto, claves: claves.map((c) => c.clave), titulo: tituloPub || tituloItem || null,
      importe: importeDePedido(items), se_vuelve_a_retener: !retencionResuelta(db, claves) };
  });
}
