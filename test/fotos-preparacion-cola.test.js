import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDb } from '../db/index.js';
import { preparacionRouter, crearPreparacion } from '../routes/preparacion.js';
import { procesarColaFotos, reintentarFoto, _resetCandadoParaTests } from '../lib/fotosPreparacionCola.js';
import { rutaAbsoluta } from '../utils/storage.js';

const TEST_DB = './test/tmp-fotos-cola.sqlite';
const WORKER_OK = new URL('./fixtures/workerFakeOk.js', import.meta.url).pathname;
const WORKER_FAIL = new URL('./fixtures/workerFakeFail.js', import.meta.url).pathname;

let db;
let prepId;

function subirFotoDirecto({ url = '/uploads/preparacion/900/1-foto.jpg', esHeic = 0 } = {}) {
  // Simula lo que hace el endpoint (routes/preparacion.js): guarda el archivo "tal cual" y
  // deja la fila en estado_proceso='pendiente'. Escribimos el archivo real en disco porque
  // el worker (aunque sea el fake) recibe una ruta absoluta y algunos tests verifican los
  // efectos de estaDentroDeUploads sobre rutas reales.
  const abs = path.resolve(rutaAbsoluta(url));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from('original de prueba'));
  const r = db.prepare(`
    INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, nombre_archivo, creado_en, estado_proceso, es_heic)
    VALUES (?,NULL,'extra',?,?,?, 'pendiente', ?)
  `).run(prepId, url, path.basename(url), new Date().toISOString(), esHeic ? 1 : 0);
  return r.lastInsertRowid;
}

beforeEach(() => {
  db = openDb(TEST_DB);
  preparacionRouter(db, { woo: null, ml: null }); // side effect: ensureTables
  prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 900, numeroPedido: '900', comprador: 'Juan', items: [] });
  _resetCandadoParaTests();
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.rmSync('./uploads/preparacion/900', { recursive: true, force: true }); } catch {}
});

describe('procesarColaFotos', () => {
  it('procesa una foto pendiente: queda listo con url_liviana y sin error', async () => {
    const fotoId = subirFotoDirecto({ url: '/uploads/preparacion/900/1-a.jpg' });

    const r = await procesarColaFotos(db, { workerPath: WORKER_OK });

    expect(r).toEqual({ omitido: false, procesadas: 1, ok: 1, errores: 0 });
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    expect(foto.estado_proceso).toBe('listo');
    expect(foto.url_liviana).toBe('/uploads/preparacion/900/1-a-liviana.jpg');
    expect(foto.ultimo_error).toBeNull();
    expect(fs.existsSync(rutaAbsoluta(foto.url_liviana))).toBe(true);
  });

  it('no toca fotos que ya están en estado_proceso=listo', async () => {
    const fotoId = subirFotoDirecto({ url: '/uploads/preparacion/900/1-b.jpg' });
    db.prepare("UPDATE preparacion_fotos SET estado_proceso='listo' WHERE id=?").run(fotoId);

    const r = await procesarColaFotos(db, { workerPath: WORKER_OK });

    expect(r).toEqual({ omitido: false, procesadas: 0, ok: 0, errores: 0 });
  });

  it('backoff creciente (500/1500/4000ms) tras cada fallo, y estado_proceso=error al agotar los 3 intentos', async () => {
    const fotoId = subirFotoDirecto({ url: '/uploads/preparacion/900/1-c.jpg' });

    // Intento 1: falla → vuelve a 'pendiente' con backoff de 500ms.
    await procesarColaFotos(db, { workerPath: WORKER_FAIL });
    let foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    expect(foto.estado_proceso).toBe('pendiente');
    expect(foto.intentos).toBe(1);
    expect(foto.ultimo_error).toBe('fallo simulado de prueba');
    let esperaMs = new Date(foto.proximo_intento_en).getTime() - Date.now();
    expect(esperaMs).toBeGreaterThan(400); // ~500ms, con margen para el tiempo del test

    // Con el backoff todavía vigente, un segundo tick no la toca (no está "lista para intentar").
    let r = await procesarColaFotos(db, { workerPath: WORKER_FAIL });
    expect(r.procesadas).toBe(0);

    // Forzamos que el backoff ya venció (no queremos que el test dependa de sleeps reales) y
    // reintentamos: intento 2, backoff de 1500ms.
    db.prepare("UPDATE preparacion_fotos SET proximo_intento_en=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), fotoId);
    await procesarColaFotos(db, { workerPath: WORKER_FAIL });
    foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    expect(foto.estado_proceso).toBe('pendiente');
    expect(foto.intentos).toBe(2);
    esperaMs = new Date(foto.proximo_intento_en).getTime() - Date.now();
    expect(esperaMs).toBeGreaterThan(1400);

    // Intento 3 (el último, MAX_INTENTOS=3): agota los reintentos → estado_proceso='error',
    // visible, sin proximo_intento_en (no se reintenta sola nunca más).
    db.prepare("UPDATE preparacion_fotos SET proximo_intento_en=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), fotoId);
    await procesarColaFotos(db, { workerPath: WORKER_FAIL });
    foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    expect(foto.estado_proceso).toBe('error');
    expect(foto.intentos).toBe(3);
    expect(foto.proximo_intento_en).toBeNull();

    // Una foto en 'error' no vuelve a intentarse sola (no queda reintentándose para siempre).
    const rFinal = await procesarColaFotos(db, { workerPath: WORKER_FAIL });
    expect(rFinal.procesadas).toBe(0);
  });

  it('candado anti-reentrada: dos corridas superpuestas del mismo proceso, la segunda se omite', async () => {
    subirFotoDirecto({ url: '/uploads/preparacion/900/1-d.jpg' });

    const p1 = procesarColaFotos(db, { workerPath: WORKER_OK });
    const p2 = procesarColaFotos(db, { workerPath: WORKER_OK }); // arranca mientras p1 sigue en curso
    const [r1, r2] = await Promise.all([p1, p2]);

    // Una de las dos corridas hizo el trabajo real; la otra se omitió por el candado.
    const omitidas = [r1, r2].filter(r => r.omitido).length;
    expect(omitidas).toBe(1);
  });

  it('MAX_POR_TICK acota cuántas fotos procesa una sola corrida, dejando el resto pendiente', async () => {
    for (let i = 0; i < 12; i++) subirFotoDirecto({ url: `/uploads/preparacion/900/1-e${i}.jpg` });

    const r = await procesarColaFotos(db, { workerPath: WORKER_OK });

    expect(r.procesadas).toBe(10); // MAX_POR_TICK
    const pendientes = db.prepare("SELECT COUNT(*) n FROM preparacion_fotos WHERE estado_proceso='pendiente'").get().n;
    expect(pendientes).toBe(2);
  });

  it('defensa en profundidad: una url manipulada fuera de uploads/ no se procesa y queda en error sin tocar el filesystem', async () => {
    const fotoId = db.prepare(`
      INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, nombre_archivo, creado_en, estado_proceso, es_heic)
      VALUES (?,NULL,'extra','/etc/passwd','x',?, 'pendiente', 0)
    `).run(prepId, new Date().toISOString()).lastInsertRowid;

    const r = await procesarColaFotos(db, { workerPath: WORKER_OK });

    expect(r.errores).toBe(1);
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    // Con MAX_INTENTOS=1 efectivo acá (mismo contador que cualquier otro fallo): intento 1 de 3.
    expect(foto.estado_proceso).toBe('pendiente');
    expect(foto.ultimo_error).toMatch(/fuera de uploads/);
  });
});

describe('reintentarFoto', () => {
  it('resetea una foto en error a pendiente con intentos=0', async () => {
    const fotoId = subirFotoDirecto({ url: '/uploads/preparacion/900/1-f.jpg' });
    db.prepare("UPDATE preparacion_fotos SET estado_proceso='error', intentos=3, ultimo_error='x' WHERE id=?").run(fotoId);

    const ok = reintentarFoto(db, fotoId);

    expect(ok).toBe(true);
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
    expect(foto.estado_proceso).toBe('pendiente');
    expect(foto.intentos).toBe(0);
    expect(foto.ultimo_error).toBeNull();
  });

  it('no hace nada si la foto NO está en estado de error (evita "reintentar" algo que ya está listo o en curso)', () => {
    const fotoId = subirFotoDirecto({ url: '/uploads/preparacion/900/1-g.jpg' });
    db.prepare("UPDATE preparacion_fotos SET estado_proceso='listo' WHERE id=?").run(fotoId);

    const ok = reintentarFoto(db, fotoId);

    expect(ok).toBe(false);
    expect(db.prepare('SELECT estado_proceso FROM preparacion_fotos WHERE id=?').get(fotoId).estado_proceso).toBe('listo');
  });
});
