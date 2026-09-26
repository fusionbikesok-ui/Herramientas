/*
 * lib/vigiaPausado.js — qué hacer con un cambio de formato detectado.
 *
 * Asienta, pausa en ML y avisa. La detección vive en lib/vigiaFormato.js; acá está la parte que
 * ESCRIBE, con su freno de mano.
 */
import { mlFetch } from './mlClient.js';
import { abrirOActualizarIncidente } from './incidentes.js';

/**
 * Máximo de publicaciones que el vigía puede pausar en una sola corrida.
 *
 * Trescientas publicaciones no se rompen juntas: un cambio masivo es casi siempre ML cambiando
 * algo de su lado (un atributo nuevo, un valor que pasa de nulo a "Unidad"). Pausar el catálogo
 * entero por un cambio de esquema sería mucho peor que el problema que el vigía viene a resolver.
 */
export const UMBRAL_PAUSA_MASIVA = 5;

const now = () => new Date().toISOString();

/**
 * Ruido de `catalog_product_id` (medido 2026-09-17: 30 de 46 eventos desde el 12/09 eran el campo apareciendo y
 * desapareciendo, y 19 volvían a un valor ya visto; MLA932429289 alternó 5 veces en 3 días). ML devuelve ese campo
 * de forma intermitente y a veces alterna entre dos productos. Decisión de José del 2026-09-17:
 *  - producto → vacío: se registra como historial y no pausa;
 *  - vuelta a un producto que la publicación ya tuvo en los últimos 7 días: se registra y no pausa;
 *  - vacío → producto NUEVO o salto a un producto nunca visto (el caso GP5000): pausa como siempre.
 * Los casos que no pausan se cierran solos (`revisado_por='vigia-auto'`): no quedan como aviso abierto ni frenan
 * al reactivador. UNITS_PER_PACK y SALE_FORMAT no cambian.
 */
export const VENTANA_OSCILACION_MS = 7 * 24 * 60 * 60 * 1000;
// Migración de ML (dominio reorganizado): mismo par viejo→nuevo en 2+ publicaciones dentro de esta ventana.
const VENTANA_MIGRACION_MS = 48 * 60 * 60 * 1000;
// Lecturas GET /products distintas por corrida: pocas; pasado el tope no se clasifica y se pausa como hoy.
const MAX_LECTURAS_PRODUCTOS = 10;
// Una publicación nueva nace sin producto de catálogo y ML se lo asigna minutos u horas después
// (caso FB-69577/FB-69580 del 2026-09-17): vacío → producto dentro de esta ventana desde el alta no pausa.
export const VENTANA_ALTA_RECIENTE_MS = 48 * 60 * 60 * 1000;

export function clasificarCambio(db, c, ahoraMs = Date.now()) {
  if (c.campo !== 'catalog_product_id') return 'real';
  if (c.valor_nuevo === null) return 'desaparece';
  const creadaMs = c.creada_en ? Date.parse(c.creada_en) : NaN;
  if (c.valor_anterior === null && Number.isFinite(creadaMs) && ahoraMs - creadaMs <= VENTANA_ALTA_RECIENTE_MS) return 'alta_reciente';
  const desde = new Date(ahoraMs - VENTANA_OSCILACION_MS).toISOString();
  const vistos = db.prepare(`SELECT 1 FROM ml_publicacion_cambios
    WHERE item_id = ? AND campo = 'catalog_product_id' AND detectado_en >= ?
      AND (valor_anterior = ? OR valor_nuevo = ?) LIMIT 1`).get(c.item_id, desde, c.valor_nuevo, c.valor_nuevo);
  return vistos ? 'oscila' : 'real';
}

export const MOTIVO_SIN_STOCK = 'sin stock en ML: se registra y queda bloqueado hasta revisión humana';

/** Sin stock: ya pausada por out_of_stock, o cantidad disponible 0, según el cache. */
export function esSinStock(db, itemId) {
  const cache = db.prepare('SELECT status, sub_status, available_quantity FROM ml_publicaciones_cache WHERE item_id=? LIMIT 1').get(itemId);
  const sub = Array.isArray(cache?.sub_status) ? cache.sub_status.join(',') : String(cache?.sub_status || '');
  return !!cache && ((cache.status === 'paused' && sub.includes('out_of_stock')) || cache.available_quantity === 0);
}

/** Pares viejo→nuevo de un lote, con los items que los traen (señal 2+ publicaciones del mismo par). */
export function parejasDeLote(lista) {
  const m = new Map();
  for (const c of lista) if (c.campo === 'catalog_product_id' && c.valor_anterior && c.valor_nuevo) {
    const k = `${c.valor_anterior}\u0000${c.valor_nuevo}`;
    m.set(k, (m.get(k) || new Set()).add(c.item_id));
  }
  return m;
}

/**
 * ¿Es este cambio de catalog_product_id una migración de ML? (a) mismo par en 2+ publicaciones en 48 h, (b) el producto
 * viejo da 404, (c) ambos productos actualizados hace ≤72 h y con minutos de diferencia. GETs cacheados en `cache`
 * (Map por corrida) con tope MAX_LECTURAS_PRODUCTOS; ante error/429/tope devuelve false (fail-closed: se pausa/queda abierto).
 */
export async function detectarMigracion(db, mlCfg, c, { parejasEnLote, cache }) {
  if (c.campo !== 'catalog_product_id' || !c.valor_anterior || !c.valor_nuevo) return false;
  const desde48h = new Date(Date.now() - VENTANA_MIGRACION_MS).toISOString();
  const repetidos = db.prepare(`SELECT COUNT(DISTINCT item_id) n FROM ml_publicacion_cambios
    WHERE campo='catalog_product_id' AND valor_anterior=? AND valor_nuevo=? AND item_id<>? AND detectado_en >= ?`).get(c.valor_anterior, c.valor_nuevo, c.item_id, desde48h).n;
  const pareja = parejasEnLote.get(`${c.valor_anterior}\u0000${c.valor_nuevo}`);
  if (repetidos >= 1 || pareja?.size >= 2) return true;
  const leer = async (id) => {
    if (cache.has(id)) return cache.get(id);
    if (cache.size >= MAX_LECTURAS_PRODUCTOS) return null;
    let r;
    try { r = await mlFetch(db, mlCfg, 'get', `/products/${id}`); } catch (e) { r = { error: e }; }
    cache.set(id, r);
    return r;
  };
  const viejo = await leer(c.valor_anterior);
  const nuevo = viejo?.status === 200 ? await leer(c.valor_nuevo) : null;
  const fecha = (x) => x?.data?.last_updated ? Date.parse(x.data.last_updated) : NaN;
  const ahora = Date.now();
  const reciente = (x) => ahora - fecha(x) >= -60e3 && ahora - fecha(x) <= 72 * 3600e3;
  const pairFresh = viejo?.status === 200 && nuevo?.status === 200 && Number.isFinite(fecha(viejo)) && Number.isFinite(fecha(nuevo))
    && reciente(viejo) && reciente(nuevo) && Math.abs(fecha(viejo) - fecha(nuevo)) <= 5 * 60e3;
  return viejo?.status === 404 || pairFresh;
}

function describir(c) {
  const antes = c.valor_anterior === null ? '(vacío)' : c.valor_anterior;
  const despues = c.valor_nuevo === null ? '(vacío)' : c.valor_nuevo;
  return `${c.sku || c.item_id}: ${c.campo} pasó de ${antes} a ${despues}`;
}

export async function procesarCambios(db, mlCfg, cambios, opts = {}) {
  const umbral = Number.isInteger(opts.umbral) ? opts.umbral : UMBRAL_PAUSA_MASIVA;
  const lista = cambios || [];
  if (!lista.length) return { detectados: 0, pausadas: 0, omitidos_por_umbral: 0, errores: 0 };

  const ts = now();
  // Se clasifica ANTES de insertar: la historia que decide si un valor ya se vio es la de corridas anteriores.
  const migracionCache = new Map();
  const parejasEnLote = parejasDeLote(lista);
  const clases = [];
  let migracionesSinPausa = 0;
  for (const c of lista) {
    let clase = clasificarCambio(db, c);
    if (clase === 'real' && c.campo === 'catalog_product_id' && c.valor_anterior && c.valor_nuevo) {
      if (await detectarMigracion(db, mlCfg, c, { parejasEnLote, cache: migracionCache })) clase = 'migracion';
    }
    clases.push(clase);
  }
  const insertar = db.prepare(`INSERT INTO ml_publicacion_cambios
    (clave, item_id, sku, campo, valor_anterior, valor_nuevo, pausada, pausa_error, detectado_en, revisado_en, revisado_por)
    VALUES (?,?,?,?,?,?,0,?,?,?,?)`);
  const todos = [];
  db.transaction(() => {
    lista.forEach((c, i) => {
      const ruido = clases[i] !== 'real' && clases[i] !== 'migracion';
      const motivo = clases[i] === 'migracion' ? 'migración de ML: no se pausa, revisar' : clases[i] === 'desaparece' ? 'ruido de ML: el campo desapareció, no se pausa'
        : clases[i] === 'oscila' ? 'ruido de ML: volvió a un valor ya visto en 7 días, no se pausa'
        : clases[i] === 'alta_reciente' ? 'publicación nueva: ML le asignó catálogo por primera vez, no se pausa' : null;
      const info = insertar.run(c.clave, c.item_id, c.sku || null, c.campo, c.valor_anterior, c.valor_nuevo,
        motivo, ts, ruido ? ts : null, ruido ? 'vigia-auto' : null);
      todos.push({ id: info.lastInsertRowid, real: !ruido && clases[i] !== 'migracion', migracion: clases[i] === 'migracion' });
    });
  })();
  const ignorados = todos.filter((t) => !t.real).length;
  const reales = lista.filter((_, i) => todos[i].real);
  const ids = todos.filter((t) => t.real).map((t) => t.id);
  migracionesSinPausa = todos.filter(t => t.migracion).length;
  if (!reales.length) return { detectados: lista.length, pausadas: 0, omitidos_por_umbral: 0, errores: 0, ignorados_por_ruido: ignorados, migraciones_sin_pausa: migracionesSinPausa };

  // Sin stock (ya pausada por out_of_stock o cantidad 0): se asienta y se autocierra, pero bloquea al reactivador
  // hasta que una persona lo revise. No cuenta para el umbral masivo: no se pausa nada.
  const estadoEnCache = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE item_id=? LIMIT 1");
  const todosItems = [...new Set(reales.map((c) => c.item_id))];
  const itemsSinStock = todosItems.filter((i) => esSinStock(db, i));
  let sinStock = 0;
  if (itemsSinStock.length) {
    const cerrar = db.prepare("UPDATE ml_publicacion_cambios SET revisado_en=?, revisado_por='vigia-auto', bloquea_reactivador=1, pausa_error=? WHERE id=?");
    db.transaction(() => {
      for (const itemId of itemsSinStock) {
        for (const [i, t] of todos.entries()) {
          if (t.real && lista[i].item_id === itemId) { cerrar.run(ts, MOTIVO_SIN_STOCK, t.id); sinStock += 1; }
        }
      }
    })();
  }

  // Un item puede tener dos campos cambiados: se pausa una sola vez.
  const items = todosItems.filter((i) => !itemsSinStock.includes(i));
  const excede = items.length > umbral;

  let pausadas = 0;
  let errores = 0;
  if (!excede) {
    const marcarOk = db.prepare('UPDATE ml_publicacion_cambios SET pausada=1 WHERE id=?');
    const marcarError = db.prepare('UPDATE ml_publicacion_cambios SET pausa_error=? WHERE id=?');
    for (const itemId of items) {
      const idsDelItem = todos.map((t, i) => t.real && lista[i].item_id === itemId ? t.id : null).filter(Boolean);
      let error = null;
      // Si ya está pausada —el caso de las 31 pausadas que este vigía viene a cubrir— no se
      // toca ML: el efecto deseado ya está, el cambio se asienta igual y el reactivador la
      // saltea por la fila sin revisar. Pedirle a ML que pause lo ya pausado sólo agrega una
      // llamada que puede fallar por una razón que no le importa a nadie.
      const yaPausada = estadoEnCache.get(itemId)?.status === 'paused';
      if (!yaPausada) {
        try {
          const r = await mlFetch(db, mlCfg, 'put', `/items/${itemId}`, { status: 'paused' });
          if (r.status < 200 || r.status >= 300) error = `ML respondió ${r.status}`;
        } catch (e) {
          error = e?.message || 'error desconocido';
        }
      }
      // Fail-open por publicación: si no se pudo pausar, el cambio queda asentado igual y el
      // aviso sale igual. Perder la detección por un fallo de escritura sería lo peor posible.
      if (error) { errores += 1; for (const id of idsDelItem) marcarError.run(error, id); }
      else { pausadas += idsDelItem.length; for (const id of idsDelItem) marcarOk.run(id); }
    }
  }

  const detalle = reales.slice(0, 10).map(describir).join('; ');
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre',
    proceso: 'vigia_formato',
    tipoError: 'datos',
    severidad: 'critico',
    mensajeTecnico: detalle,
    mensajeHumano: excede
      ? `${items.length} publicaciones cambiaron de formato en una sola corrida. No se pausó ninguna por seguridad: revisá si fue un cambio de MercadoLibre antes de tocar nada.`
      : `${items.length} publicación(es) cambiaron de formato: se pausaron las que se pudo (${pausadas} cambios pausados, ${errores} con error).${sinStock ? ` Sin stock, solo registrados: ${sinStock}.` : ''} ${detalle} Migraciones no pausadas: ${migracionesSinPausa}.`,
    contexto: { items: items.slice(0, 20), excede_umbral: excede, umbral, migraciones_sin_pausa: migracionesSinPausa },
  });

  return { detectados: lista.length, pausadas, sin_stock: sinStock, omitidos_por_umbral: excede ? reales.length : 0, errores, ignorados_por_ruido: ignorados, migraciones_sin_pausa: migracionesSinPausa };
}
