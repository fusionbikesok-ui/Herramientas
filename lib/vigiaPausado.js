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
  const insertar = db.prepare(`INSERT INTO ml_publicacion_cambios
    (clave, item_id, sku, campo, valor_anterior, valor_nuevo, pausada, pausa_error, detectado_en)
    VALUES (?,?,?,?,?,?,0,NULL,?)`);
  const ids = [];
  db.transaction(() => {
    for (const c of lista) {
      const info = insertar.run(c.clave, c.item_id, c.sku || null, c.campo, c.valor_anterior, c.valor_nuevo, ts);
      ids.push(info.lastInsertRowid);
    }
  })();

  // Un item puede tener dos campos cambiados: se pausa una sola vez.
  const items = [...new Set(lista.map((c) => c.item_id))];
  const excede = items.length > umbral;

  let pausadas = 0;
  let errores = 0;
  if (!excede) {
    const marcarOk = db.prepare('UPDATE ml_publicacion_cambios SET pausada=1 WHERE id=?');
    const marcarError = db.prepare('UPDATE ml_publicacion_cambios SET pausa_error=? WHERE id=?');
    const estadoEnCache = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE item_id=? LIMIT 1");
    for (const itemId of items) {
      const idsDelItem = ids.filter((_, i) => lista[i].item_id === itemId);
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

  const detalle = lista.slice(0, 10).map(describir).join('; ');
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

  return { detectados: lista.length, pausadas, omitidos_por_umbral: excede ? lista.length : 0, errores };
}
