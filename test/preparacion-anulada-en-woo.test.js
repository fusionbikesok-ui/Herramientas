// E-1b: una preparación `anulado_en_woo` no admite ninguna acción (409), por cada ruta que mute una preparación.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { preparacionRouter, crearPreparacion, anularPreparacionPorWoo, restaurarPreparacionPorWoo, ESTADO_ANULADO_EN_WOO } from '../routes/preparacion.js';

const TEST_DB = `./test/tmp-prep-anulada.${process.pid}.sqlite`;
const CFG = { woo: { url: 'https://x.test', ck: 'a', cs: 'b' }, ml: {} };
let db, app, id;
const limpiar = () => { for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + s, { force: true }); };

beforeEach(() => {
  limpiar();
  db = openDb(TEST_DB);
  const router = preparacionRouter(db, CFG);
  app = express();
  app.use(express.json());
  app.use('/api/preparacion', router);
  id = crearPreparacion(db, { canal: 'web', wcOrderId: 500, numeroPedido: '500', comprador: 'Ana', items: [] });
  anularPreparacionPorWoo(db, 500, { motivo: 'trash' });
});
afterEach(() => { db.close(); limpiar(); });

const estado = () => db.prepare('SELECT estado FROM preparaciones WHERE id = ?').get(id).estado;

describe('preparación anulada en Woo: toda acción devuelve 409 y no cambia nada', () => {
  const acciones = () => [
    ['post', `/${id}/tomar`], ['post', `/${id}/claim/renovar`], ['post', `/${id}/claim/liberar`], ['post', `/${id}/heartbeat`],
    ['post', `/${id}/escanear`], ['post', `/${id}/item/1/confirmar-manual`], ['post', `/${id}/etiquetas-manuales/1/hecha`],
    ['post', `/${id}/item/1/embalaje`], ['post', `/${id}/item/1/despacho`], ['post', `/${id}/foto`],
    ['post', `/${id}/foto/1/reintentar`], ['delete', `/${id}/foto/1`], ['post', `/${id}/asociar-tracking`],
    ['post', `/${id}/completar`], ['post', `/${id}/reabrir`], ['put', `/${id}/fotos-hold`], ['delete', `/${id}/fotos-hold`],
    ['post', `/despacho/${id}/escanear`], ['post', `/despacho/${id}/confirmar`], ['post', `/despacho/${id}/confirmar-manual`],
    ['post', '/etiquetas/500/lista'], ['post', '/seguimientos/500'], ['post', '/seguimientos/500/corregir-tracking'],
  ];

  it('cada ruta que muta una preparación responde 409 PREPARACION_ANULADA_EN_WOO', async () => {
    for (const [metodo, ruta] of acciones()) {
      const r = await request(app)[metodo](`/api/preparacion${ruta}`).send({});
      expect(r.status, `${metodo.toUpperCase()} ${ruta}`).toBe(409);
      expect(r.body.code).toBe('PREPARACION_ANULADA_EN_WOO');
    }
    const r = await request(app).post('/api/preparacion/iniciar').send({ canal: 'web', id: 500 });
    expect(r.status).toBe(409);
    expect(estado()).toBe(ESTADO_ANULADO_EN_WOO);
  });

  it('las lecturas siguen funcionando (muestran el aviso)', async () => {
    const r = await request(app).get(`/api/preparacion/${id}`);
    expect(r.status).not.toBe(409);
  });

  it('al restaurarse el pedido vuelve al estado previo y las acciones se habilitan de nuevo', async () => {
    restaurarPreparacionPorWoo(db, 500);
    expect(estado()).toBe('en_preparacion');
    const r = await request(app).post(`/api/preparacion/${id}/heartbeat`).send({});
    expect(r.status).not.toBe(409);
  });
});
