// Fase E-1a: guardia fail-closed de los webhooks de Woo (firma, ping, ID de webhook, topic).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import crypto from 'crypto';
import { openDb } from '../db/index.js';
import { verificarWebhookWoo, _resetWooWebhookAuth, _envejecerListaWooWebhookAuth } from '../lib/wooWebhookAuth.js';

const PATH = `./test/tmp-woo-guard.${process.pid}.sqlite`;
const SECRETO = 'secreto-guardia';
let db;
beforeEach(() => {
  for (const x of ['', '-wal', '-shm']) fs.rmSync(PATH + x, { force: true });
  db = openDb(PATH);
  process.env.WOO_WEBHOOK_SECRET = SECRETO;
  delete process.env.WOO_WEBHOOK_IDS;
  _resetWooWebhookAuth();
});
afterEach(() => {
  db.close();
  for (const x of ['', '-wal', '-shm']) fs.rmSync(PATH + x, { force: true });
  delete process.env.WOO_WEBHOOK_SECRET;
  delete process.env.WOO_WEBHOOK_IDS;
});

const firmar = (cuerpo, secreto = SECRETO) => crypto.createHmac('sha256', secreto).update(cuerpo).digest('base64');
function req(cuerpo, { topic = 'order.updated', id = '7', firma = firmar(cuerpo) } = {}) {
  const headers = { 'x-wc-webhook-topic': topic, 'x-wc-webhook-id': id };
  if (firma) headers['x-wc-webhook-signature'] = firma;
  return { body: Buffer.from(cuerpo), headers };
}
const incidente = (tipo) => db.prepare('SELECT severidad FROM incidentes_operativos WHERE tipo_error = ?').get(tipo);
const listar = (ids) => vi.fn(async () => ids);
const JSON_PEDIDO = JSON.stringify({ id: 1, status: 'processing' });

describe('guardia de webhooks Woo', () => {
  it('sin WOO_WEBHOOK_SECRET responde 503 y abre un incidente crítico (nunca procesa sin autenticar)', async () => {
    delete process.env.WOO_WEBHOOK_SECRET;
    const r = await verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: listar([7]) });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(incidente('secreto_webhook_ausente')).toMatchObject({ severidad: 'critico' });
  });

  it('sin firma o con firma inválida es 401', async () => {
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { firma: null }), 'order', { listar: listar([7]) })).toMatchObject({ ok: false, status: 401, error: 'sin firma' });
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { firma: 'x' }), 'order', { listar: listar([7]) })).toMatchObject({ ok: false, status: 401, error: 'firma inválida' });
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { firma: firmar(JSON_PEDIDO, 'otro-secreto') }), 'order', { listar: listar([7]) })).toMatchObject({ ok: false, status: 401 });
  });

  it('el ping de Woo (webhook_id=N, firmado) se contesta sin procesar y sin consultar la lista', async () => {
    const l = listar([7]);
    const r = await verificarWebhookWoo(db, {}, req('webhook_id=7', { topic: '', id: '' }), 'order', { listar: l });
    expect(r).toEqual({ ok: true, ping: true });
    expect(l).not.toHaveBeenCalled();
  });

  it('un ping SIN firma válida sigue siendo 401', async () => {
    const r = await verificarWebhookWoo(db, {}, req('webhook_id=7', { firma: 'mala' }), 'order', { listar: listar([7]) });
    expect(r.status).toBe(401);
  });

  it('un webhook conocido pasa y la lista se cachea (una lectura por hora)', async () => {
    const l = listar([7, 8]);
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: l })).toEqual({ ok: true });
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { id: '8' }), 'order', { listar: l })).toEqual({ ok: true });
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('un ID desconocido refresca la lista UNA vez (si la lista tiene más de 30 s); si sigue desconocido es 401 + incidente', async () => {
    const l = listar([7]);
    await verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: l });
    _envejecerListaWooWebhookAuth(31_000);
    const r = await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { id: '99' }), 'order', { listar: l });
    expect(r).toMatchObject({ ok: false, status: 401, error: 'webhook desconocido' });
    expect(l).toHaveBeenCalledTimes(2);
    expect(incidente('webhook_id_desconocido')).toMatchObject({ severidad: 'critico' });
  });

  it('un webhook creado después del cache se acepta al refrescar', async () => {
    const l = vi.fn().mockResolvedValueOnce([7]).mockResolvedValueOnce([7, 12]);
    await verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: l });
    _envejecerListaWooWebhookAuth(31_000);
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { id: '12' }), 'order', { listar: l })).toEqual({ ok: true });
  });

  it('con la lista de menos de 30 s, un ID desconocido NO fuerza otra lectura (no se martilla a Woo)', async () => {
    const l = listar([7]);
    await verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: l });
    for (const id of ['91', '92', '93']) {
      expect((await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { id }), 'order', { listar: l })).status).toBe(401);
    }
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('single-flight: avisos simultáneos comparten UNA lectura de la lista', async () => {
    let n = 0;
    const l = vi.fn(async () => { n++; await new Promise((r) => setTimeout(r, 30)); return [7]; });
    const rs = await Promise.all([1, 2, 3, 4].map(() => verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: l })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(n).toBe(1);
  });

  it('una lista lenta corta a los 3 s (aquí 50 ms) y cae a "firma válida + advertencia" sin demorar el ACK', async () => {
    const l = vi.fn(() => new Promise(() => {})); // nunca responde
    const t0 = Date.now();
    const r = await verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: l, timeoutMs: 50 });
    expect(r).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(incidente('webhook_lista_no_disponible')).toMatchObject({ severidad: 'advertencia' });
  });

  it('WOO_WEBHOOK_IDS fija los IDs válidos sin consultar a Woo', async () => {
    process.env.WOO_WEBHOOK_IDS = '3, 4';
    const l = listar([]);
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { id: '4' }), 'order', { listar: l })).toEqual({ ok: true });
    expect((await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { id: '7' }), 'order', { listar: l })).status).toBe(401);
    expect(l).not.toHaveBeenCalled();
  });

  it('el topic debe corresponder al endpoint (400) y tiene que existir', async () => {
    expect((await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { topic: 'product.updated' }), 'order', { listar: listar([7]) })).status).toBe(400);
    expect((await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { topic: 'order.updated' }), 'product', { listar: listar([7]) })).status).toBe(400);
    expect((await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { topic: '' }), 'order', { listar: listar([7]) })).status).toBe(400);
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { topic: 'product.deleted' }), 'product', { listar: listar([7]) })).toEqual({ ok: true });
  });

  it('si la lista de webhooks no se puede obtener, un aviso con firma válida se acepta y queda un incidente', async () => {
    const l = vi.fn().mockRejectedValue(new Error('Woo caído'));
    expect(await verificarWebhookWoo(db, {}, req(JSON_PEDIDO), 'order', { listar: l })).toEqual({ ok: true });
    expect(incidente('webhook_lista_no_disponible')).toMatchObject({ severidad: 'advertencia' });
  });

  it('un webhook sin X-WC-Webhook-ID es 401', async () => {
    expect((await verificarWebhookWoo(db, {}, req(JSON_PEDIDO, { id: '' }), 'order', { listar: listar([7]) })).status).toBe(401);
  });
});
