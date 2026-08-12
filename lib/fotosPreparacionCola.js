// Cola de procesamiento de fotos de preparación (plan 2026-08-12-fotos-preparacion.md).
//
// El request de subida (routes/preparacion.js, POST /:id/foto) guarda el archivo TAL COMO
// LLEGÓ y responde al instante — no hace ninguna conversión sincrónica. Este módulo procesa
// esas fotos "pendiente" en segundo plano: decodifica HEIC si hace falta, rota por EXIF y
// genera una versión liviana, todo corriendo en un worker thread (lib/workers/
// procesarFotoWorker.js) para que el hilo principal de Express nunca se bloquee — heic-convert
// es JS puro y bloquea 3-7s por foto (medido en el VPS, ver el plan).
//
// Original vs. liviana: el original (columna `url`) es el archivo tal cual subido, NUNCA se
// toca ni se borra — el usuario lo necesita para detalle fino. `url_liviana` es la versión
// procesada que llena la cola; hasta que esté lista, el frontend puede seguir mostrando el
// original (ya guardado y accesible por HTTP desde el instante de la subida).
//
// Reintentos acotados con backoff CRECIENTE (regla del repo: nunca loop inmediato) — ver
// BACKOFF_MS. Agotados los intentos, la foto queda en estado_proceso='error': VISIBLE (nunca
// desaparece, nunca se reintenta para siempre) y reintentable a mano vía reintentarFoto().
//
// Candado anti-reentrada en memoria (_procesandoEnCurso), mismo patrón que _wcToMlEnCurso /
// _refrescarCatalogoEnCurso — no cubre dos procesos node distintos contra la misma base (ningún
// candado en memoria lo cubre); por eso tomarSiguiente() además hace un UPDATE...WHERE
// condicionado (compare-and-swap a nivel fila) antes de procesar: si dos procesos compitieran
// por la misma foto, el segundo UPDATE no matchea (la fila ya no está en 'pendiente') y esa
// corrida la salta sin duplicar trabajo.
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { rutaAbsoluta, estaDentroDeUploads } from '../utils/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH_DEFAULT = path.join(__dirname, 'workers', 'procesarFotoWorker.js');

// Backoff creciente entre reintentos (regla del repo: 500/1500/4000ms, nunca loop inmediato).
// 3 intentos: si el problema es transitorio (ej. el disco estaba ocupado escribiendo otra
// foto), una de las 3 pasadas lo resuelve; si es estructural (archivo corrupto, formato que
// heic-convert no soporta), no tiene sentido seguir intentando para siempre.
const BACKOFF_MS = [500, 1500, 4000];
const MAX_INTENTOS = BACKOFF_MS.length;

// Tope de fotos procesadas por corrida de la cola: evita que un backlog grande (ej. tras un
// reinicio con muchas fotos pendientes) monopolice el proceso — el resto queda para la
// corrida siguiente (cron cada 1 min, ver server.js, más el disparo inmediato tras cada subida).
const MAX_POR_TICK = 10;

// Tope de tiempo por foto individual dentro del worker: si heic-convert se cuelga (no debería,
// pero es JS de terceros sobre un WASM) no puede dejar la cola entera trabada esperando para
// siempre — se corta, se cuenta como fallo de ESA foto (con su propio backoff) y la cola sigue
// con las demás.
const TIMEOUT_WORKER_MS = 30000;

const now = () => new Date().toISOString();

let _procesandoEnCurso = false;

// Deriva la URL de la liviana a partir de la del original, reemplazando la extensión.
// Ej: /uploads/preparacion/900/123-foto.HEIC → /uploads/preparacion/900/123-foto-liviana.jpg
function urlLivianaDe(urlOriginal) {
  return urlOriginal.replace(/\.[^./]+$/, '') + '-liviana.jpg';
}

// Toma la próxima foto pendiente y lista para intentar (fuera de backoff), marcándola
// 'procesando' con un UPDATE condicionado (ver comentario de arriba). Devuelve:
//  - null: no hay ninguna pendiente lista → cortar el loop del tick.
//  - undefined: había una candidata pero otro proceso/tick se la ganó → seguir probando.
//  - la fila: la tomamos nosotros, a procesar.
function tomarSiguiente(db) {
  const candidata = db.prepare(`
    SELECT * FROM preparacion_fotos
    WHERE estado_proceso='pendiente' AND (proximo_intento_en IS NULL OR proximo_intento_en <= ?)
    ORDER BY id ASC LIMIT 1
  `).get(now());
  if (!candidata) return null;
  const r = db.prepare(`UPDATE preparacion_fotos SET estado_proceso='procesando' WHERE id=? AND estado_proceso='pendiente'`)
    .run(candidata.id);
  return r.changes === 1 ? candidata : undefined;
}

function ejecutarEnWorker(workerPath, datos) {
  return new Promise((resolve, reject) => {
    let worker;
    const timeout = setTimeout(() => {
      if (worker) worker.terminate();
      reject(new Error(`timeout procesando la foto (worker > ${TIMEOUT_WORKER_MS}ms)`));
    }, TIMEOUT_WORKER_MS);
    try {
      worker = new Worker(workerPath, { workerData: datos });
    } catch (e) {
      clearTimeout(timeout);
      reject(e);
      return;
    }
    worker.once('message', (msg) => { clearTimeout(timeout); resolve(msg); worker.terminate(); });
    worker.once('error', (err) => { clearTimeout(timeout); reject(err); });
    worker.once('exit', (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error(`worker terminó con código ${code}`)); }
    });
  });
}

function registrarResultado(db, foto, resultado, urlLiviana) {
  if (resultado.ok) {
    db.prepare(`
      UPDATE preparacion_fotos
      SET estado_proceso='listo', url_liviana=?, procesado_en=?, ultimo_error=NULL, proximo_intento_en=NULL
      WHERE id=?
    `).run(urlLiviana, now(), foto.id);
    return;
  }
  const intentos = (foto.intentos || 0) + 1;
  // Truncado: es un mensaje de error de librería, no contenido del archivo, pero por las
  // dudas no lo dejamos crecer sin límite en la base.
  const msg = String(resultado.error || 'error desconocido').slice(0, 500);
  if (intentos >= MAX_INTENTOS) {
    db.prepare(`
      UPDATE preparacion_fotos SET estado_proceso='error', intentos=?, ultimo_error=?, proximo_intento_en=NULL WHERE id=?
    `).run(intentos, msg, foto.id);
    console.error(`[preparacion] foto ${foto.id} quedó en estado 'error' tras ${intentos} intentos:`, msg);
  } else {
    const proximo = new Date(Date.now() + BACKOFF_MS[intentos - 1]).toISOString();
    db.prepare(`
      UPDATE preparacion_fotos SET estado_proceso='pendiente', intentos=?, ultimo_error=?, proximo_intento_en=? WHERE id=?
    `).run(intentos, msg, proximo, foto.id);
  }
}

/**
 * Procesa hasta MAX_POR_TICK fotos pendientes. Anti-solape: si ya hay una corrida en curso
 * (mismo proceso), se omite devolviendo { omitido: true } — el disparo inmediato tras cada
 * subida y el cron de barrido (server.js) pueden superponerse en el tiempo sin problema.
 *
 * opts.workerPath: solo para tests (inyecta un worker de prueba en vez del real, que hace
 * heic-convert+sharp de verdad y sería lento/pesado de fixturar en cada test).
 */
export async function procesarColaFotos(db, opts = {}) {
  const workerPath = opts.workerPath || WORKER_PATH_DEFAULT;
  if (_procesandoEnCurso) return { omitido: true };
  _procesandoEnCurso = true;
  let procesadas = 0, ok = 0, errores = 0;
  try {
    for (let i = 0; i < MAX_POR_TICK; i++) {
      const foto = tomarSiguiente(db);
      if (foto === null) break;
      if (foto === undefined) continue; // perdió la carrera con otro proceso: probar la siguiente

      procesadas++;
      const abs = path.resolve(rutaAbsoluta(foto.url));
      const urlLiviana = urlLivianaDe(foto.url);
      const absLiviana = path.resolve(rutaAbsoluta(urlLiviana));
      // Defensa en profundidad (mismo criterio que purgarFotosBorradas): si por lo que sea la
      // ruta calculada cae fuera de uploads/, no tocamos el filesystem. No debería poder pasar
      // (url ya sale saneada de guardarArchivo) pero el costo de chequearlo acá es nulo.
      if (!estaDentroDeUploads(abs) || !estaDentroDeUploads(absLiviana)) {
        registrarResultado(db, foto, { ok: false, error: 'ruta fuera de uploads/, se omite por seguridad' }, null);
        errores++;
        continue;
      }
      try {
        const resultado = await ejecutarEnWorker(workerPath, {
          rutaEntrada: abs, rutaSalida: absLiviana, esHeic: !!foto.es_heic,
        });
        if (resultado.ok) ok++; else errores++;
        registrarResultado(db, foto, resultado, urlLiviana);
      } catch (e) {
        errores++;
        registrarResultado(db, foto, { ok: false, error: e.message }, null);
      }
    }
  } finally {
    _procesandoEnCurso = false;
  }
  return { omitido: false, procesadas, ok, errores };
}

/**
 * Reintento manual: solo tiene efecto sobre una foto en estado_proceso='error' (agotó sus
 * reintentos automáticos). La devuelve a 'pendiente' con el contador en 0 — si el problema fue
 * transitorio (ver la pregunta abierta del plan: no se pudo reproducir la causa exacta de
 * heic-convert con las muestras disponibles) esto le da otra chance completa de 3 intentos.
 * Devuelve true si encontró y reseteó la fila, false si no (ya no está en error, o no existe).
 */
export function reintentarFoto(db, fotoId) {
  const r = db.prepare(`
    UPDATE preparacion_fotos
    SET estado_proceso='pendiente', intentos=0, ultimo_error=NULL, proximo_intento_en=NULL
    WHERE id=? AND estado_proceso='error'
  `).run(fotoId);
  return r.changes === 1;
}

/** Solo para tests: fuerza el candado a false entre casos si un test anterior quedó a mitad. */
export function _resetCandadoParaTests() {
  _procesandoEnCurso = false;
}
