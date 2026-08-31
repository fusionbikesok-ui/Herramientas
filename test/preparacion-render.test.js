import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function extraerScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return scripts.reduce((a, b) => (b.length > a.length ? b : a));
}

function documentoFake() {
  const elementos = new Map();
  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, {
        innerHTML: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {}, removeEventListener() {}, focus() {}, contains() { return false; },
      });
      return elementos.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

let ctx;

beforeEach(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
  const document = documentoFake();
  const sandbox = {
    document, window: null, console, Date, Math, JSON, setTimeout, clearTimeout,
    setInterval() { return 1; }, clearInterval() {},
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: { href: '', pathname: '/preparacion/', search: '' },
    fetch: vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, is_admin: 1, user: 'tester' }) })),
    alert() {}, confirm() { return true; },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/api.js'), 'utf8'), ctx);
  vm.runInContext(extraerScript(html), ctx, { filename: 'preparacion-inline.js' });
  ctx.PEND_BASELINE_LISTA = false;
  ctx.PEND_NUEVOS = {};
  ctx.PEND_CACHE = [];
});

describe('preparacion/index.html — render de pedidos nuevos', () => {
  it('no marca la carga inicial y marca un pedido aparecido en el polling con tiempo transcurrido', () => {
    const pedido = { canal: 'web', wc_order_id: 901, numero_pedido: '901', comprador: 'Ana', fecha: '2026-08-28T12:00:00Z', items: [] };
    ctx.registrarPendientesNuevos([pedido], false);
    ctx.PEND_CACHE = [pedido];
    expect(ctx.cardPendiente(pedido, 0)).not.toContain('NUEVO');

    ctx.PEND_CACHE = [];
    ctx.registrarPendientesNuevos([pedido], true);
    const html = ctx.cardPendiente(pedido, 0);
    expect(html).toContain('class="ped nuevo"');
    expect(html).toContain('NUEVO · hace menos de 1 min');
    expect(html).toContain('aria-label="Pedido nuevo, ingresado menos de 1 min"');
  });

  it('conserva el estado nuevo por clave y elimina pedidos que ya no están en la cola', () => {
    const pedido = { canal: 'ml', ml_order_id: 'ML-1', numero_pedido: 'ML-1', items: [] };
    ctx.registrarPendientesNuevos([], false);
    ctx.PEND_CACHE = [];
    ctx.registrarPendientesNuevos([pedido], true);
    expect(ctx.PEND_NUEVOS['ml:ML-1']).toBeTypeOf('number');
    ctx.PEND_CACHE = [pedido];
    ctx.registrarPendientesNuevos([], true);
    expect(ctx.PEND_NUEVOS['ml:ML-1']).toBeUndefined();
  });
});
