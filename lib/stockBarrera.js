// Fase E-0 (spec docs/superpowers/specs/2026-10-11-fase-e-webhooks-design.md): barrera de venta ML.
//
// Problema: tras crear el pedido Woo de una venta ML, el sync empujaba a ML el stock del caché ANTERIOR al descuento.
// La barrera bloquea toda escritura de stock hacia ML sobre la "bolsa" del SKU vendido hasta que hay evidencia de que
// Woo descontó ESE pedido y se releyó el stock de Woo después de reunir esa evidencia.
//
// Este módulo concentra: candados por SKU (válidos entre procesos), resolución de la bolsa, la barrera
// (stock_refresco_pendiente), la evidencia (nota de descuento de Woo) y la puerta única de escritura
// `escribirStockMl`. La corrección dueña (releer ML y empujar) vive en routes/sync.js porque usa la CTE del sync.
import crypto from 'node:crypto';
import { mlFetch } from './mlClient.js';
import { wooFetch } from '../routes/woo.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

const ahora = () => new Date().toISOString();
export const LEASE_MS = 60_000;
export const RENOVAR_MS = 10_000;
export const SIN_EVIDENCIA_MAX_MS = 30 * 60 * 1000;
const ACCIONES_VINCULO = "('asignar','confirmar')";

// ─── Candados por SKU ────────────────────────────────────────────────────────

class CandadoOcupado extends Error {}

/** Toma, en orden alfabético y de forma atómica, el candado de cada SKU. Devuelve {token, skus} o null si alguno está ocupado. */
export function tomarCandados(db, skus, { leaseMs = LEASE_MS, token = crypto.randomUUID() } = {}) {
  const lista = [...new Set((skus || []).filter(Boolean))].sort();
  if (!lista.length) return { token, skus: [] };
  const vence = new Date(Date.now() + leaseMs).toISOString();
  const sel = db.prepare('SELECT token, vence FROM stock_lock WHERE sku = ?');
  const ups = db.prepare(`INSERT INTO stock_lock (sku, token, vence) VALUES (?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET token = excluded.token, vence = excluded.vence`);
  try {
    db.transaction(() => {
      const t = ahora();
      for (const sku of lista) {
        const f = sel.get(sku);
        // Solo se puede tomar uno vencido y sin renovar (dueño caído) o uno propio.
        if (f && f.token !== token && f.vence > t) throw new CandadoOcupado(sku);
        ups.run(sku, token, vence);
      }
    }).immediate();
  } catch (e) {
    if (e instanceof CandadoOcupado) return null;
    throw e;
  }
  return { token, skus: lista };
}

export async function tomarCandadosConEspera(db, skus, { esperaMs = Number(process.env.STOCK_LOCK_ESPERA_MS) || 45_000, pasoMs = 200 } = {}) {
  const limite = Date.now() + esperaMs;
  for (;;) {
    const c = tomarCandados(db, skus);
    if (c) return c;
    if (Date.now() >= limite) return null;
    await new Promise((r) => setTimeout(r, pasoMs));
  }
}

export function renovarCandados(db, token, leaseMs = LEASE_MS) {
  db.prepare('UPDATE stock_lock SET vence = ? WHERE token = ?').run(new Date(Date.now() + leaseMs).toISOString(), token);
}

/** Solo el dueño (por token) libera. */
export function liberarCandados(db, token) {
  db.prepare('DELETE FROM stock_lock WHERE token = ?').run(token);
}

export function candadosDelToken(db, token, skus) {
  const lista = [...new Set((skus || []).filter(Boolean))];
  if (!lista.length) return true;
  const t = ahora();
  const n = db.prepare(`SELECT COUNT(*) n FROM stock_lock WHERE token = ? AND vence > ? AND sku IN (${lista.map(() => '?').join(',')})`).get(token, t, ...lista).n;
  return n === lista.length;
}

/** Ejecuta `fn` con los candados tomados (renovándolos mientras corre). `{ocupado:true}` si no se pudieron tomar. */
export async function conCandados(db, skus, fn, opts = {}) {
  const c = await tomarCandadosConEspera(db, skus, opts);
  if (!c) return { ocupado: true };
  const timer = setInterval(() => { try { renovarCandados(db, c.token); } catch { /* se reintenta en el próximo tick */ } }, RENOVAR_MS);
  timer.unref?.();
  try {
    return { ocupado: false, valor: await fn(c) };
  } finally {
    clearInterval(timer);
    liberarCandados(db, c.token);
  }
}

// ─── Bolsa ───────────────────────────────────────────────────────────────────

/**
 * La bolsa de una venta: todos los SKUs y claves ML que un push de stock puede tocar junto. Parte de SKUs y/o claves,
 * suma las claves de cada SKU (sku_matcher_decisiones, el conjunto que el sync escribe) y las que comparten
 * `user_product_id` en ml_publicaciones_cache (cualquiera sea su SKU), y repite hasta que no crece.
 * Si la enumeración falla, lanza: el llamador conserva la barrera.
 */
export function resolverBolsa(db, { skus = [], claves = [] } = {}) {
  const S = new Set(skus.filter(Boolean));
  const C = new Set(claves.filter(Boolean));
  const clavesDeSku = db.prepare(`SELECT clave FROM sku_matcher_decisiones WHERE sku = ? AND accion IN ${ACCIONES_VINCULO}`);
  const skuDeClave = db.prepare(`SELECT sku FROM sku_matcher_decisiones WHERE clave = ? AND accion IN ${ACCIONES_VINCULO} AND sku IS NOT NULL AND sku <> ''`);
  const upDeClave = db.prepare("SELECT user_product_id FROM ml_publicaciones_cache WHERE clave = ? AND user_product_id IS NOT NULL AND user_product_id <> ''");
  const clavesDeUp = db.prepare('SELECT clave FROM ml_publicaciones_cache WHERE user_product_id = ?');
  for (let i = 0; i < 8; i++) {
    const antes = S.size + C.size;
    for (const sku of [...S]) for (const r of clavesDeSku.all(sku)) C.add(r.clave);
    for (const clave of [...C]) {
      const d = skuDeClave.get(clave);
      if (d) S.add(d.sku);
      const up = upDeClave.get(clave);
      if (up) for (const r of clavesDeUp.all(up.user_product_id)) C.add(r.clave);
    }
    if (S.size + C.size === antes) break;
  }
  return { skus: [...S].sort(), claves: [...C].sort() };
}

// ─── Barrera ─────────────────────────────────────────────────────────────────

export const idBarrera = (sku, mlOrderId) => `${sku}|${mlOrderId}`;

export function filasBarrera(db, skus) {
  const lista = [...new Set((skus || []).filter(Boolean))];
  if (!lista.length) return [];
  return db.prepare(`SELECT * FROM stock_refresco_pendiente WHERE sku IN (${lista.map(() => '?').join(',')}) ORDER BY vendido_en`).all(...lista);
}

/**
 * ¿Puede una escritura sobre esta bolsa? Con una fila `bloqueante` nunca. Con una `liberable` solo la llamada dueña
 * (la que lleva el `barrera_id` de alguna fila liberable de la bolsa), que es la que las cierra.
 */
export function evaluarBarrera(db, skusBolsa, barreraId = null) {
  const filas = filasBarrera(db, skusBolsa);
  if (filas.some((f) => f.estado === 'bloqueante')) return { permitido: false, motivo: 'barrera_bloqueante' };
  const liberables = filas.filter((f) => f.estado === 'liberable');
  if (!liberables.length) return { permitido: true };
  if (barreraId && liberables.some((f) => idBarrera(f.sku, f.ml_order_id) === barreraId)) return { permitido: true, duena: true };
  return { permitido: false, motivo: 'barrera_liberable_ajena' };
}

/** Agrupa las líneas (con `sku`) de una venta por SKU. */
export function lineasPorSku(lineas) {
  const m = new Map();
  for (const l of lineas) {
    if (!m.has(l.sku)) m.set(l.sku, []);
    m.get(l.sku).push(l);
  }
  return m;
}

/** Inserta una fila `bloqueante` (woo_confirmado=0) por SKU de la venta. Idempotente por (sku, ml_order_id). */
export function insertarBarrera(db, { mlOrderId, vendidoEn, lineas }) {
  const ins = db.prepare(`INSERT OR IGNORE INTO stock_refresco_pendiente
    (sku, ml_order_id, vendido_en, lineas_json, woo_confirmado, estado, creado_en, actualizado_en)
    VALUES (?, ?, ?, ?, 0, 'bloqueante', ?, ?)`);
  const t = ahora();
  db.transaction(() => {
    for (const [sku, ls] of lineasPorSku(lineas)) ins.run(sku, String(mlOrderId), vendidoEn, JSON.stringify(ls), t, t);
  })();
}

export function borrarBarreraDeOrden(db, mlOrderId) {
  db.prepare('DELETE FROM stock_refresco_pendiente WHERE ml_order_id = ?').run(String(mlOrderId));
}

/**
 * Completa, tras el POST, `line_item_id` y `name` de cada línea desde el pedido de Woo y marca `woo_confirmado=1`.
 * Las líneas se asignan a los `line_items` del pedido por (product_id, variation_id) sin reutilizar ninguno.
 */
export function confirmarBarreraConPedido(db, mlOrderId, pedido) {
  const usados = new Set();
  const lis = Array.isArray(pedido?.line_items) ? pedido.line_items : [];
  const filas = db.prepare('SELECT * FROM stock_refresco_pendiente WHERE ml_order_id = ?').all(String(mlOrderId));
  const upd = db.prepare(`UPDATE stock_refresco_pendiente SET lineas_json = ?, woo_confirmado = 1, wc_order_id = ?, actualizado_en = ?
    WHERE sku = ? AND ml_order_id = ?`);
  db.transaction(() => {
    for (const f of filas) {
      const lineas = JSON.parse(f.lineas_json);
      for (const l of lineas) {
        const idx = lis.findIndex((li, i) => !usados.has(i)
          && Number(li.product_id) === Number(l.product_id)
          && Number(li.variation_id || 0) === Number(l.variation_id || 0));
        if (idx >= 0) {
          usados.add(idx);
          l.line_item_id = lis[idx].id ?? null;
          l.name = lis[idx].name ?? null;
        }
      }
      upd.run(JSON.stringify(lineas), pedido?.id ?? null, ahora(), f.sku, f.ml_order_id);
    }
  })();
}

// ─── Evidencia: la nota de descuento de Woo ──────────────────────────────────

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', ndash: '–', mdash: '—', hellip: '…' };
function decodificar(t) {
  let s = String(t ?? '');
  for (let i = 0; i < 3; i++) { // la nota viene doble-codificada (`&amp;rarr;`)
    const n = s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&([a-z]+);/gi, (m, e) => ENTIDADES[e.toLowerCase()] ?? m);
    if (n === s) break;
    s = n;
  }
  return s;
}
export function limpiarNota(html) {
  return decodificar(String(html ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
export const normalizarNombre = (s) => decodificar(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** Patrones de la nota de descuento (configurables: STOCK_NOTA_PATRONES="regex1;;regex2"). La tienda usa "Niveles de inventario reducidos:". */
export function patronesReduccion(env = process.env) {
  const cfg = String(env.STOCK_NOTA_PATRONES || '').split(';;').map((s) => s.trim()).filter(Boolean);
  if (cfg.length) return cfg.map((s) => new RegExp(s, 'i'));
  return [/Niveles de (?:inventario|stock) reducidos:/i, /(?:Stock|Inventory) levels reduced:/i];
}
export const PATRONES_FALLO = [/Unable to reduce stock/i, /No se pudo reducir (?:el )?(?:stock|inventario)/i];

/** Entradas `Nombre (desde→hasta)` de una nota de descuento ya limpia. Devuelve [] si la nota no es de descuento. */
export function entradasDeNota(texto, patrones = patronesReduccion()) {
  for (const re of patrones) {
    const m = re.exec(texto);
    if (!m) continue;
    const resto = texto.slice(m.index + m[0].length).trim();
    const out = [];
    for (const e of resto.matchAll(/(.+?) \((-?\d+)\s*(?:→|->)\s*(-?\d+)\)(?:, |\s*$)/g)) {
      out.push({ nombre: e[1].trim(), desde: Number(e[2]), hasta: Number(e[3]) });
    }
    return out;
  }
  return [];
}

/**
 * Evalúa la evidencia de cada línea de una fila. Pura (sin red).
 *  - lineas: las de la fila (lineas_json).
 *  - lineItemsOrden: line_items del pedido Woo (para detectar nombres ambiguos).
 *  - notas: textos limpios de las notas internas.
 *  - manageStockActual: Map `${product_id}:${variation_id}` → 'true'|'false'|'parent' leído DESPUÉS de confirmar el pedido.
 *  - confirmaciones: [{idx}] de "Confirmar descuento".
 */
export function evaluarEvidencia({ lineas, lineItemsOrden = [], notas = [], manageStockActual = new Map(), confirmaciones = [], nombresRepetidosCatalogo = () => false, patrones }) {
  const pats = patrones || patronesReduccion();
  const entradas = notas.flatMap((n) => entradasDeNota(n, pats));
  const disponibles = new Map();
  for (const e of entradas) {
    const k = normalizarNombre(e.nombre);
    disponibles.set(k, (disponibles.get(k) || 0) + 1);
  }
  const fallos = new Set();
  for (const n of notas) {
    if (PATRONES_FALLO.some((re) => re.test(n))) for (const l of lineas) if (l.name && n.toLowerCase().includes(String(l.name).toLowerCase())) fallos.add(l.idx);
  }
  const productosPorNombre = new Map();
  for (const li of lineItemsOrden) {
    const k = normalizarNombre(li.name);
    if (!productosPorNombre.has(k)) productosPorNombre.set(k, new Set());
    productosPorNombre.get(k).add(`${li.product_id}:${li.variation_id || 0}`);
  }
  const confirmadas = new Set((confirmaciones || []).map((c) => c.idx));
  const resultado = lineas.map((l) => {
    const base = { idx: l.idx, evidencia: null, motivo: null };
    if (fallos.has(l.idx)) return { ...base, motivo: 'unable_to_reduce' };
    if (confirmadas.has(l.idx)) return { ...base, evidencia: 'confirmacion' };
    const clave = `${l.product_id}:${l.variation_id || 0}`;
    if (l.manage_stock === 'false' && manageStockActual.get(clave) === 'false') return { ...base, evidencia: 'manage_stock_false' };
    if (!l.name) return { ...base, motivo: 'sin_nombre' };
    const k = normalizarNombre(l.name);
    if ((productosPorNombre.get(k)?.size || 0) > 1 || nombresRepetidosCatalogo(l.name)) return { ...base, motivo: 'nombre_ambiguo' };
    return { ...base, evidencia: 'pendiente_nota', _k: k };
  });
  // Las que dependen de la nota consumen entradas: N líneas con el mismo nombre exigen N entradas.
  for (const r of resultado) {
    if (r.evidencia !== 'pendiente_nota') continue;
    const quedan = disponibles.get(r._k) || 0;
    if (quedan > 0) { disponibles.set(r._k, quedan - 1); r.evidencia = 'nota'; } else { r.evidencia = null; r.motivo = 'sin_nota'; }
    delete r._k;
  }
  return { lineas: resultado, completo: resultado.every((r) => r.evidencia), ambiguas: resultado.filter((r) => r.motivo === 'nombre_ambiguo'), fallos: resultado.filter((r) => r.motivo === 'unable_to_reduce') };
}

// ─── Lecturas de Woo ─────────────────────────────────────────────────────────

const pathProducto = (padre, id) => (padre ? `/products/${padre}/variations/${id}` : `/products/${id}`);

async function leerNotasInternas(wooCfg, wcOrderId) {
  const textos = [];
  let paginas = 1;
  for (let page = 1; page <= paginas && page <= 10; page++) {
    const r = await wooFetch(wooCfg, `/orders/${wcOrderId}/notes?type=internal&page=${page}`);
    if (!Array.isArray(r?.data)) throw new Error('notas de Woo con forma inesperada');
    for (const n of r.data) textos.push(limpiarNota(n.note));
    paginas = Number(r.headers?.['x-wp-totalpages'] || 1) || 1;
  }
  return textos;
}

/** Lee de Woo el stock de cada gestor y lo vuelca en catalogo_cache. Lanza si alguna lectura falla. */
export async function releerStockGestores(db, wooCfg, gestores, { estricto = true } = {}) {
  const vistos = new Set();
  const upd = db.prepare('UPDATE catalogo_cache SET stock = ?, actualizado_en = ? WHERE id_woo = ?');
  for (const g of gestores) {
    if (!g?.id || vistos.has(g.id)) continue;
    vistos.add(g.id);
    const r = await wooFetch(wooCfg, pathProducto(g.padre, g.id));
    const q = r?.data?.stock_quantity;
    if (q === null || q === undefined || !Number.isFinite(Number(q))) {
      if (estricto) throw new Error(`Woo no devolvió stock_quantity de ${g.id}`);
      continue; // producto sin gestión de stock: no hay valor que volcar
    }
    upd.run(Number(q), ahora(), g.id);
  }
}

export function gestoresDeFilas(filas) {
  const out = [];
  for (const f of filas) for (const l of JSON.parse(f.lineas_json)) out.push({ id: l.stock_gestor_id, padre: l.stock_gestor_padre ?? null });
  return out;
}

// ─── Estado de la barrera / manage_stock ─────────────────────────────────────

export function leerEstado(db, clave) {
  return db.prepare('SELECT valor, actualizado_en FROM stock_barrera_estado WHERE clave = ?').get(clave) ?? null;
}
export function guardarEstado(db, clave, valor) {
  db.prepare(`INSERT INTO stock_barrera_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`).run(clave, String(valor), ahora());
}

/** Con `woocommerce_manage_stock=no` Woo no descuenta nada: no se libera ninguna barrera ni se escribe stock. */
export function stockWooPausado(db) {
  return leerEstado(db, 'woocommerce_manage_stock')?.valor === 'no';
}

export async function verificarManageStockWoo(db, wooCfg, { cadaMs = 24 * 3600 * 1000, forzar = false } = {}) {
  const previo = leerEstado(db, 'woocommerce_manage_stock');
  if (!forzar && previo && Date.now() - new Date(previo.actualizado_en).getTime() < cadaMs) return { omitido: true, valor: previo.valor };
  const r = await wooFetch(wooCfg, '/settings/products/woocommerce_manage_stock');
  const valor = String(r?.data?.value ?? '').toLowerCase();
  if (valor !== 'yes' && valor !== 'no') throw new Error(`woocommerce_manage_stock con valor inesperado: ${valor}`);
  guardarEstado(db, 'woocommerce_manage_stock', valor);
  if (valor === 'no') {
    abrirOActualizarIncidente(db, {
      integracion: 'woocommerce', proceso: 'barrera_stock', tipoError: 'manage_stock_desactivado', severidad: 'critico',
      mensajeTecnico: 'woocommerce_manage_stock=no',
      mensajeHumano: 'WooCommerce tiene desactivada la gestión de inventario (Ajustes → Productos → Inventario): Woo no descuenta las ventas. Se pausaron las escrituras de stock hacia MercadoLibre hasta que se reactive.',
      contexto: {},
    });
  } else {
    confirmarCicloSano(db, { integracion: 'woocommerce', proceso: 'barrera_stock', tipoError: 'manage_stock_desactivado' });
  }
  return { valor };
}

// ─── Liberación (bloqueante → liberable) ─────────────────────────────────────

function incidenteWooNoDescontó(db, fila, lineas, evaluacion, motivo) {
  const reduced = lineas.map((l) => l.reduced_stock_meta);
  abrirOActualizarIncidente(db, {
    integracion: 'woocommerce', proceso: 'barrera_stock', tipoError: `woo_no_descontó_${fila.sku}_${fila.ml_order_id}`.slice(0, 120), severidad: 'critico',
    mensajeTecnico: `${motivo}: sku=${fila.sku} ml_order=${fila.ml_order_id} wc_order=${fila.wc_order_id}`,
    mensajeHumano: `Woo no descontó el stock del SKU ${fila.sku} de la venta ML ${fila.ml_order_id} (pedido Woo ${fila.wc_order_id}). Hasta que se resuelva, no se empuja stock de ese SKU a MercadoLibre. `
      + 'Si la línea no tiene _reduced_stock: en el pedido Woo, "Acciones del pedido → Reducir niveles de stock". '
      + 'Si ya tiene _reduced_stock igual a la cantidad vendida pero la nota no se reconoce: "Confirmar descuento" (admin).',
    contexto: { sku: fila.sku, ml_order_id: fila.ml_order_id, wc_order_id: fila.wc_order_id, motivo, lineas: evaluacion.lineas, reduced_stock: reduced },
  });
}

/**
 * Intenta pasar una fila a `liberable`. Devuelve {estado: 'liberable'|'bloqueada'|'reintentar'|'esperando', motivo}.
 * Nunca libera una fila con woo_confirmado=0. La lectura del stock de los gestores se hace DESPUÉS de reunir la evidencia.
 */
export async function intentarLiberarFila(db, wooCfg, fila, { patrones } = {}) {
  if (stockWooPausado(db)) return { estado: 'bloqueada', motivo: 'manage_stock_no' };
  if (!fila.woo_confirmado || !fila.wc_order_id) return { estado: 'esperando', motivo: 'sin_confirmar' };
  try {
    const orden = (await wooFetch(wooCfg, `/orders/${fila.wc_order_id}`))?.data;
    if (!orden || !Array.isArray(orden.line_items)) return { estado: 'reintentar', motivo: 'pedido_ilegible' };
    const lineas = JSON.parse(fila.lineas_json);
    // Completa ids/nombres si la fila se confirmó sin ellos (p. ej. por el chequeo periódico).
    if (lineas.some((l) => !l.name)) {
      confirmarBarreraConPedido(db, fila.ml_order_id, orden);
      return { estado: 'reintentar', motivo: 'lineas_completadas' };
    }
    for (const l of lineas) {
      const li = orden.line_items.find((x) => x.id === l.line_item_id);
      const m = (li?.meta_data || []).find((x) => x.key === '_reduced_stock');
      l.reduced_stock_meta = m ? Number(m.value) : null;
    }
    const notas = await leerNotasInternas(wooCfg, fila.wc_order_id);
    // manage_stock=false se acepta solo si una relectura posterior al pedido sigue diciendo false.
    const manageActual = new Map();
    for (const l of lineas.filter((x) => x.manage_stock === 'false')) {
      const r = await wooFetch(wooCfg, pathProducto(l.variation_id ? l.product_id : null, l.variation_id || l.product_id));
      manageActual.set(`${l.product_id}:${l.variation_id || 0}`, r?.data?.manage_stock === true ? 'true' : (r?.data?.manage_stock === 'parent' ? 'parent' : 'false'));
    }
    const confirmaciones = fila.confirmaciones_json ? JSON.parse(fila.confirmaciones_json) : [];
    const evalu = evaluarEvidencia({
      lineas, lineItemsOrden: orden.line_items, notas, manageStockActual: manageActual, confirmaciones, patrones,
      nombresRepetidosCatalogo: (nombre) => db.prepare('SELECT COUNT(*) n FROM catalogo_cache WHERE nombre = ?').get(nombre).n > 1,
    });
    if (!evalu.completo) {
      const viejo = Date.now() - new Date(fila.creado_en).getTime() > SIN_EVIDENCIA_MAX_MS;
      const motivoFuerte = evalu.ambiguas.length || evalu.fallos.length;
      if (motivoFuerte || viejo) {
        const motivo = evalu.ambiguas.length ? 'nombre_ambiguo' : (evalu.fallos.length ? 'unable_to_reduce' : 'sin_nota_30min');
        incidenteWooNoDescontó(db, fila, lineas, evalu, motivo);
        db.prepare('UPDATE stock_refresco_pendiente SET incidente_motivo = ?, actualizado_en = ? WHERE sku = ? AND ml_order_id = ?')
          .run(motivo, ahora(), fila.sku, fila.ml_order_id);
        return { estado: 'bloqueada', motivo };
      }
      return { estado: 'esperando', motivo: 'sin_nota' };
    }
    // Evidencia reunida → recién ahora se lee el stock de los gestores.
    await releerStockGestores(db, wooCfg, gestoresDeFilas([fila]));
    db.prepare("UPDATE stock_refresco_pendiente SET estado = 'liberable', incidente_motivo = NULL, actualizado_en = ? WHERE sku = ? AND ml_order_id = ? AND estado = 'bloqueante'")
      .run(ahora(), fila.sku, fila.ml_order_id);
    confirmarCicloSano(db, { integracion: 'woocommerce', proceso: 'barrera_stock', tipoError: `woo_no_descontó_${fila.sku}_${fila.ml_order_id}`.slice(0, 120) });
    return { estado: 'liberable' };
  } catch (e) {
    return { estado: 'reintentar', motivo: String(e.message).slice(0, 200) };
  }
}

/**
 * "Confirmar descuento" (admin): evidencia de UNA línea cuando Woo la descontó (`_reduced_stock` igual a la cantidad
 * vendida) pero la nota no se reconoce. Relee el pedido: un `_reduced_stock` distinto de la cantidad no se confirma.
 */
export async function confirmarDescuentoLinea(db, wooCfg, { sku, mlOrderId, idx, motivo, actor }) {
  if (!String(motivo || '').trim()) return { ok: false, code: 400, error: 'motivo requerido' };
  const fila = db.prepare('SELECT * FROM stock_refresco_pendiente WHERE sku = ? AND ml_order_id = ?').get(sku, String(mlOrderId));
  if (!fila) return { ok: false, code: 404, error: 'no hay barrera para ese SKU y venta' };
  if (!fila.woo_confirmado) return { ok: false, code: 409, error: 'el pedido Woo todavía no está confirmado' };
  const lineas = JSON.parse(fila.lineas_json);
  const l = lineas.find((x) => x.idx === Number(idx));
  if (!l) return { ok: false, code: 404, error: 'línea inexistente' };
  const orden = (await wooFetch(wooCfg, `/orders/${fila.wc_order_id}`))?.data;
  const li = (orden?.line_items || []).find((x) => x.id === l.line_item_id);
  const m = (li?.meta_data || []).find((x) => x.key === '_reduced_stock');
  if (!m) return { ok: false, code: 409, error: 'la línea no tiene _reduced_stock: usá "Reducir niveles de stock" en el pedido Woo' };
  if (Number(m.value) !== Number(l.cantidad)) return { ok: false, code: 409, error: `_reduced_stock (${m.value}) distinto de la cantidad vendida (${l.cantidad})` };
  const confs = fila.confirmaciones_json ? JSON.parse(fila.confirmaciones_json) : [];
  if (!confs.some((c) => c.idx === l.idx)) confs.push({ idx: l.idx, actor, motivo: String(motivo).trim(), reduced_stock: Number(m.value), en: ahora() });
  db.prepare('UPDATE stock_refresco_pendiente SET confirmaciones_json = ?, actualizado_en = ? WHERE sku = ? AND ml_order_id = ?')
    .run(JSON.stringify(confs), ahora(), sku, String(mlOrderId));
  return { ok: true };
}

// ─── Puerta única de escritura de stock hacia ML ─────────────────────────────

export function buildMlStockUpdate(itemId, variationId, cantidad) {
  if (variationId) {
    return { path: `/items/${itemId}/variations/${variationId}`, body: { available_quantity: cantidad } };
  }
  return { path: `/items/${itemId}`, body: { available_quantity: cantidad } };
}

function partirClave(clave) {
  const i = String(clave).indexOf('|');
  return { itemId: clave.slice(0, i), variationId: clave.slice(i + 1) };
}

/**
 * ÚNICA puerta de `available_quantity` hacia ML. Se omite (sin PUT) si Woo no gestiona stock, si la bolsa de la clave
 * tiene una fila bloqueante (o liberable ajena) o si no se pudo resolver la bolsa. Toma el candado de cada SKU de la
 * bolsa mientras el PUT está en vuelo.
 * @returns {{omitido:true, motivo:string}|{omitido:false, resp:object}}
 */
export async function escribirStockMl(db, mlCfg, { clave, sku = null, cantidad, barreraId = null, candadoToken = null, opts = {} }) {
  if (stockWooPausado(db)) return { omitido: true, motivo: 'manage_stock_no' };
  let bolsa;
  try {
    const skuClave = sku || db.prepare(`SELECT sku FROM sku_matcher_decisiones WHERE clave = ? AND accion IN ${ACCIONES_VINCULO}`).get(clave)?.sku || null;
    bolsa = resolverBolsa(db, { skus: skuClave ? [skuClave] : [], claves: [clave] });
  } catch (e) {
    return { omitido: true, motivo: 'bolsa_no_resuelta' };
  }
  const { itemId, variationId } = partirClave(clave);
  const { path, body } = buildMlStockUpdate(itemId, variationId, Math.max(0, Math.round(Number(cantidad))));
  const ejecutar = async () => {
    // Con los candados tomados se vuelve a evaluar: una barrera insertada mientras se esperaba bloquea el PUT.
    const ev = evaluarBarrera(db, bolsa.skus, barreraId);
    if (!ev.permitido) return { omitido: true, motivo: ev.motivo };
    // Sin opciones, la misma llamada de 4 argumentos que hacían los sitios originales.
    const resp = Object.keys(opts || {}).length ? await mlFetch(db, mlCfg, 'put', path, body, opts) : await mlFetch(db, mlCfg, 'put', path, body);
    return { omitido: false, resp };
  };
  if (candadoToken && candadosDelToken(db, candadoToken, bolsa.skus)) return ejecutar();
  const r = await conCandados(db, bolsa.skus, ejecutar);
  if (r.ocupado) return { omitido: true, motivo: 'candado_ocupado' };
  return r.valor;
}
