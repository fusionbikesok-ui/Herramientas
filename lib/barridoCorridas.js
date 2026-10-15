/**
 * Fase E-3: diferencias del barrido (métrica 3 de "Recuperación y medición").
 *
 * Cada corrida de un barrido (stock WC→ML, reconciliación de stock ML, refresco ML) deja una fila en `barrido_corridas` con
 * cuántas claves revisó, cuántas encontró distintas y cuántas de esas diferencias NO tuvieron evento ("sin evento"): una
 * clave tiene evento si en la ventana previa hubo un job cerrado (o aún abierto, que ya la tiene en cola) que la cubre —
 * `item.project` del ítem, `stock.bolsa` del SKU, `order.woo` cuyo pedido lo incluye o `catalog.woo_product_sync` del producto.
 * Si el barrido encuentra algo que ningún aviso trajo, ese aviso se perdió (o nunca existió): es la medida real de si los
 * webhooks cubren, y lo que decide en E-5 si una frecuencia puede bajar.
 *
 * Solo MIDE. En E-3 ninguna frecuencia cambia: la regla "umbral 2 días seguidos → el barrido vuelve a su frecuencia anterior"
 * se registra en `barrido_estado.revertir` y queda lista para que E-5 la lea con `frecuenciaBarridoRevertida`.
 */
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

const ahora = () => new Date().toISOString();

/** Ventana previa por barrido: cuánto hacia atrás se busca el job que debió cubrir la diferencia. */
export const VENTANA_SIN_EVENTO_MS = Object.freeze({
  wc_a_ml: 2 * 60 * 60 * 1000,
  reconciliacion_stock_ml: 6 * 60 * 60 * 1000, // una vuelta completa del cursor tarda ~3 h
  refresco_ml: 2 * 60 * 60 * 1000, // el llamador pasa `desde` = inicio del escaneo anterior cuando lo conoce
});
export const UMBRAL_SIN_EVENTO_DIA = () => Number(process.env.BARRIDO_UMBRAL_SIN_EVENTO_DIA ?? 5);

const itemDeClave = (clave) => String(clave).split('|')[0];

/**
 * ¿Qué claves NO tienen evento desde `desde`? `claves` = [{ clave, sku? }]. Devuelve el subconjunto sin evento.
 * Un job abierto (pendiente/tomado) cuenta como evento: el aviso llegó y está en cola.
 */
export function clavesSinEvento(db, claves, desde) {
  if (!claves.length) return [];
  const items = new Set();
  const skus = new Set();
  const productos = new Set();
  const ordenes = [];
  const filas = db.prepare(`SELECT tipo, recurso FROM trabajos_recurso
    WHERE tipo IN ('item.project', 'stock.bolsa', 'order.woo', 'catalog.woo_product_sync')
      AND (estado IN ('pendiente', 'tomado') OR (estado = 'hecho' AND cerrado_en >= ?))`).all(desde);
  for (const f of filas) {
    if (f.tipo === 'item.project') items.add(f.recurso);
    else if (f.tipo === 'stock.bolsa') skus.add(String(f.recurso).replace(/^sku:/, ''));
    else if (f.tipo === 'order.woo') ordenes.push(f.recurso);
    else productos.add(Number(f.recurso));
  }
  for (const id of ordenes) {
    try {
      const r = db.prepare('SELECT skus_json FROM woo_orden_skus WHERE order_id = ?').get(String(id));
      for (const s of JSON.parse(r?.skus_json || '[]')) skus.add(String(s));
    } catch { /* orden sin SKUs conocidos */ }
  }
  if (productos.size) {
    const marcas = [...productos].map(() => '?').join(',');
    for (const r of db.prepare(`SELECT DISTINCT sku FROM catalogo_cache WHERE sku IS NOT NULL AND sku <> '' AND (id_woo IN (${marcas}) OR id_padre IN (${marcas}))`).all(...productos, ...productos)) skus.add(r.sku);
  }
  return claves.filter((c) => !items.has(itemDeClave(c.clave)) && !(c.sku && skus.has(String(c.sku))));
}

/**
 * Registra una corrida. `claves` = las claves con diferencia ([{ clave, sku? }]); `diferencias` cuenta esas claves salvo que
 * se indique otra cosa. Nunca lanza: medir no puede tumbar el barrido que mide.
 * @returns {{diferencias:number, diferenciasSinEvento:number}|null}
 */
export function registrarCorrida(db, { proceso, inicio, fin = ahora(), revisados = 0, claves = [], diferencias = null, sinEvento: sinEventoDado = null, desde = null, error = null }) {
  try {
    const ventana = VENTANA_SIN_EVENTO_MS[proceso] ?? 2 * 60 * 60 * 1000;
    const limite = desde || new Date(new Date(inicio).getTime() - ventana).toISOString();
    const sinEvento = sinEventoDado ?? clavesSinEvento(db, claves, limite).length;
    const dif = diferencias ?? claves.length;
    db.prepare(`INSERT INTO barrido_corridas (proceso, inicio, fin, revisados, diferencias, diferencias_sin_evento, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(proceso, inicio, fin, revisados, dif, sinEvento, error ? String(error).slice(0, 300) : null);
    return { diferencias: dif, diferenciasSinEvento: sinEvento };
  } catch (e) {
    console.error('[barrido-corridas] no se pudo registrar la corrida:', e.message);
    return null;
  }
}

/** Resumen de las últimas `horas` por barrido. */
export function resumenBarridos(db, { horas = 24, ahoraMs = Date.now() } = {}) {
  const desde = new Date(ahoraMs - horas * 3600 * 1000).toISOString();
  return db.prepare(`SELECT proceso, COUNT(*) AS corridas, COALESCE(SUM(revisados), 0) AS revisados, COALESCE(SUM(diferencias), 0) AS diferencias,
      COALESCE(SUM(diferencias_sin_evento), 0) AS diferencias_sin_evento, COALESCE(SUM(error IS NOT NULL), 0) AS con_error
    FROM barrido_corridas WHERE fin >= ? GROUP BY proceso ORDER BY proceso`).all(desde);
}

/** ¿El barrido debe volver a su frecuencia anterior? (umbral superado 2 días seguidos). E-5 lo lee; E-3 no actúa. */
export function frecuenciaBarridoRevertida(db, proceso) {
  return Boolean(db.prepare('SELECT revertir FROM barrido_estado WHERE proceso = ?').get(proceso)?.revertir);
}

/**
 * Alerta diaria + regla del umbral. Una sola evaluación por día calendario (UTC): repetirla el mismo día no suma otro día.
 * El incidente es informativo si todo está bajo el umbral y de advertencia si algún barrido lo supera.
 */
export function evaluarBarridosDiario(db, { ahoraMs = Date.now(), umbral = UMBRAL_SIN_EVENTO_DIA() } = {}) {
  const hoy = new Date(ahoraMs).toISOString().slice(0, 10);
  const ayer = new Date(ahoraMs - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const resumen = resumenBarridos(db, { ahoraMs });
  const sobre = [];
  // Un barrido sin corridas hoy no cuenta como "sobre el umbral": corta la racha, no la deja congelada.
  const sinCorridas = db.prepare('SELECT proceso FROM barrido_estado').all().map((e) => e.proceso).filter((p) => !resumen.some((r) => r.proceso === p));
  for (const r of [...resumen, ...sinCorridas.map((proceso) => ({ proceso, diferencias_sin_evento: 0 }))]) {
    const estado = db.prepare('SELECT * FROM barrido_estado WHERE proceso = ?').get(r.proceso);
    const supera = r.diferencias_sin_evento > umbral;
    if (estado?.ultimo_dia !== hoy) {
      const dias = supera ? (estado?.ultimo_dia === ayer ? (estado.dias_sobre_umbral || 0) + 1 : 1) : 0;
      db.prepare(`INSERT INTO barrido_estado (proceso, dias_sobre_umbral, ultimo_dia, revertir, actualizado_en) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(proceso) DO UPDATE SET dias_sobre_umbral = excluded.dias_sobre_umbral, ultimo_dia = excluded.ultimo_dia,
          revertir = excluded.revertir, actualizado_en = excluded.actualizado_en`).run(r.proceso, dias, hoy, dias >= 2 ? 1 : 0, ahora());
    }
    if (supera) sobre.push(r.proceso);
  }
  const lineas = resumen.map((r) => `${r.proceso}: ${r.corridas} corrida(s), ${r.revisados} revisadas, ${r.diferencias} con diferencia, ${r.diferencias_sin_evento} sin evento${r.con_error ? `, ${r.con_error} con error` : ''}`);
  const texto = resumen.length
    ? `Barridos de las últimas 24 h (umbral sin evento: ${umbral}). ${lineas.join(' | ')}`
    : 'Ningún barrido registró corridas en las últimas 24 h.';
  const revertir = resumen.filter((r) => frecuenciaBarridoRevertida(db, r.proceso)).map((r) => r.proceso);
  abrirOActualizarIncidente(db, {
    integracion: 'sistema', proceso: 'barridos', tipoError: 'barrido_diario', severidad: sobre.length || !resumen.length ? 'advertencia' : 'info',
    mensajeTecnico: texto,
    mensajeHumano: `${texto}${revertir.length ? ` Superaron el umbral 2 días seguidos (volverían a su frecuencia anterior): ${revertir.join(', ')}.` : ''}`,
    contexto: { resumen, umbral, sobre_umbral: sobre, revertir },
  });
  if (!sobre.length && resumen.length) confirmarCicloSano(db, { integracion: 'sistema', proceso: 'barridos', tipoError: 'barrido_diario' });
  return { resumen, sobre, revertir };
}
