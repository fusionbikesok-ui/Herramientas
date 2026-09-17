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
  const clases = lista.map((c) => clasificarCambio(db, c));
  const insertar = db.prepare(`INSERT INTO ml_publicacion_cambios
    (clave, item_id, sku, campo, valor_anterior, valor_nuevo, pausada, pausa_error, detectado_en, revisado_en, revisado_por)
    VALUES (?,?,?,?,?,?,0,?,?,?,?)`);
  const todos = [];
  db.transaction(() => {
    lista.forEach((c, i) => {
      const ruido = clases[i] !== 'real';
      const motivo = clases[i] === 'desaparece' ? 'ruido de ML: el campo desapareció, no se pausa'
        : clases[i] === 'oscila' ? 'ruido de ML: volvió a un valor ya visto en 7 días, no se pausa'
        : clases[i] === 'alta_reciente' ? 'publicación nueva: ML le asignó catálogo por primera vez, no se pausa' : null;
      const info = insertar.run(c.clave, c.item_id, c.sku || null, c.campo, c.valor_anterior, c.valor_nuevo,
        motivo, ts, ruido ? ts : null, ruido ? 'vigia-auto' : null);
      todos.push({ id: info.lastInsertRowid, real: !ruido });
    });
  })();
  const ignorados = todos.filter((t) => !t.real).length;
  const reales = lista.filter((_, i) => todos[i].real);
  const ids = todos.filter((t) => t.real).map((t) => t.id);
  if (!reales.length) return { detectados: lista.length, pausadas: 0, omitidos_por_umbral: 0, errores: 0, ignorados_por_ruido: ignorados };

  // Un item puede tener dos campos cambiados: se pausa una sola vez.
  const items = [...new Set(reales.map((c) => c.item_id))];
  const excede = items.length > umbral;

  let pausadas = 0;
  let errores = 0;
  if (!excede) {
    const marcarOk = db.prepare('UPDATE ml_publicacion_cambios SET pausada=1 WHERE id=?');
    const marcarError = db.prepare('UPDATE ml_publicacion_cambios SET pausa_error=? WHERE id=?');
    const estadoEnCache = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE item_id=? LIMIT 1");
    for (const itemId of items) {
      const idsDelItem = ids.filter((_, i) => reales[i].item_id === itemId);
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
      : `${items.length} publicación(es) cambiaron de formato y se pausaron. ${detalle}`,
    contexto: { items: items.slice(0, 20), excede_umbral: excede, umbral },
  });

  return { detectados: lista.length, pausadas, omitidos_por_umbral: excede ? reales.length : 0, errores, ignorados_por_ruido: ignorados };
}
