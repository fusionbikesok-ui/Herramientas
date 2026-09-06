import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import axios from 'axios';
import { openDb } from '../db/index.js';
import { esPropio, refrescarWebhooksWoo, saludPipelineEventos, webhooksWooCaidos } from '../lib/wooWebhooks.js';

const FILE = './test/tmp-woo-webhooks.sqlite';
const CFG = { url: 'https://tienda.example.com', ck: 'ck', cs: 'cs' };
const HOST = 'herramientas.example.com';

function responder(data, status = 200) {
  return vi.spyOn(axios, 'request').mockResolvedValue({ status, data });
}

describe('vigilancia de los webhooks de Woo', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('distingue los webhooks propios de los de terceros', () => {
    // La tienda tiene webhooks de otros sistemas que no administramos.
    expect(esPropio('https://herramientas.example.com/api/woo/webhook', HOST)).toBe(true);
    expect(esPropio('https://prometheo-be.itesa.co/v1/webhook', HOST)).toBe(false);
    expect(esPropio('', HOST)).toBe(false);
  });

  it('reporta como caído el que Woo desactivó, y no los ajenos', async () => {
    // El caso real: `order.updated` estaba `disabled` en producción sin que nadie lo supiera.
    responder([
      { id: 8, topic: 'product.created', status: 'active', delivery_url: `https://${HOST}/api/woo/webhook` },
      { id: 7, topic: 'order.updated', status: 'disabled', delivery_url: `https://${HOST}/api/woo/webhook` },
      { id: 2, topic: 'product.updated', status: 'disabled', delivery_url: 'https://otro.example.com/hook' },
    ]);
    const r = await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });

    expect(r).toMatchObject({ ok: true, total: 3, propios: 2 });
    expect(webhooksWooCaidos(db)).toMatchObject([{ id: 7, topic: 'order.updated', status: 'disabled' }]);
  });

  it('trata `paused` como caído: los eventos tampoco llegan', async () => {
    responder([{ id: 9, topic: 'product.deleted', status: 'paused', delivery_url: `https://${HOST}/x` }]);
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });
    expect(webhooksWooCaidos(db)).toHaveLength(1);
  });

  it('conserva desde cuándo está caído entre corridas', async () => {
    // Si `status_desde` se reescribiera en cada corrida, un webhook caído hace días parecería
    // recién caído y se perdería el dato que dice cuántos eventos pueden haberse perdido.
    responder([{ id: 7, topic: 'order.updated', status: 'disabled', delivery_url: `https://${HOST}/x` }]);
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });
    const primera = webhooksWooCaidos(db)[0].status_desde;

    await new Promise((r) => setTimeout(r, 5));
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });
    expect(webhooksWooCaidos(db)[0].status_desde).toBe(primera);
  });

  it('mueve la fecha sólo cuando el estado cambia de verdad', async () => {
    responder([{ id: 7, topic: 'order.updated', status: 'disabled', delivery_url: `https://${HOST}/x` }]);
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });
    const caido = webhooksWooCaidos(db)[0].status_desde;

    vi.restoreAllMocks();
    responder([{ id: 7, topic: 'order.updated', status: 'active', delivery_url: `https://${HOST}/x` }]);
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });
    expect(webhooksWooCaidos(db)).toEqual([]);
    expect(db.prepare('SELECT status_desde FROM woo_webhooks_estado WHERE id=7').get().status_desde).not.toBe(caido);
  });

  it('olvida el webhook que se borró en la tienda', async () => {
    responder([
      { id: 7, topic: 'order.updated', status: 'disabled', delivery_url: `https://${HOST}/x` },
      { id: 8, topic: 'product.created', status: 'active', delivery_url: `https://${HOST}/x` },
    ]);
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });
    vi.restoreAllMocks();
    responder([{ id: 8, topic: 'product.created', status: 'active', delivery_url: `https://${HOST}/x` }]);
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });

    expect(db.prepare('SELECT COUNT(*) n FROM woo_webhooks_estado').get().n).toBe(1);
    expect(webhooksWooCaidos(db)).toEqual([]);
  });

  it('no rompe ni borra nada cuando Woo responde con error', async () => {
    responder([{ id: 8, topic: 'product.created', status: 'active', delivery_url: `https://${HOST}/x` }]);
    await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST });
    vi.restoreAllMocks();
    responder({ code: 'rest_forbidden' }, 401);

    expect(await refrescarWebhooksWoo(db, CFG, { hostPropio: HOST })).toMatchObject({ ok: false });
    expect(db.prepare('SELECT COUNT(*) n FROM woo_webhooks_estado').get().n).toBe(1);
  });

  it('rechaza una URL que no sea HTTPS', async () => {
    expect(await refrescarWebhooksWoo(db, { url: 'http://tienda.example.com', ck: 'a', cs: 'b' }))
      .toMatchObject({ ok: false });
  });
});

describe('salud del pipeline de eventos', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  const evento = (id) => db.prepare(`INSERT INTO integration_events
    (event_id,event_type,channel,source,occurred_at,received_at,correlation_id,dedupe_key,status)
    VALUES (?,'items','ml','webhook',?,?,?,?,'completed')`).run(id, ISO_E, ISO_E, 'corr-' + id, 'dedupe-' + id);
  const ISO_E = '2026-09-06T12:00:00.000Z';
  // `job_id` lo genera la base (INTEGER AUTOINCREMENT), no se pasa.
  const job = (evId, status, attempts = 0, max = 5) => db.prepare(`INSERT INTO integration_jobs
    (event_id,job_type,status,attempts,max_attempts,available_at)
    VALUES (?,'item.project',?,?,?,?)`).run(evId, status, attempts, max, ISO_E);

  it('cuenta el evento que se ingirió y nunca derivó en trabajo', () => {
    // Es el que desaparece sin rastro: no falla, no reintenta, no sale en dead letters.
    evento('e1'); evento('e2');
    job('e1', 'completed');

    expect(saludPipelineEventos(db)).toMatchObject({ disponible: true, eventos_sin_job: 1 });
  });

  it('separa dead letters de jobs atascados', () => {
    // Un job que agotó sus intentos sin quedar marcado como muerto ni se reintenta ni se ve.
    evento('e3'); evento('e4');
    job('e3', 'dead_lettered', 5, 5);
    job('e4', 'pending', 5, 5);

    expect(saludPipelineEventos(db)).toMatchObject({ dead_letters: 1, atascados: 1, eventos_sin_job: 0 });
  });

  it('agrupa los dead letters por tipo para no perder de vista al reincidente', () => {
    evento('e5'); job('e5', 'dead_lettered', 5, 5);
    expect(saludPipelineEventos(db).por_tipo).toMatchObject([{ job_type: 'item.project', n: 1 }]);
  });
});
