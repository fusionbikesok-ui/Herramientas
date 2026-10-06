import { wooFetch } from '../routes/woo.js';
import { mlFetch } from './mlClient.js';
import { normalizarOrdenMl } from './modelos/ordenVenta.js';
import { skuDesdeMl } from './mlMapeo.js';

// Rotación y criticidad del control cíclico de stock.

const now = () => new Date().toISOString();
const DOCE_MESES_MS = 365 * 24 * 3600 * 1000;

export function ensureVentasHistorialTables(db) {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ventas_historial (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      canal             TEXT NOT NULL,
      orden_id          TEXT NOT NULL,
      sku               TEXT NOT NULL,
      cantidad          INTEGER NOT NULL,
      precio_unitario   REAL,
      fecha             TEXT NOT NULL,
      creado_en         TEXT NOT NULL
    )`).run();
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_historial_canal_orden_sku ON ventas_historial(canal, orden_id, sku)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ventas_historial_sku ON ventas_historial(sku)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ventas_historial_fecha ON ventas_historial(fecha)').run();

    // Categorías marcadas como críticas a mano por José (score compuesto, ver
    // calcularCriticidad). No hay una tabla `sku_criticidad` persistida a propósito: el
    // score se recalcula al pedirlo (lectura barata sobre datos ya locales), así se evita
    // el problema de invalidar un caché cada vez que cambia una venta o una diferencia.
    db.prepare(`CREATE TABLE IF NOT EXISTS categorias_criticas (
      categoria    TEXT PRIMARY KEY,
      marcado_por  TEXT,
      marcado_en   TEXT NOT NULL
    )`).run();
  } catch (_) { /* ya existe */ }
}

function cursorVentas(db, canal) {
  const row = db.prepare('SELECT MAX(fecha) f FROM ventas_historial WHERE canal=?').get(canal);
  const haceDoceMeses = new Date(Date.now() - DOCE_MESES_MS).toISOString();
  // Primera corrida: no hay cursor, arranca 12 meses atrás. Corridas siguientes:
  // retrocede 1 día desde la última fecha vista, para tolerar pedidos que llegan
  // fuera de orden (ej. `date_created` de Woo vs. procesamiento asincrónico).
  if (!row?.f) return haceDoceMeses;
  const conMargen = new Date(new Date(row.f).getTime() - 24 * 3600 * 1000).toISOString();
  return conMargen > haceDoceMeses ? conMargen : haceDoceMeses;
}

const insertVenta = (db) => db.prepare(`
  INSERT OR IGNORE INTO ventas_historial (canal, orden_id, sku, cantidad, precio_unitario, fecha, creado_en)
  VALUES (?,?,?,?,?,?,?)
`);

// WooCommerce: pedidos completados o en preparación (procesando), paginado por per_page=100.
// `after` va en UTC (toISOString()); Woo lo compara contra date_created, que es hora LOCAL
// del sitio — el desfasaje posible entre ambos es el motivo del margen de 1 día del cursor
// de arriba, no un ajuste exacto al segundo.
async function backfillWoo(db, wooCfg) {
  const insertar = insertVenta(db);
  const desde = cursorVentas(db, 'woo');
  let pagina = 1;
  let insertados = 0, ordenes = 0;
  for (;;) {
    const resp = await wooFetch(
      wooCfg,
      `/orders?status=completed,processing&after=${encodeURIComponent(desde)}&per_page=100&page=${pagina}&orderby=date&order=asc`
    );
    const ordenesPagina = resp.data || [];
    if (!ordenesPagina.length) break;
    const tx = db.transaction((lista) => {
      for (const orden of lista) {
        ordenes++;
        // Agrupar por SKU ANTES de insertar (hallazgo del revisor): Woo permite el mismo
        // SKU en más de un line_item de una misma orden (carga manual, POS, edición a
        // mano). UNIQUE(canal, orden_id, sku) + INSERT OR IGNORE haría que la segunda
        // línea se descarte en silencio y la venta quede subcontada — acá se suma antes.
        const porSku = new Map();
        for (const li of orden.line_items || []) {
          const sku = String(li.sku || '').trim();
          if (!sku) continue; // sin SKU no hay a qué SKU atribuirle la venta — se omite
          const cantidad = Number(li.quantity) || 0;
          if (cantidad <= 0) continue;
          const precioUnitario = cantidad ? Number(li.price ?? (Number(li.total) / cantidad)) : null;
          const acumulado = porSku.get(sku);
          if (acumulado) {
            acumulado.cantidad += cantidad;
          } else {
            porSku.set(sku, { cantidad, precioUnitario });
          }
        }
        for (const [sku, { cantidad, precioUnitario }] of porSku) {
          const info = insertar.run('woo', String(orden.id), sku, cantidad, precioUnitario, orden.date_created, now());
          if (info.changes) insertados++;
        }
      }
    });
    tx(ordenesPagina);
    const totalPaginas = Number(resp.headers?.['x-wp-totalpages']) || pagina;
    if (pagina >= totalPaginas) break;
    pagina++;
  }
  return { ordenes, insertados };
}

// MercadoLibre: reutiliza EXACTAMENTE la resolución de SKU que ya usa syncMlToWc
// (routes/sync.js) — vínculo confirmado en sku_matcher_decisiones primero, seller_sku de
// la publicación como fallback. No reimplementa esa lógica: una venta de ML que no se
// pueda mapear a un SKU simplemente no se cuenta acá (no bloquea el backfill).
async function backfillMl(db, mlCfg) {
  if (!mlCfg?.userId) return { ordenes: 0, insertados: 0, omitido: true };
  const insertar = insertVenta(db);
  const desde = cursorVentas(db, 'ml');
  let offset = 0;
  const limit = 50;
  let ordenes = 0, insertados = 0;
  for (;;) {
    const resp = await mlFetch(
      db, mlCfg, 'get',
      `/orders/search?seller=${mlCfg.userId}&order.status=paid&sort=date_asc&order.date_created.from=${encodeURIComponent(desde)}&offset=${offset}&limit=${limit}`
    );
    if (resp.status !== 200) {
      console.error(`backfillVentas (ML): error API ${resp.status}, corte de esta corrida`);
      break;
    }
    const ordenesPagina = resp.data?.results ?? [];
    if (!ordenesPagina.length) break;
    for (const orden of ordenesPagina) {
      ordenes++;
      const ov = normalizarOrdenMl(orden);
      for (const item of ov.items) {
        let sku = skuDesdeMl(db, item.item_id_ml, item.variation_id_ml);
        if (!sku && item.seller_sku) sku = String(item.seller_sku).trim();
        if (!sku) continue;
        const cantidad = Number(item.cantidad) || 0;
        if (cantidad <= 0) continue;
        const info = insertar.run('ml', ov.ml_order_id, sku, cantidad, item.unit_price ?? null, orden.date_created, now());
        if (info.changes) insertados++;
      }
    }
    if (ordenesPagina.length < limit) break;
    offset += ordenesPagina.length;
  }
  return { ordenes, insertados };
}

// Backfill/incremental de ventas_historial. Fail-open entre canales: si Woo falla, ML se
// intenta igual (y viceversa) — un canal caído no debe bloquear al otro, y la próxima
// corrida retoma desde el cursor real de cada uno por separado.
export async function backfillVentas(db, cfg) {
  ensureVentasHistorialTables(db);
  const resultado = { woo: null, ml: null };
  try {
    resultado.woo = await backfillWoo(db, cfg.woo);
  } catch (e) {
    console.error('backfillVentas (Woo) falló:', e.message);
    resultado.woo = { error: e.message };
  }
  try {
    resultado.ml = await backfillMl(db, cfg.ml);
  } catch (e) {
    console.error('backfillVentas (ML) falló:', e.message);
    resultado.ml = { error: e.message };
  }
  return resultado;
}

// Score compuesto 0..1 (más alto = más crítico / más urgente de contar seguido), pesos del
// plan: ventas 12m 40%, historial de diferencias 30%, categoría marcada crítica 20%, valor
// de stock 10%. Se recalcula en cada pedido — sobre datos ya locales (sin llamadas
// externas), es barato, y evita el problema de invalidar un score cacheado cada vez que
// entra una venta o una diferencia nueva.
export function calcularCriticidad(db) {
  ensureVentasHistorialTables(db);
  const desde12m = new Date(Date.now() - DOCE_MESES_MS).toISOString();

  const ventasPorSku = new Map();
  for (const r of db.prepare('SELECT sku, SUM(cantidad) n FROM ventas_historial WHERE fecha >= ? GROUP BY sku').all(desde12m)) {
    ventasPorSku.set(r.sku, r.n);
  }
  const diferenciasPorSku = new Map();
  for (const r of db.prepare('SELECT sku, COUNT(*) n FROM inventario_diferencias GROUP BY sku').all()) {
    diferenciasPorSku.set(r.sku, r.n);
  }
  const categoriasCriticas = new Set(db.prepare('SELECT categoria FROM categorias_criticas').all().map(r => r.categoria));

  const productos = db.prepare(
    "SELECT sku, categorias_json, stock, precio FROM catalogo_cache WHERE COALESCE(sku,'')<>'' AND COALESCE(tipo,'')<>'variable'"
  ).all();

  const maxVentas = Math.max(1, ...productos.map(p => ventasPorSku.get(p.sku) || 0));
  const maxDiferencias = Math.max(1, ...productos.map(p => diferenciasPorSku.get(p.sku) || 0));
  const maxValorStock = Math.max(1, ...productos.map(p => (p.stock || 0) * (p.precio || 0)));

  const filas = productos.map(p => {
    const ventas = ventasPorSku.get(p.sku) || 0;
    const diferencias = diferenciasPorSku.get(p.sku) || 0;
    let cats = [];
    try { cats = JSON.parse(p.categorias_json || '[]'); } catch (_) { /* dato viejo, se ignora */ }
    const catCritica = cats.some(c => categoriasCriticas.has(c));
    const valorStock = (p.stock || 0) * (p.precio || 0);

    const score = (ventas / maxVentas) * 0.4
      + (diferencias / maxDiferencias) * 0.3
      + (catCritica ? 1 : 0) * 0.2
      + (valorStock / maxValorStock) * 0.1;

    return {
      sku: p.sku, score,
      ventas_12m: ventas, diferencias_historicas: diferencias,
      categoria_critica: catCritica, valor_stock: valorStock,
    };
  });
  filas.sort((a, b) => b.score - a.score);
  return filas;
}
