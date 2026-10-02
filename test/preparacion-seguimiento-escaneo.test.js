import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function extraerScript(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .reduce((a, b) => (b.length > a.length ? b : a));
}

function documentoFake() {
  const elementos = new Map();
  const crear = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, readOnly: false,
    dataset: {}, style: {}, hidden: false, className: '', classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    addEventListener() {}, removeEventListener() {}, focus: vi.fn(), click() {},
    contains() { return false; }, querySelector() { return null; },
    querySelectorAll() { return []; }, closest() { return null; },
    setAttribute() {}, insertAdjacentElement() {}, remove() {},
  });
  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, crear(id));
      return elementos.get(id);
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    contains() { return true; }, addEventListener() {},
  };
}

let ctx;
let respuestas;

beforeEach(() => {
  const document = documentoFake();
  respuestas = [];
  const sandbox = {
    document, window: null, console, Date, Math, JSON, Intl, URLSearchParams,
    setTimeout(fn) { fn(); return 1; }, clearTimeout, setInterval() { return 1; }, clearInterval() {},
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: { href: '', pathname: '/preparacion/', search: '' }, history: { pushState() {} },
    navigator: {}, fetch: vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false }) })),
    alert() {}, confirm() { return true; }, prompt() { return null; },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/api.js'), 'utf8'), ctx);
  vm.runInContext(extraerScript(fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8')), ctx);
  ctx.PEND_BASELINE_LISTA = false;
  ctx.PEND_NUEVOS = {};
  ctx.PEND_CACHE = [];
  ctx.ir = vi.fn();
  ctx.refrescarDetalle = vi.fn();
  ctx.beep = vi.fn();
  ctx.api = vi.fn(async (url, opts) => {
    respuestas.push({ url, opts });
    return { status: 200, body: { ok: true } };
  });
});

describe('seguimiento Andreani desde Finalizar preparación', () => {
  it('acepta un Andreani de 15 dígitos y rechaza formato inválido', () => {
    expect(ctx.validarTrackingEscaneo(' 360003042094910 ')).toEqual({ ok: true, valor: '360003042094910' });
    expect(ctx.validarTrackingEscaneo('ABC123')).toMatchObject({ ok: false });
  });

  it('rechaza un EAN-13 válido y un SKU del pedido como código de producto', () => {
    const items = [{ sku: 'CASCO-9', ean_sku: '7791234567892', cantidad_esperada: 1 }];
    expect(ctx.validarTrackingEscaneo('7791234567892', items).error)
      .toBe('Ese es un código de producto, no un seguimiento');
    expect(ctx.validarTrackingEscaneo('CASCO-9', items).error)
      .toBe('Ese es un código de producto, no un seguimiento');
  });

  it('rechaza un GTIN válido aunque no esté en los ítems del pedido', () => {
    expect(ctx.validarTrackingEscaneo('4006381333931', []).error)
      .toBe('Ese es un código de producto, no un seguimiento');
  });

  it('muestra el escaneo solo para web completada, no para ML ni pendiente de depósito', () => {
    ctx.PREP = { canal: 'web', estado: 'completada', wc_order_id: 44, numero_pedido: 'W-44', comprador: 'Ana', items: [] };
    ctx.completar = vi.fn();
    ctx.abrirFlujoTracking();
    expect(ctx.document.getElementById('cuerpo').innerHTML).toContain('Escaneá el seguimiento');

    ctx.PREP = { canal: 'ml', estado: 'completada', items: [] };
    ctx.document.getElementById('cuerpo').innerHTML = '';
    ctx.completarTrasRespuesta({ ok: true, estado: 'completada' });
    expect(ctx.document.getElementById('cuerpo').innerHTML).not.toContain('Escaneá el seguimiento');

    ctx.PREP = { canal: 'web', estado: 'pendiente_deposito', items: [] };
    ctx.document.getElementById('cuerpo').innerHTML = '';
    ctx.completarTrasRespuesta({ ok: true, estado: 'pendiente_deposito' });
    expect(ctx.document.getElementById('cuerpo').innerHTML).not.toContain('Escaneá el seguimiento');
  });

  it('confirma una sola vez con el tracking crudo y “Lo cargo después” no hace POST', async () => {
    ctx.PREP = { canal: 'web', estado: 'completada', wc_order_id: 44, numero_pedido: 'W-44', comprador: 'Ana', items: [] };
    ctx.SEG = { data: { esperando: [], sin_preparacion: [], a_medias: [] }, guardadosSesion: {} };
    ctx.renderTrackingConfirmacion(' 360003042094910 ', null);
    await Promise.all([ctx.confirmarTrackingFlujo(), ctx.confirmarTrackingFlujo()]);
    expect(respuestas.filter((x) => x.url === '/seguimientos/44')).toHaveLength(1);
    expect(respuestas[0].opts.body).toBe(JSON.stringify({ tracking: '360003042094910' }));

    respuestas = [];
    ctx.loCargoDespuesTracking();
    expect(respuestas).toHaveLength(0);
    expect(ctx.ir).toHaveBeenCalledWith('seguimientos');
  });

  it.each([
    [409, { ok: false, error: 'el pedido ya no está disponible' }, 'el pedido ya no está disponible'],
    [502, { ok: false, colgado: true, error: 'se reintentará solo' }, 'se reintentará solo'],
  ])('muestra el error del backend ante %s sin duplicar la llamada', async (status, body, mensaje) => {
    ctx.api = vi.fn(async () => ({ status, body }));
    ctx.PREP = { canal: 'web', estado: 'completada', wc_order_id: 44, comprador: 'Ana', items: [] };
    ctx.renderTrackingConfirmacion('360003042094910', null);
    await ctx.confirmarTrackingFlujo();
    expect(ctx.document.getElementById('cuerpo').innerHTML).toContain(mensaje);
    expect(ctx.api).toHaveBeenCalledTimes(1);
  });
});
