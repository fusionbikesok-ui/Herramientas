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
  app.use((req, _res, next) => { req.user = { username: 'sup', is_admin: true }; next(); });
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
    restaurarPreparacionPorWoo(db, 500, 'lpaandreani');
    expect(estado()).toBe('en_preparacion');
    const r = await request(app).post(`/api/preparacion/${id}/heartbeat`).send({});
    expect(r.status).not.toBe(409);
  });

  it('restaurado de la papelera con un estado NO elegible (pending/on-hold): sigue anulada y el estado Woo queda en un evento (sin repetir el mismo)', () => {
    expect(restaurarPreparacionPorWoo(db, 500, 'pending')).toMatchObject({ restaurada: false, rechazada: true });
    restaurarPreparacionPorWoo(db, 500, 'pending');
    restaurarPreparacionPorWoo(db, 500, 'on-hold');
    expect(estado()).toBe(ESTADO_ANULADO_EN_WOO);
    const evs = db.prepare("SELECT detalle_json FROM preparacion_eventos WHERE preparacion_id = ? AND tipo = 'restauracion_rechazada'").all(id).map((e) => JSON.parse(e.detalle_json).estado_woo);
    expect(evs).toEqual(['pending', 'on-hold']);
  });

  it('cancelled con la preparación que estaba en curso: va al circuito de cancelación (no queda anulada)', () => {
    const r = restaurarPreparacionPorWoo(db, 500, 'cancelled');
    expect(r).toMatchObject({ restaurada: false, rechazada: true, cancelacion: true });
    expect(estado()).toBe('cancelada_sin_retiro_registrado');
  });

  it('los estados elegibles configurados (lpaandreani/completed/enviadoandreani) restauran', () => {
    expect(restaurarPreparacionPorWoo(db, 500, 'completed').restaurada).toBe(true);
    expect(estado()).toBe('en_preparacion');
  });

  it('el detalle expone estado_previo_anulado para el badge', async () => {
    const ui = await request(app).get(`/api/preparacion/${id}`);
    expect(ui.body.data.estado_previo_anulado).toBe('en_preparacion');
  });
});

describe('anular una preparación ya completada o con tracking: incidente de advertencia', () => {
  const incidente = (wc) => db.prepare('SELECT * FROM incidentes_operativos WHERE tipo_error = ?').get(`preparacion_anulada_en_woo_${wc}`);
  it('completada: queda anulada (reversible), abre incidente advertencia y el detalle dice de qué estado venía', async () => {
    const id2 = crearPreparacion(db, { canal: 'web', wcOrderId: 501, numeroPedido: '501', comprador: 'Beto', items: [] });
    db.prepare("UPDATE preparaciones SET estado = 'completada' WHERE id = ?").run(id2);
    anularPreparacionPorWoo(db, 501, { motivo: 'trash' });
    expect(db.prepare('SELECT estado FROM preparaciones WHERE id = ?').get(id2).estado).toBe(ESTADO_ANULADO_EN_WOO);
    expect(incidente(501)).toMatchObject({ severidad: 'advertencia', estado: 'activo' });
    const r = await request(app).get(`/api/preparacion/${id2}`);
    expect(r.body.data.estado_previo_anulado).toBe('completada');
  });
  it('con tracking aunque siga en preparación: también avisa; sin tracking y en preparación: no', () => {
    crearPreparacion(db, { canal: 'web', wcOrderId: 502, numeroPedido: '502', comprador: 'C', items: [] });
    db.prepare("UPDATE preparaciones SET tracking = 'AND123' WHERE clave = 'web:502'").run();
    anularPreparacionPorWoo(db, 502);
    expect(incidente(502)).toBeDefined();
    expect(incidente(500)).toBeUndefined();
  });
});
