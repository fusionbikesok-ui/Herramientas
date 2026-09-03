import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { etiquetasRouter } from '../routes/etiquetas.js';

const TEST_DB = './test/tmp-etiquetas.sqlite';

function buildApp(db, usuario = 'jose') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0 }; next(); });
  app.use('/api/etiquetas', etiquetasRouter(db));
  return app;
}

afterEach(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
});

describe('etiquetas cola', () => {
  it('rechaza alta sin sku', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const res = await request(app).post('/api/etiquetas/cola').send({ cantidad: 2 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rechaza alta con cantidad inválida', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const res = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-1', cantidad: 0 });
    expect(res.status).toBe(400);
  });

  it('agrega un ítem y lo lista como pendiente', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola')
      .send({ sku: 'FB-1', cantidad: 3, origen: 'conteo', sesion_id: 7 });
    expect(alta.status).toBe(200);
    expect(alta.body.item.sku).toBe('FB-1');
    expect(alta.body.item.estado).toBe('pendiente');
    expect(alta.body.item.solicitado_por).toBe('jose');

    const lista = await request(app).get('/api/etiquetas/cola?estado=pendiente');
    expect(lista.body.cola).toHaveLength(1);
    expect(lista.body.cola[0].sku).toBe('FB-1');
  });

  it('sobrevive a "recargar" — persiste en la base, no en memoria del proceso', async () => {
    const db1 = openDb(TEST_DB);
    await request(buildApp(db1)).post('/api/etiquetas/cola').send({ sku: 'FB-2', cantidad: 1 });

    // Nueva conexión a la misma DB simula un proceso/pestaña nuevo.
    const db2 = openDb(TEST_DB);
    const lista = await request(buildApp(db2)).get('/api/etiquetas/cola');
    expect(lista.body.cola).toHaveLength(1);
    expect(lista.body.cola[0].sku).toBe('FB-2');
  });

  it('edita cantidad y nota de un ítem pendiente', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-3', cantidad: 1 });
    const id = alta.body.item.id;

    const edit = await request(app).patch(`/api/etiquetas/cola/${id}`).send({ cantidad: 5, nota: 'ya tiene una vieja' });
    expect(edit.status).toBe(200);
    expect(edit.body.item.cantidad).toBe(5);
    expect(edit.body.item.nota).toBe('ya tiene una vieja');
  });

  it('marca varios ítems como impresos y no los vuelve a marcar dos veces', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const a = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-4', cantidad: 1 });
    const b = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-5', cantidad: 2 });

    const marcar = await request(app).post('/api/etiquetas/cola/marcar-impresas')
      .send({ ids: [a.body.item.id, b.body.item.id] });
    expect(marcar.body.marcadas).toBe(2);

    const otraVez = await request(app).post('/api/etiquetas/cola/marcar-impresas')
      .send({ ids: [a.body.item.id, b.body.item.id] });
    expect(otraVez.body.marcadas).toBe(0);

    const pendientes = await request(app).get('/api/etiquetas/cola?estado=pendiente');
    expect(pendientes.body.cola).toHaveLength(0);
    const impresas = await request(app).get('/api/etiquetas/cola?estado=impresa');
    expect(impresas.body.cola).toHaveLength(2);
  });

  it('reclama atómicamente, confirma impresión y no permite confirmar con otro agente', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-PRINT', cantidad: 1 });
    const claim = await request(app).post('/api/etiquetas/cola/reclamar').send({ agente_id: 'deposito-pc' });
    expect(claim.body.trabajo.id).toBe(alta.body.item.id);
    const bad = await request(app).post(`/api/etiquetas/cola/${alta.body.item.id}/resultado`)
      .send({ claim_token: 'otro', ok: true });
    expect(bad.status).toBe(409);
    const ok = await request(app).post(`/api/etiquetas/cola/${alta.body.item.id}/resultado`)
      .send({ claim_token: claim.body.trabajo.claim_token, ok: true });
    expect(ok.body.estado).toBe('impresa');
    const replay = await request(app).post(`/api/etiquetas/cola/${alta.body.item.id}/resultado`)
      .send({ claim_token: claim.body.trabajo.claim_token, ok: true });
    expect(replay.body).toMatchObject({ ok: true, estado: 'impresa', idempotente: true });
  });

  it('recupera un trabajo cuyo lease venció', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-LEASE', cantidad: 1 });
    const primero = await request(app).post('/api/etiquetas/cola/reclamar').send({ agente_id: 'pc-caida' });
    db.prepare("UPDATE etiquetas_cola SET claim_hasta='2000-01-01T00:00:00.000Z' WHERE id=?").run(alta.body.item.id);
    const recuperado = await request(app).post('/api/etiquetas/cola/reclamar').send({ agente_id: 'pc-nueva' });
    expect(recuperado.body.trabajo.id).toBe(alta.body.item.id);
    expect(recuperado.body.trabajo.claim_token).not.toBe(primero.body.trabajo.claim_token);
  });

  it('puede reintentar un error sin duplicar el trabajo', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-RETRY', cantidad: 1 });
    const claim = await request(app).post('/api/etiquetas/cola/reclamar').send({ agente_id: 'deposito-pc' });
    await request(app).post(`/api/etiquetas/cola/${alta.body.item.id}/resultado`)
      .send({ claim_token: claim.body.trabajo.claim_token, ok: false, error: 'sin papel' });
    expect((await request(app).post(`/api/etiquetas/cola/${alta.body.item.id}/reintentar`)).body.ok).toBe(true);
    const siguiente = await request(app).post('/api/etiquetas/cola/reclamar').send({ agente_id: 'deposito-pc' });
    expect(siguiente.body.trabajo.id).toBe(alta.body.item.id);
  });

  it('no permite editar un ítem ya impreso', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-6', cantidad: 1 });
    const id = alta.body.item.id;
    await request(app).post('/api/etiquetas/cola/marcar-impresas').send({ ids: [id] });

    const edit = await request(app).patch(`/api/etiquetas/cola/${id}`).send({ cantidad: 9 });
    expect(edit.status).toBe(400);
  });

  it('descarta un ítem sin imprimir', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-7', cantidad: 1 });
    const id = alta.body.item.id;

    const borrar = await request(app).delete(`/api/etiquetas/cola/${id}`);
    expect(borrar.status).toBe(200);

    const lista = await request(app).get('/api/etiquetas/cola');
    expect(lista.body.cola).toHaveLength(0);
  });

  it('no permite borrar un ítem ya impreso (queda como registro)', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const alta = await request(app).post('/api/etiquetas/cola').send({ sku: 'FB-8', cantidad: 1 });
    const id = alta.body.item.id;
    await request(app).post('/api/etiquetas/cola/marcar-impresas').send({ ids: [id] });

    const borrar = await request(app).delete(`/api/etiquetas/cola/${id}`);
    expect(borrar.status).toBe(400);

    const lista = await request(app).get('/api/etiquetas/cola?estado=impresa');
    expect(lista.body.cola).toHaveLength(1);
  });

  it('404 al borrar/editar un id inexistente', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const borrar = await request(app).delete('/api/etiquetas/cola/999');
    expect(borrar.status).toBe(404);
    const edit = await request(app).patch('/api/etiquetas/cola/999').send({ cantidad: 1 });
    expect(edit.status).toBe(404);
  });

  it('exige ids no vacíos para marcar-impresas', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const res = await request(app).post('/api/etiquetas/cola/marcar-impresas').send({ ids: [] });
    expect(res.status).toBe(400);
  });
});
