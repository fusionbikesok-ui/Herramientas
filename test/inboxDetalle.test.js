import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware, mobileRequirePermission } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';
import { inboxClaimsRouter } from '../routes/inboxClaims.js';
import { ensureTables } from '../routes/notificacionesMl.js';
import { serializarAcciones } from '../lib/mlAccionesCaso.js';

const DB = './test/tmp-inbox-detalle.sqlite';
const SECRET = 'test-mobile-jwt-secret-which-is-long-enough-123';

/**
 * Detalle operativo de un caso de la bandeja.
 *
 * La notificación no es fuente de verdad: lleva identificadores opacos y la app pide el
 * estado actual antes de mostrar o habilitar nada. Por eso el detalle tiene que decir de qué
 * recurso externo se trata, en qué estado está y qué acciones siguen permitidas.
 *
 * `available_actions` es tri-estado (§4.3): `null` es desconocido, `[]` es "ML dijo que no
 * hay ninguna". Los tests de este archivo verifican esa distinción explícitamente porque es
 * la razón de ser de `lib/inboxDetalle.js`.
 */
describe('GET /api/v1/inbox/:id/detail', () => {
  let db, app, auth, t;

  const nuevoCaso = ({ eventId, kind, resourceId, extra = {} }) => {
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, `${kind}.received`, 'ml', 'mercadolibre', t, `corr-${eventId}`, `dedupe-${eventId}`);
    const columnas = ['event_id', 'channel', 'resource_id', 'title', 'preview', 'kind', 'status', 'version', 'created_at', 'updated_at'];
    const valores = [eventId, 'ml', resourceId, 'Caso', 'Vista previa', kind, 'unread', 1, t, t];
    for (const [clave, valor] of Object.entries(extra)) { columnas.push(clave); valores.push(valor); }
    const marcas = columnas.map(() => '?').join(',');
    const info = db.prepare(`INSERT INTO inbox_items (${columnas.join(',')}) VALUES (${marcas})`).run(...valores);
    return Number(info.lastInsertRowid);
  };

  beforeEach(async () => {
    db = openDb(DB);
    // Las tablas de ML se crean de forma perezosa en producción; el test usa la misma DDL.
    ensureTables(db);
    t = new Date().toISOString();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('detalle-user', hashPassword('correcta123'), 0, 1, t, t);
    db.prepare("INSERT INTO user_permisos (user_id,herramienta,nivel) VALUES (1,'notificaciones-ml','read')").run();
    db.prepare('INSERT INTO users (username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES (?,?,?,?,?,?)')
      .run('otro-user', hashPassword('correcta123'), 0, 1, t, t);

    app = express();
    app.use(express.json());
    const authMiddleware = [mobileAuthMiddleware(db, SECRET), mobileRequirePermission('notificaciones-ml')];
    app.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
    app.use('/api/v1/inbox', inboxClaimsRouter(db, authMiddleware));
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'detalle-user', password: 'correcta123', platform: 'ios', push_token: 'detalle-device',
    });
    auth = { Authorization: `Bearer ${login.body.access_token}` };
  });

  afterEach(() => { db.close(); if (fs.existsSync(DB)) fs.unlinkSync(DB); });

  it('exige autenticación', async () => {
    const id = nuevoCaso({ eventId: 'evt-q1', kind: 'pregunta', resourceId: 'Q-1' });
    expect((await request(app).get(`/api/v1/inbox/${id}/detail`)).status).toBe(401);
  });

  it('devuelve 404 para un caso inexistente', async () => {
    const r = await request(app).get('/api/v1/inbox/9999/detail').set(auth);
    expect(r.status).toBe(404);
  });

  // Un caso asignado a otra persona no se muestra: el detalle trae texto de clientes. La
  // ruta responde el mismo 404 que para un caso inexistente, para no revelar que existe.
  it('no expone un caso asignado a otro usuario (404, igual que un caso inexistente)', async () => {
    const id = nuevoCaso({ eventId: 'evt-q2', kind: 'pregunta', resourceId: 'Q-2', extra: { assigned_user_id: 2 } });
    expect((await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth)).status).toBe(404);
  });

  it('una pregunta trae su identificador externo, el ítem publicado y el texto', async () => {
    db.prepare(`INSERT INTO ml_preguntas (id,item_id,texto,estado,fecha_creacion,actualizado_en)
      VALUES (?,?,?,?,?,?)`).run(1001, 'MLA123', 'Tienen envio a Cordoba?', 'UNANSWERED', t, t);
    const id = nuevoCaso({
      eventId: 'evt-q3', kind: 'pregunta', resourceId: '1001',
      extra: { item_id: 'MLA123', external_status: 'UNANSWERED', last_synced_at: t },
    });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'pregunta', external_id: '1001', external_status: 'UNANSWERED' });
    expect(r.body.producto).toMatchObject({ item_id: 'MLA123' });
    expect(r.body.pregunta).toMatchObject({ texto: 'Tienen envio a Cordoba?' });
    expect(r.body.last_synced_at).toBe(t);
  });

  // Las acciones las decide el backend contra el estado externo; la app no las infiere.
  it('una pregunta ya respondida no ofrece responder (available_actions vacío)', async () => {
    db.prepare(`INSERT INTO ml_preguntas (id,item_id,texto,estado,fecha_creacion,actualizado_en)
      VALUES (?,?,?,?,?,?)`).run(1002, 'MLA9', 'Ya respondida', 'ANSWERED', t, t);
    const id = nuevoCaso({ eventId: 'evt-q4', kind: 'pregunta', resourceId: '1002', extra: { external_status: 'ANSWERED' } });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.available_actions).toEqual([]);
    expect(r.body.actions_source).toBe('local_state');
  });

  it('una pregunta UNANSWERED sí habilita responder', async () => {
    db.prepare(`INSERT INTO ml_preguntas (id,item_id,texto,estado,fecha_creacion,actualizado_en)
      VALUES (?,?,?,?,?,?)`).run(1003, 'MLA9', 'Pendiente', 'UNANSWERED', t, t);
    const id = nuevoCaso({ eventId: 'evt-q5', kind: 'pregunta', resourceId: '1003', extra: { external_status: 'UNANSWERED' } });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.available_actions.some((a) => a.action === 'reply')).toBe(true);
    expect(r.body.actions_source).toBe('local_state');
  });

  it('un reclamo trae su claim_id real, motivo y estado', async () => {
    db.prepare(`INSERT INTO ml_reclamos (id,recurso,estado,titulo,detalle,type,reason_id,actualizado_en)
      VALUES (?,?,?,?,?,?,?,?)`).run('CLM-77', 'order/500', 'opened', 'Producto danado', 'Llego roto', 'mediations', 'PDD9', t);
    const id = nuevoCaso({
      eventId: 'evt-c1', kind: 'reclamo', resourceId: 'CLM-77',
      extra: { external_status: 'opened', order_id: '500' },
    });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'reclamo', external_id: 'CLM-77', external_status: 'opened' });
    expect(r.body.reclamo).toMatchObject({ motivo: 'PDD9', tipo: 'mediations' });
  });

  // §4.3: sin `external_actions` persistidas no se puede afirmar nada — es DESCONOCIDO, no
  // "ninguna acción". `available_actions` debe ser null, no [], y actions_source lo declara.
  it('un reclamo abierto sin external_actions persistidas es desconocido, no "ninguna"', async () => {
    db.prepare(`INSERT INTO ml_reclamos (id,recurso,estado,titulo,detalle,actualizado_en)
      VALUES (?,?,?,?,?,?)`).run('CLM-80', 'order/503', 'opened', 'Sin acciones aun', 'Detalle', t);
    const id = nuevoCaso({ eventId: 'evt-c4', kind: 'reclamo', resourceId: 'CLM-80', extra: { external_status: 'opened' } });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.available_actions).toBeNull();
    expect(r.body.actions_source).toBe('unknown');
    expect(r.body.quick_actions).toEqual([]);
  });

  it('un reclamo con external_actions persistidas expone el array de ML y su vencimiento', async () => {
    db.prepare(`INSERT INTO ml_reclamos (id,recurso,estado,titulo,detalle,actualizado_en)
      VALUES (?,?,?,?,?,?)`).run('CLM-81', 'order/504', 'opened', 'Con acciones', 'Detalle', t);
    const acciones = [
      { action: 'send_message_to_mediator', mandatory: true, due_date: '2026-09-12T00:00:00.000Z' },
      { action: 'refund', mandatory: false, due_date: null },
    ];
    const id = nuevoCaso({
      eventId: 'evt-c5', kind: 'reclamo', resourceId: 'CLM-81',
      extra: { external_status: 'opened', external_actions: serializarAcciones(acciones) },
    });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.actions_source).toBe('ml');
    expect(r.body.available_actions).toEqual(acciones);
    expect(r.body.due_date).toBe('2026-09-12T00:00:00.000Z');
  });

  // Una accion economica jamas sale como accion rapida: solo dentro del detalle y con
  // confirmacion explicita. El backend no debe ofrecerla aca.
  it('un reclamo no ofrece reembolso ni mediación como acción rápida', async () => {
    db.prepare(`INSERT INTO ml_reclamos (id,recurso,estado,titulo,detalle,actualizado_en)
      VALUES (?,?,?,?,?,?)`).run('CLM-78', 'order/501', 'opened', 'Otro', 'Detalle', t);
    const acciones = [
      { action: 'refund', mandatory: false, due_date: null },
      { action: 'send_message_to_mediator', mandatory: false, due_date: null },
    ];
    const id = nuevoCaso({
      eventId: 'evt-c2', kind: 'reclamo', resourceId: 'CLM-78',
      extra: { external_status: 'opened', external_actions: serializarAcciones(acciones) },
    });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    const quickNames = (r.body.quick_actions || []).map((a) => a.action);
    expect(quickNames).not.toContain('refund');
    expect(quickNames).not.toContain('mediation');
    expect(quickNames).toContain('send_message_to_mediator');
  });

  it('un caso cerrado externamente no ofrece ninguna acción (array vacío conocido, no desconocido)', async () => {
    db.prepare(`INSERT INTO ml_reclamos (id,recurso,estado,titulo,detalle,actualizado_en)
      VALUES (?,?,?,?,?,?)`).run('CLM-79', 'order/502', 'closed', 'Cerrado', 'Detalle', t);
    const id = nuevoCaso({ eventId: 'evt-c3', kind: 'reclamo', resourceId: 'CLM-79', extra: { external_status: 'closed' } });

    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    expect(r.body.available_actions).toEqual([]);
    expect(r.body.actions_source).toBe('ml_closed');
  });

  it('no expone tokens ni payload crudo de Mercado Libre', async () => {
    const id = nuevoCaso({ eventId: 'evt-q6', kind: 'pregunta', resourceId: '1004' });
    const r = await request(app).get(`/api/v1/inbox/${id}/detail`).set(auth);
    const texto = JSON.stringify(r.body).toLowerCase();
    for (const prohibido of ['access_token', 'refresh_token', 'client_secret', 'authorization']) {
      expect(texto).not.toContain(prohibido);
    }
  });
});
