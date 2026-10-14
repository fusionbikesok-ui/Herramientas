// E-1b: script de alta idempotente de los webhooks de pedidos de Woo (Woo simulado).
import { describe, it, expect, vi } from 'vitest';
import { altaWebhooksWooOrdenes, DELIVERY_URL, TOPICS_NUEVOS } from '../scripts/ops/alta-webhooks-woo-ordenes.mjs';

const SECRETO = 'super-secreto-que-no-se-imprime';
const CFG = { url: 'https://x.test', ck: 'a', cs: 'b' };

function wooSimulado(existentes = []) {
  const estado = { lista: [...existentes], posts: [], puts: [], siguiente: 100 };
  const wooFetch = vi.fn(async (cfg, p, method = 'get', body = null) => {
    if (p.startsWith('/webhooks?') && method === 'get') return { status: 200, data: estado.lista };
    if (p === '/webhooks' && method === 'post') {
      estado.posts.push(body);
      const w = { id: estado.siguiente++, topic: body.topic, status: body.status, delivery_url: body.delivery_url };
      estado.lista.push(w);
      return { status: 201, data: w };
    }
    const m = /^\/webhooks\/(\d+)$/.exec(p);
    if (m && method === 'put') { estado.puts.push({ id: Number(m[1]), body }); estado.lista.find((w) => w.id === Number(m[1])).status = body.status; return { status: 200, data: {} }; }
    throw new Error(`ruta inesperada ${method} ${p}`);
  });
  return { estado, wooFetch };
}
const correr = (woo, extra = {}) => {
  const logs = [];
  const refrescar = vi.fn(async () => undefined);
  return altaWebhooksWooOrdenes({ wooFetch: woo.wooFetch, cfg: CFG, secreto: SECRETO, refrescar, log: (m) => logs.push(m), ...extra }).then((r) => ({ ...r, logs, refrescar }));
};
const updated = { id: 7, topic: 'order.updated', status: 'active', delivery_url: DELIVERY_URL };

describe('alta-webhooks-woo-ordenes', () => {
  it('crea los 3 webhooks (created/deleted/restored) activos, con el delivery_url y el secreto, y refresca la lista', async () => {
    const woo = wooSimulado([updated]);
    const r = await correr(woo);
    expect(woo.estado.posts.map((b) => b.topic)).toEqual(TOPICS_NUEVOS);
    for (const b of woo.estado.posts) expect(b).toMatchObject({ status: 'active', delivery_url: DELIVERY_URL, secret: SECRETO });
    expect(r.acciones.every((a) => a.accion === 'creado')).toBe(true);
    expect(r.refrescar).toHaveBeenCalledTimes(1);
  });

  it('una segunda corrida no hace nada (idempotente) ni refresca', async () => {
    const woo = wooSimulado([updated]);
    await correr(woo);
    const r2 = await correr(woo);
    expect(woo.estado.posts).toHaveLength(3);
    expect(r2.acciones.every((a) => a.accion === 'ya_activo')).toBe(true);
    expect(r2.refrescar).not.toHaveBeenCalled();
  });

  it('un webhook existente pero deshabilitado NO se duplica; con --reactivar se activa', async () => {
    const woo = wooSimulado([updated, { id: 31, topic: 'order.created', status: 'disabled', delivery_url: DELIVERY_URL }]);
    const r = await correr(woo);
    expect(woo.estado.posts.map((b) => b.topic)).toEqual(['order.deleted', 'order.restored']);
    expect(r.acciones.find((a) => a.topic === 'order.created')).toMatchObject({ accion: 'existe_inactivo', id: 31 });
    const r2 = await correr(woo, { reactivar: true });
    expect(woo.estado.puts).toEqual([{ id: 31, body: { status: 'active' } }]);
    expect(r2.acciones.find((a) => a.topic === 'order.created')).toMatchObject({ accion: 'reactivado' });
    expect(woo.estado.posts).toHaveLength(2);
  });

  it('un webhook del mismo topic hacia OTRO delivery_url no cuenta como existente', async () => {
    const woo = wooSimulado([{ id: 40, topic: 'order.created', status: 'active', delivery_url: 'https://otro.test/hook' }]);
    await correr(woo);
    expect(woo.estado.posts.map((b) => b.topic)).toContain('order.created');
  });

  it('--dry-run no escribe nada y no necesita secreto', async () => {
    const woo = wooSimulado([updated]);
    const r = await correr(woo, { dryRun: true, secreto: '' });
    expect(woo.estado.posts).toHaveLength(0);
    expect(woo.estado.puts).toHaveLength(0);
    expect(r.acciones.every((a) => a.accion === 'crearia')).toBe(true);
    expect(r.refrescar).not.toHaveBeenCalled();
  });

  it('sin secreto en modo real falla antes de tocar Woo', async () => {
    const woo = wooSimulado([]);
    await expect(correr(woo, { secreto: '' })).rejects.toThrow(/WOO_WEBHOOK_SECRET/);
    expect(woo.wooFetch).not.toHaveBeenCalled();
  });

  it('el secreto no aparece en ningún log, ni siquiera si el refresco falla con un mensaje que lo contiene', async () => {
    const woo = wooSimulado([updated]);
    const r = await correr(woo, { refrescar: async () => { throw new Error(`falló con ${SECRETO}`); } });
    expect(r.logs.join('\n')).not.toContain(SECRETO);
  });

  it('un fallo al refrescar no tira el alta (los webhooks ya quedaron creados)', async () => {
    const woo = wooSimulado([updated]);
    const r = await correr(woo, { refrescar: async () => { throw new Error('Woo 502'); } });
    expect(r.acciones.every((a) => a.accion === 'creado')).toBe(true);
    expect(r.logs.join('\n')).toMatch(/no se pudo refrescar/);
  });
});
