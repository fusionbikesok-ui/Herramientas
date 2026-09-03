import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import express from 'express';
import multer from 'multer';
import { wooFetch } from './woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { skuDesdeMl } from '../lib/mlMapeo.js';
import { guardarArchivo, rutaAbsoluta, estaDentroDeUploads } from '../utils/storage.js';
import { procesarColaFotos, reintentarFoto } from '../lib/fotosPreparacionCola.js';
import {
  normalizarEnvio, direccionesDifieren, resolverPerfil, requisitosFoto, requisitosPaquete,
  requisitosConCantidad, fotosFaltantes, esEnvioLocal, detectarVinculoEntrePedidos,
  normalizarTelefonoParaComparacion,
  clasificarElegibilidadMl, pedidosElegiblesOrdenados,
} from '../lib/preparacion.js';
import { normalizarPedidoWc, normalizarOrdenMl } from '../lib/modelos/ordenVenta.js';
import { productoDesdeFilaCatalogo } from '../lib/modelos/producto.js';
import { inicioHoyBuenosAiresISO } from '../lib/tiempo.js';
import { looksLikeGtin } from '../lib/gtinWoo.js';
import { calcularFechaDespacho, leerHorarios, leerVersionHorarios, asegurarEsquemaHorarios, sembrarHorarios, horaValida, DIAS_SEMANA, fechaEstimadaShipment, calcularSlaPreparacion } from '../lib/horariosDespacho.js';
import { sincronizarMiniOlas, jornadaDeHoy } from '../lib/jornada.js';
import { ensureTablesJornada } from './jornada.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

  const now = () => new Date().toISOString();

// Perfiles de foto soportados (validación de los endpoints de perfiles por categoría y por SKU).
const PERFILES_VALIDOS = ['bici', 'kit_transmision', 'sellado'];

// Motivos válidos para confirmar-manual (atajo que salta el escaneo real). Lista corta a
// propósito — el objetivo es dejar rastro auditable, no dar una excusa en blanco.
const MOTIVOS_CONFIRMACION_MANUAL = ['codigo_ilegible', 'sin_etiqueta', 'otro'];
const MOTIVOS_DESPACHO_MANUAL = ['ya_despachado_sin_codigo'];

function encolarSalidaWoo(db, lote, usuario) {
  const at = new Date().toISOString();
  const eventId = `dispatch-lote-${lote.id}`;
  const orders = db.prepare(`SELECT DISTINCT p.wc_order_id, p.canal FROM despacho_lote_items li
    JOIN despacho_controles d ON d.id=li.control_id
    JOIN preparaciones p ON (p.pack_id=d.grupo_clave OR p.clave=d.grupo_clave)
    WHERE li.lote_id=? AND p.wc_order_id IS NOT NULL`).all(lote.id);
  const metadata = JSON.stringify({ lote_id: lote.id, canal: lote.canal, orders, actor: usuario });
  db.prepare(`INSERT OR IGNORE INTO integration_events
    (event_id,event_type,channel,source,resource_id,payload_version,occurred_at,received_at,correlation_id,dedupe_key,metadata_json,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(eventId, 'dispatch.confirmed', lote.canal, 'fusionbikes', String(lote.id), 'v1', at, at, eventId, eventId, metadata);
  const event = db.prepare('SELECT event_id FROM integration_events WHERE event_id=?').get(eventId);
  if (event) db.prepare('INSERT OR IGNORE INTO integration_jobs (event_id,job_type,available_at) VALUES (?,?,?)').run(event.event_id, 'dispatch.woo', at);
  return eventId;
}

// Estados en los que NO se puede seguir trabajando una preparación (escanear, confirmar
// manual, subir fotos) — hallazgo del revisor: antes se podía escanear/fotografiar una
// 'cerrada_sin_evidencia' sin pasar por /reabrir, así que el evento 'reabierta' (el
// rastro de "entró un reclamo y alguien la reactivó") quedaba registrado después de que
// ya se había trabajado encima, o directamente nunca. 'completada' también se bloquea
// para no poder alterar el historial de una preparación ya cerrada de verdad.
// 'despachada_sin_verificar' y 'pendiente_deposito' quedan AFUERA a propósito: siguen
// siendo trabajables (la primera, para que después /completar la pueda subir a
// 'completada' si se verifica todo; la segunda, para que el depósito termine su parte).
const ESTADOS_BLOQUEADOS_PARA_TRABAJAR = new Set(['completada', 'cerrada_sin_evidencia']);

function encolarEtiquetaInterna(db, prep, usuario) {
  const grupo = prep.pack_id || prep.clave;
  const clave = `preparacion:${prep.id}:${grupo}`;
  const ts = new Date().toISOString();
  const result = db.prepare(`INSERT OR IGNORE INTO etiquetas_cola
    (sku, cantidad, origen, solicitado_por, nota, estado, creado_en, formato_ancho_mm, formato_alto_mm, tipo_etiqueta, idempotencia)
    VALUES (?, 1, 'preparacion', ?, ?, 'pendiente', ?, 50, 25, 'interna', ?)`)
    .run(grupo, usuario || null, JSON.stringify({ formato: '50x25mm', grupo_clave: grupo, preparacion_id: prep.id }), ts, clave);
  return db.prepare('SELECT id FROM etiquetas_cola WHERE idempotencia=?').get(clave)?.id || result.lastInsertRowid;
}

// Mensaje genérico para la pantalla del operario — el detalle de qué endpoint usar para
// desbloquear (/reabrir) es del contrato/log, no de una pantalla de alguien embalando
// cajas (hallazgo del revisor).
function bloqueoPorEstado(prep) {
  if (!ESTADOS_BLOQUEADOS_PARA_TRABAJAR.has(prep.estado)) return null;
  if (prep.estado === 'cerrada_sin_evidencia') {
    return 'esta preparación está cerrada — pedile a un compañero que la reabra antes de seguir';
  }
  return 'ya completada';
}

function rolUsuario(user) {
  return String(user?.rol || user?.role || user?.perfil || '').toLowerCase();
}

function puedeAdministrarPerfiles(user) {
  return !!user?.is_admin || ['supervisor', 'supervisor_deposito'].includes(rolUsuario(user));
}

function puedeVerDetallePreparacion(db, prep, user) {
  if (!user?.username) return false;
  if (user.is_admin || ['supervisor', 'supervisor_deposito', 'auditor', 'despacho'].includes(rolUsuario(user))) return true;
  const claim = db.prepare("SELECT 1 FROM preparacion_claims WHERE preparacion_id=? AND usuario=? AND (expires_at IS NULL OR expires_at>datetime('now'))").get(prep.id, user.username);
  return !!claim;
}

// ─── Tablas (idempotente, patrón de routes/pedidos.js) ───────────────────────

function ensureTables(db) {
  // pick_wave_items/pick_waves/operational_days son de jornadaRouter, pero /pendientes
  // las lee (sincronizarMiniOlas, join en el listado) sin importar si jornadaRouter
  // está montado en esta instancia de Express — aseguramos su existencia acá también.
  ensureTablesJornada(db);
  db.prepare(`CREATE TABLE IF NOT EXISTS preparaciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    canal           TEXT NOT NULL,
    clave           TEXT NOT NULL UNIQUE,
    wc_order_id     INTEGER,
    ml_order_id     TEXT,
    numero_pedido   TEXT,
    comprador       TEXT,
    etiqueta_lista  INTEGER NOT NULL DEFAULT 0,
    estado          TEXT NOT NULL DEFAULT 'en_preparacion',
    notas           TEXT,
    preparado_por   TEXT,
    creado_en       TEXT NOT NULL,
    completado_en   TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    preparacion_id     INTEGER NOT NULL,
    line_item_id       INTEGER,
    product_id         INTEGER,
    variation_id       INTEGER,
    sku                TEXT,
    nombre             TEXT,
    categoria          TEXT,
    perfil             TEXT NOT NULL DEFAULT 'sellado',
    cantidad_esperada  INTEGER NOT NULL DEFAULT 1,
    cantidad_escaneada INTEGER NOT NULL DEFAULT 0,
    confirmado_manual  INTEGER NOT NULL DEFAULT 0,
    estado_embalaje    TEXT,
    despacho           TEXT NOT NULL DEFAULT 'local',
    despacho_motivo    TEXT,
    estado_item        TEXT NOT NULL DEFAULT 'pendiente'
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_fotos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    preparacion_id INTEGER NOT NULL,
    item_id        INTEGER,
    tipo           TEXT NOT NULL,
    url            TEXT NOT NULL,
    nombre_archivo TEXT,
    creado_en      TEXT NOT NULL
  )`).run();
  try { db.prepare('ALTER TABLE preparacion_fotos ADD COLUMN upload_id TEXT').run(); } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables upload_id:', e.message);
  }
  for (const ddl of [
    'ALTER TABLE preparacion_fotos ADD COLUMN fingerprint TEXT',
    'ALTER TABLE preparacion_fotos ADD COLUMN procesando_reclamada_en TEXT',
  ]) { try { db.prepare(ddl).run(); } catch (_) {} }
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_preparacion_fotos_upload ON preparacion_fotos(preparacion_id, upload_id) WHERE upload_id IS NOT NULL').run();
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_fotos_holds (
    preparacion_id INTEGER PRIMARY KEY,
    motivo TEXT NOT NULL,
    creado_por TEXT,
    creado_en TEXT NOT NULL
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_perfiles (
    categoria       TEXT PRIMARY KEY,
    perfil          TEXT NOT NULL,
    requisitos_json TEXT,
    actualizado_en  TEXT NOT NULL
  )`).run();

  // Overrides por SKU exacto: tienen prioridad sobre las reglas por categoria.
  // Arranca vacia a proposito (el operario la completa caso por caso, sin seed).
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_perfiles_sku (
    sku             TEXT PRIMARY KEY,
    perfil          TEXT NOT NULL,
    requisitos_json TEXT,
    actualizado_en  TEXT NOT NULL
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_perfiles_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alcance TEXT NOT NULL, clave TEXT NOT NULL, tipo TEXT NOT NULL,
    usuario TEXT, detalle_json TEXT NOT NULL, creado_en TEXT NOT NULL
  )`).run();
  for (const ddl of [
    'ALTER TABLE preparacion_perfiles ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE preparacion_perfiles_sku ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE preparacion_items ADD COLUMN perfil_version INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE preparacion_items ADD COLUMN requisitos_json_snapshot TEXT',
  ]) { try { db.prepare(ddl).run(); } catch (_) {} }

  // Seed de perfiles por defecto (el usuario los edita desde la UI)
  const seed = db.prepare(
    'INSERT OR IGNORE INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES (?,?,NULL,?)'
  );
  seed.run('BICICLETAS', 'bici', now());
  seed.run('TRANSMISIONES', 'kit_transmision', now());

  db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
    clave           TEXT PRIMARY KEY,
    canal           TEXT NOT NULL,
    wc_order_id     INTEGER,
    ml_order_id     TEXT,
    numero_pedido   TEXT,
    comprador       TEXT,
    fecha           TEXT,
    estado_envio    TEXT NOT NULL,
    estado_wc       TEXT,
    espejo_ml       INTEGER NOT NULL DEFAULT 0,
    logistic_type   TEXT,
    substatus       TEXT,
    items_json      TEXT NOT NULL,
    actualizado_en  TEXT NOT NULL,
    fecha_despacho  TEXT,
    fecha_despacho_limite TEXT,
    estado_despacho TEXT NOT NULL DEFAULT 'activo',
    despacho_motivo TEXT,
    shipment_limite_original TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pedidos_cache_estado ON pedidos_cache(estado_envio)').run();
  try { asegurarEsquemaHorarios(db); db.prepare(`CREATE TABLE IF NOT EXISTS despacho_horarios (
    dia INTEGER PRIMARY KEY CHECK (dia BETWEEN 1 AND 7), habilitado INTEGER NOT NULL DEFAULT 0 CHECK (habilitado IN (0,1)),
    hora_corte TEXT NOT NULL DEFAULT '16:00', actualizado_en TEXT NOT NULL
  )`).run(); sembrarHorarios(db); } catch (e) { console.error('ensureTables despacho_horarios:', e.message); }
  // La migración histórica puede ejecutarse antes de que exista la tabla en una base
  // nueva; garantizar aquí la columna evita que el contrato de resultado incierto
  // dependa del orden de inicialización.
  try { db.prepare('ALTER TABLE preparaciones ADD COLUMN woo_paso1_incierto INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { if (!/duplicate column/i.test(e.message)) console.error('ensureTables woo_paso1_incierto:', e.message); }
  // pack_id acá también: pedidos_cache es lo que alimenta tanto "A preparar" como el
  // Historial, así que es el único lugar donde ponerlo hace que el número que se lee en ML
  // sea encontrable en las dos pantallas (ver el comentario de preparaciones.pack_id).
  try {
    db.prepare('ALTER TABLE pedidos_cache ADD COLUMN pack_id TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables pedidos_cache.pack_id:', e.message);
  }
  // customer_note: antes solo se veía en la pestaña Etiquetas Andreani (que la pide en
  // vivo a Woo); acá se cachea para que la pantalla de armado del pedido (GET /pendientes)
  // la muestre sin ida y vuelta extra a Woo. ML no expone un campo equivalente en su API de
  // orders (confirmado 2026-08-26) — queda '' para esas filas, no se inventa nada.
  try {
    db.prepare("ALTER TABLE pedidos_cache ADD COLUMN customer_note TEXT NOT NULL DEFAULT ''").run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables pedidos_cache.customer_note:', e.message);
  }

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_vistas (
    preparacion_id INTEGER NOT NULL,
    usuario        TEXT NOT NULL,
    visto_en       TEXT NOT NULL,
    PRIMARY KEY (preparacion_id, usuario)
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_eventos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    preparacion_id INTEGER NOT NULL,
    item_id        INTEGER,
    tipo           TEXT NOT NULL,
    usuario        TEXT,
    detalle_json   TEXT NOT NULL,
    creado_en      TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_preparacion_eventos_prep ON preparacion_eventos(preparacion_id, id)').run();

  db.prepare(`CREATE TABLE IF NOT EXISTS despacho_controles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo_clave TEXT NOT NULL UNIQUE,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'escaneado', 'confirmado')),
    etiqueta_cola_id INTEGER,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL,
    confirmado_por TEXT,
    confirmado_en TEXT,
    confirmacion_idempotencia TEXT
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS despacho_escaneos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    control_id INTEGER NOT NULL,
    preparacion_id INTEGER NOT NULL,
    codigo TEXT NOT NULL,
    idempotencia TEXT NOT NULL UNIQUE,
    usuario TEXT NOT NULL,
    creado_en TEXT NOT NULL,
    CHECK (length(trim(codigo)) > 0)
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_despacho_escaneos_control ON despacho_escaneos(control_id, id)').run();
  db.prepare(`CREATE TABLE IF NOT EXISTS etiquetas_cola (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, cantidad INTEGER NOT NULL,
    origen TEXT, sesion_id INTEGER, solicitado_por TEXT, nota TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente', creado_en TEXT NOT NULL, impreso_en TEXT,
    formato_ancho_mm INTEGER NOT NULL DEFAULT 50 CHECK (formato_ancho_mm > 0),
    formato_alto_mm INTEGER NOT NULL DEFAULT 25 CHECK (formato_alto_mm > 0),
    tipo_etiqueta TEXT NOT NULL DEFAULT 'interna',
    idempotencia TEXT
  )`).run();
  try { db.prepare('ALTER TABLE despacho_controles ADD COLUMN confirmacion_idempotencia TEXT').run(); } catch (_) {}
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_despacho_confirmacion_idempotencia ON despacho_controles(confirmacion_idempotencia) WHERE confirmacion_idempotencia IS NOT NULL').run();
  for (const ddl of [
    'ALTER TABLE etiquetas_cola ADD COLUMN formato_ancho_mm INTEGER NOT NULL DEFAULT 50',
    'ALTER TABLE etiquetas_cola ADD COLUMN formato_alto_mm INTEGER NOT NULL DEFAULT 25',
    "ALTER TABLE etiquetas_cola ADD COLUMN tipo_etiqueta TEXT NOT NULL DEFAULT 'interna'",
    'ALTER TABLE etiquetas_cola ADD COLUMN idempotencia TEXT',
  ]) { try { db.prepare(ddl).run(); } catch (_) {} }
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_etiquetas_idempotencia ON etiquetas_cola(idempotencia) WHERE idempotencia IS NOT NULL').run();

  // Claim exclusivo de la preparación. Tabla separada para no cambiar el contrato ni
  // reescribir filas históricas; la PK garantiza que dos operadores no puedan adquirirla
  // simultáneamente. expires_at se compara como ISO-8601 UTC.
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_claims (
    preparacion_id INTEGER PRIMARY KEY,
    usuario        TEXT NOT NULL,
    claimed_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    renovado_en    TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_preparacion_claims_expira ON preparacion_claims(expires_at)').run();

  // borrado_en: soft-delete de fotos (columna nueva, agregada con try/catch porque SQLite
  // no tiene "ADD COLUMN IF NOT EXISTS" — falla con "duplicate column" si ya existe, y eso
  // es justamente lo esperado en cada arranque salvo el primero).
  try {
    db.prepare('ALTER TABLE preparacion_fotos ADD COLUMN borrado_en TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables borrado_en:', e.message);
  }

  // Cola de procesamiento en segundo plano (migrations/009_preparacion_fotos_cola.sql, y ver
  // lib/fotosPreparacionCola.js para el porqué). DEFAULT 'listo' en estado_proceso: las filas
  // que ya existían antes de este cambio vienen del pipeline viejo, que SÍ convertía de forma
  // sincrónica — para ellas `url` ya es el jpeg final, no hay nada pendiente que procesar.
  const colaCols = [
    ["estado_proceso TEXT NOT NULL DEFAULT 'listo'", 'estado_proceso'],
    ['url_liviana TEXT', 'url_liviana'],
    ['es_heic INTEGER NOT NULL DEFAULT 0', 'es_heic'],
    ['intentos INTEGER NOT NULL DEFAULT 0', 'intentos'],
    ['ultimo_error TEXT', 'ultimo_error'],
    ['proximo_intento_en TEXT', 'proximo_intento_en'],
    ['procesado_en TEXT', 'procesado_en'],
  ];
  for (const [ddl, nombre] of colaCols) {
    try {
      db.prepare(`ALTER TABLE preparacion_fotos ADD COLUMN ${ddl}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) console.error(`ensureTables ${nombre}:`, e.message);
    }
  }

  // woo_paso2_pendiente: marca un pedido web que llegó a 'completed' en Woo (paso 1 del
  // seguimiento) pero cuyo paso 2 (status final enviadoandreani) todavía no se confirmó —
  // permite que reintentarColgadosTracking lo encuentre sin volver a escanear Woo.
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN woo_paso2_pendiente INTEGER NOT NULL DEFAULT 0').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables woo_paso2_pendiente:', e.message);
  }

  // tracking: número cargado en el paso 1 (guardado ANTES del intento de paso 2, ver POST
  // /seguimientos/:wcOrderId) — permite que GET /seguimientos arme la sección "a medias"
  // (woo_paso2_pendiente=1) sin pedirle de nuevo el tracking a Woo por cada fila.
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN tracking TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables tracking:', e.message);
  }

  // localidad: se llena junto con numero_pedido/comprador en el INSERT del paso 1 de
  // POST /seguimientos/:wcOrderId (fix del hallazgo del revisor: la fila de "a_medias"
  // nacía sin nombre ni número de pedido reales). No forma parte del `comprador` porque
  // GET /seguimientos ya arma un objeto `envio` con campos separados (nombre/localidad)
  // y mezclarla en el string de comprador obligaría a parsearla de vuelta.
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN localidad TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables localidad:', e.message);
  }
  // pack_id: el número que ML le MUESTRA al vendedor cuando la compra agrupa varios ítems.
  // No coincide con el id de la orden — medido el 2026-08-18 sobre las 50 ventas más
  // recientes, 37 tienen un pack distinto. Sin esta columna, buscar en la herramienta por el
  // número que se lee en ML no encontraba nada, y la venta parecía no existir aunque
  // estuviera procesada y hasta preparada (caso real: pack 2000014544268249 ↔ orden
  // 2000017948004320, ya preparada por Joaco).
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN pack_id TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables pack_id:', e.message);
  }

  // direccion_confirmada_fuente: cuando envío y facturación difieren de verdad
  // (direccionesDifieren en lib/preparacion.js), el operario elige cuál usar
  // antes de poder seguir con la preparación — se guarda acá para no volver a
  // preguntar, y GET /etiquetas y /seguimientos la usan en vez de la regla
  // automática de normalizarEnvio.
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN direccion_confirmada_fuente TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables direccion_confirmada_fuente:', e.message);
  }
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN direccion_confirmada_por TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables direccion_confirmada_por:', e.message);
  }
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN direccion_confirmada_en TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables direccion_confirmada_en:', e.message);
  }

  // Tabla de vínculos entre pedidos del mismo comprador (Fase 4).
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_vinculos (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_a_clave        TEXT NOT NULL,
    pedido_b_clave        TEXT NOT NULL,
    campo_match           TEXT NOT NULL,
    estado                TEXT NOT NULL DEFAULT 'sugerido',
    un_solo_paquete       INTEGER NOT NULL DEFAULT 0,
    decidido_por          TEXT,
    decidido_en           TEXT,
    creado_en             TEXT NOT NULL,
    UNIQUE (pedido_a_clave, pedido_b_clave)
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_preparacion_vinculos_claves ON preparacion_vinculos(pedido_a_clave, pedido_b_clave)').run();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Perfil de un ítem, por orden de prioridad:
//   1) override por SKU exacto (preparacion_perfiles_sku),
//   2) override por categoría (preparacion_perfiles, match por substring, la regla más larga gana),
//   3) heurística por nombre (resolverPerfil, sin cambios).
function perfilParaItem(db, { sku, categoria, nombre }) {
  const skuNorm = String(sku || '').trim().toUpperCase();
  if (skuNorm) {
    const reglaSku = db.prepare('SELECT perfil FROM preparacion_perfiles_sku WHERE sku=?').get(skuNorm);
    if (reglaSku) return reglaSku.perfil;
  }
  const cats = String(categoria || '').toUpperCase();
  if (cats) {
    const reglas = db.prepare('SELECT categoria, perfil FROM preparacion_perfiles ORDER BY LENGTH(categoria) DESC').all();
    for (const r of reglas) {
      if (cats.includes(r.categoria.toUpperCase())) return r.perfil;
    }
  }
  return resolverPerfil({ categorias: categoria, nombre });
}

function versionPerfilParaItem(db, { sku, categoria }) {
  const skuNorm = String(sku || '').trim().toUpperCase();
  if (skuNorm) {
    const reglaSku = db.prepare('SELECT version FROM preparacion_perfiles_sku WHERE sku=?').get(skuNorm);
    if (reglaSku) return reglaSku.version || 1;
  }
  const cats = String(categoria || '').toUpperCase();
  if (cats) {
    const regla = db.prepare('SELECT version FROM preparacion_perfiles ORDER BY LENGTH(categoria) DESC').all()
      .find(r => cats.includes(String(r.categoria).toUpperCase()));
    if (regla) return regla.version || 1;
  }
  return 1;
}

// Requisitos de foto de un ítem, respetando requisitos_json custom: primero por SKU
// exacto, después por categoría, y al final el default del perfil. Al final se le anota
// la cantidad esperada a los slots "de artículo" (requisitosConCantidad) cuando el ítem
// pide más de 1 unidad — un único punto de salida para no tener que repetir esa llamada
// en cada return de abajo.
//
// La foto de artículo es el PISO, no el techo: requisitosBaseParaItem ya garantiza al
// menos un slot para cualquier perfil (nunca devuelve vacío), y las reglas por SKU/
// categoría que ya existían pueden seguir pidiendo fotos ADICIONALES encima de ese piso
// (más slots, no menos) — este cambio no las reemplaza ni las achica.
function requisitosParaItem(db, item) {
  return requisitosConCantidad(requisitosBaseParaItem(db, item), item.cantidad_esperada);
}

function requisitosBaseParaItem(db, item) {
  if (item.requisitos_json_snapshot) {
    try {
      const snapshot = JSON.parse(item.requisitos_json_snapshot);
      if (Array.isArray(snapshot) && snapshot.length) return snapshot; // formato legado
      if (snapshot && typeof snapshot === 'object') {
        const slots = snapshot[item.estado_embalaje || 'default'] || snapshot.default;
        if (Array.isArray(slots) && slots.length) return slots;
      }
    } catch (_) {}
  }
  const skuNorm = String(item.sku || '').trim().toUpperCase();
  if (skuNorm) {
    const reglaSku = db.prepare('SELECT requisitos_json FROM preparacion_perfiles_sku WHERE sku=?').get(skuNorm);
    // El override por SKU es la regla más específica: si existe la fila, cortocircuita
    // el bloque de categoría (igual que perfilParaItem). Si no cortara, un SKU con
    // perfil forzado a kit_transmision heredaría los requisitos_json de la categoría
    // (otro perfil, ej. sellado) y el ítem se podría completar con la foto incorrecta.
    if (reglaSku) {
      if (reglaSku.requisitos_json) {
        try {
          const custom = JSON.parse(reglaSku.requisitos_json);
          const slots = custom[item.estado_embalaje || 'default'] || custom.default;
          if (Array.isArray(slots) && slots.length) return slots;
        } catch (_) { /* JSON inválido: cae a la heurística base del perfil ya resuelto */ }
      }
      // Sin requisitos_json propios (o inválidos): heurística base del perfil ya
      // resuelto por SKU, sin pasar por la categoría.
      return requisitosFoto(item.perfil, item.estado_embalaje);
    }
  }
  const cats = String(item.categoria || '').toUpperCase();
  if (cats) {
    const reglas = db.prepare(
      'SELECT categoria, requisitos_json FROM preparacion_perfiles WHERE requisitos_json IS NOT NULL ORDER BY LENGTH(categoria) DESC'
    ).all();
    for (const r of reglas) {
      if (!cats.includes(r.categoria.toUpperCase())) continue;
      try {
        const custom = JSON.parse(r.requisitos_json);
        const slots = custom[item.estado_embalaje || 'default'] || custom.default;
        if (Array.isArray(slots) && slots.length) return slots;
      } catch (_) { /* JSON inválido: cae al default */ }
    }
  }
  return requisitosFoto(item.perfil, item.estado_embalaje);
}

// Recorre los ítems y fotos de una preparación y devuelve exactamente lo que le falta
// para poder completarse — MISMA función que usa POST /:id/completar para decidir si
// bloquea (no una versión paralela que se pueda desincronizar). La reusan también
// preparacionEstaVerificada (para decidir 'completada' vs 'despachada_sin_verificar' al
// cargar el tracking) y el cron reintentarColgadosTracking, con el mismo criterio.
function calcularFaltantesPreparacion(db, prep) {
  const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(prep.id);
  const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND borrado_en IS NULL').all(prep.id);

  const faltantes = [];
  const delegadosPendientes = [];

  for (const it of items) {
    if (it.estado_item === 'exento') continue;

    if (it.estado_item !== 'verificado') {
      if (it.despacho === 'deposito_delegado') {
        delegadosPendientes.push({ item_id: it.id, sku: it.sku, nombre: it.nombre });
      } else {
        faltantes.push({ item_id: it.id, sku: it.sku, nombre: it.nombre, motivo: 'sin_verificar' });
      }
      continue;
    }

    const req_ = requisitosParaItem(db, it);
    const faltan = fotosFaltantes(req_, fotos.filter(f => f.item_id === it.id));
    if (faltan.length) {
      faltantes.push({ item_id: it.id, sku: it.sku, nombre: it.nombre, motivo: 'fotos', faltan });
    }
  }

  const fotosGenerales = fotos.filter(f => !f.item_id);
  const faltaPaquete = fotosFaltantes(requisitosPaquete(), fotosGenerales);

  return { faltantes, delegadosPendientes, faltaPaquete };
}

// ¿Esta preparación está completamente verificada (todo escaneado/confirmado con motivo,
// con sus fotos, incluidas las dos del paquete, y sin nada delegado al depósito
// pendiente)? Se usa para decidir el estado interno al cargar el tracking — cargar el
// tracking sigue moviendo el pedido en Woo (mail al cliente incluido), pero el estado
// LOCAL solo puede decir 'completada' si esto da true; si no, 'despachada_sin_verificar'
// (ver marcarPreparacionEnviada). No mira el estado de la fila `preparaciones` en sí
// (cerrada_sin_evidencia se filtra antes de llegar acá, en el caller).
function preparacionEstaVerificada(db, prep) {
  const { faltantes, delegadosPendientes, faltaPaquete } = calcularFaltantesPreparacion(db, prep);
  return faltantes.length === 0 && delegadosPendientes.length === 0 && faltaPaquete.length === 0;
}

// Cierra el lado LOCAL de la preparación una vez que el pedido ya salió en Woo (paso 2 de
// /seguimientos, o el reintento del cron reintentarColgadosTracking). El flujo de Woo NO
// cambia: el mail al cliente ya se mandó en el paso 1, eso es correcto y no se toca. Lo
// que se decide acá es el estado INTERNO:
//   - si preparacionEstaVerificada -> 'completada' (como antes de este ciclo).
//   - si NO -> 'despachada_sin_verificar': el envío salió igual, pero el sistema no puede
//     afirmar una verificación que no ocurrió (mismo espíritu que 'cerrada_sin_evidencia').
// Fail-closed por partida doble contra pisar una 'cerrada_sin_evidencia': se lee el
// estado ANTES y el UPDATE además lleva `AND estado<>'cerrada_sin_evidencia'` en el WHERE
// (defensa en profundidad ante una corrida concurrente — cron + script de mantenimiento
// — aunque hoy, de un solo proceso y sin await entre la lectura y el UPDATE, no haga
// falta para el caso simple).
// `woo_paso2_pendiente` se limpia siempre (es un flag del lado Woo, no del de
// verificación) — incluso si la preparación resultó ser 'cerrada_sin_evidencia'.
function marcarPreparacionEnviada(db, clave, { usuario = null } = {}) {
  db.prepare('UPDATE preparaciones SET woo_paso2_pendiente=0 WHERE clave=?').run(clave);
  const prep = db.prepare('SELECT id, estado FROM preparaciones WHERE clave=?').get(clave);
  if (!prep || prep.estado === 'cerrada_sin_evidencia') return null;

  const estadoFinal = preparacionEstaVerificada(db, prep) ? 'completada' : 'despachada_sin_verificar';
  const cambio = db.prepare(
    "UPDATE preparaciones SET estado=?, completado_en=? WHERE id=? AND estado<>'cerrada_sin_evidencia'"
  ).run(estadoFinal, now(), prep.id);
  if (!cambio.changes) return null; // se cerró sin evidencia justo entre el SELECT y el UPDATE

  if (estadoFinal === 'despachada_sin_verificar') {
    registrarEvento(db, { preparacionId: prep.id, itemId: null, tipo: 'despachado_sin_verificar', usuario, detalle: {} });
  }
  return estadoFinal;
}

// Crea (o completa) una preparación con el snapshot de sus ítems.
// Idempotente por clave: si ya existe con ítems, devuelve el id existente.
export function crearPreparacion(db, { canal, wcOrderId = null, mlOrderId = null, packId = null, numeroPedido, comprador, notas = null, items = [] }) {
  ensureTables(db);
  const clave = canal === 'web' ? `web:${wcOrderId}` : `ml:${mlOrderId}`;

  const existente = db.prepare('SELECT id FROM preparaciones WHERE clave=?').get(clave);
  let prepId = existente?.id;

  const tx = db.transaction(() => {
    if (!prepId) {
      prepId = db.prepare(`INSERT INTO preparaciones
        (canal, clave, wc_order_id, ml_order_id, pack_id, numero_pedido, comprador, notas, estado, creado_en)
        VALUES (?,?,?,?,?,?,?,?, 'en_preparacion', ?)`)
        .run(canal, clave, wcOrderId, mlOrderId, packId || null, numeroPedido || null, comprador || null, notas || null, now()).lastInsertRowid;
    }
    const tieneItems = db.prepare('SELECT 1 FROM preparacion_items WHERE preparacion_id=? LIMIT 1').get(prepId);
    if (tieneItems) return;

    const ins = db.prepare(`INSERT INTO preparacion_items
      (preparacion_id, line_item_id, product_id, variation_id, sku, nombre, categoria, perfil, perfil_version, requisitos_json_snapshot, cantidad_esperada)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const it of items) {
      const perfil = perfilParaItem(db, { sku: it.sku, categoria: it.categoria, nombre: it.nombre });
      const perfilVersion = versionPerfilParaItem(db, { sku: it.sku, categoria: it.categoria });
      // Congelar la regla vigente sin congelar el estado operativo: una bici creada
      // antes de re-embalarse debe seguir pudiendo exigir lado A/B y accesorios.
      const requisitosSnapshot = {};
      for (const estado_embalaje of ['default', 're_embalada']) {
        requisitosSnapshot[estado_embalaje] = requisitosBaseParaItem(db, {
          sku: it.sku, categoria: it.categoria, perfil, estado_embalaje, requisitos_json_snapshot: null,
        });
      }
      ins.run(prepId, it.line_item_id || null, it.product_id || null, it.variation_id || null,
        it.sku || '', it.nombre || '', it.categoria || '', perfil, perfilVersion, JSON.stringify(requisitosSnapshot),
        Math.max(1, parseInt(it.cantidad) || 1));
    }
  });
  tx();
  return prepId;
}

const CLAIM_TTL_DEFAULT_MS = 15 * 60 * 1000;

function claimTtlMs(cfg) {
  const configured = Number(cfg?.preparacionClaimTtlMs ?? process.env.PREPARACION_CLAIM_TTL_MS);
  return Number.isFinite(configured) && configured >= 1000 ? Math.floor(configured) : CLAIM_TTL_DEFAULT_MS;
}

function claimPreparacion(db, preparacionId, usuario, cfg, timestamp = new Date(), alreadyInTransaction = false) {
  if (!usuario) return { ok: false, code: 'AUTH_REQUIRED' };
  const at = timestamp.toISOString();
  const expires = new Date(timestamp.getTime() + claimTtlMs(cfg)).toISOString();
  const operation = () => {
    const actual = db.prepare('SELECT * FROM preparacion_claims WHERE preparacion_id=?').get(preparacionId);
    if (!actual) {
      db.prepare(`INSERT INTO preparacion_claims (preparacion_id, usuario, claimed_at, expires_at, renovado_en)
        VALUES (?,?,?,?,?)`).run(preparacionId, usuario, at, expires, at);
      return { ok: true, usuario, claimed_at: at, expires_at: expires };
    }
    if (actual.usuario !== usuario && actual.expires_at > at) {
      return { ok: false, code: 'PREPARATION_CLAIMED', claim: actual };
    }
    // Mismo usuario: retry idempotente/renovación. Claim vencido de otro usuario también
    // se puede reutilizar atómicamente; nunca se libera un claim vigente ajeno.
    const claimedAt = actual.usuario === usuario ? actual.claimed_at : at;
    db.prepare(`UPDATE preparacion_claims SET usuario=?, claimed_at=?, expires_at=?, renovado_en=?
      WHERE preparacion_id=?`).run(usuario, claimedAt, expires, at, preparacionId);
    return { ok: true, usuario, claimed_at: claimedAt, expires_at: expires };
  };
  return alreadyInTransaction ? operation() : db.transaction(operation)();
}

function claimConflict(res, claim) {
  return res.status(409).json({ ok: false, error: 'La preparación está siendo trabajada por otro operador.', code: 'PREPARATION_CLAIMED', claim: {
    usuario: claim.usuario, claimed_at: claim.claimed_at, expires_at: claim.expires_at,
  }});
}

// Toda mutación operativa debe pertenecer al operador que tomó la preparación.
// Las lecturas no llaman a este guard. Un claim vencido se puede reclamar de forma
// explícita (/tomar), pero no habilita silenciosamente una escritura posterior.
function exigirClaimVigente(db, prep, usuario, res) {
  const claim = db.prepare('SELECT * FROM preparacion_claims WHERE preparacion_id=?').get(prep.id);
  if (!usuario) {
    res.status(409).json({ ok: false, error: 'La preparación requiere una toma vigente.', code: 'PREPARATION_CLAIMED' });
    return false;
  }
  if (!claim || claim.usuario !== usuario || claim.expires_at <= now()) {
    if (claim && claim.usuario !== usuario && claim.expires_at > now()) return claimConflict(res, claim), false;
    res.status(409).json({ ok: false, error: 'La preparación no está tomada por este operador o la toma venció.', code: 'PREPARATION_CLAIMED' });
    return false;
  }
  return true;
}

export function registrarEvento(db, { preparacionId, itemId = null, tipo, usuario, detalle, failClosed = false }) {
  // Fail-open a propósito: el historial de "Actividad" es auxiliar, nunca debe poder
  // frenar la acción real (escanear, subir foto, etc.) que el operario está haciendo.
  try {
    db.prepare(`
      INSERT INTO preparacion_eventos (preparacion_id, item_id, tipo, usuario, detalle_json, creado_en)
      VALUES (?,?,?,?,?,?)
    `).run(preparacionId, itemId, tipo, usuario ?? null, JSON.stringify(detalle ?? {}), now());
  } catch (e) {
    console.error('registrarEvento: no se pudo registrar', tipo, e.message);
    if (failClosed) throw e;
  }
}

function registrarPerfilEvento(db, { alcance, clave, tipo, usuario, detalle }) {
  db.prepare(`INSERT INTO preparacion_perfiles_eventos
    (alcance, clave, tipo, usuario, detalle_json, creado_en) VALUES (?,?,?,?,?,?)`)
    .run(alcance, clave, tipo, usuario ?? null, JSON.stringify(detalle ?? {}), now());
}

// Purga del disco y de la tabla las fotos con soft-delete de más de 180 días,
// excepto preparaciones con un hold activo por reclamo/incidente/garantía/auditoría.
// Devuelve la cantidad purgada (para logging del cron).
export function purgarFotosBorradas(db) {
  const limite = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
  const vencidas = db.prepare(`SELECT f.id, f.url, f.url_liviana FROM preparacion_fotos f
    WHERE f.borrado_en IS NOT NULL AND f.borrado_en < ?
      AND NOT EXISTS (SELECT 1 FROM preparacion_fotos_holds h WHERE h.preparacion_id=f.preparacion_id)`).all(limite);
  let purgadas = 0;
  for (const f of vencidas) {
    // Contención (defensa en profundidad): si la ruta resuelta cae fuera de uploads/,
    // no borramos nada y dejamos la fila para revisión manual.
    const abs = path.resolve(rutaAbsoluta(f.url));
    if (!estaDentroDeUploads(abs)) {
      console.error('purgarFotosBorradas: url fuera de uploads/, se omite (revisión manual):', f.id, f.url);
      continue;
    }
    try {
      fs.unlinkSync(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('purgarFotosBorradas: error al borrar archivo, se borra igual la fila:', f.id, f.url, err.message);
      }
    }
    // url_liviana puede no existir todavía (foto que nunca llegó a procesarse) — se borra
    // best-effort, sin frenar la purga de la fila si falta.
    if (f.url_liviana) {
      const absLiviana = path.resolve(rutaAbsoluta(f.url_liviana));
      if (estaDentroDeUploads(absLiviana)) {
        try { fs.unlinkSync(absLiviana); } catch (err) {
          if (err.code !== 'ENOENT') console.error('purgarFotosBorradas: error al borrar liviana:', f.id, f.url_liviana, err.message);
        }
      } else {
        console.error('purgarFotosBorradas: url_liviana fuera de uploads/, se omite:', f.id, f.url_liviana);
      }
    }
    db.prepare('DELETE FROM preparacion_fotos WHERE id=?').run(f.id);
    purgadas++;
  }
  return purgadas;
}

// Parsea detalle_json de forma defensiva: la Actividad es auxiliar y nunca debe poder
// bloquear la apertura del pedido por un JSON corrupto o NULL en un evento viejo.
function mapearEvento(e) {
  let parsed = null;
  try { parsed = JSON.parse(e.detalle_json); } catch (_) { /* detalle_json inválido */ }
  // JSON.parse('null') no lanza excepción y devuelve `null` (no un objeto), así que el
  // catch de arriba no lo agarra: hay que chequear el tipo del resultado también.
  const detalle = (parsed && typeof parsed === 'object') ? parsed : {};
  return { ...e, detalle };
}

// Reintenta el paso 2 (status final) de cada pedido "colgado" (paso 1 ya confirmado en
// Woo, paso 2 pendiente). Fail-open por ítem: si uno vuelve a fallar, sigue con el resto
// y lo deja para la corrida siguiente del cron. Devuelve cuántos se resolvieron.
export async function reintentarColgadosTracking(db, cfg) {
  const pendientes = db.prepare('SELECT * FROM preparaciones WHERE woo_paso2_pendiente=1').all();
  let resueltos = 0;
  for (const prep of pendientes) {
    try {
      await wooFetch(cfg.woo, `/orders/${prep.wc_order_id}`, 'put', { status: cfg.enviadoAndreaniStatus || 'enviadoandreani' });
      // Mismo criterio que /seguimientos/:wcOrderId: 'completada' solo si de verdad está
      // verificada, y nunca pisa una 'cerrada_sin_evidencia' — ver marcarPreparacionEnviada.
      marcarPreparacionEnviada(db, prep.clave, { usuario: null });
      registrarEvento(db, { preparacionId: prep.id, itemId: null, tipo: 'tracking_recuperado', usuario: null, detalle: {} });
      resueltos++;
    } catch (e) {
      // 404/410: el pedido ya no existe en Woo (borrado o pasado a papelera) — el paso 2
      // va a fallar SIEMPRE, así que dejar woo_paso2_pendiente=1 deja una fila irrecuperable
      // que el chip de a_medias cuenta todos los días y que "Reintentar" nunca puede resolver
      // (hallazgo del revisor: antes de que a_medias fuera 100% local, esto se resolvía solo
      // porque la sección se derivaba de Woo). Se limpia el flag y se deja constancia con un
      // evento propio para que un reclamo posterior pueda ver qué pasó. Cualquier otro error
      // (5xx, timeout, red) sigue fail-closed: no se toca el flag, se reintenta en la corrida
      // siguiente del cron — no hay forma de distinguir "temporal" de "permanente" ahí.
      const status = Number((/error (\d+)/.exec(e.message) || [])[1]);
      if (status === 404 || status === 410) {
        db.prepare('UPDATE preparaciones SET woo_paso2_pendiente=0 WHERE id=?').run(prep.id);
        registrarEvento(db, {
          preparacionId: prep.id, itemId: null, tipo: 'tracking_abandonado', usuario: null,
          detalle: { error: e.message, motivo: 'pedido inexistente en Woo (404/410)' },
        });
        console.error(`reintentarColgadosTracking: abandonado wc_order_id=${prep.wc_order_id} (Woo ${status}):`, e.message);
        continue;
      }
      console.error(`reintentarColgadosTracking: sigue colgado wc_order_id=${prep.wc_order_id}:`, e.message);
    }
  }
  return resueltos;
}

function getPrep(db, id) {
  return db.prepare('SELECT * FROM preparaciones WHERE id=?').get(parseInt(id));
}

// Busca en preparacion_eventos quién subió una foto, mirando el evento 'foto_subida'
// que quedó registrado con ese foto_id en su detalle_json. Fail-open a propósito (igual
// que registrarEvento): si json_extract fallara (JSON1 no disponible, detalle_json
// corrupto en un evento viejo) o no hubiera evento previo (foto preexistente al ciclo de
// instrumentación), devuelve null y nunca lanza — el borrado de la foto no debe romperse
// por esto.
function usuarioQueSubio(db, fotoId, preparacionId) {
  try {
    const evento = db.prepare(
      "SELECT usuario FROM preparacion_eventos WHERE tipo='foto_subida' AND preparacion_id=? AND json_extract(detalle_json,'$.foto_id')=? ORDER BY id DESC LIMIT 1"
    ).get(preparacionId, fotoId);
    return evento?.usuario ?? null;
  } catch (e) {
    console.error('usuarioQueSubio: no se pudo consultar', e.message);
    return null;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function preparacionRouter(db, cfg) {
  ensureTables(db);
  const router = express.Router();
  const eventoLote = (loteId, tipo, usuario, detalle = {}) => db.prepare(
    'INSERT INTO despacho_lote_eventos (lote_id, tipo, usuario, detalle_json, creado_en) VALUES (?,?,?,?,?)'
  ).run(loteId, tipo, usuario ?? null, JSON.stringify(detalle), now());
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS despacho_lote_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id INTEGER NOT NULL REFERENCES despacho_lotes(id),
      tipo TEXT NOT NULL, usuario TEXT, detalle_json TEXT NOT NULL, creado_en TEXT NOT NULL
    )`).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_despacho_lote_eventos_lote ON despacho_lote_eventos(lote_id, id)').run();
  } catch (error) { console.error('ensureTables despacho_lote_eventos:', error.message); }
  const andreaniStatus = cfg?.andreaniStatus || 'lpaandreani';
  const enviadoAndreaniStatus = cfg?.enviadoAndreaniStatus || 'enviadoandreani';
  const TRACKING_META_KEY = '_andreani_tracking';

  // Queries para resolución de GTIN/EAN en escanear
  const skuPorEan = db.prepare('SELECT sku FROM ean_sku WHERE ean=?');
  const skusPorGtin = db.prepare("SELECT DISTINCT sku FROM catalogo_cache WHERE gtin=? AND sku IS NOT NULL AND sku <> ''");

  // ─── Detección de vínculos entre pedidos (Fase 4) ─────────────────────────
  //
  // DISEÑO: Cuando se crea una preparación (POST /iniciar), corremos la detección
  // contra todos los otros pedidos ya preparados o pendientes. Si hay match y no
  // existe ya una fila en preparacion_vinculos para ese par, creamos una con
  // estado='sugerido'. Esto es O(n) por preparación creada, donde n es la cantidad
  // de preparaciones ya en la DB (decenas en producción, no miles). Mucho más
  // eficiente que hacerlo en GET /pendientes (que sería O(n²) en la cola).
  function inyectarDeteccionVinculosDesdePedidoNuevo(db, nuevoOrder, nuevaClave) {
    const ahora = now();

    // Obtener todas las preparaciones ya existentes + sus órdenes de pedidos_cache.
    // Usamos INNER JOIN para asegurarnos de que la fila cache existe.
    const otrasPreps = db.prepare(`
      SELECT p.clave, pc.canal, pc.wc_order_id, pc.ml_order_id, pc.items_json
      FROM preparaciones p
      INNER JOIN pedidos_cache pc ON p.clave = pc.clave
      WHERE p.clave != ?
      ORDER BY p.creado_en DESC
      LIMIT 100
    `).all(nuevaClave);

    for (const otraFila of otrasPreps) {
      // Construir un objeto "order" minimal desde pedidos_cache para poder pasarlo a
      // detectarVinculoEntrePedidos. Los datos de pedidos_cache son limitados, pero
      // suficientes para comparar email, teléfono. DNI puede venir en meta_data que no
      // tenemos acá, así que la detección por DNI fallaría — eso está bien, es un
      // false negative aceptable que se corrija manualmente.
      const otraOrder = {
        meta_data: [],
        billing: { email: otraFila.email || '', phone: '' },
        shipping: { phone: '', first_name: '', last_name: '', address_1: '' },
      };

      const campoMatch = detectarVinculoEntrePedidos(nuevoOrder, otraOrder);
      if (!campoMatch) continue;

      // Normalizar las claves: siempre en orden alfabético para el índice único.
      const [claveA, claveB] = [nuevaClave, otraFila.clave].sort();

      try {
        db.prepare(`
          INSERT INTO preparacion_vinculos
          (pedido_a_clave, pedido_b_clave, campo_match, estado, creado_en)
          VALUES (?, ?, ?, 'sugerido', ?)
        `).run(claveA, claveB, campoMatch, ahora);
      } catch (e) {
        if (!/unique constraint/i.test(e.message)) {
          console.error('inyectarDeteccionVinculosDesdePedidoNuevo:', e.message);
        }
      }
    }
  }

  // Disparo inmediato de la cola de fotos tras cada subida/reintento (además del cron de
  // barrido en server.js). Default ON en producción; los tests lo apagan (cfg.colaFotos.
  // disparoInmediato: false) para no lanzar workers threads reales de fondo en cada test que
  // sube una foto — el módulo de la cola se testea aparte, inyectando un worker de prueba vía
  // cfg.colaFotos.workerPath.
  const dispararColaFotos = cfg?.colaFotos?.disparoInmediato !== false
    ? () => procesarColaFotos(db, { workerPath: cfg?.colaFotos?.workerPath })
        .catch(e => console.error('[preparacion] error disparando cola de fotos:', e.message))
    : () => {};

  // ── Pendientes: lee de pedidos_cache (sincronizada por cron cada 5 min) ──
  router.get('/pendientes', (req, res) => {
    try {
      try { sincronizarMiniOlas(db); } catch (e) { console.error('[preparacion] error sincronizando mini-olas:', e.message); }
      const rows = pedidosElegiblesOrdenados(db);
      // Filtramos filas cuya preparación local ya está resuelta (completada, o en flujo de
      // depósito con pantalla propia en Historial). El sync de ML nunca marca estado_envio
      // como "enviado" en la caché (diseño existente, fuera de alcance acá) y la poda de
      // syncPedidosCache excluye a propósito estas filas para no borrar de más — por eso
      // pueden quedar en pedidos_cache con estado_envio='pendiente' para siempre aunque el
      // operario ya haya terminado. Filtramos acá, en la lectura, sin tocar la poda.
      // 'cerrada_sin_evidencia': preparaciones viejas cerradas por el script de
      // mantenimiento (ver scripts/cerrar-preparaciones-sin-evidencia.mjs) — salen de la
      // cola de trabajo igual que una completada, pero se consultan desde su sección propia
      // (GET /cerradas-sin-evidencia) si entra un reclamo, no desde acá.
      // 'despachada_sin_verificar': el pedido ya salió (tracking cargado, mail al cliente
      // ya mandado) aunque no estaba verificado — no es "pendiente de trabajo" (ya se
      // despachó, no tiene sentido que el sector lo vuelva a ver acá), se consulta desde
      // GET /despachadas-sin-verificar.
      const RESUELTAS = ['completada', 'pendiente_deposito', 'cerrada_sin_evidencia', 'despachada_sin_verificar'];
      const data = rows
        .map(row => {
          const prep = db.prepare('SELECT id, estado, etiqueta_lista FROM preparaciones WHERE clave=?').get(row.clave);
          return { row, prep };
        })
        .filter(({ prep }) => !prep || !RESUELTAS.includes(prep.estado))
        .map(({ row, prep }) => {
          const items = JSON.parse(row.items_json);
          let waveItem = null;
          try {
            const jornada = jornadaDeHoy(db);
            waveItem = jornada
              ? db.prepare(`SELECT pw.id, pw.tipo FROM pick_wave_items pi
                JOIN pick_waves pw ON pw.id = pi.pick_wave_id
                WHERE pi.pedido_clave = ? AND pw.operational_day_id = ?`).get(row.clave, jornada.id)
              : null;
          } catch (e) { /* fail-open: metadata auxiliar de jornada, no debe romper /pendientes */ }
        if (row.canal === 'web') {
          return {
            canal: 'web',
            espejo_ml: !!row.espejo_ml,
            wc_order_id: row.wc_order_id,
            numero_pedido: row.numero_pedido,
            comprador: row.comprador,
            fecha: row.fecha,
            fecha_despacho: row.fecha_despacho,
            fecha_despacho_limite: row.fecha_despacho_limite || null,
            estado_despacho: row.estado_despacho || null,
            despacho_motivo: row.despacho_motivo || null,
            shipment_limite_original: row.shipment_limite_original || null,
            estado_wc: row.estado_wc,
            notas: row.customer_note || '',
            items,
            preparacion_id: prep?.id || null,
            estado_preparacion: prep?.estado || null,
            etiqueta_lista: prep?.etiqueta_lista || 0,
            pick_wave_id: waveItem?.id || null,
            pick_wave_tipo: waveItem?.tipo || null,
          };
        }
        return {
          canal: 'ml',
          ml_order_id: row.ml_order_id,
          wc_order_id: row.wc_order_id,
          pack_id: row.pack_id || null,
          numero_pedido: row.numero_pedido,
          comprador: row.comprador,
          fecha: row.fecha,
          fecha_despacho: row.fecha_despacho,
          fecha_despacho_limite: row.fecha_despacho_limite || null,
          estado_despacho: row.estado_despacho || null,
          despacho_motivo: row.despacho_motivo || null,
          shipment_limite_original: row.shipment_limite_original || null,
          logistic_type: row.logistic_type,
          substatus: row.substatus,
          items,
          preparacion_id: prep?.id || null,
          estado_preparacion: prep?.estado || null,
          pick_wave_id: waveItem?.id || null,
          pick_wave_tipo: waveItem?.tipo || null,
        };
      });
      const ultimoLog = db.prepare(
        "SELECT creado_en, estado, error FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1"
      ).get();
      res.json({
        ok: true,
        data,
        actualizado_en: ultimoLog?.creado_en || null,
        sync_error: ultimoLog?.estado === 'error' ? ultimoLog.error : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Control de despacho: la jornada pertenece al pedido, no al momento en que se creó
  // el control. `pedidos_cache.fecha_despacho` ya contiene la fecha de despacho explícita
  // o el SLA normalizado a Buenos Aires; sin fila/fecha, el control queda en `sin_fecha`.
  router.get('/despacho/cola', (req, res) => {
    const fecha = req.query.fecha == null ? null : String(req.query.fecha);
    if (fecha !== null && fecha !== 'sin_fecha' && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ ok: false, error: 'fecha debe ser YYYY-MM-DD o sin_fecha', code: 'FECHA_INVALIDA' });
    }
    const estado = req.query.estado == null ? null : String(req.query.estado).trim();
    const canal = req.query.canal == null ? null : String(req.query.canal).trim();
    const q = req.query.q == null ? null : String(req.query.q).trim().toLowerCase();
    const estadosValidos = new Set(['pendiente', 'escaneado', 'confirmado']);
    if (estado && !estadosValidos.has(estado)) {
      return res.status(400).json({ ok: false, error: 'estado inválido', code: 'ESTADO_INVALIDO' });
    }
    // Una preparación aprobada entra en la hoja aunque todavía nadie haya escaneado
    // el paquete. INSERT OR IGNORE hace que la primera lectura sea operable y conserva
    // los controles huérfanos históricos para poder auditarlos.
    db.prepare(`INSERT OR IGNORE INTO despacho_controles
      (grupo_clave, estado, creado_en, actualizado_en)
      SELECT COALESCE(pack_id, clave), 'pendiente', creado_en, creado_en
      FROM preparaciones
      WHERE estado='completada'`).run();
    const params = [];
    const where = [];
    if (fecha === 'sin_fecha') where.push('jornada_fecha IS NULL');
    else if (fecha) { where.push('(jornada_fecha = ? OR (p.canal = \'web\' AND jornada_fecha IS NULL))'); params.push(fecha); }
    if (estado) { where.push('d.estado = ?'); params.push(estado); }
    if (canal) { where.push('p.canal = ?'); params.push(canal); }
    if (q) {
      where.push(`(lower(d.grupo_clave) LIKE ? OR lower(COALESCE(p.numero_pedido, '')) LIKE ?
        OR lower(COALESCE(p.clave, '')) LIKE ?)`);
      const term = `%${q}%`; params.push(term, term, term);
    }
    const base = `
      SELECT d.*, COUNT(e.id) AS escaneos,
        p.id AS preparacion_id, p.clave, p.canal, p.numero_pedido, p.estado AS estado_preparacion,
        p.pack_id, pc.fecha_despacho AS jornada_fecha,
        CASE WHEN pc.fecha_despacho IS NULL THEN 'sin_fecha' ELSE pc.fecha_despacho END AS jornada
      FROM despacho_controles d
      LEFT JOIN despacho_escaneos e ON e.control_id=d.id
      LEFT JOIN preparaciones p ON (p.pack_id = d.grupo_clave OR p.clave = d.grupo_clave)
      LEFT JOIN pedidos_cache pc ON pc.clave = (SELECT pc2.clave FROM pedidos_cache pc2
        WHERE pc2.clave = p.clave OR (p.pack_id IS NOT NULL AND pc2.pack_id = p.pack_id)
        ORDER BY pc2.actualizado_en DESC, pc2.clave DESC LIMIT 1)
      GROUP BY d.id`;
    const rows = db.prepare(`${base}${where.length ? ` HAVING ${where.join(' AND ')}` : ''} ORDER BY jornada_fecha IS NULL, jornada_fecha, d.creado_en`).all(...params);
    const jornada = fecha || 'sin_fecha';
    const allParams = fecha === 'sin_fecha' ? [] : fecha ? [fecha] : [];
    const summaryRows = db.prepare(`${base}${fecha === 'sin_fecha' ? ' HAVING jornada_fecha IS NULL' : fecha ? " HAVING (jornada_fecha = ? OR (p.canal = 'web' AND jornada_fecha IS NULL))" : ''}`).all(...allParams);
    const resumen = { total: summaryRows.length, pendientes: 0, escaneados: 0, confirmados: 0 };
    for (const row of summaryRows) resumen[row.estado === 'pendiente' ? 'pendientes' : `${row.estado}s`] += 1;
    return res.json({ ok: true, jornada: { fecha: jornada, zona_horaria: 'America/Argentina/Buenos_Aires' }, resumen, data: rows });
  });

  // E4: los lotes congelan una selección por canal; nunca se mezclan ML y Web/Andreani.
  router.post('/despacho/lotes', (req, res) => {
    const canal = String(req.body?.canal || '').trim();
    const fecha = String(req.body?.fecha_jornada || '').trim();
    const ids = [...new Set(Array.isArray(req.body?.control_ids)
      ? req.body.control_ids.map(Number).filter(Number.isInteger) : [])];
    const idem = String(req.get('Idempotency-Key') || '').trim();
    if (!['ml', 'web'].includes(canal)) return res.status(400).json({ ok: false, error: 'canal debe ser ml o web', code: 'CANAL_INVALIDO' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ ok: false, error: 'fecha_jornada inválida', code: 'FECHA_INVALIDA' });
    if (!ids.length) return res.status(400).json({ ok: false, error: 'control_ids no puede estar vacío', code: 'LOTE_SIN_MIEMBROS' });
    if (!idem) return res.status(400).json({ ok: false, error: 'Idempotency-Key requerido', code: 'IDEMPOTENCIA_REQUERIDA' });
    const existing = db.prepare('SELECT * FROM despacho_lotes WHERE idempotencia=?').get(idem);
    if (existing) return res.json({ ok: true, repetido: true, lote: existing, items: db.prepare('SELECT * FROM despacho_lote_items WHERE lote_id=?').all(existing.id) });
    try {
      const lote = db.transaction(() => {
        const valid = db.prepare(`SELECT d.id FROM despacho_controles d
          JOIN preparaciones p ON (p.pack_id=d.grupo_clave OR p.clave=d.grupo_clave)
          LEFT JOIN pedidos_cache pc ON pc.clave=p.clave
          WHERE d.id IN (${ids.map(() => '?').join(',')}) AND d.estado!='confirmado'
            AND p.canal=? AND pc.fecha_despacho=? AND p.estado='completada'
          GROUP BY d.id`).all(...ids, canal, fecha).map(row => row.id);
        if (valid.length !== ids.length) {
          const error = new Error('uno o más controles no son elegibles para este lote'); error.code = 'LOTE_MIEMBRO_INVALIDO'; throw error;
        }
        const ts = now();
        const created = db.prepare(`INSERT INTO despacho_lotes
          (canal, fecha_jornada, estado, creado_por, creado_en, motivo_anulacion)
          VALUES (?, ?, 'abierto', ?, ?, ?) RETURNING *`).get(canal, fecha, req.user.username, ts, null);
        db.prepare('UPDATE despacho_lotes SET idempotencia=? WHERE id=?').run(idem, created.id);
        const add = db.prepare(`INSERT INTO despacho_lote_items (lote_id, control_id, agregado_en) VALUES (?, ?, ?)`);
        for (const id of valid) add.run(created.id, id, ts);
        eventoLote(created.id, 'lote_creado', req.user.username, { canal, fecha_jornada: fecha, control_ids: valid, idempotencia: idem });
        return created;
      })();
      res.status(201).json({ ok: true, repetido: false, lote, items: db.prepare('SELECT * FROM despacho_lote_items WHERE lote_id=?').all(lote.id) });
    } catch (error) {
      const conflicto = error.code === 'LOTE_MIEMBRO_INVALIDO' || /UNIQUE constraint failed: despacho_lote_items.control_id/.test(error.message);
      res.status(conflicto ? 409 : 500).json({ ok: false, error: conflicto ? 'uno o más paquetes ya pertenecen a otro lote' : error.message, code: conflicto ? 'LOTE_MIEMBRO_DUPLICADO' : (error.code || 'LOTE_ERROR') });
    }
  });

  router.get('/despacho/lotes', (req, res) => {
    const fecha = req.query.fecha_jornada == null ? null : String(req.query.fecha_jornada).trim();
    const canal = req.query.canal == null ? null : String(req.query.canal).trim();
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ ok: false, error: 'fecha_jornada inválida', code: 'FECHA_INVALIDA' });
    if (canal && !['ml', 'web'].includes(canal)) return res.status(400).json({ ok: false, error: 'canal inválido', code: 'CANAL_INVALIDO' });
    const where = []; const params = [];
    if (fecha) { where.push('l.fecha_jornada=?'); params.push(fecha); }
    if (canal) { where.push('l.canal=?'); params.push(canal); }
    const rows = db.prepare(`SELECT l.*, COUNT(li.id) AS miembros,
      SUM(CASE WHEN li.estado='confirmado' THEN 1 ELSE 0 END) AS confirmados,
      SUM(CASE WHEN li.tracking IS NOT NULL THEN 1 ELSE 0 END) AS con_tracking
      FROM despacho_lotes l LEFT JOIN despacho_lote_items li ON li.lote_id=l.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY l.id ORDER BY l.fecha_jornada, l.canal, l.id`).all(...params);
    res.json({ ok: true, lotes: rows });
  });

  router.get('/despacho/lotes/:id', (req, res) => {
    const lote = db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(Number(req.params.id));
    if (!lote) return res.status(404).json({ ok: false, error: 'lote no encontrado' });
    res.json({ ok: true, lote, items: db.prepare(`SELECT li.*, d.grupo_clave, d.estado AS estado_despacho
      FROM despacho_lote_items li JOIN despacho_controles d ON d.id=li.control_id
      WHERE li.lote_id=? ORDER BY li.id`).all(lote.id) });
  });

  router.get('/despacho/lotes/:id/eventos', (req, res) => {
    const id = Number(req.params.id);
    if (!req.user?.is_admin && !['supervisor', 'supervisor_deposito', 'auditor', 'despacho'].includes(rolUsuario(req.user))) {
      return res.status(403).json({ ok: false, error: 'solo supervisor, auditor o despacho puede ver el historial del lote', code: 'FORBIDDEN' });
    }
    if (!db.prepare('SELECT id FROM despacho_lotes WHERE id=?').get(id)) return res.status(404).json({ ok: false, error: 'lote no encontrado' });
    res.json({ ok: true, eventos: db.prepare('SELECT id, lote_id, tipo, usuario, detalle_json, creado_en FROM despacho_lote_eventos WHERE lote_id=? ORDER BY id').all(id) });
  });

  router.post('/despacho/lotes/:id/iniciar', (req, res) => {
    const id = Number(req.params.id); const ts = now();
    const info = db.prepare(`UPDATE despacho_lotes SET estado='en_preparacion', iniciado_en=COALESCE(iniciado_en, ?)
      WHERE id=? AND estado='abierto'`).run(ts, id);
    if (!info.changes) return res.status(409).json({ ok: false, error: 'el lote no está abierto', code: 'LOTE_ESTADO_INVALIDO' });
    eventoLote(id, 'lote_iniciado', req.user.username);
    res.json({ ok: true, lote: db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(id) });
  });

  router.post('/despacho/lotes/:id/anular', (req, res) => {
    const id = Number(req.params.id); const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ ok: false, error: 'motivo requerido', code: 'MOTIVO_REQUERIDO' });
    const info = db.prepare(`UPDATE despacho_lotes SET estado='anulado', motivo_anulacion=? WHERE id=? AND estado IN ('abierto','en_preparacion')`).run(motivo, id);
    if (!info.changes) return res.status(409).json({ ok: false, error: 'el lote no puede anularse', code: 'LOTE_ESTADO_INVALIDO' });
    eventoLote(id, 'lote_anulado', req.user.username, { motivo });
    res.json({ ok: true, lote: db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(id) });
  });

  router.post('/despacho/lotes/:id/escanear', (req, res) => {
    const loteId = Number(req.params.id);
    const codigo = String(req.body?.codigo || '').trim();
    const idem = String(req.get('Idempotency-Key') || '').trim();
    if (!codigo || !idem) return res.status(400).json({ ok: false, error: 'codigo e Idempotency-Key requeridos', code: 'DATOS_REQUERIDOS' });
    const lote = db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(loteId);
    if (!lote || lote.estado !== 'en_preparacion') return res.status(409).json({ ok: false, error: 'el lote no está en preparación', code: 'LOTE_ESTADO_INVALIDO' });
    const item = db.prepare(`SELECT li.*, d.grupo_clave FROM despacho_lote_items li
      JOIN despacho_controles d ON d.id=li.control_id WHERE li.lote_id=? AND d.grupo_clave=?`).get(loteId, codigo);
    if (!item) return res.status(409).json({ ok: false, error: 'el código no pertenece al lote', code: 'LOTE_PAQUETE_AJENO' });
    if (item.ultima_idempotencia === idem) return res.json({ ok: true, repetido: true, item });
    if (item.estado === 'confirmado' || item.estado === 'anulado') return res.status(409).json({ ok: false, error: 'el paquete no puede escanearse en su estado actual', code: 'LOTE_ITEM_NO_OPERABLE' });
    const ts = now();
    const info = db.prepare(`UPDATE despacho_lote_items SET estado='escaneado', escaneado_en=?, ultima_idempotencia=? WHERE id=? AND estado='esperado'`).run(ts, idem, item.id);
    if (!info.changes) return res.status(409).json({ ok: false, error: 'otra operación actualizó el paquete', code: 'LOTE_CONFLICTO' });
    eventoLote(loteId, 'paquete_escaneado', req.user.username, { control_id: item.control_id, codigo, idempotencia: idem });
    res.status(201).json({ ok: true, repetido: false, item: db.prepare('SELECT * FROM despacho_lote_items WHERE id=?').get(item.id) });
  });

  router.post('/despacho/lotes/:id/tracking', (req, res) => {
    const loteId = Number(req.params.id);
    const controlId = Number(req.body?.control_id);
    const tracking = String(req.body?.tracking || '').trim();
    if (!Number.isInteger(controlId) || !tracking) return res.status(400).json({ ok: false, error: 'control_id y tracking requeridos', code: 'DATOS_REQUERIDOS' });
    const lote = db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(loteId);
    if (!lote || !['abierto', 'en_preparacion'].includes(lote.estado)) return res.status(409).json({ ok: false, error: 'el lote no admite tracking', code: 'LOTE_ESTADO_INVALIDO' });
    const item = db.prepare('SELECT * FROM despacho_lote_items WHERE lote_id=? AND control_id=?').get(loteId, controlId);
    if (!item) return res.status(404).json({ ok: false, error: 'el paquete no pertenece al lote', code: 'LOTE_PAQUETE_AJENO' });
    if (item.tracking && item.tracking !== tracking) return res.status(409).json({ ok: false, error: 'el paquete ya tiene otro tracking', code: 'TRACKING_CONFLICTO' });
    db.prepare('UPDATE despacho_lote_items SET tracking=? WHERE id=?').run(tracking, item.id);
    eventoLote(loteId, item.tracking ? 'tracking_repetido' : 'tracking_asociado', req.user.username, { control_id: controlId, tracking });
    res.json({ ok: true, repetido: !!item.tracking, item: db.prepare('SELECT * FROM despacho_lote_items WHERE id=?').get(item.id) });
  });

  router.post('/despacho/lotes/:id/cerrar', (req, res) => {
    const loteId = Number(req.params.id); const motivo = String(req.body?.motivo || '').trim();
    const lote = db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(loteId);
    if (!lote || lote.estado !== 'en_preparacion') return res.status(409).json({ ok: false, error: 'el lote no está en preparación', code: 'LOTE_ESTADO_INVALIDO' });
    const resumen = db.prepare(`SELECT estado, COUNT(*) AS cantidad FROM despacho_lote_items WHERE lote_id=? GROUP BY estado`).all(loteId);
    const pendientes = resumen.filter(row => !['confirmado', 'escaneado'].includes(row.estado)).reduce((sum, row) => sum + row.cantidad, 0);
    if (pendientes && !motivo) return res.status(409).json({ ok: false, error: 'hay miembros sin confirmar; indicá motivo para cierre excepcional', code: 'LOTE_INCOMPLETO', resumen });
    const ts = now();
    db.transaction(() => {
      db.prepare(`UPDATE despacho_lote_items SET estado='confirmado', confirmado_en=? WHERE lote_id=? AND estado='escaneado'`).run(ts, loteId);
      db.prepare(`UPDATE despacho_lotes SET estado='cerrado', cerrado_en=?, motivo_anulacion=? WHERE id=? AND estado='en_preparacion'`).run(ts, motivo || null, loteId);
    })();
    eventoLote(loteId, 'lote_cerrado', req.user.username, { motivo: motivo || null, resumen });
    res.json({ ok: true, lote: db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(loteId), resumen });
  });

  router.post('/despacho/lotes/:id/salida', (req, res) => {
    const id = Number(req.params.id); const idem = String(req.get('Idempotency-Key') || '').trim();
    if (!idem) return res.status(400).json({ ok: false, error: 'Idempotency-Key requerido', code: 'IDEMPOTENCIA_REQUERIDA' });
    const lote = db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(id);
    if (!lote) return res.status(404).json({ ok: false, error: 'lote no encontrado' });
    if (lote.salida_idempotencia === idem) return res.json({ ok: true, repetido: true, lote });
    if (lote.estado !== 'cerrado') return res.status(409).json({ ok: false, error: 'el lote debe estar cerrado antes de confirmar salida', code: 'LOTE_NO_CERRADO' });
    if (lote.salida_idempotencia) return res.status(409).json({ ok: false, error: 'la salida ya fue confirmada con otra idempotencia', code: 'SALIDA_YA_CONFIRMADA' });
    const ts = now();
    const info = db.prepare(`UPDATE despacho_lotes SET salida_confirmada_por=?, salida_confirmada_en=?, salida_idempotencia=?
      WHERE id=? AND estado='cerrado' AND salida_idempotencia IS NULL`).run(req.user.username, ts, idem, id);
    if (!info.changes) return res.status(409).json({ ok: false, error: 'otra operación confirmó la salida', code: 'SALIDA_CONFLICTO' });
    eventoLote(id, 'salida_confirmada', req.user.username, { idempotencia: idem });
    const jobEventId = encolarSalidaWoo(db, db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(id), req.user.username);
    res.json({ ok: true, repetido: false, lote: db.prepare('SELECT * FROM despacho_lotes WHERE id=?').get(id) });
  });

  router.post('/despacho/:id/escanear', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const bloqueo = prep.estado === 'completada' ? null : bloqueoPorEstado(prep);
    if (bloqueo) return res.status(400).json({ ok: false, error: bloqueo, code: 'PREPARACION_CERRADA' });
    const cache = db.prepare('SELECT fecha_despacho FROM pedidos_cache WHERE clave=? OR (pack_id IS NOT NULL AND pack_id=?) ORDER BY actualizado_en DESC, clave DESC LIMIT 1').get(prep.clave, prep.pack_id || null);
    if (!cache?.fecha_despacho) return res.status(409).json({ ok: false, error: 'el pedido no tiene jornada de despacho asignada', code: 'DESPACHO_SIN_FECHA' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();
    const idempotencia = String(req.get('Idempotency-Key') || req.body?.idempotencia || '').trim();
    if (!codigo || !idempotencia) return res.status(400).json({ ok: false, error: 'codigo e idempotencia requeridos' });
    const previoGlobal = db.prepare('SELECT * FROM despacho_escaneos WHERE idempotencia=?').get(idempotencia);
    if (previoGlobal && previoGlobal.preparacion_id !== prep.id) {
      return res.status(409).json({ ok: false, error: 'la idempotencia ya fue usada para otro despacho', code: 'IDEMPOTENCY_CONFLICT' });
    }
    const grupo = prep.pack_id || prep.clave;
    // Alias no permitido: el código esperado es exactamente pack_id o, si no existe, clave.
    if (codigo !== String(grupo).trim().toUpperCase()) {
      return res.status(409).json({ ok: false, error: 'el código no coincide con el despacho', code: 'DESPACHO_NO_COINCIDE', match: 'no_coincide' });
    }
    const control = db.prepare('INSERT INTO despacho_controles (grupo_clave, creado_en, actualizado_en) VALUES (?,?,?) ON CONFLICT(grupo_clave) DO UPDATE SET actualizado_en=excluded.actualizado_en RETURNING *')
      .get(grupo, now(), now());
    const previo = previoGlobal || db.prepare('SELECT * FROM despacho_escaneos WHERE idempotencia=?').get(idempotencia);
    if (previo && (previo.control_id !== control.id || previo.preparacion_id !== prep.id || previo.codigo !== codigo)) {
      return res.status(409).json({ ok: false, error: 'la idempotencia ya fue usada para otro despacho', code: 'IDEMPOTENCY_CONFLICT' });
    }
    if (control.estado === 'confirmado') return res.status(409).json({ ok: false, error: 'el despacho ya fue confirmado', code: 'DESPACHO_CONFIRMADO' });
    if (previo) return res.json({ ok: true, repetido: true, control });
    db.transaction(() => {
      db.prepare('INSERT INTO despacho_escaneos (control_id, preparacion_id, codigo, idempotencia, usuario, creado_en) VALUES (?,?,?,?,?,?)')
        .run(control.id, prep.id, codigo, idempotencia, req.user.username, now());
      db.prepare("UPDATE despacho_controles SET estado='escaneado', actualizado_en=? WHERE id=? AND estado='pendiente'").run(now(), control.id);
      registrarEvento(db, { preparacionId: prep.id, tipo: 'despacho_escaneo', usuario: req.user.username, detalle: { codigo, grupo_clave: grupo, idempotencia }, failClosed: true });
    })();
    res.status(201).json({ ok: true, repetido: false, control: db.prepare('SELECT * FROM despacho_controles WHERE id=?').get(control.id) });
  });

  router.post('/despacho/:id/confirmar', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const bloqueo = prep.estado === 'completada' ? null : bloqueoPorEstado(prep);
    if (bloqueo) return res.status(400).json({ ok: false, error: bloqueo, code: 'PREPARACION_CERRADA' });
    const idempotencia = String(req.get('Idempotency-Key') || '').trim();
    if (!idempotencia) return res.status(400).json({ ok: false, error: 'Idempotency-Key requerido', code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const grupo = prep.pack_id || prep.clave;
    const control = db.prepare('SELECT * FROM despacho_controles WHERE grupo_clave=?').get(grupo);
    if (!control) return res.status(409).json({ ok: false, error: 'el despacho requiere al menos un escaneo' });
    if (!['escaneado', 'confirmado'].includes(control.estado)) return res.status(409).json({ ok: false, error: 'estado de despacho inválido', code: 'DESPACHO_ESTADO_INVALIDO' });
    const previo = db.prepare('SELECT * FROM despacho_controles WHERE confirmacion_idempotencia=?').get(idempotencia);
    if (previo && previo.id !== control.id) return res.status(409).json({ ok: false, error: 'la idempotencia ya fue usada para otro despacho', code: 'IDEMPOTENCY_CONFLICT' });
    if (control.confirmacion_idempotencia && control.confirmacion_idempotencia !== idempotencia) return res.status(409).json({ ok: false, error: 'el despacho ya fue confirmado con otra idempotencia', code: 'IDEMPOTENCY_CONFLICT' });
    if (control.estado === 'confirmado') return res.json({ ok: true, repetido: true, control });
    const ts = now();
    const confirmar = db.transaction(() => {
      const cambio = db.prepare("UPDATE despacho_controles SET estado='confirmado', confirmado_por=?, confirmado_en=?, actualizado_en=?, confirmacion_idempotencia=? WHERE id=? AND estado='escaneado' AND (confirmacion_idempotencia IS NULL OR confirmacion_idempotencia=?)")
        .run(req.user.username, ts, ts, idempotencia, control.id, idempotencia);
      if (!cambio.changes) return { repetido: true, etiquetaId: db.prepare('SELECT etiqueta_cola_id FROM despacho_controles WHERE id=?').get(control.id).etiqueta_cola_id };
      db.prepare(`INSERT INTO preparacion_eventos (preparacion_id, item_id, tipo, usuario, detalle_json, creado_en)
        VALUES (?,?,?,?,?,?)`).run(prep.id, null, 'despacho_confirmado', req.user.username,
          JSON.stringify({ grupo_clave: grupo, etiqueta_cola_id: null, formato: '50x25mm', etiqueta_momento: 'evidencia_completa' }), ts);
      db.prepare("UPDATE preparaciones SET estado='despachada_sin_verificar' WHERE id=? AND estado NOT IN ('completada', 'cerrada_sin_evidencia')")
        .run(prep.id);
      return { repetido: false, etiquetaId: null };
    })();
    if (confirmar.repetido) return res.json({ ok: true, repetido: true, control: db.prepare('SELECT * FROM despacho_controles WHERE id=?').get(control.id) });
    res.json({ ok: true, repetido: false, control: db.prepare('SELECT * FROM despacho_controles WHERE id=?').get(control.id), etiqueta_cola_id: confirmar.etiquetaId });
  });

  router.post('/despacho/:id/confirmar-manual', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const motivo = String(req.body?.motivo || '').trim();
    const nota = String(req.body?.nota || '').trim();
    if (!MOTIVOS_DESPACHO_MANUAL.includes(motivo)) return res.status(400).json({ ok: false, error: 'motivo de despacho manual inválido', code: 'MOTIVO_REQUERIDO' });
    if (nota.length > 500) return res.status(400).json({ ok: false, error: 'nota demasiado larga', code: 'NOTA_INVALIDA' });
    const idempotencia = String(req.get('Idempotency-Key') || '').trim();
    if (!idempotencia) return res.status(400).json({ ok: false, error: 'Idempotency-Key requerido', code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const grupo = prep.pack_id || prep.clave;
    const existente = db.prepare('SELECT * FROM despacho_controles WHERE grupo_clave=?').get(grupo);
    const previo = db.prepare('SELECT * FROM despacho_controles WHERE confirmacion_idempotencia=?').get(idempotencia);
    if (previo && previo.id !== existente?.id) return res.status(409).json({ ok: false, error: 'la idempotencia ya fue usada para otro despacho', code: 'IDEMPOTENCY_CONFLICT' });
    if (existente?.estado === 'confirmado') return res.json({ ok: true, repetido: true, control: existente });
    const ts = now();
    const resultado = db.transaction(() => {
      const control = existente || db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES (?, 'pendiente', ?, ?) RETURNING *").get(grupo, ts, ts);
      const cambio = db.prepare("UPDATE despacho_controles SET estado='confirmado', confirmado_por=?, confirmado_en=?, actualizado_en=?, confirmacion_idempotencia=? WHERE id=? AND estado!='confirmado' AND (confirmacion_idempotencia IS NULL OR confirmacion_idempotencia=?)").run(req.user.username, ts, ts, idempotencia, control.id, idempotencia);
      if (!cambio.changes) return { repetido: true };
      registrarEvento(db, { preparacionId: prep.id, tipo: 'despacho_confirmado_manual', usuario: req.user.username, detalle: { grupo_clave: grupo, motivo, nota: nota || null, codigo_verificado: false }, failClosed: true });
      db.prepare("UPDATE preparaciones SET estado='despachada_sin_verificar' WHERE id=? AND estado NOT IN ('completada', 'cerrada_sin_evidencia')").run(prep.id);
      return { repetido: false };
    })();
    return res.json({ ok: true, ...resultado, control: db.prepare('SELECT * FROM despacho_controles WHERE grupo_clave=?').get(grupo) });
  });

  router.post('/despacho/regularizar-jornada-sin-evidencia', (req, res) => {
    if (!req.user?.is_admin) return res.status(403).json({ ok: false, error: 'la regularización masiva requiere administrador', code: 'FORBIDDEN' });
    const fecha = String(req.body?.fecha || '').trim();
    const motivo = String(req.body?.motivo || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ ok: false, error: 'fecha inválida', code: 'FECHA_INVALIDA' });
    if (motivo !== 'despachado_sin_evidencia_herramienta_inhabilitada') return res.status(400).json({ ok: false, error: 'motivo de regularización inválido', code: 'MOTIVO_REQUERIDO' });
    const ts = now();
    const filas = db.prepare(`SELECT DISTINCT p.id, p.pack_id, p.clave FROM preparaciones p JOIN pedidos_cache pc
      ON pc.clave=p.clave OR (p.pack_id IS NOT NULL AND pc.pack_id=p.pack_id)
      LEFT JOIN despacho_controles dc ON dc.grupo_clave=COALESCE(p.pack_id,p.clave)
      WHERE pc.fecha_despacho=? AND COALESCE(dc.estado, 'pendiente') <> 'confirmado'`).all(fecha);
    const cantidad = db.transaction(() => filas.reduce((n, prep) => {
      const grupo = prep.pack_id || prep.clave;
      db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en, confirmado_por, confirmado_en, confirmacion_idempotencia) VALUES (?, 'confirmado', ?, ?, ?, ?, ?) ON CONFLICT(grupo_clave) DO UPDATE SET estado='confirmado', confirmado_por=excluded.confirmado_por, confirmado_en=excluded.confirmado_en, actualizado_en=excluded.actualizado_en, confirmacion_idempotencia=COALESCE(despacho_controles.confirmacion_idempotencia, excluded.confirmacion_idempotencia)").run(grupo, ts, ts, req.user.username, ts, `regularizacion:${fecha}:${grupo}`);
      registrarEvento(db, { preparacionId: prep.id, tipo: 'despacho_regularizado_sin_evidencia', usuario: req.user.username, detalle: { grupo_clave: grupo, fecha, motivo, evidencia: 'no_disponible', herramienta_inhabilitada: true }, failClosed: true });
      db.prepare("UPDATE preparaciones SET estado='despachada_sin_verificar' WHERE id=? AND estado NOT IN ('completada', 'cerrada_sin_evidencia')").run(prep.id);
      return n + 1;
    }, 0))();
    res.json({ ok: true, fecha, regularizadas: cantidad });
  });

  router.get('/horarios-despacho', (req, res) => {
    try { return res.json({ ok: true, version: leerVersionHorarios(db), data: leerHorarios(db) }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  router.put('/horarios-despacho', (req, res) => {
    try {
      const horarios = req.body?.horarios;
      if (!Array.isArray(horarios) || horarios.length !== 7
        || new Set(horarios.map((h) => Number(h.dia))).size !== 7
        || horarios.some((h) => !DIAS_SEMANA.includes(Number(h.dia)) || typeof h.habilitado !== 'boolean' || !horaValida(h.hora_corte))
        || !horarios.some((h) => h.habilitado === true)) {
        return res.status(422).json({ ok: false, error: 'horarios inválidos' });
      }
      const expectedVersion = Number(req.body?.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return res.status(422).json({ ok: false, error: 'expected_version inválida' });
      }
      const versionActual = leerVersionHorarios(db);
      if (expectedVersion !== versionActual) {
        return res.status(409).json({ ok: false, error: 'conflicto de versión', code: 'VERSION_CONFLICT', current_version: versionActual, version: versionActual });
      }
      const anteriores = leerHorarios(db);
      const usuario = req.user?.username ?? req.session?.username ?? null;
      const siguienteVersion = versionActual + 1;
      const update = db.prepare('UPDATE despacho_horarios SET habilitado=?, hora_corte=?, actualizado_en=? WHERE dia=?');
      const tx = db.transaction(() => {
        horarios.forEach((h) => update.run(h.habilitado ? 1 : 0, h.hora_corte, now(), Number(h.dia)));
        const cambiado = db.prepare('UPDATE despacho_horarios_meta SET version=?, actualizado_en=? WHERE id=1 AND version=?')
          .run(siguienteVersion, now(), expectedVersion);
        if (cambiado.changes !== 1) throw Object.assign(new Error('conflicto de versión'), { code: 'VERSION_CONFLICT' });
        db.prepare(`INSERT INTO despacho_horarios_auditoria
          (usuario, valores_anteriores_json, valores_nuevos_json, version_anterior, version_nueva, creado_en)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(usuario, JSON.stringify(anteriores), JSON.stringify(leerHorarios(db)), expectedVersion, siguienteVersion, now());
      });
      tx();
      return res.json({ ok: true, version: siguienteVersion, data: leerHorarios(db) });
    } catch (e) {
      if (e.code === 'VERSION_CONFLICT' || e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') {
        return res.status(409).json({ ok: false, error: 'conflicto de versión', code: 'VERSION_CONFLICT', current_version: leerVersionHorarios(db) });
      }
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Estados de pedido vistos en WC (respaldo para confirmar el slug) ──
  router.get('/estados-wc', async (req, res) => {
    try {
      const resp = await wooFetch(cfg.woo, '/orders?per_page=100');
      const conteo = {};
      for (const o of resp.data || []) conteo[o.status] = (conteo[o.status] || 0) + 1;
      res.json({ ok: true, data: conteo, configurado: andreaniStatus });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Etiquetas Andreani: una fila por pedido web pendiente ──
  router.get('/etiquetas', async (req, res) => {
    try {
      const resp = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`);
      const filas = (resp.data || []).map(order => {
        const prep = db.prepare(
          'SELECT id, etiqueta_lista, estado, direccion_confirmada_fuente FROM preparaciones WHERE clave=?'
        ).get(`web:${order.id}`);
        return {
          wc_order_id: order.id,
          envio: normalizarEnvio(order, prep?.direccion_confirmada_fuente || null),
          etiqueta_lista: prep?.etiqueta_lista || 0,
          preparacion_id: prep?.id || null,
          estado_preparacion: prep?.estado || null,
        };
      });
      res.json({ ok: true, data: filas });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Marca/desmarca "etiqueta lista"; crea la preparación mínima si no existía
  // (las etiquetas suelen hacerse antes de empezar a embalar).
  router.post('/etiquetas/:wcOrderId/lista', (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado' });
    const { lista = true, numero_pedido, comprador } = req.body || {};
    const clave = `web:${wcOrderId}`;
    const existente = db.prepare('SELECT * FROM preparaciones WHERE clave=?').get(clave);
    if (existente && !exigirClaimVigente(db, existente, req.user.username, res)) return;
    let claim;
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, numero_pedido, comprador, etiqueta_lista, estado, creado_en)
          VALUES ('web', ?, ?, ?, ?, ?, 'en_preparacion', ?)
          ON CONFLICT(clave) DO UPDATE SET etiqueta_lista=excluded.etiqueta_lista`)
          .run(clave, wcOrderId, numero_pedido || String(wcOrderId), comprador || null, lista ? 1 : 0, now());
        const prep = db.prepare('SELECT id FROM preparaciones WHERE clave=?').get(clave);
        claim = claimPreparacion(db, prep.id, req.user.username, cfg, new Date(), true);
        if (!claim.ok) {
          const error = new Error('PREPARATION_CLAIMED');
          error.code = claim.code;
          error.claim = claim.claim;
          throw error;
        }
      })();
    } catch (error) {
      if (error.code === 'PREPARATION_CLAIMED') return claimConflict(res, error.claim);
      throw error;
    }
    if (!claim.ok) return claim.code === 'AUTH_REQUIRED'
      ? res.status(401).json({ ok: false, error: 'No autenticado' })
      : claimConflict(res, claim.claim);
    res.json({ ok: true, etiqueta_lista: lista ? 1 : 0 });
  });

  // ── Seguimientos: tres secciones que reparten TODO el universo lpaandreani ──
  // Antes (versión vieja, retirada): "a medias" se INFERÍA mirando la meta _andreani_tracking
  // en pedidos 'completed' de Woo. Esa inferencia daba falso positivo en cualquier pedido con
  // el tracking cargado A MANO en WooCommerce (el hábito real del usuario, confirmado por él),
  // así que mostraba ~70 pedidos "colgados" que nunca pasaron por esta herramienta — ver
  // docs/superpowers/plans/2026-08-13-seguimientos.md. Ahora "a medias" es EXCLUSIVAMENTE
  // el dato local `woo_paso2_pendiente=1`, que esta misma herramienta pone en 1 al hacer el
  // paso 1 y limpia al confirmar el paso 2 (o al reintentar) — nunca se infiere de Woo.
  //
  // - esperando: preparación local 'completada' (preparado y VERIFICADO) todavía en
  //   lpaandreani — falta cargar el tracking.
  // - sin_preparacion: TODO el resto del universo lpaandreani (sin fila local, o
  //   en_preparacion/despachada_sin_verificar/cerrada_sin_evidencia). A propósito no se
  //   excluye 'en_preparacion': marcar "etiqueta lista" ya crea una preparación en ese
  //   estado sin trabajo real (POST /etiquetas/:wcOrderId/lista), así que excluirla
  //   escondería justo los pedidos por despacharse.
  // - a_medias: woo_paso2_pendiente=1 (dato local). Ya no están en lpaandreani (Woo los
  //   movió a 'completed' en el paso 1). Antes se armaba `envio` pidiéndole a Woo un GET
  //   por fila (costo "típicamente 0" pero sin techo: si el paso 2 empieza a fallar
  //   sistemáticamente, cada carga de tracking del día deja una fila acá y la pantalla
  //   pasa a hacer N GET seriales sin límite — hallazgo del revisor). Ahora `envio` sale
  //   ENTERO de datos locales (preparaciones.numero_pedido/comprador, ya guardados en el
  //   mismo INSERT que pone woo_paso2_pendiente=1): más pobre que el de Woo (sin
  //   dirección/localidad), pero cardAMedias() en el frontend solo usa pedido/nombre/
  //   localidad con fallback a null, y estos son justo los pedidos trabados que YA
  //   pasaron por el paso 1 (mail al cliente ya mandado) — no hace falta reimprimir
  //   etiqueta desde acá. Además LIMIT 20 + `a_medias_total`: sin tope, un universo que
  //   crece de verdad (el escenario de arriba) también volvía sin límite.
  router.get('/seguimientos', async (req, res) => {
    try {
      const resp = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`);
      const filasUniverso = resp.data || [];
      // Universo truncado en silencio si hay más de 100 en lpaandreani: el criterio de
      // diseño de esta pantalla es que nada se oculte, así que un `truncado:true` explícito
      // es mejor que una lista incompleta sin ninguna señal (hallazgo del revisor).
      const truncado = filasUniverso.length === 100;
      const esperando = [];
      const sinPreparacion = [];
      for (const order of filasUniverso) {
        const prep = db.prepare(
          'SELECT id, estado, direccion_confirmada_fuente FROM preparaciones WHERE clave=?'
        ).get(`web:${order.id}`);
        const fila = {
          wc_order_id: order.id,
          envio: normalizarEnvio(order, prep?.direccion_confirmada_fuente || null),
          preparacion_id: prep?.id || null,
          estado_preparacion: prep?.estado || null,
        };
        if (prep?.estado === 'completada') esperando.push(fila);
        else sinPreparacion.push(fila);
      }

      const totalAMedias = db.prepare(
        "SELECT COUNT(*) n FROM preparaciones WHERE canal='web' AND woo_paso2_pendiente=1"
      ).get().n;
      const pendientesPaso2 = db.prepare(
        `SELECT id, wc_order_id, tracking, numero_pedido, comprador, localidad FROM preparaciones
         WHERE canal='web' AND woo_paso2_pendiente=1 ORDER BY id LIMIT 20`
      ).all();
      const aMedias = pendientesPaso2.map((row) => ({
        wc_order_id: row.wc_order_id,
        envio: {
          pedido: row.numero_pedido || String(row.wc_order_id),
          nombre: row.comprador || '',
          apellido: '',
          localidad: row.localidad || '',
          provincia: '',
        },
        preparacion_id: row.id,
        tracking: row.tracking || null,
      }));

      // Solo canal='web': esta pantalla trabaja exclusivamente el universo lpaandreani/
      // Andreani, y hoy nada del flujo 'ml' pone una preparación en este estado — filtrar
      // por canal deja el número atado al dominio real de la pantalla en vez de a la tabla
      // entera. Sin ventana temporal a propósito: 'despachada_sin_verificar' NO es terminal
      // (POST /:id/completar la puede subir a 'completada' si se verifica después), así que
      // el conteo baja solo con trabajo real. Ocultar los viejos con una ventana escondería
      // justo los reclamos más urgentes de resolver, contra el criterio de "nada se oculta"
      // de esta pantalla (hallazgo del revisor).
      const despachadosSinVerificar = db.prepare(
        "SELECT COUNT(*) n FROM preparaciones WHERE canal='web' AND estado='despachada_sin_verificar'"
      ).get().n;

      // COUNT(DISTINCT preparacion_id), no COUNT(*): un reintento manual sobre un pedido
      // colgado registra un segundo evento 'tracking_cargado' para el MISMO pedido, y
      // COUNT(*) lo contaba dos veces (hallazgo del revisor). El corte de "hoy" es en hora
      // de Buenos Aires (lib/tiempo.js) — antes era medianoche UTC = 21:00 Argentina.
      const inicioHoy = inicioHoyBuenosAiresISO();
      const cargadosHoy = db.prepare(
        "SELECT COUNT(DISTINCT preparacion_id) n FROM preparacion_eventos WHERE tipo='tracking_cargado' AND creado_en >= ?"
      ).get(inicioHoy).n;

      res.json({
        ok: true,
        data: {
          esperando,
          sin_preparacion: sinPreparacion,
          a_medias: aMedias,
          a_medias_total: totalAMedias,
          despachados_sin_verificar: despachadosSinVerificar,
          cargados_hoy: cargadosHoy,
          truncado,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Cargar tracking: guarda meta + avanza status lpaandreani → completed → enviadoandreani ──
  router.post('/seguimientos/:wcOrderId', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    const tracking = String(req.body?.tracking || '').trim();
    if (!tracking) return res.status(400).json({ ok: false, error: 'tracking requerido' });
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    const prepExistente = db.prepare('SELECT * FROM preparaciones WHERE clave=?').get(`web:${wcOrderId}`);
    if (prepExistente && !exigirClaimVigente(db, prepExistente, req.user.username, res)) return;

    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const statusActual = actual.data?.status;
      const metaExistente = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingGuardado = String(metaExistente?.value || '').trim();

      // Fail-closed: solo se acepta desde el estado de origen (lpaandreani) o
      // desde un pedido "colgado" en 'completed' que ya tenga guardado EXACTAMENTE
      // el mismo tracking (reintento). Si está 'completed' con un tracking distinto
      // no se pisa: haría un PUT1 que reenvía el mail nativo al cliente. Corregir un
      // tracking erróneo sería un flujo aparte, hoy hacemos fail-closed.
      const enOrigen = statusActual === andreaniStatus;
      const colgadoCompletado = statusActual === 'completed' && trackingGuardado === tracking;
      if (!enOrigen && !colgadoCompletado) {
        return res.status(409).json({
          ok: false,
          error: `el pedido está en estado '${statusActual}', no se puede cargar el seguimiento`,
        });
      }

      const metaEntry = metaExistente
        ? { id: metaExistente.id, key: TRACKING_META_KEY, value: tracking }
        : { key: TRACKING_META_KEY, value: tracking };

      // Paso 1: guarda el tracking y pasa a 'completed' (dispara el mail nativo de WooCommerce).
      // Se saltea cuando el pedido ya está en 'completed' con el mismo tracking (reintento):
      // así no se reenvía el mail al cliente.
      const yaCompletadoMismoTracking = statusActual === 'completed' && trackingGuardado === tracking;
      if (!yaCompletadoMismoTracking) {
        await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', {
          status: 'completed',
          meta_data: [metaEntry],
        });
      }
      // Registro local ANTES del paso 2: si el paso 2 falla, igual queda constancia de
      // que el pedido llegó a 'completed' con tracking guardado — sin esto, la única
      // fuente de verdad sería Woo (y solo se detectaría escaneando status=completed).
      // También llenamos numero_pedido/comprador/localidad desde el GET de más arriba
      // (`actual.data`): para un pedido de "sin_preparacion" (el caso central de esta
      // pantalla) esta es la PRIMERA fila local que se crea, y sin esto nace con ambos en
      // NULL — la tarjeta de `a_medias` terminaba mostrando el wc_order_id como número Y
      // como nombre, y ese id además NO es el número de pedido real de Woo (que usa
      // numeración custom vía `order.number`, ver lib/preparacion.js normalizarEnvio) — el
      // operario quedaba sin forma de ubicar en Woo el único pedido que está trabado
      // (hallazgo del revisor). ON CONFLICT también los actualiza: si ya existía una fila
      // vieja con datos desactualizados (ej. el comprador cambió el pedido), se refresca.
      const crearYTomar = db.transaction(() => {
        db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, numero_pedido, comprador, localidad, etiqueta_lista, estado, creado_en, woo_paso2_pendiente, tracking)
        VALUES ('web', ?, ?, ?, ?, ?, 1, 'en_preparacion', ?, 1, ?)
        ON CONFLICT(clave) DO UPDATE SET numero_pedido=excluded.numero_pedido, comprador=excluded.comprador, localidad=excluded.localidad, woo_paso2_pendiente=1, tracking=excluded.tracking`)
        .run(
          `web:${wcOrderId}`, wcOrderId,
          String(actual.data.number ?? wcOrderId),
          `${actual.data.billing?.first_name || ''} ${actual.data.billing?.last_name || ''}`.trim() || null,
          actual.data.shipping?.city || actual.data.billing?.city || null,
          now(), tracking,
        );
        const nueva = db.prepare('SELECT * FROM preparaciones WHERE clave=?').get(`web:${wcOrderId}`);
        if (!nueva) throw new Error('No se pudo crear la preparación');
        if (!prepExistente) {
          const claim = claimPreparacion(db, nueva.id, req.user.username, cfg, new Date(), true);
          if (!claim.ok) throw Object.assign(new Error('No se pudo tomar la preparación'), { claim });
        }
        return nueva;
      });
      const preparacion = crearYTomar();

      // Evento para GET /seguimientos.data.cargados_hoy — se registra ACÁ, apenas el
      // tracking quedó cargado de verdad (Woo ya tiene el tracking guardado y el mail
      // nativo del paso 1 ya salió), no solo si el paso 2 sale bien. Antes se registraba
      // después del try del paso 2 y el contador ignoraba todo pedido que quedara
      // "colgado" ese día — exactamente el escenario de Woo lento que motivó a_medias
      // (hallazgo del revisor, ver plan 2026-08-13-seguimientos.md). El COUNT(DISTINCT
      // preparacion_id) de GET /seguimientos ya dedupea un reintento posterior sobre el
      // mismo pedido. CONTRATO: el frontend hoy solo incrementa cargados_hoy en la rama
      // 'ok' de la respuesta — con este cambio el backend también lo cuenta cuando la
      // respuesta es 502/colgado, así que el frontend tiene que dejar de incrementarlo
      // localmente y refrescar desde GET /seguimientos (o incrementar también en la rama
      // colgado) para no quedar corrido en -1 el resto del día.
      const prepId = preparacion.id;
      registrarEvento(db, {
        preparacionId: prepId, itemId: null, tipo: 'tracking_cargado', usuario: req.user?.username,
        detalle: { tracking },
      });

      // Paso 2: estado final custom, en una segunda escritura separada. Si falla, no se
      // relanza — queda "colgado" (woo_paso2_pendiente=1) para que reintentarColgadosTracking
      // (cron) o un reintento manual del operario lo resuelvan después.
      try {
        await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', { status: enviadoAndreaniStatus });
      } catch (e) {
        registrarEvento(db, {
          preparacionId: prepId, itemId: null, tipo: 'tracking_colgado', usuario: req.user?.username,
          detalle: { error: e.message },
        });
        return res.status(502).json({
          ok: false, colgado: true,
          error: 'el tracking se guardó pero no se pudo marcar como enviado (se reintentará solo)',
        });
      }

      // El envío ya salió (Woo confirmado, mail al cliente ya mandado) — el estado LOCAL
      // distingue si de verdad se verificó o no, y nunca pisa una 'cerrada_sin_evidencia'
      // (ver marcarPreparacionEnviada). Bloqueante crítico del revisor: antes esto
      // marcaba 'completada' sin mirar ítems/fotos/estado previo, y era un atajo más
      // rápido que confirmar-manual para "verificar" un pedido sin escanear nada.
      marcarPreparacionEnviada(db, `web:${wcOrderId}`, { usuario: req.user?.username });

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Lookup de solo lectura: tracking actual + si es corregible ──
  router.get('/seguimientos/:wcOrderId/tracking-actual', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const status = actual.data?.status;
      const meta = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingActual = String(meta?.value || '').trim();
      const corregible = (status === 'completed' || status === enviadoAndreaniStatus) && !!trackingActual;
      res.json({ ok: true, status, tracking_actual: trackingActual, corregible });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Corregir un tracking ya cargado, sin reenviar el mail nativo (solo meta_data) ──
  router.post('/seguimientos/:wcOrderId/corregir-tracking', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    const trackingNuevo = String(req.body?.tracking || '').trim();
    if (!trackingNuevo) return res.status(400).json({ ok: false, error: 'tracking requerido' });
    const prepExistente = db.prepare('SELECT * FROM preparaciones WHERE clave=?').get(`web:${wcOrderId}`);
    if (prepExistente && !exigirClaimVigente(db, prepExistente, req.user?.username, res)) return;

    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const status = actual.data?.status;
      if (status !== 'completed' && status !== enviadoAndreaniStatus) {
        return res.status(409).json({ ok: false, error: `el pedido está en estado '${status}', no se puede corregir` });
      }
      const metaExistente = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingAnterior = String(metaExistente?.value || '').trim();
      if (!trackingAnterior) {
        return res.status(409).json({ ok: false, error: 'no hay tracking cargado para corregir — usá el flujo normal de seguimientos' });
      }

      if (trackingNuevo === trackingAnterior) {
        // Aun sin cambio en Woo, `preparaciones.tracking` (espejo local, columna nueva) puede
        // estar desincronizada si nunca pasó por acá — corregirla igual (hallazgo del revisor:
        // antes esta ruta no la tocaba, y un Deshacer siguiente comparaba contra un valor viejo).
        db.prepare("UPDATE preparaciones SET tracking=? WHERE clave=?").run(trackingNuevo, `web:${wcOrderId}`);
        return res.json({ ok: true, tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo });
      }

      await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', {
        meta_data: [{ id: metaExistente.id, key: TRACKING_META_KEY, value: trackingNuevo }],
      });
      // Espejo local: preparaciones.tracking es lo que lee `a_medias` para reintentar sin
      // volver a preguntarle a Woo — si no se actualiza acá, un Deshacer deja esa columna
      // apuntando al tracking viejo (hallazgo del revisor).
      db.prepare("UPDATE preparaciones SET tracking=? WHERE clave=?").run(trackingNuevo, `web:${wcOrderId}`);

      const prep = db.prepare('SELECT id FROM preparaciones WHERE clave=?').get(`web:${wcOrderId}`);
      if (prep) {
        registrarEvento(db, {
          preparacionId: prep.id, itemId: null, tipo: 'tracking_corregido', usuario: req.user?.username,
          detalle: { tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo },
        });
      }

      res.json({ ok: true, tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Iniciar preparación (snapshot de ítems desde WC o ML) ──
  router.post('/iniciar', async (req, res) => {
    const { canal, id, direccion_elegida } = req.body || {};
    try {
      if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
      if (canal === 'web') {
        const resp = await wooFetch(cfg.woo, `/orders/${id}`);
        const estadosElegibles = [cfg.andreaniStatus || 'lpaandreani', 'completed', cfg.enviadoAndreaniStatus || 'enviadoandreani'];
        if (!estadosElegibles.includes(resp.data?.status)) {
          db.prepare("UPDATE pedidos_cache SET estado_envio='no_elegible', estado_wc=?, actualizado_en=? WHERE clave=? AND estado_envio='pendiente'")
            .run(resp.data?.status || null, now(), `web:${resp.data?.id || id}`);
          return res.status(409).json({ ok: false, error: 'El pedido ya no está habilitado para preparación.' });
        }
        const clave = `web:${resp.data.id}`;
        const existente = db.prepare('SELECT * FROM preparaciones WHERE clave=?').get(clave);
        if (existente && !exigirClaimVigente(db, existente, req.user.username, res)) return;
        const yaConfirmada = db.prepare(
          'SELECT direccion_confirmada_fuente FROM preparaciones WHERE clave=?'
        ).get(clave)?.direccion_confirmada_fuente;

        // Envío y facturación difieren de verdad (no solo mayúsculas/acentos) y todavía
        // nadie decidió cuál usar en ESTA preparación: frenar antes de crearla — pedirlo
        // después dejaría una preparación ya armada con la dirección "adivinada" por la
        // regla automática, y nadie vuelve a mirar eso una vez que el pedido ya se está
        // preparando.
        if (!yaConfirmada && !direccion_elegida) {
          const chequeo = direccionesDifieren(resp.data);
          if (chequeo.difieren) {
            return res.status(409).json({
              ok: false,
              error: 'Los datos de envío y facturación difieren. Elegí a cuál se envía antes de seguir.',
              direcciones_difieren: true,
              campos_distintos: chequeo.campos,
              envio: normalizarEnvio(resp.data, 'shipping'),
              facturacion: normalizarEnvio(resp.data, 'billing'),
            });
          }
        }

        const p = armarPendienteWeb(db, resp.data);
        // crearPreparacion + el UPDATE de la dirección elegida van en la misma transacción:
        // si el proceso muere entre los dos statements, la preparación no puede quedar
        // creada sin la decisión ya tomada (revertiría a la regla automática de
        // normalizarEnvio, justo lo que este gate existe para evitar).
        const resultado = db.transaction(() => {
          const id = crearPreparacion(db, {
            canal: 'web', wcOrderId: resp.data.id,
            numeroPedido: String(resp.data.number || resp.data.id),
            comprador: `${resp.data.billing?.first_name || ''} ${resp.data.billing?.last_name || ''}`.trim(),
            notas: p.notas,
            items: p.items,
          });
          if (direccion_elegida && ['shipping', 'billing'].includes(direccion_elegida)) {
            db.prepare(`UPDATE preparaciones SET direccion_confirmada_fuente=?, direccion_confirmada_por=?,
              direccion_confirmada_en=? WHERE id=?`)
              .run(direccion_elegida, req.user?.username || null, now(), id);
          }
          const claim = claimPreparacion(db, id, req.user.username, cfg, new Date(), true);
          if (!claim.ok) {
            const error = new Error(claim.code);
            error.claimResult = claim;
            throw error;
          }
          return { id, claim };
        })();
        const prepId = resultado.id;

        // Fase 4: detectar si este pedido tiene vínculos con otros ya preparados.
        const nuevaClave = `web:${resp.data.id}`;
        inyectarDeteccionVinculosDesdePedidoNuevo(db, resp.data, nuevaClave);

        return res.json({ ok: true, id: prepId });
      }
      if (canal === 'ml') {
        // manual: true — armado de preparación disparado a mano desde el panel.
        const resp = await mlFetch(db, cfg.ml, 'get', `/orders/${id}`, null, { manual: true });
        if (resp.status !== 200) throw new Error(`ML order ${resp.status}`);
        const orden = resp.data;
        const existente = db.prepare('SELECT * FROM preparaciones WHERE clave=?').get(`ml:${orden.id || id}`);
        if (existente && !exigirClaimVigente(db, existente, req.user.username, res)) return;
        if (orden.status !== 'paid') {
          invalidarCacheMlNoElegible(db, orden.id || id, orden.status);
          return res.status(409).json({ ok: false, error: 'La orden ML no está paga y no está habilitada para preparación.' });
        }
        const shipmentId = orden.shipping?.id;
        let envio = null;
        if (shipmentId) {
          const envioResp = await mlFetch(db, cfg.ml, 'get', `/shipments/${shipmentId}`, null, { manual: true });
          if (envioResp.status !== 200) throw new Error(`ML shipment ${envioResp.status}`);
          envio = envioResp.data;
        }
        const elegibilidad = clasificarElegibilidadMl(orden, envio);
        if (elegibilidad.estado !== 'elegible') {
          if (elegibilidad.estado === 'no_elegible') {
            invalidarCacheMlNoElegible(db, orden.id || id, orden.status, envio?.status, envio?.logistic_type);
          }
          return res.status(409).json({ ok: false, error: 'No hay evidencia suficiente de que el envío ML esté habilitado para preparación.', estado_elegibilidad: elegibilidad.estado, motivo_elegibilidad: elegibilidad.motivo });
        }
        const items = itemsDesdeOrdenMl(db, orden);
        const vinculo = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get(String(orden.id));
        const resultado = db.transaction(() => {
          const prepId = crearPreparacion(db, {
            canal: 'ml', mlOrderId: String(orden.id), wcOrderId: vinculo?.wc_order_id || null,
            packId: orden.pack_id ? String(orden.pack_id) : null,
            numeroPedido: String(orden.id),
            comprador: orden.buyer?.nickname || 'Comprador ML',
            items,
          });
          const claim = claimPreparacion(db, prepId, req.user.username, cfg, new Date(), true);
          if (!claim.ok) {
            const error = new Error(claim.code);
            error.claimResult = claim;
            throw error;
          }
          return { id: prepId, claim };
        })();
        const prepId = resultado.id;

        // Fase 4: detectar si este pedido tiene vínculos con otros ya preparados.
        // Nota: detectarVinculoEntrePedidos espera un objeto order similar a WC. ML tiene
        // estructura diferente (buyer, address, etc.). Por ahora no detectamos vínculos de
        // pedidos ML (el match sería por email en orden.buyer.email, pero necesitaría mapeo).
        // TODO: expandir detectarVinculoEntrePedidos para soportar ambos formatos si es necesario.

        return res.json({ ok: true, id: prepId, estado_elegibilidad: elegibilidad.estado, motivo_elegibilidad: elegibilidad.motivo });
      }
      res.status(400).json({ ok: false, error: 'canal inválido' });
    } catch (e) {
      if (e?.claimResult?.code === 'AUTH_REQUIRED') {
        return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
      }
      if (e?.claimResult?.code === 'PREPARATION_CLAIMED') {
        return claimConflict(res, e.claimResult.claim);
      }
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Historial ──
  router.get('/historial', (req, res) => {
    const preparadas = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM preparacion_items WHERE preparacion_id=p.id) AS total_items,
        (SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id AND borrado_en IS NULL) AS total_fotos
      FROM preparaciones p
      WHERE p.estado IN ('completada','pendiente_deposito')
      ORDER BY COALESCE(p.completado_en, p.creado_en) DESC LIMIT 200
    `).all();

    const sinPreparar = db.prepare(`
      SELECT * FROM pedidos_cache pc
      WHERE pc.estado_envio='enviado'
        AND NOT EXISTS (SELECT 1 FROM preparaciones p WHERE p.clave = pc.clave)
      ORDER BY pc.fecha DESC LIMIT 200
    `).all().map(row => ({
      id: null,
      canal: row.canal,
      clave: row.clave,
      wc_order_id: row.wc_order_id,
      ml_order_id: row.ml_order_id,
      numero_pedido: row.numero_pedido,
      comprador: row.comprador,
      estado: 'enviado_sin_preparar',
      creado_en: row.fecha,
      completado_en: null,
      total_items: JSON.parse(row.items_json).length,
      total_fotos: 0,
    }));

    res.json({ ok: true, data: [...preparadas, ...sinPreparar] });
  });

  // ── Cerradas sin evidencia: sección propia, separada del historial de verificadas ──
  // A propósito NO se mezclan con GET /historial (que solo trae 'completada'/
  // 'pendiente_deposito'): el sentido del estado 'cerrada_sin_evidencia' es que se puedan
  // distinguir de las que sí se verificaron de verdad cuando alguien las consulte por un
  // reclamo — mezclarlas en la misma lista sería repetir el problema que este estado
  // existe para resolver. Se reabren con POST /:id/reabrir.
  router.get('/cerradas-sin-evidencia', (req, res) => {
    const data = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM preparacion_items WHERE preparacion_id=p.id) AS total_items,
        (SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id AND borrado_en IS NULL) AS total_fotos
      FROM preparaciones p
      WHERE p.estado='cerrada_sin_evidencia'
      ORDER BY p.creado_en DESC LIMIT 200
    `).all();
    res.json({ ok: true, data });
  });

  // ── Despachadas sin verificar: sección propia, mismo criterio que cerradas-sin-evidencia ──
  // El pedido SÍ salió (Woo ya confirmó el envío y mandó el mail al cliente), pero la
  // preparación no estaba completamente verificada cuando se cargó el tracking (ver
  // marcarPreparacionEnviada). El sentido de este estado es justo poder consultarlo ante
  // un reclamo — un estado que no se puede listar no sirve para nada (hallazgo del
  // revisor). Tampoco se mezcla con GET /historial (que solo trae 'completada'/
  // 'pendiente_deposito'): mezclarlo ahí sería volver a "indistinguible de una verificada".
  //
  // Filtrado por canal='web', igual que el conteo de GET /seguimientos (línea ~742): hoy no
  // hay ninguna fila 'ml' en este estado (el flujo ML no lo produce), pero si algún día lo
  // hiciera, contador y lista tienen que coincidir — antes discrepaban en silencio (hallazgo
  // del revisor).
  //
  // Este estado NO es terminal (POST /:id/completar lo puede subir a 'completada' si se
  // verifica después) y a propósito no tiene ventana temporal — la lista completa es el
  // criterio de esta pantalla ("nada se oculta"). Sin tope explícito, sin embargo, un
  // LIMIT 200 en silencio sería la misma trampa que a_medias_total/truncado ya resuelven: se
  // aplica el mismo patrón acá (hallazgo del revisor).
  router.get('/despachadas-sin-verificar', (req, res) => {
    const total = db.prepare(
      "SELECT COUNT(*) n FROM preparaciones WHERE canal='web' AND estado='despachada_sin_verificar'"
    ).get().n;
    const data = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM preparacion_items WHERE preparacion_id=p.id) AS total_items,
        (SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id AND borrado_en IS NULL) AS total_fotos
      FROM preparaciones p
      WHERE p.canal='web' AND p.estado='despachada_sin_verificar'
      ORDER BY p.creado_en DESC LIMIT 200
    `).all();
    res.json({ ok: true, data, total, truncado: total > data.length });
  });

  // ── Estado del sync de pedidos_cache (para el aviso de frescura en el frontend) ──
  router.get('/pedidos-cache/estado', (req, res) => {
    const ultimoLog = db.prepare(
      "SELECT creado_en, estado, error FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1"
    ).get();
    res.json({
      ok: true,
      actualizado_en: ultimoLog?.creado_en || null,
      ultimo_error: ultimoLog?.estado === 'error' ? ultimoLog.error : null,
    });
  });

  // ── Perfiles de foto por categoría ──
  router.get('/perfiles', (req, res) => {
    if (!puedeAdministrarPerfiles(req.user)) return res.status(403).json({ ok: false, error: 'requiere supervisor o administrador', code: 'FORBIDDEN' });
    const rows = db.prepare('SELECT * FROM preparacion_perfiles ORDER BY categoria').all();
    res.json({ ok: true, data: rows });
  });

  router.put('/:id/fotos-hold', (req, res) => {
    if (!req.user?.is_admin) return res.status(403).json({ ok: false, error: 'requiere administrador', code: 'FORBIDDEN' });
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const motivo = String(req.body?.motivo || '').trim();
    if (!['reclamo', 'incidente', 'garantia', 'auditoria'].includes(motivo)) return res.status(400).json({ ok: false, error: 'motivo de hold inválido', code: 'MOTIVO_REQUERIDO' });
    const anterior = db.prepare('SELECT * FROM preparacion_fotos_holds WHERE preparacion_id=?').get(prep.id);
    db.transaction(() => {
      db.prepare(`INSERT INTO preparacion_fotos_holds (preparacion_id,motivo,creado_por,creado_en) VALUES (?,?,?,?)
        ON CONFLICT(preparacion_id) DO UPDATE SET motivo=excluded.motivo, creado_por=excluded.creado_por, creado_en=excluded.creado_en`).run(prep.id, motivo, req.user.username, now());
      registrarEvento(db, { preparacionId: prep.id, tipo: anterior ? 'foto_hold_actualizado' : 'foto_hold_creado', usuario: req.user.username,
        detalle: { motivo_anterior: anterior?.motivo || null, motivo_nuevo: motivo, operacion: anterior ? 'actualizar' : 'crear' }, failClosed: true });
    })();
    res.json({ ok: true, hold: db.prepare('SELECT * FROM preparacion_fotos_holds WHERE preparacion_id=?').get(prep.id) });
  });

  router.delete('/:id/fotos-hold', (req, res) => {
    if (!req.user?.is_admin) return res.status(403).json({ ok: false, error: 'requiere administrador', code: 'FORBIDDEN' });
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const anterior = db.prepare('SELECT * FROM preparacion_fotos_holds WHERE preparacion_id=?').get(prep.id);
    db.transaction(() => {
      db.prepare('DELETE FROM preparacion_fotos_holds WHERE preparacion_id=?').run(prep.id);
      if (anterior) registrarEvento(db, { preparacionId: prep.id, tipo: 'foto_hold_eliminado', usuario: req.user.username,
        detalle: { motivo_anterior: anterior.motivo, operacion: 'eliminar' }, failClosed: true });
    })();
    res.json({ ok: true });
  });

  router.put('/perfiles/:categoria', (req, res) => {
    if (!puedeAdministrarPerfiles(req.user)) return res.status(403).json({ ok: false, error: 'requiere supervisor o administrador', code: 'FORBIDDEN' });
    const categoria = String(req.params.categoria || '').trim().toUpperCase();
    const { perfil, requisitos_json = null } = req.body || {};
    if (!categoria || !PERFILES_VALIDOS.includes(perfil)) {
      return res.status(400).json({ ok: false, error: 'categoria y perfil válidos requeridos' });
    }
    const anterior = db.prepare('SELECT * FROM preparacion_perfiles WHERE categoria=?').get(categoria);
    db.transaction(() => {
      db.prepare(`INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en, version)
      VALUES (?,?,?, ?, 1)
      ON CONFLICT(categoria) DO UPDATE SET perfil=excluded.perfil, requisitos_json=excluded.requisitos_json, actualizado_en=excluded.actualizado_en, version=preparacion_perfiles.version+1`)
      .run(categoria, perfil, requisitos_json ? JSON.stringify(requisitos_json) : null, now());
      registrarPerfilEvento(db, { alcance: 'categoria', clave: categoria, tipo: 'actualizado', usuario: req.user.username,
        detalle: { anterior, perfil, requisitos_json } });
    })();
    res.json({ ok: true });
  });

  router.delete('/perfiles/:categoria', (req, res) => {
    if (!puedeAdministrarPerfiles(req.user)) return res.status(403).json({ ok: false, error: 'requiere supervisor o administrador', code: 'FORBIDDEN' });
    const categoria = String(req.params.categoria || '').trim().toUpperCase();
    const anterior = db.prepare('SELECT * FROM preparacion_perfiles WHERE categoria=?').get(categoria);
    db.transaction(() => {
      db.prepare('DELETE FROM preparacion_perfiles WHERE categoria=?').run(categoria);
      if (anterior) registrarPerfilEvento(db, { alcance: 'categoria', clave: categoria, tipo: 'eliminado', usuario: req.user.username,
        detalle: { anterior } });
    })();
    res.json({ ok: true });
  });

  // ── Perfiles de foto por SKU exacto (prioridad sobre los de categoría) ──
  router.get('/perfiles-sku', (req, res) => {
    if (!puedeAdministrarPerfiles(req.user)) return res.status(403).json({ ok: false, error: 'requiere supervisor o administrador', code: 'FORBIDDEN' });
    const rows = db.prepare('SELECT * FROM preparacion_perfiles_sku ORDER BY sku').all();
    res.json({ ok: true, data: rows });
  });

  router.put('/perfiles-sku/:sku', (req, res) => {
    if (!puedeAdministrarPerfiles(req.user)) return res.status(403).json({ ok: false, error: 'requiere supervisor o administrador', code: 'FORBIDDEN' });
    const sku = String(req.params.sku || '').trim().toUpperCase();
    const { perfil, requisitos_json = null } = req.body || {};
    if (!sku || !PERFILES_VALIDOS.includes(perfil)) {
      return res.status(400).json({ ok: false, error: 'sku y perfil válidos requeridos' });
    }
    const anterior = db.prepare('SELECT * FROM preparacion_perfiles_sku WHERE sku=?').get(sku);
    db.transaction(() => {
      db.prepare(`INSERT INTO preparacion_perfiles_sku (sku, perfil, requisitos_json, actualizado_en, version)
      VALUES (?,?,?, ?, 1)
      ON CONFLICT(sku) DO UPDATE SET perfil=excluded.perfil, requisitos_json=excluded.requisitos_json, actualizado_en=excluded.actualizado_en, version=preparacion_perfiles_sku.version+1`)
      .run(sku, perfil, requisitos_json ? JSON.stringify(requisitos_json) : null, now());
      registrarPerfilEvento(db, { alcance: 'sku', clave: sku, tipo: 'actualizado', usuario: req.user.username,
        detalle: { anterior, perfil, requisitos_json } });
    })();
    res.json({ ok: true });
  });

  router.delete('/perfiles-sku/:sku', (req, res) => {
    if (!puedeAdministrarPerfiles(req.user)) return res.status(403).json({ ok: false, error: 'requiere supervisor o administrador', code: 'FORBIDDEN' });
    const sku = String(req.params.sku || '').trim().toUpperCase();
    const anterior = db.prepare('SELECT * FROM preparacion_perfiles_sku WHERE sku=?').get(sku);
    db.transaction(() => {
      db.prepare('DELETE FROM preparacion_perfiles_sku WHERE sku=?').run(sku);
      if (anterior) registrarPerfilEvento(db, { alcance: 'sku', clave: sku, tipo: 'eliminado', usuario: req.user.username,
        detalle: { anterior } });
    })();
    res.json({ ok: true });
  });

  // ── Detalle ──
  router.get('/:id', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!puedeVerDetallePreparacion(db, prep, req.user)) return res.status(403).json({ ok: false, error: 'no tenés acceso a esta preparación', code: 'FORBIDDEN' });
    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(prep.id);
    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND borrado_en IS NULL ORDER BY id').all(prep.id);
    const eventos = db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? ORDER BY id DESC').all(prep.id)
      .map(mapearEvento);
    const data = {
      ...prep,
      items: items.map(it => ({
        ...it,
        requisitos_foto: requisitosParaItem(db, it),
        fotos: fotos.filter(f => f.item_id === it.id),
      })),
      fotos_generales: fotos.filter(f => !f.item_id),
      eventos,
    };
    res.json({ ok: true, data });
  });

  // ── Eventos de actividad (refresco liviano, sin re-traer items/fotos) ──
  // Query param opcional `desde=<id>`: si viene y es un entero válido, solo trae eventos
  // con id>desde (para que el frontend haga polling incremental en vez de repetir todo
  // el historial cada 15s). Sin `desde` (o inválido), se mantiene el comportamiento
  // actual: todo el historial.
  router.get('/:id/eventos', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const desde = parseInt(req.query.desde, 10);
    const eventos = (Number.isInteger(desde)
      ? db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND id>? ORDER BY id DESC').all(prep.id, desde)
      : db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? ORDER BY id DESC').all(prep.id)
    ).map(mapearEvento);
    res.json({ ok: true, eventos });
  });

  // ── Claim exclusivo de trabajo ──
  // Las operaciones de preparación existentes siguen siendo compatibles; las pantallas
  // nuevas pueden tomar explícitamente una preparación ya creada y renovar/liberar su claim.
  router.post('/:id/tomar', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const claim = claimPreparacion(db, prep.id, req.user?.username, cfg);
    if (!claim.ok) return claim.code === 'PREPARATION_CLAIMED'
      ? claimConflict(res, claim.claim)
      : res.status(401).json({ ok: false, error: 'Usuario requerido', code: claim.code });
    res.json({ ok: true, claim: { usuario: claim.usuario, claimed_at: claim.claimed_at, expires_at: claim.expires_at } });
  });

  router.post('/:id/claim/renovar', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const claim = claimPreparacion(db, prep.id, req.user?.username, cfg);
    if (!claim.ok) return claim.code === 'PREPARATION_CLAIMED'
      ? claimConflict(res, claim.claim)
      : res.status(401).json({ ok: false, error: 'Usuario requerido', code: claim.code });
    res.json({ ok: true, claim: { usuario: claim.usuario, claimed_at: claim.claimed_at, expires_at: claim.expires_at } });
  });

  router.post('/:id/claim/liberar', (req, res) => {
    const usuario = req.user?.username;
    if (!usuario) return res.status(401).json({ ok: false, error: 'Usuario requerido', code: 'AUTH_REQUIRED' });
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const actual = db.prepare('SELECT * FROM preparacion_claims WHERE preparacion_id=?').get(prep.id);
    if (!actual) return res.json({ ok: true, liberado: false });
    if (actual.usuario !== usuario) return actual.expires_at > now()
      ? claimConflict(res, actual)
      : res.status(409).json({ ok: false, error: 'La toma vencida pertenece a otro operador.', code: 'PREPARATION_CLAIMED' });
    db.prepare('DELETE FROM preparacion_claims WHERE preparacion_id=? AND usuario=?').run(prep.id, usuario);
    res.json({ ok: true, liberado: true });
  });

  // ── Heartbeat de presencia: "estoy viendo esta preparación ahora" ──
  // No bloquea nada — solo informa quién más la está viendo, para que los operarios
  // coordinen entre sí si se están por pisar. Sin limpieza explícita de filas viejas:
  // solo se consideran "activos" los últimos 30s, así que una fila vieja deja de contar
  // sola sin que haga falta borrarla (se sobreescribe con el próximo heartbeat de ese
  // mismo usuario, gracias a la PRIMARY KEY compuesta).
  router.post('/:id/heartbeat', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const usuario = req.user?.username;
    const ahora = now();

    db.prepare(`
      INSERT INTO preparacion_vistas (preparacion_id, usuario, visto_en) VALUES (?,?,?)
      ON CONFLICT(preparacion_id, usuario) DO UPDATE SET visto_en=excluded.visto_en
    `).run(prep.id, usuario, ahora);

    const hace30s = new Date(Date.now() - 30000).toISOString();
    const otros = db.prepare(
      'SELECT usuario, visto_en FROM preparacion_vistas WHERE preparacion_id=? AND usuario<>? AND visto_en > ?'
    ).all(prep.id, usuario, hace30s);

    const ultimoEvento = db.prepare('SELECT MAX(id) AS m FROM preparacion_eventos WHERE preparacion_id=?').get(prep.id);
    res.json({ ok: true, otros, ultimo_evento_id: ultimoEvento.m || 0 });
  });

  // ── Escanear código ──
  router.post('/:id/escanear', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    const bloqueo = bloqueoPorEstado(prep);
    if (bloqueo) return res.status(400).json({ ok: false, error: bloqueo });

    const codigo = String(req.body?.codigo || '').trim().toUpperCase();
    if (!codigo) return res.status(400).json({ ok: false, error: 'codigo requerido' });

    const items = db.prepare(
      "SELECT * FROM preparacion_items WHERE preparacion_id=? AND UPPER(TRIM(sku))=? AND estado_item <> 'exento'"
    ).all(prep.id, codigo);

    if (!items.length) return res.json({ ok: true, resultado: 'no_coincide', codigo });

    const item = items.find(i => i.cantidad_escaneada < i.cantidad_esperada);
    if (!item) return res.json({ ok: true, resultado: 'sobrante', codigo });

    const nuevaCant = item.cantidad_escaneada + 1;
    const verificado = nuevaCant >= item.cantidad_esperada;
    db.prepare('UPDATE preparacion_items SET cantidad_escaneada=?, estado_item=? WHERE id=?')
      .run(nuevaCant, verificado ? 'verificado' : 'pendiente', item.id);

    const origen = ['camara', 'lector_teclado'].includes(req.body?.origen) ? req.body.origen : 'lector_teclado';
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'escaneo', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, cantidad_nueva: nuevaCant, cantidad_esperada: item.cantidad_esperada, origen },
    });

    res.json({ ok: true, resultado: 'match', item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Confirmar sin código ──
  // Ya no es gratis (incidente 2026-08-12: un pedido de 5 unidades salió con 1 porque el
  // atajo verificaba sin escanear nada — ver plan 2026-08-12-escaneo-obligatorio.md). Fail-
  // closed: sin motivo válido de la lista corta, 400 y no se toca el ítem. Cualquier usuario
  // puede usarla (decisión del usuario: no se restringe a admin), pero motivo+usuario+hora
  // quedan en preparacion_eventos.
  router.post('/:id/item/:itemId/confirmar-manual', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    const bloqueo = bloqueoPorEstado(prep);
    if (bloqueo) return res.status(400).json({ ok: false, error: bloqueo });
    const item = db.prepare('SELECT * FROM preparacion_items WHERE id=? AND preparacion_id=?').get(parseInt(req.params.itemId), prep.id);
    if (!item) return res.status(404).json({ ok: false, error: 'ítem no encontrado' });

    const motivo = String(req.body?.motivo || '').trim();
    if (!MOTIVOS_CONFIRMACION_MANUAL.includes(motivo)) {
      return res.status(400).json({
        ok: false,
        error: `motivo requerido (uno de: ${MOTIVOS_CONFIRMACION_MANUAL.join(', ')})`,
      });
    }
    // "otro" sin texto libre no es un motivo real — sería el mismo agujero con un paso más.
    const detalleTexto = String(req.body?.detalle_texto || '').trim();
    if (motivo === 'otro' && !detalleTexto) {
      return res.status(400).json({ ok: false, error: 'detalle_texto requerido cuando motivo es "otro"' });
    }

    // Si ya estaba verificado antes de esta llamada, es un no-op (doble tap /
    // re-confirmación): no pasó nada nuevo que auditar, igual que "sobrante" en /escanear.
    const yaVerificado = item.estado_item === 'verificado';

    db.prepare("UPDATE preparacion_items SET confirmado_manual=1, estado_item='verificado', cantidad_escaneada=cantidad_esperada WHERE id=?")
      .run(item.id);
    if (!yaVerificado) {
      registrarEvento(db, {
        preparacionId: prep.id, itemId: item.id, tipo: 'escaneo', usuario: req.user?.username,
        detalle: {
          sku: item.sku, nombre: item.nombre, cantidad_nueva: item.cantidad_esperada,
          cantidad_esperada: item.cantidad_esperada, origen: 'manual',
          motivo, detalle_texto: detalleTexto || null,
        },
      });
    }
    res.json({ ok: true, item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Estado de embalaje (solo bicis) ──
  router.post('/:id/item/:itemId/embalaje', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    const item = db.prepare('SELECT * FROM preparacion_items WHERE id=? AND preparacion_id=?').get(parseInt(req.params.itemId), prep.id);
    if (!item) return res.status(404).json({ ok: false, error: 'ítem no encontrado' });
    if (item.perfil !== 'bici') return res.status(400).json({ ok: false, error: 'solo aplica a bicicletas' });

    const { estado_embalaje } = req.body || {};
    if (!['sellada', 'abierta', 're_embalada'].includes(estado_embalaje)) {
      return res.status(400).json({ ok: false, error: 'estado_embalaje inválido' });
    }
    const valorAnterior = item.estado_embalaje;
    db.prepare('UPDATE preparacion_items SET estado_embalaje=? WHERE id=?').run(estado_embalaje, item.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'embalaje', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, valor_anterior: valorAnterior, valor_nuevo: estado_embalaje },
    });
    const actualizado = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    res.json({ ok: true, item: actualizado, requisitos_foto: requisitosParaItem(db, actualizado) });
  });

  // ── Despacho desde depósito ──
  router.post('/:id/item/:itemId/despacho', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    const item = db.prepare('SELECT * FROM preparacion_items WHERE id=? AND preparacion_id=?').get(parseInt(req.params.itemId), prep.id);
    if (!item) return res.status(404).json({ ok: false, error: 'ítem no encontrado' });

    const { modo, motivo = null } = req.body || {};
    if (!['local', 'deposito_relajado', 'deposito_delegado'].includes(modo)) {
      return res.status(400).json({ ok: false, error: 'modo inválido' });
    }

    let estadoItem = item.estado_item;
    if (modo === 'deposito_relajado') estadoItem = 'exento';
    else if (item.estado_item === 'exento') estadoItem = 'pendiente'; // revertir exención

    const valorAnterior = item.despacho;
    db.prepare('UPDATE preparacion_items SET despacho=?, despacho_motivo=?, estado_item=? WHERE id=?')
      .run(modo, motivo, estadoItem, item.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'despacho', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, valor_anterior: valorAnterior, valor_nuevo: modo },
    });
    res.json({ ok: true, item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Fotos ──
  // Envolvemos el multer manualmente para capturar sus errores (p.ej. archivo
  // que supera el límite de tamaño) y responder JSON claro. Sin esto, el
  // MulterError se propaga a next() y, al no haber error-handler global que
  // devuelva JSON, Express contesta una página HTML 500 que el frontend no
  // puede parsear (síntoma: "No se pudo subir la foto: error").
  router.post('/:id/foto', (req, res, next) => {
    upload.single('archivo')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ ok: false, error: 'la foto es muy pesada (máx 15MB), probá con menor calidad o resolución' });
        }
        return res.status(400).json({ ok: false, error: 'no se pudo subir el archivo' });
      }
      next();
    });
  }, (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    const bloqueo = bloqueoPorEstado(prep);
    if (bloqueo) return res.status(400).json({ ok: false, error: bloqueo });
    if (!req.file) return res.status(400).json({ ok: false, error: 'archivo requerido' });

    // Detección de HEIC/HEIF: los iPhone al compartir mandan el .heic con mimetype
    // vacío o application/octet-stream (no arranca con image/). Si dejáramos que el
    // guard cortara solo por mimetype, el fix de HEIC nunca se activaría. Por eso
    // detectamos también por extensión del nombre y lo aceptamos.
    const nombre = (req.file.originalname || '').toLowerCase();
    const esHeic = req.file.mimetype === 'image/heic' || req.file.mimetype === 'image/heif'
      || nombre.endsWith('.heic') || nombre.endsWith('.heif');
    if (!req.file.mimetype?.startsWith('image/') && !esHeic) {
      return res.status(400).json({ ok: false, error: 'solo imágenes' });
    }

    const { item_id = null, tipo = 'extra', upload_id: uploadId = null } = req.body || {};
    const itemId = item_id ? parseInt(item_id) : null;
    if (item_id && (!Number.isInteger(itemId) || !db.prepare('SELECT 1 FROM preparacion_items WHERE id=? AND preparacion_id=?').get(itemId, prep.id))) {
      return res.status(400).json({ ok: false, error: 'ítem no pertenece a esta preparación', code: 'ITEM_PREPARACION_INVALIDO' });
    }
    const fingerprint = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    // Clientes antiguos pueden no mandar upload_id: se deriva una clave estable del
    // contenido y del destino, manteniendo idempotencia sin romper compatibilidad.
    const uploadKey = uploadId ? String(uploadId).trim()
      : `auto:${itemId || 0}:${tipo}:${nombre}:${fingerprint}`;
    const previa = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND upload_id=? AND borrado_en IS NULL').get(prep.id, uploadKey);
    if (previa) {
      if (Number(previa.item_id || 0) !== Number(itemId || 0) || previa.tipo !== tipo || (previa.fingerprint && previa.fingerprint !== fingerprint)) {
        return res.status(409).json({ ok:false, error:'upload_id ya fue usado para otra foto', code:'IDEMPOTENCY_CONFLICT' });
      }
      return res.json({ ok: true, foto: previa, idempotente: true });
    }

    // GUARDAR Y RESPONDER AL INSTANTE, sin conversión sincrónica (plan 2026-08-12-fotos-
    // preparacion.md): heic-convert es JS puro y bloquea el único hilo de Node 3-7s enteros
    // por foto (medido en el VPS) — mientras dura, la app no responde a NADIE, no solo a
    // quien subió la foto. La conversión/rotación/achicado se hace en segundo plano, en un
    // worker thread (lib/fotosPreparacionCola.js) que no compite por el hilo principal.
    //
    // Guardamos el archivo TAL COMO LLEGÓ (sin re-encodear) como el "original" — nunca se
    // toca ni se pierde, lo pide el uso real (detalle fino). La versión liviana la llena la
    // cola cuando termina; hasta entonces el original ya es servible por HTTP igual.
    //
    // Fail-open deliberado acá: no validamos con sharp que el buffer sea una imagen real
    // decodificable (eso exigiría el mismo trabajo bloqueante que estamos evitando). Un
    // archivo corrupto o que no sea una imagen queda guardado como "original" y la cola lo
    // marca estado_proceso='error' cuando falla — fail-closed del lado de abajo: nunca se
    // muestra como "listo" con datos basura, nunca desaparece en silencio.
    let saved;
    try {
      saved = guardarArchivo({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        importador: 'preparacion',
        numeroPedido: prep.numero_pedido || prep.clave,
      });
    } catch (e) {
      console.error('[preparacion] no se pudo guardar el archivo subido:', JSON.stringify({
        mimetype: req.file.mimetype || '(vacío)',
        extension: (nombre.match(/\.[^.]+$/) || ['(sin extensión)'])[0],
        bytes: req.file.size,
        error: e.message,
      }));
      return res.status(500).json({ ok: false, error: 'no se pudo guardar la foto' });
    }

    const itemRef = itemId ? db.prepare('SELECT sku, nombre FROM preparacion_items WHERE id=?').get(itemId) : null;
    let fotoId;
    try {
      fotoId = db.transaction(() => {
        const id = db.prepare(`
          INSERT INTO preparacion_fotos
            (preparacion_id, item_id, tipo, url, nombre_archivo, creado_en, estado_proceso, es_heic, upload_id, fingerprint)
          VALUES (?,?,?,?,?,?, 'pendiente', ?, ?, ?)
        `).run(prep.id, itemId, tipo, saved.url, saved.filename, now(), esHeic ? 1 : 0, uploadKey, fingerprint).lastInsertRowid;
        registrarEvento(db, {
          preparacionId: prep.id, itemId, tipo: 'foto_subida', usuario: req.user?.username,
          detalle: { sku: itemRef?.sku ?? null, nombre: itemRef?.nombre ?? null, tipo_foto: tipo, nombre_archivo: saved.filename, foto_id: id, upload_id: uploadKey, fingerprint },
          failClosed: true,
        });
        return id;
      })();
    } catch (e) {
      if (uploadKey && /constraint/i.test(e.message)) {
        const existente = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND upload_id=? AND borrado_en IS NULL').get(prep.id, uploadKey);
        if (existente) {
          try { fs.unlinkSync(rutaAbsoluta(saved.url)); } catch (_) {}
          return res.json({ ok: true, foto: existente, idempotente: true });
        }
      }
      throw e;
    }

    res.json({ ok: true, foto: db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId) });

    // Disparo en segundo plano, DESPUÉS de responder: fire-and-forget a propósito (mismo
    // criterio fail-open que los crons del resto del repo). Si esto falla, el cron de
    // barrido de server.js (cada 1 min) toma la foto igual — nunca queda huérfana.
    dispararColaFotos();
  });

  // Reintento manual de una foto que agotó sus reintentos automáticos (estado_proceso='error').
  // La cola en segundo plano ya reintenta sola con backoff (ver lib/fotosPreparacionCola.js);
  // esto es para cuando esos reintentos ya se agotaron y la causa pudo haber sido transitoria.
  router.post('/:id/foto/:fotoId/reintentar', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    const bloqueo = bloqueoPorEstado(prep);
    if (bloqueo) return res.status(400).json({ ok: false, error: bloqueo });
    const fotoId = parseInt(req.params.fotoId);
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=? AND preparacion_id=?').get(fotoId, prep.id);
    if (!foto) return res.status(404).json({ ok: false, error: 'foto no encontrada' });
    const reseteada = reintentarFoto(db, fotoId);
    if (!reseteada) {
      return res.status(400).json({ ok: false, error: 'la foto no está en estado de error' });
    }
    res.json({ ok: true, foto: db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId) });
    dispararColaFotos();
  });

  router.delete('/:id/foto/:fotoId', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    if (prep.estado === 'completada') {
      return res.status(409).json({ ok: false, error: 'la preparación está aprobada; debe reabrirse mediante una acción auditada antes de modificar evidencia', code: 'REAPERTURA_REQUERIDA' });
    }
    const fotoId = parseInt(req.params.fotoId);
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=? AND preparacion_id=? AND borrado_en IS NULL').get(fotoId, prep.id);
    if (!foto) return res.json({ ok: true, borradas: 0 });

    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(now(), fotoId);

    const itemRef = foto.item_id ? db.prepare('SELECT sku, nombre FROM preparacion_items WHERE id=?').get(foto.item_id) : null;
    // subida_por: no hay columna dedicada en preparacion_fotos para quién la subió
    // (fuera de alcance de este ciclo agregarla) — se recupera del propio evento
    // foto_subida que Task 3 ya registra, buscando por foto_id en su detalle_json.
    // Puede venir null si la foto es preexistente a esta instrumentación (no hay evento
    // foto_subida previo) o ante cualquier fallo de la consulta (fail-open, ver helper);
    // el frontend no debe imprimir literalmente "null" en ese caso.
    const subidaPor = usuarioQueSubio(db, fotoId, prep.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: foto.item_id, tipo: 'foto_borrada', usuario: req.user?.username,
      detalle: { sku: itemRef?.sku ?? null, nombre: itemRef?.nombre ?? null, tipo_foto: foto.tipo, nombre_archivo: foto.nombre_archivo, foto_id: fotoId, subida_por: subidaPor },
    });
    res.json({ ok: true, borradas: 1 });
  });

  // ── Completar ──
  router.post('/:id/completar', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    if (prep.estado === 'completada') return res.status(400).json({ ok: false, error: 'ya completada' });
    // Fail-closed: una 'cerrada_sin_evidencia' no se completa directamente — primero hay
    // que reabrirla (POST /:id/reabrir, ver docs/api-contrato.md), que deja registrado el
    // quién/cuándo del reclamo que la reactivó. Sin este freno, /completar la sacaría del
    // estado "sin evidencia" en silencio, sin ese rastro. El mensaje al operario es
    // genérico a propósito: el detalle del endpoint para reabrir es del contrato/log, no
    // de una pantalla de alguien embalando cajas.
    if (prep.estado === 'cerrada_sin_evidencia') {
      console.error(`POST /completar rechazado: preparación ${prep.id} está cerrada_sin_evidencia — reabrir con POST /:id/reabrir antes de completar`);
      return res.status(400).json({ ok: false, error: 'esta preparación está cerrada y no se puede completar así — pedile a un compañero que la reabra' });
    }

    // Misma función que decide 'completada' vs 'despachada_sin_verificar' al cargar el
    // tracking (calcularFaltantesPreparacion/preparacionEstaVerificada) — un solo criterio
    // de "qué falta", no dos que se puedan desincronizar.
    const { faltantes, delegadosPendientes, faltaPaquete } = calcularFaltantesPreparacion(db, prep);

    if (faltantes.length) {
      return res.status(400).json({ ok: false, error: 'preparación incompleta', faltantes });
    }

    if (delegadosPendientes.length) {
      // Todavía no es el cierre final (falta lo que resuelva el depósito) -> el paquete no
      // está sellado y no tiene sentido pedir "la foto del paquete armado" acá. Se exige en
      // el completar final, más abajo.
      db.prepare("UPDATE preparaciones SET estado='pendiente_deposito' WHERE id=? AND estado<>'cerrada_sin_evidencia'").run(prep.id);
      return res.json({ ok: true, estado: 'pendiente_deposito', pendientes_deposito: delegadosPendientes });
    }

    if (faltaPaquete.length) {
      return res.status(400).json({
        ok: false, error: 'preparación incompleta',
        faltantes: [{ item_id: null, sku: null, nombre: 'Paquete armado', motivo: 'fotos', faltan: faltaPaquete }],
      });
    }

    // Guard de estado también en el WHERE (defensa en profundidad, no solo en el `if` de
    // arriba): hoy no hay TOCTOU dentro de este proceso (sin await entre la lectura de
    // `prep` y este UPDATE, better-sqlite3 es síncrono), pero con dos procesos —cron,
    // script de mantenimiento, otro request— corriendo en paralelo, un `/completar` no
    // debería poder pisar una preparación que se cerró sin evidencia justo en el medio.
    // `changes` en 0 significa que alguien más la cambió de estado antes: se lo decimos
    // al cliente en vez de mentir con un 200.
    const completada = db.transaction(() => {
      const cambio = db.prepare(
        "UPDATE preparaciones SET estado='completada', completado_en=?, preparado_por=? WHERE id=? AND estado<>'cerrada_sin_evidencia'"
      ).run(now(), req.user?.username || null, prep.id);
      if (!cambio.changes) return false;
      registrarEvento(db, {
        preparacionId: prep.id, itemId: null, tipo: 'completado', usuario: req.user?.username, detalle: {},
      });
      encolarEtiquetaInterna(db, prep, req.user?.username);
      return true;
    })();
    if (!completada) {
      return res.status(409).json({ ok: false, error: 'la preparación cambió de estado mientras se completaba, volvé a intentarlo' });
    }
    res.json({ ok: true, estado: 'completada' });
  });

  // ── Reabrir una preparación cerrada sin evidencia ──
  // No es un cierre definitivo: si entra un reclamo por una de las preparaciones viejas
  // cerradas por el script de mantenimiento, hace falta poder volver a trabajarla con el
  // flujo normal (escanear/fotografiar/completar). Cualquiera puede reabrir — mismo
  // criterio que confirmar-manual: no se restringe a admin — pero motivo implícito
  // (reclamo), usuario y hora quedan en preparacion_eventos. Fail-closed: solo se puede
  // reabrir desde 'cerrada_sin_evidencia' — reabrir una 'completada' sería otro flujo (no
  // existe hoy, fuera de alcance; ver la regla de negocio de "un pedido WC creado desde ML
  // no se modifica después", que no aplica acá porque esto es local, pero el mismo
  // criterio de no tocar lo ya verificado sin querer aplica igual).
  router.post('/:id/reabrir', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!exigirClaimVigente(db, prep, req.user?.username, res)) return;
    if (prep.estado !== 'cerrada_sin_evidencia') {
      return res.status(400).json({
        ok: false,
        error: `solo se puede reabrir una preparación 'cerrada_sin_evidencia' (está '${prep.estado}')`,
      });
    }
    // Guard de estado también en el WHERE (mismo criterio que /completar): defensa contra
    // una corrida concurrente que haya cambiado el estado entre el SELECT de arriba y este
    // UPDATE.
    const cambio = db.prepare("UPDATE preparaciones SET estado='en_preparacion' WHERE id=? AND estado='cerrada_sin_evidencia'").run(prep.id);
    if (!cambio.changes) {
      return res.status(409).json({ ok: false, error: 'la preparación cambió de estado, volvé a intentarlo' });
    }
    registrarEvento(db, {
      preparacionId: prep.id, itemId: null, tipo: 'reabierta', usuario: req.user?.username, detalle: {},
    });
    res.json({ ok: true, estado: 'en_preparacion' });
  });

  // ── Vínculos entre pedidos (Fase 4) ────
  //
  // GET /vinculos/:clave — consultar sugerencias pendientes para un pedido.
  // Devuelve las filas de preparacion_vinculos donde ese pedido participa y el
  // estado sigue siendo 'sugerido' (todavía no se decidió), con resumen del OTRO
  // pedido del par para que el frontend arme el aviso.
  router.get('/vinculos/:clave', (req, res) => {
    try {
      const clave = req.params.clave;
      if (!clave) return res.status(400).json({ ok: false, error: 'clave requerida' });

      // Buscar sugerencias donde este pedido es pedido_a o pedido_b, pero solo 'sugerido'.
      const sugerencias = db.prepare(`
        SELECT id, pedido_a_clave, pedido_b_clave, campo_match, estado, creado_en
        FROM preparacion_vinculos
        WHERE (pedido_a_clave = ? OR pedido_b_clave = ?)
          AND estado = 'sugerido'
        ORDER BY creado_en DESC
      `).all(clave, clave);

      // Para cada sugerencia, obtener el resumen del OTRO pedido del par.
      const resultado = sugerencias.map(vinc => {
        const otraClave = vinc.pedido_a_clave === clave ? vinc.pedido_b_clave : vinc.pedido_a_clave;
        const otraPedido = db.prepare('SELECT canal, wc_order_id, ml_order_id, numero_pedido, comprador FROM pedidos_cache WHERE clave = ?').get(otraClave);

        return {
          id: vinc.id,
          campo_match: vinc.campo_match,
          otro_pedido: otraPedido ? {
            clave: otraClave,
            canal: otraPedido.canal,
            numero: otraPedido.numero_pedido || otraPedido.wc_order_id || otraPedido.ml_order_id,
            comprador: otraPedido.comprador,
          } : null,
          creado_en: vinc.creado_en,
        };
      });

      res.json({ ok: true, data: resultado });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /vinculos/:id/decidir — decidir sobre un vínculo.
  // Body: { estado: 'confirmado_junto'|'confirmado_separado_pero_vinculado'|'rechazado',
  //         un_solo_paquete?: boolean }
  router.post('/vinculos/:id/decidir', (req, res) => {
    try {
      const vinculoId = req.params.id;
      const { estado, un_solo_paquete } = req.body || {};

      // Validación: estado debe ser uno de los 3 valores válidos.
      const estadosValidos = ['confirmado_junto', 'confirmado_separado_pero_vinculado', 'rechazado'];
      if (!estadosValidos.includes(estado)) {
        return res.status(400).json({
          ok: false,
          error: `estado inválido. debe ser uno de: ${estadosValidos.join(', ')}`,
        });
      }

      // Buscar la fila del vínculo.
      const vinculo = db.prepare('SELECT * FROM preparacion_vinculos WHERE id = ?').get(vinculoId);
      if (!vinculo) return res.status(404).json({ ok: false, error: 'vínculo no encontrado' });
      const prepVinculo = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(vinculo.preparacion_id);
      if (prepVinculo && !exigirClaimVigente(db, prepVinculo, req.user?.username, res)) return;
      const claves = [vinculo.pedido_a_clave, vinculo.pedido_b_clave];
      const preparaciones = claves
        .map((clave) => db.prepare('SELECT * FROM preparaciones WHERE clave=?').get(clave))
        .filter(Boolean);
      for (const prep of preparaciones) {
        if (prep.id !== prepVinculo?.id && !exigirClaimVigente(db, prep, req.user?.username, res)) return;
      }

      // Actualizar con la decisión.
      const cambio = db.prepare(`
        UPDATE preparacion_vinculos
        SET estado = ?, un_solo_paquete = ?, decidido_por = ?, decidido_en = ?
        WHERE id = ?
      `).run(
        estado,
        estado === 'confirmado_junto' ? (un_solo_paquete ? 1 : 0) : 0,
        req.user?.username || null,
        now(),
        vinculoId,
      );

      if (!cambio.changes) {
        return res.status(500).json({ ok: false, error: 'no se pudo actualizar' });
      }

      res.json({ ok: true, estado });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

// ─── Helpers de fuentes (WC / ML) ────────────────────────────────────────────

// Un pedido WC → entrada de la cola de pendientes con ítems enriquecidos.
function armarPendienteWeb(db, order) {
  const ov = normalizarPedidoWc(order);
  const items = ov.items.map(it => {
    const idWoo = it.variation_id_wc || it.product_id;
    const fila = db.prepare('SELECT sku, categorias_json FROM catalogo_cache WHERE id_woo=?').get(idWoo) || {};
    const producto = productoDesdeFilaCatalogo(fila);
    return {
      line_item_id: it.line_item_id,
      product_id: it.product_id,
      variation_id: it.variation_id_wc,
      sku: it.sku || producto.sku || '',
      nombre: it.nombre,
      categoria: producto.categorias.join(' | '),
      cantidad: it.cantidad,
    };
  });
  const prep = db.prepare('SELECT id, estado, etiqueta_lista FROM preparaciones WHERE clave=?').get(`web:${order.id}`);
  return {
    canal: 'web',
    espejo_ml: ov.espejo_ml,
    wc_order_id: order.id,
    numero_pedido: ov.numero,
    comprador: `${ov.comprador.nombre} ${ov.comprador.apellido}`.trim(),
    fecha: ov.fecha,
    estado_wc: ov.estado,
    notas: ov.notas,
    items,
    preparacion_id: prep?.id || null,
    estado_preparacion: prep?.estado || null,
    etiqueta_lista: prep?.etiqueta_lista || 0,
  };
}

// Ítems de una orden ML mapeados a SKU/categoría de WC (best effort).
function itemsDesdeOrdenMl(db, orden) {
  const ov = normalizarOrdenMl(orden);
  return ov.items.map(it => {
    const sku = skuDesdeMl(db, it.item_id_ml, it.variation_id_ml) || it.seller_sku || '';
    let categoria = '';
    let productId = null;
    if (sku) {
      const fila = db.prepare('SELECT id_woo, categorias_json FROM catalogo_cache WHERE sku=?').get(sku);
      if (fila) {
        productId = fila.id_woo;
        categoria = productoDesdeFilaCatalogo(fila).categorias.join(' | ');
      }
    }
    return {
      line_item_id: null,
      product_id: productId,
      variation_id: null,
      sku,
      nombre: it.nombre,
      categoria,
      cantidad: it.cantidad,
    };
  });
}

// Órdenes ML pagas cuyo envío está listo y lo despacha el local.
// Devuelve { pendientes, confiable }: `confiable` indica si esta corrida vio el listado
// completo (paginación agotada sin errores) y sin fallos de /shipments/:id.
// Cuando confiable=false, el caller NO debe usar el resultado para podar (solo para
// alimentar/actualizar filas existentes), porque puede faltar un pedido real todavía
// ready_to_ship que simplemente no se pudo confirmar esta vez.
// Estados de envío ML que ya no cambian: una vez alcanzados, nunca vuelven a
// ready_to_ship. Ver migrations/006_ml_shipment_estado.sql.
// OJO: 'not_delivered' queda afuera a propósito -- es una visita fallida, no un estado
// final, y para envíos locales (self_service/Flex, los únicos que mira esEnvioLocal) hay
// reintento de visita: el envío puede volver a ready_to_ship. Tratarlo como terminal
// borraría en silencio un pedido real pendiente de despachar (ver revisión 2026-08-08).
const ESTADOS_SHIPMENT_TERMINALES = new Set(['shipped', 'delivered', 'cancelled']);

// Vigencia del cacheo de un estado terminal: aunque shipped/delivered/cancelled no
// deberían volver atrás, no confiamos ciegamente en un dato que puede llevar semanas sin
// revalidar -- se re-verifica contra ML pasados 7 días, igual que el criterio ya usado
// para ml_reactivacion_frenada (ver migrations/005_reactivacion_frenada_insumos.sql).
const VIGENCIA_SHIPMENT_TERMINAL_MS = 7 * 24 * 3600 * 1000;

async function pendientesMl(db, mlCfg) {
  if (!mlCfg?.clientId || !mlCfg?.userId) return { pendientes: [], confiable: false };
  const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const limite = 50;

  // Paginación real (mismo patrón que syncMlToWc/procesarCancelacionesMl en sync.js):
  // con el volumen actual (~34 pendientes ML en 30 días) la primera página ya viene llena
  // seguido, así que quedarse con una sola página marcaba `confiable=false` casi siempre y
  // la poda nunca corría. Se agota la paginación hasta la última página incompleta.
  let offset = 0;
  let hayMas = true;
  let resultados = [];
  // Fail-closed: si una página después de la primera falla, se corta la paginación (no se
  // reintenta indefinidamente) y se marca el listado como no confiable -> el caller no poda
  // con un resultado parcial. Si falla la primera página, se aborta con throw como antes
  // (no hay nada útil que devolver).
  let paginacionCortada = false;
  while (hayMas) {
    const resp = await mlFetch(db, mlCfg, 'get',
      `/orders/search?seller=${mlCfg.userId}&order.status=paid&sort=date_desc&order.date_created.from=${encodeURIComponent(desde)}&offset=${offset}&limit=${limite}`);
    if (resp.status !== 200) {
      if (offset === 0) throw new Error(`ML orders ${resp.status}`);
      paginacionCortada = true;
      break;
    }
    const pagina = resp.data.results || [];
    resultados = resultados.concat(pagina);
    hayMas = pagina.length === limite;
    offset += pagina.length;
  }
  const truncado = paginacionCortada;

  let fallosShipment = 0;
  const out = [];
  const clavesInconclusas = new Set();
  for (const orden of resultados) {
    const shipmentId = orden.shipping?.id;
    if (!shipmentId) { clavesInconclusas.add(`ml:${orden.id}`); continue; }

    // Saltar las ya completadas sin gastar un GET de shipment. No cuenta como fallo (la
    // preparación ya está confirmada del lado local) y esas filas se excluyen de la poda
    // por separado en syncPedidosCache, no dependen de aparecer acá.
    const prep = db.prepare('SELECT id, estado FROM preparaciones WHERE clave=?').get(`ml:${orden.id}`);
    if (prep?.estado === 'completada') continue;

    // Saltar envíos ya en estado terminal sin gastar el GET, pero solo mientras el cacheo
    // sea reciente (< 7 días): pasado ese plazo se re-verifica contra ML por las dudas. No
    // cuenta como fallo -- no es un error, es información que ya sabíamos -- y un envío
    // terminal tampoco sería `pendiente` igual que hoy.
    const estadoPrevio = db.prepare('SELECT status, actualizado_en FROM ml_shipment_estado WHERE shipment_id=?').get(String(shipmentId));
    if (estadoPrevio && ESTADOS_SHIPMENT_TERMINALES.has(estadoPrevio.status)) {
      const edadMs = Date.now() - new Date(estadoPrevio.actualizado_en).getTime();
      if (edadMs < VIGENCIA_SHIPMENT_TERMINAL_MS) continue;
    }

    const shipResp = await mlFetch(db, mlCfg, 'get', `/shipments/${shipmentId}`);
    if (shipResp.status !== 200) {
      fallosShipment++;
      continue;
    }
    const envio = shipResp.data;
    // Un 200 sin `status` es un dato inservible, no un éxito: la columna es NOT NULL y
    // cachear NULL/vacío tira SqliteError, que sube sin capturar y le hace perder a
    // syncPedidosCache la sección ML entera de la corrida (ver revisión 2026-08-08). Se
    // trata igual que un fallo de red: cuenta para `fallosShipment` y nunca se cachea.
    if (!envio?.status) {
      fallosShipment++;
      continue;
    }
    db.prepare(`
      INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(shipment_id) DO UPDATE SET status=excluded.status, logistic_type=excluded.logistic_type, actualizado_en=excluded.actualizado_en
    `).run(String(shipmentId), envio.status, envio.logistic_type || null, now());
    if (envio.status !== 'ready_to_ship') continue;
    const elegibilidad = clasificarElegibilidadMl(orden, envio);
    if (elegibilidad.estado !== 'elegible') {
      if (elegibilidad.estado === 'inconcluso') clavesInconclusas.add(`ml:${orden.id}`);
      continue;
    }
    const sla = calcularSlaPreparacion({ canal: 'ml', logisticType: envio.logistic_type, shipment: envio, horarios: leerHorarios(db), ahora: new Date() });
    if (sla.estado === 'excluido') continue;

    const ov = normalizarOrdenMl(orden);
    const vinculo = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get(ov.ml_order_id);
    out.push({
      canal: 'ml',
      ml_order_id: ov.ml_order_id,
      wc_order_id: vinculo?.wc_order_id || null,
      // El número que el operario ve en ML es el del pack cuando existe: mostrarlo es lo que
      // permite que buscar acá lo que se lee allá encuentre algo (ver ensureTables#pack_id).
      pack_id: ov.pack_id,
      numero_pedido: ov.numero,
      comprador: ov.comprador.nickname || 'Comprador ML',
      fecha: ov.fecha,
      fecha_despacho: sla.fecha_local || null,
      fecha_despacho_limite: sla.limite,
      estado_despacho: sla.estado,
      despacho_motivo: sla.razon,
      shipment_limite_original: sla.shipment_original,
      sla,
      logistic_type: envio.logistic_type,
      substatus: envio.substatus || null,
      items: itemsDesdeOrdenMl(db, orden),
      preparacion_id: prep?.id || null,
      estado_preparacion: prep?.estado || null,
    });
  }

  const confiable = !truncado && fallosShipment === 0;
  if (!confiable && fallosShipment > 0) {
    console.warn(`pendientesMl: ${fallosShipment} fallo(s) de /shipments al listar pendientes ML`);
  }
  return { pendientes: out, confiable, clavesInconclusas };
}

// ─── Caché local de pedidos (para GET /pendientes y GET /historial) ──────────

// Candado para evitar corridas concurrentes de syncPedidosCache (cron + disparo manual
// se pisarían y duplicarían llamadas a Woo/ML). Mismo patrón que _wcToMlEnCurso en sync.js.
let _pedidosCacheEnCurso = false;

function logSyncPedidos(db, estado, error) {
  db.prepare(`
    INSERT INTO sync_log (direccion, clave, sku, cant_anterior, cant_nueva, estado, error, intentos, creado_en, actualizado_en)
    VALUES ('pedidos_cache', NULL, NULL, NULL, NULL, ?, ?, 0, ?, ?)
  `).run(estado, error ?? null, now(), now());
}

function upsertPedidoCache(db, row) {
  const sla = row.sla || calcularSlaPreparacion({ canal: row.canal, logisticType: row.logistic_type, shipment: row.shipment, horarios: leerHorarios(db), ahora: new Date() });
  const fechaDespacho = sla.fecha_local ?? null;
  const limiteDespacho = sla.limite ?? null;
  const estadoDespacho = sla.estado ?? null;
  const motivoDespacho = sla.razon ?? null;
  const shipmentOriginal = sla.shipment_original ?? null;
  db.prepare(`
    INSERT INTO pedidos_cache
      (clave, canal, wc_order_id, ml_order_id, pack_id, numero_pedido, comprador, fecha,
       fecha_despacho, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en, customer_note,
       fecha_despacho_limite, estado_despacho, despacho_motivo, shipment_limite_original)
    VALUES (@clave, @canal, @wc_order_id, @ml_order_id, @pack_id, @numero_pedido, @comprador, @fecha,
       @fecha_despacho, @estado_envio, @estado_wc, @espejo_ml, @logistic_type, @substatus, @items_json, @actualizado_en, @customer_note,
       @fecha_despacho_limite, @estado_despacho, @despacho_motivo, @shipment_limite_original)
    ON CONFLICT(clave) DO UPDATE SET
      pack_id=excluded.pack_id,
      fecha_despacho=excluded.fecha_despacho,
      fecha_despacho_limite=excluded.fecha_despacho_limite,
      estado_despacho=excluded.estado_despacho, despacho_motivo=excluded.despacho_motivo,
      shipment_limite_original=excluded.shipment_limite_original,
      numero_pedido=excluded.numero_pedido, comprador=excluded.comprador, fecha=excluded.fecha,
      estado_envio=excluded.estado_envio, estado_wc=excluded.estado_wc, espejo_ml=excluded.espejo_ml,
      logistic_type=excluded.logistic_type, substatus=excluded.substatus,
      items_json=excluded.items_json, actualizado_en=excluded.actualizado_en, customer_note=excluded.customer_note
  `).run({ ...row, customer_note: row.customer_note ?? '', fecha_despacho: fechaDespacho, fecha_despacho_limite: limiteDespacho, estado_despacho: estadoDespacho, despacho_motivo: motivoDespacho, shipment_limite_original: shipmentOriginal });
}

// Un pedido WC (de cualquiera de los 3 estados relevantes) → fila de pedidos_cache.
function filaWebDesdeOrder(db, order, estadoEnvio) {
  const pend = armarPendienteWeb(db, order); // reusa el enriquecido de ítems/comprador ya existente
  return {
    clave: `web:${order.id}`,
    canal: 'web',
    wc_order_id: order.id,
    ml_order_id: null,
    pack_id: null, // los pedidos web no tienen pack: el concepto es de ML
    numero_pedido: pend.numero_pedido,
    comprador: pend.comprador,
    fecha: pend.fecha,
    estado_envio: estadoEnvio,
    estado_wc: pend.estado_wc,
    espejo_ml: pend.espejo_ml ? 1 : 0,
    logistic_type: null,
    substatus: null,
    items_json: JSON.stringify(pend.items),
    actualizado_en: now(),
    customer_note: pend.notas || '',
  };
}

export async function syncPedidosCache(db, cfg) {
  ensureTables(db);
  if (_pedidosCacheEnCurso) return;
  _pedidosCacheEnCurso = true;
  try {
    const andreaniStatus = cfg?.andreaniStatus || 'lpaandreani';
    const enviadoAndreaniStatus = cfg?.enviadoAndreaniStatus || 'enviadoandreani';

    // WooCommerce: 3 llamadas, una por estado relevante (mismo endpoint /orders que ya
    // usaban /pendientes, /etiquetas y /seguimientos por separado — acá se hace una sola
    // vez para las 3, en una única función/único cron).
    // Secuencial (no Promise.all): si la primera llamada no resuelve nunca (WC caído,
    // hang de red), no queremos disparar las otras dos en paralelo igual.
    // Los "enviados" (completed/enviadoandreani) se acotan a los últimos 60 días — si no,
    // el historial crece sin límite. Los "pendientes" (lpaandreani) no se acotan: un
    // pedido pendiente de preparar sigue siendo relevante sin importar hace cuánto se
    // generó, hasta que se procese.
    // `dates_are_gmt=true` es obligatorio junto con `after`: sin el, Woo interpreta la
    // fecha en la hora LOCAL del sitio y la ventana queda corrida (con el sitio en UTC-3,
    // 3 horas). Acá el impacto es leve porque la ventana es de 60 días, pero es el mismo
    // defecto que causó los pedidos duplicados 66554/66555 el 2026-07-29 — donde la
    // ventana era de minutos y el desfase la vaciaba por completo. Ver
    // buscarPedidoWcPorMlOrderId en routes/sync.js.
    const hace60Dias = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const wcPend = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`);
    const wcCompleted = await wooFetch(cfg.woo, `/orders?status=completed&dates_are_gmt=true&after=${encodeURIComponent(hace60Dias)}&per_page=100`);
    const wcEnviado = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(enviadoAndreaniStatus)}&dates_are_gmt=true&after=${encodeURIComponent(hace60Dias)}&per_page=100`);

    const tx = db.transaction(() => {
      for (const order of wcPend.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'pendiente'));
      for (const order of wcCompleted.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'enviado'));
      for (const order of wcEnviado.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'enviado'));
      // Limpieza: el sync solo hace upsert, nunca borra — sin esto, una fila "enviado" que
      // ya cayó fuera de la ventana de 60 días quedaría para siempre en la caché.
      db.prepare("DELETE FROM pedidos_cache WHERE estado_envio='enviado' AND fecha < ?").run(hace60Dias);
    });
    tx();

    // MercadoLibre: reusa pendientesMl (ya filtra paid+ready_to_ship+local) para pendientes.
    // Los "enviados" de ML quedan fuera de este alcance (no hay filtro de shipped simple
    // sin otro GET por shipment; el historial de enviados ML se cubre desde el lado Woo,
    // que ya refleja el pedido cuando se cargó el tracking en el tab Seguimientos).
    try {
      // Misma ventana de 30 días que usa pendientesMl para consultar /orders/search: la poda
      // de abajo solo puede confiar en la ausencia de una fila si esa fila estaba dentro del
      // rango que la consulta a ML pudo haber visto.
      const desdeMl = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { pendientes: mlPend, confiable: mlConfiable, clavesInconclusas } = await pendientesMl(db, cfg.ml);
      const clavesVigentesMl = new Set(mlPend.map((p) => `ml:${p.ml_order_id}`));
      const txMl = db.transaction(() => {
        for (const p of mlPend) {
          upsertPedidoCache(db, {
            clave: `ml:${p.ml_order_id}`,
            canal: 'ml',
            wc_order_id: p.wc_order_id,
            ml_order_id: p.ml_order_id,
            pack_id: p.pack_id || null,
            numero_pedido: p.numero_pedido,
            comprador: p.comprador,
            fecha: p.fecha,
            sla: p.sla,
            estado_envio: 'pendiente',
            estado_wc: null,
            espejo_ml: 0,
            logistic_type: p.logistic_type,
            substatus: p.substatus,
            items_json: JSON.stringify(p.items),
            actualizado_en: now(),
          });
        }
        // Poda: un pedido ML que dejó de estar ready_to_ship (se despachó) simplemente
        // desaparece del resultado de pendientesMl, pero el upsert de arriba nunca lo toca
        // -> quedaría huérfano para siempre como "pendiente" (mismo bug ya visto en
        // catalogo_cache/refrescarCatalogo). Fail-closed: solo podamos si pendientesMl marcó
        // el listado como confiable (paginación agotada sin fallos y sin fallos de
        // /shipments/:id); si no es confiable, dejamos los pendientes viejos tal cual esta
        // corrida (falso positivo temporal) en vez de arriesgar borrar de golpe un pedido
        // real que no se pudo confirmar. Además, solo se poda dentro de la ventana de 30
        // días que pendientesMl pudo confirmar: un pedido ML pagado hace más de 30 días que
        // sigue genuinamente ready_to_ship (envío demorado, etc.) queda fuera del alcance de
        // esta poda -- ni se confirma ni se descarta, se deja como está.
        if (mlConfiable) {
          const filasViejas = db.prepare(
            "SELECT pc.clave AS clave, p.estado AS estado_prep " +
            "FROM pedidos_cache pc " +
            "LEFT JOIN preparaciones p ON p.clave = pc.clave " +
            // Comparación normalizada con strftime (no texto plano): pc.fecha guarda el
            // date_created crudo de ML con su offset propio (ej. -04:00), y SQLite compara
            // strings ignorando el sufijo de zona -- una fecha con offset distinto a UTC
            // podía "parecer" más nueva o vieja de lo que es en tiempo real.
            "WHERE pc.canal='ml' AND pc.estado_envio='pendiente' AND strftime('%s', pc.fecha) >= strftime('%s', ?)"
          ).all(desdeMl);
          const borrar = db.prepare('DELETE FROM pedidos_cache WHERE clave=?');
          for (const r of filasViejas) {
            // Una preparación ya completada nunca se vuelve a refetchear en pendientesMl
            // (optimización de cuota) -> nunca va a aparecer en clavesVigentesMl aunque el
            // despacho real siga sin confirmarse. No es candidata a poda por ausencia; solo
            // se poda lo que se confirmó activamente que ya no es ready_to_ship.
            if (r.estado_prep === 'completada') continue;
            if (!clavesVigentesMl.has(r.clave) && !clavesInconclusas.has(r.clave)) borrar.run(r.clave);
          }
        } else {
          console.warn('syncPedidosCache: listado ML no confiable esta corrida (truncado o fallos de shipment), se omite la poda');
        }

        // Limpieza aparte de la poda "activa" de arriba: las filas ML con preparación ya
        // completada nunca se podan por ausencia (ver comentario arriba, no se refetchean),
        // y desde el fix que las ocultó de /pendientes tampoco son visibles en la UI -> sin
        // esto se acumularían para siempre en pedidos_cache. Misma ventana de retención de
        // 60 días que ya se usa para estado_envio='enviado' más arriba en esta función.
        db.prepare(
          "DELETE FROM pedidos_cache WHERE clave IN (" +
          "  SELECT pc.clave FROM pedidos_cache pc " +
          "  JOIN preparaciones p ON p.clave = pc.clave " +
          "  WHERE pc.canal='ml' AND pc.estado_envio='pendiente' " +
          "    AND p.estado='completada' AND p.completado_en < ?" +
          ")"
        ).run(hace60Dias);

        // ml_shipment_estado tampoco se poda nunca por su cuenta (mismo patrón de arriba):
        // sin esto, cada envío consultado alguna vez queda para siempre en la tabla, aunque
        // ya no tenga ninguna relación con un pedido vigente en pedidos_cache.
        db.prepare('DELETE FROM ml_shipment_estado WHERE actualizado_en < ?').run(hace60Dias);
      });
      txMl();
    } catch (eMl) {
      // ML tolerante a fallas (igual que hoy en GET /pendientes): no aborta el sync de Woo.
      logSyncPedidos(db, 'error', `ML: ${eMl.message}`);
      return;
    }

    logSyncPedidos(db, 'ok', null);
  } catch (e) {
    logSyncPedidos(db, 'error', e.message);
    throw e;
  } finally {
    _pedidosCacheEnCurso = false;
  }
}

// ─── Camino rápido por webhook: un solo pedido, sin esperar al cron de 10 min ────
//
// A.1 (2026-08-26): syncPedidosCache de arriba sigue siendo la única fuente de verdad y el
// respaldo — corre igual cada 10 min sin cambios. Estas dos funciones son un atajo puntual
// que reusa exactamente el mismo upsert/mapeo (filaWebDesdeOrder/upsertPedidoCache,
// ON CONFLICT(clave) por clave) para que la fila aparezca en pedidos_cache apenas llega la
// notificación, en vez de esperar hasta 10 min.
//
// Fail-open explícito en ambas: si la llamada puntual falla (red, Woo/ML caído, error de
// parseo), el error se loguea y se descarta acá — el pedido NO se pierde porque el cron
// siguiente lo va a traer igual por su barrido normal de 3 llamadas por estado (Woo) o de
// pendientesMl (ML). El caller (server.js) ya llama a esto con .catch(), fire-and-forget,
// igual que ya hace con syncWcToMl/syncMlToWc para el mismo webhook.

function invalidarCacheMlNoElegible(db, mlOrderId, estadoOrden, estadoEnvio = null, logisticType = null) {
  const detalle = estadoEnvio ? `${estadoOrden}/${estadoEnvio}/${logisticType || 'sin-logistica'}` : estadoOrden;
  db.prepare("UPDATE pedidos_cache SET estado_envio='no_elegible', estado_wc=?, logistic_type=?, actualizado_en=? WHERE clave=? AND estado_envio='pendiente'")
    .run(detalle || null, logisticType, now(), `ml:${mlOrderId}`);
}

// Trae SOLO la orden `wcOrderId` de Woo y hace upsert inmediato en pedidos_cache si su
// estado es uno de los 3 que syncPedidosCache ya trackea (lpaandreani/completed/enviadoandreani).
// Cualquier otro estado (pending, cancelled, etc.) se ignora en silencio: no es un estado
// relevante para la cola de preparación, igual que el barrido del cron nunca lo trae.
export async function syncPedidoWebPuntual(db, cfg, wcOrderId) {
  ensureTables(db);
  const andreaniStatus = cfg?.andreaniStatus || 'lpaandreani';
  const enviadoAndreaniStatus = cfg?.enviadoAndreaniStatus || 'enviadoandreani';
  const resp = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
  const order = resp.data;
  if (!order) return;
  let estadoEnvio = null;
  if (order.status === andreaniStatus) estadoEnvio = 'pendiente';
  else if (order.status === 'completed' || order.status === enviadoAndreaniStatus) estadoEnvio = 'enviado';
  if (!estadoEnvio) {
    db.prepare("UPDATE pedidos_cache SET estado_envio='no_elegible', estado_wc=?, actualizado_en=? WHERE clave=? AND estado_envio='pendiente'")
      .run(order.status || null, now(), `web:${order.id || wcOrderId}`);
    return;
  }
  upsertPedidoCache(db, filaWebDesdeOrder(db, order, estadoEnvio));
}

// Trae SOLO la orden `mlOrderId` de ML y hace upsert inmediato en pedidos_cache si sigue
// paid + ready_to_ship + envío local (mismos 3 filtros que pendientesMl aplica en el barrido
// del cron). Si no cumple alguno (todavía no está paga, ya se despachó, es envío por
// colecta/agencia), se ignora en silencio -- no correspondería estar en la cola igual.
export async function syncPedidoMlPuntual(db, mlCfg, mlOrderId) {
  ensureTables(db);
  if (!mlCfg?.clientId || !mlCfg?.userId) return;
  const ordenResp = await mlFetch(db, mlCfg, 'get', `/orders/${mlOrderId}`);
  if (ordenResp.status !== 200) return;
  const orden = ordenResp.data;
  if (orden.status !== 'paid') {
    invalidarCacheMlNoElegible(db, orden.id || mlOrderId, orden.status);
    return;
  }
  const shipmentId = orden.shipping?.id;
  let envio = null;
  if (shipmentId) {
    const shipResp = await mlFetch(db, mlCfg, 'get', `/shipments/${shipmentId}`);
    if (shipResp.status !== 200) return;
    envio = shipResp.data;
  }
  const elegibilidad = clasificarElegibilidadMl(orden, envio);
  if (shipmentId && envio?.status) db.prepare(`
    INSERT INTO ml_shipment_estado (shipment_id, status, logistic_type, actualizado_en)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(shipment_id) DO UPDATE SET status=excluded.status, logistic_type=excluded.logistic_type, actualizado_en=excluded.actualizado_en
  `).run(String(shipmentId), envio.status, envio.logistic_type || null, now());
  if (elegibilidad.estado === 'no_elegible') {
    invalidarCacheMlNoElegible(db, orden.id || mlOrderId, orden.status, envio?.status, envio?.logistic_type);
    return;
  }
  const sla = calcularSlaPreparacion({ canal: 'ml', logisticType: envio?.logistic_type, shipment: envio, horarios: leerHorarios(db), ahora: new Date() });
  if (sla.estado === 'excluido') return;

  const ov = normalizarOrdenMl(orden);
  const vinculo = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get(ov.ml_order_id);
  upsertPedidoCache(db, {
    clave: `ml:${ov.ml_order_id}`,
    canal: 'ml',
    wc_order_id: vinculo?.wc_order_id || null,
    ml_order_id: ov.ml_order_id,
    pack_id: ov.pack_id || null,
    numero_pedido: ov.numero,
    comprador: ov.comprador.nickname || 'Comprador ML',
    fecha: ov.fecha,
    sla,
    estado_envio: 'pendiente',
    estado_wc: null,
    espejo_ml: 0,
    logistic_type: envio?.logistic_type || null,
    substatus: envio?.substatus || null,
    items_json: JSON.stringify(itemsDesdeOrdenMl(db, orden)),
    actualizado_en: now(),
  });
}
