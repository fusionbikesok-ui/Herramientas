// Etiquetas en Preparación (spec 2026-10-15, A + v3–v14): foto con etiqueta por su propio endpoint, marca durable, reemplazo diferido,
// carrera borrado/procesado, guarda de «Completar envío» y claim sobre preparaciones cerradas.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { preparacionRouter, crearPreparacion } from '../routes/preparacion.js';
import { procesarColaFotos, _resetCandadoParaTests } from '../lib/fotosPreparacionCola.js';
import { requisitosPaquete } from '../lib/preparacion.js';
import { wooFetch } from '../routes/woo.js';
import { rutaAbsoluta } from '../utils/storage.js';

vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});

const TEST_DB = `./test/tmp-etiquetas-foto.${process.pid}.sqlite`;
const WORKER_OK = new URL('./fixtures/workerFakeOk.js', import.meta.url).pathname;
const WORKER_FAIL = new URL('./fixtures/workerFakeFail.js', import.meta.url).pathname;
const limpiar = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
let db;

const CFG = { woo: { url: 'https://x.test' }, ml: null, andreaniStatus: 'lpaandreani', enviadoAndreaniStatus: 'enviadoandreani', colaFotos: { disparoInmediato: false } };
function appComo(usuario, admin = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: admin ? 1 : 0, permisos: [{ herramienta: 'preparacion', nivel: 'write' }] }; next(); });
  app.use('/api/preparacion', preparacionRouter(db, CFG));
  return app;
}
const subirEtiqueta = (app, id, nombre = 'e.jpg') => request(app).post(`/api/preparacion/${id}/foto-etiqueta`).attach('archivo', Buffer.from(nombre + Math.random()), nombre);
const prepRow = (id) => db.prepare('SELECT * FROM preparaciones WHERE id=?').get(id);
const nueva = (wc, estado = 'completada') => {
  const id = crearPreparacion(db, { canal: 'web', wcOrderId: wc, numeroPedido: String(wc), comprador: 'Ana', items: [] });
  db.prepare('UPDATE preparaciones SET estado=?, completado_en=? WHERE id=?').run(estado, new Date().toISOString(), id);
  return id;
};
const tomar = (id, usuario) => db.prepare('INSERT OR REPLACE INTO preparacion_claims (preparacion_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)')
  .run(id, usuario, new Date().toISOString(), new Date(Date.now() + 600000).toISOString(), new Date().toISOString());

beforeEach(() => {
  limpiar(); db = openDb(TEST_DB); preparacionRouter(db, CFG); _resetCandadoParaTests(); wooFetch.mockReset();
});
afterEach(() => { db.close(); limpiar(); try { fs.rmSync('./uploads/preparacion', { recursive: true, force: true }); } catch { /* best effort */ } });

describe('requisitos del paquete', () => {
  it('«paquete_cerrado» ya no menciona la etiqueta y paquete_etiquetado no es requisito', () => {
    const r = requisitosPaquete();
    expect(r.map((x) => x.tipos[0])).toEqual(['paquete_abierto', 'paquete_cerrado']);
    expect(r[1].etiqueta).toBe('Paquete ya cerrado');
  });
});

describe('POST /:id/foto-etiqueta', () => {
  it('sobre una preparación completada: sin claim, queda pendiente y al procesarse carga la marca durable con origen foto', async () => {
    const id = nueva(5001);
    const r = await subirEtiqueta(appComo('operario'), id);
    expect(r.status).toBe(200);
    expect(r.body.foto.tipo).toBe('paquete_etiquetado');
    expect(prepRow(id).etiqueta_cargada_en).toBeNull();           // todavía pendiente: no cuenta
    await procesarColaFotos(db, { workerPath: WORKER_OK });
    expect(prepRow(id).etiqueta_cargada_en).toBeTruthy();
    expect(prepRow(id).etiqueta_origen).toBe('foto');
    const ev = db.prepare("SELECT usuario FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_etiqueta_agregada'").get(id);
    expect(ev.usuario).toBe('operario');
  });

  it('abierta: exige claim (otro operario la tiene → 409), incluso en pendiente_deposito', async () => {
    const a = nueva(5002, 'en_preparacion'); tomar(a, 'otro');
    const b = nueva(5003, 'pendiente_deposito'); tomar(b, 'otro');
    expect((await subirEtiqueta(appComo('operario'), a)).status).toBe(409);
    expect((await subirEtiqueta(appComo('operario'), b)).status).toBe(409);
    tomar(a, 'operario');
    expect((await subirEtiqueta(appComo('operario'), a)).status).toBe(200);
  });

  it('un estado bloqueado (anulado en Woo) no admite la foto', async () => {
    const id = nueva(5004, 'anulado_en_woo'); tomar(id, 'operario');
    expect((await subirEtiqueta(appComo('operario', true), id)).status).toBeGreaterThanOrEqual(400);
  });

  it('POST /:id/foto rechaza tipo paquete_etiquetado con USAR_FOTO_ETIQUETA', async () => {
    const id = nueva(5005, 'en_preparacion'); tomar(id, 'operario');
    const r = await request(appComo('operario')).post(`/api/preparacion/${id}/foto`).field('tipo', 'paquete_etiquetado').attach('archivo', Buffer.from('x'), 'a.jpg');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('USAR_FOTO_ETIQUETA');
    expect(db.prepare('SELECT COUNT(*) n FROM preparacion_fotos WHERE preparacion_id=?').get(id).n).toBe(0);
  });

  it('el reemplazo es diferido: la anterior sigue vigente hasta que la nueva llega a listo; si la nueva da error, la anterior sigue', async () => {
    const id = nueva(5006);
    const app = appComo('operario');
    await subirEtiqueta(app, id, 'uno.jpg');
    await procesarColaFotos(db, { workerPath: WORKER_OK });
    const primera = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').get(id);
    await subirEtiqueta(app, id, 'dos.jpg');
    expect(db.prepare('SELECT borrado_en FROM preparacion_fotos WHERE id=?').get(primera.id).borrado_en).toBeNull();
    for (let i = 0; i < 4; i++) {
      db.prepare("UPDATE preparacion_fotos SET proximo_intento_en=NULL WHERE estado_proceso='pendiente'").run();
      await procesarColaFotos(db, { workerPath: WORKER_FAIL });
    }
    expect(db.prepare("SELECT estado_proceso FROM preparacion_fotos WHERE id<>?").get(primera.id).estado_proceso).toBe('error');
    expect(db.prepare('SELECT borrado_en FROM preparacion_fotos WHERE id=?').get(primera.id).borrado_en).toBeNull();
    expect(prepRow(id).etiqueta_cargada_en).toBeTruthy();
    // y si la nueva sí termina, la anterior pasa a no vigente
    const segunda = db.prepare('SELECT id FROM preparacion_fotos WHERE id<>?').get(primera.id).id;
    await request(app).post(`/api/preparacion/${id}/foto/${segunda}/reintentar`);
    await procesarColaFotos(db, { workerPath: WORKER_OK });
    expect(db.prepare('SELECT borrado_en FROM preparacion_fotos WHERE id=?').get(primera.id).borrado_en).toBeTruthy();
    expect(db.prepare('SELECT borrado_en FROM preparacion_fotos WHERE id=?').get(segunda).borrado_en).toBeNull();
  });

  it('reintento manual sobre completada: solo fotos de etiqueta y sin claim', async () => {
    const id = nueva(5007);
    const app = appComo('operario');
    await subirEtiqueta(app, id);
    for (let i = 0; i < 4; i++) { db.prepare("UPDATE preparacion_fotos SET proximo_intento_en=NULL WHERE estado_proceso='pendiente'").run(); await procesarColaFotos(db, { workerPath: WORKER_FAIL }); }
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').get(id);
    expect(foto.estado_proceso).toBe('error');
    expect((await request(app).post(`/api/preparacion/${id}/foto/${foto.id}/reintentar`)).status).toBe(200);
    // una foto que NO es de etiqueta sobre completada sigue exigiendo claim/estado
    db.prepare("INSERT INTO preparacion_fotos (preparacion_id, tipo, url, creado_en, estado_proceso) VALUES (?, 'extra', '/uploads/x.jpg', ?, 'error')").run(id, new Date().toISOString());
    const otra = db.prepare("SELECT id FROM preparacion_fotos WHERE tipo='extra'").get().id;
    expect((await request(app).post(`/api/preparacion/${id}/foto/${otra}/reintentar`)).status).not.toBe(200);
  });

  it('GET /fotos/:id/estado informa el procesamiento', async () => {
    const id = nueva(5008);
    const app = appComo('operario');
    const f = (await subirEtiqueta(app, id)).body.foto;
    expect((await request(app).get(`/api/preparacion/fotos/${f.id}/estado`)).body.foto.estado_proceso).toBe('pendiente');
    await procesarColaFotos(db, { workerPath: WORKER_OK });
    expect((await request(app).get(`/api/preparacion/fotos/${f.id}/estado`)).body.foto.estado_proceso).toBe('listo');
  });
});

describe('borrado y carrera con la cola', () => {
  it('subir → listo → borrar (preparación abierta) → la marca vuelve a NULL', async () => {
    const id = nueva(5010, 'en_preparacion'); tomar(id, 'operario');
    const app = appComo('operario');
    const f = (await subirEtiqueta(app, id)).body.foto;
    await procesarColaFotos(db, { workerPath: WORKER_OK });
    expect(prepRow(id).etiqueta_cargada_en).toBeTruthy();
    expect((await request(app).delete(`/api/preparacion/${id}/foto/${f.id}`)).status).toBe(200);
    expect(prepRow(id).etiqueta_cargada_en).toBeNull();
    expect(prepRow(id).etiqueta_origen).toBeNull();
  });

  it('foto tomada por la cola y borrada mientras se procesa: no resucita, la marca queda NULL y no quedan archivos huérfanos', async () => {
    const id = nueva(5011, 'en_preparacion'); tomar(id, 'operario');
    const app = appComo('operario');
    const f = (await subirEtiqueta(app, id)).body.foto;
    const original = rutaAbsoluta(f.url);
    expect(fs.existsSync(original)).toBe(true);
    // la foto se borra "en el medio": justo cuando el worker termina (se simula borrándola antes de que la cola registre el resultado)
    db.prepare("UPDATE preparacion_fotos SET borrado_en=? WHERE id=?").run(new Date().toISOString(), f.id);
    await procesarColaFotos(db, { workerPath: WORKER_OK });
    const fila = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(f.id);
    expect(fila.borrado_en).toBeTruthy();
    expect(fila.estado_proceso).not.toBe('listo');
    expect(prepRow(id).etiqueta_cargada_en).toBeNull();
    expect(fs.existsSync(original)).toBe(false);
    expect(db.prepare("SELECT 1 FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_procesada_tras_borrado'").get(id)).toBeTruthy();
  });
});

describe('guarda de «Completar envío» (POST /seguimientos/:wcOrderId)', () => {
  const orden = (status = 'lpaandreani') => ({ data: { id: 1, number: '1', status, meta_data: [], billing: { first_name: 'A', last_name: 'B' }, shipping: { city: 'X' }, line_items: [] } });
  const callsPut = () => wooFetch.mock.calls.filter((c) => c[2] === 'put');

  it('completada sin etiqueta → 409 FOTO_ETIQUETA_REQUERIDA, sin efectos (ni PUT, ni intención, ni EN_CURSO)', async () => {
    const id = nueva(6001);
    wooFetch.mockResolvedValue(orden());
    const r = await request(appComo('operario')).post('/api/preparacion/seguimientos/6001').send({ tracking: 'AND6001' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('FOTO_ETIQUETA_REQUERIDA');
    expect(callsPut()).toHaveLength(0);
    expect(wooFetch).not.toHaveBeenCalled();
    expect(prepRow(id).woo_paso2_pendiente).toBe(0);
    expect(prepRow(id).tracking).toBeNull();
    // el pedido no quedó trabado en EN_CURSO: tras subir la foto el mismo request avanza
    db.prepare("UPDATE preparaciones SET etiqueta_cargada_en=?, etiqueta_origen='foto' WHERE id=?").run(new Date().toISOString(), id);
    wooFetch.mockResolvedValue(orden());
    const ok = await request(appComo('operario')).post('/api/preparacion/seguimientos/6001').send({ tracking: 'AND6001' });
    expect(ok.status).toBe(200);
  });

  it('con la foto todavía procesándose → 409 FOTO_ETIQUETA_PROCESANDO; una foto en error no cuenta', async () => {
    const id = nueva(6002);
    db.prepare("INSERT INTO preparacion_fotos (preparacion_id, tipo, url, creado_en, estado_proceso) VALUES (?, 'paquete_etiquetado', '/uploads/x.jpg', ?, 'pendiente')").run(id, new Date().toISOString());
    let r = await request(appComo('operario')).post('/api/preparacion/seguimientos/6002').send({ tracking: 'AND6002' });
    expect(r.body.code).toBe('FOTO_ETIQUETA_PROCESANDO');
    db.prepare("UPDATE preparacion_fotos SET estado_proceso='error'").run();
    r = await request(appComo('operario')).post('/api/preparacion/seguimientos/6002').send({ tracking: 'AND6002' });
    expect(r.body.code).toBe('FOTO_ETIQUETA_REQUERIDA');
  });

  it('no se aplica a filas mínimas, a pedidos sin fila ni a recuperaciones con intención registrada', async () => {
    const minima = nueva(6003, 'en_preparacion');
    const incierta = nueva(6004); db.prepare('UPDATE preparaciones SET woo_paso1_incierto=1, woo_paso2_pendiente=1, tracking=? WHERE id=?').run('AND6004', incierta);
    const pendiente2 = nueva(6005); db.prepare('UPDATE preparaciones SET woo_paso2_pendiente=1, tracking=? WHERE id=?').run('AND6005', pendiente2);
    const { guardaFotoEtiquetaSeguimiento } = await import('../routes/preparacion.js');
    expect(guardaFotoEtiquetaSeguimiento(db, 6003)).toBeNull();
    expect(guardaFotoEtiquetaSeguimiento(db, 999999)).toBeNull();
    expect(guardaFotoEtiquetaSeguimiento(db, 6004)).toBeNull();
    expect(guardaFotoEtiquetaSeguimiento(db, 6005)).toBeNull();
    expect(minima).toBeTruthy();
  });

  it('claim: un operario NO admin carga el tracking sobre una completada horas después del cierre; sobre una abierta tomada por otro no puede (incluye pendiente_deposito)', async () => {
    const cerrada = nueva(6006); db.prepare("UPDATE preparaciones SET etiqueta_cargada_en=?, etiqueta_origen='sin_foto' WHERE id=?").run(new Date().toISOString(), cerrada);
    wooFetch.mockResolvedValue(orden());
    expect((await request(appComo('operario')).post('/api/preparacion/seguimientos/6006').send({ tracking: 'AND6006' })).status).toBe(200);
    for (const [wc, estado] of [[6007, 'en_preparacion'], [6008, 'pendiente_deposito']]) {
      const id = nueva(wc, estado); tomar(id, 'otro');
      wooFetch.mockResolvedValue(orden());
      const r = await request(appComo('operario')).post(`/api/preparacion/seguimientos/${wc}`).send({ tracking: `AND${wc}` });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PREPARATION_CLAIMED');
    }
  });
});
