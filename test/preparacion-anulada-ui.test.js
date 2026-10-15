// E-1b: la UI de Preparación ante una preparación anulada en Woo (heartbeat/acciones con 409, lotes, etiquetas).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HTML = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
const extraerScript = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).reduce((a, b) => (b.length > a.length ? b : a));

function documentoFake() {
  const elementos = new Map();
  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, {
        innerHTML: '', textContent: '', style: {}, classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {}, removeEventListener() {}, focus() {}, contains() { return false; }, insertBefore() {}, firstChild: null,
        querySelector() { return { classList: { toggle() {}, add() {}, remove() {} } }; },
      });
      return elementos.get(id);
    },
    createElement() { return { setAttribute() {}, className: '', textContent: '' }; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

let ctx, respuesta;
beforeEach(() => {
  respuesta = { status: 409, body: { ok: false, code: 'PREPARACION_ANULADA_EN_WOO', error: 'anulado' } };
  const sandbox = {
    document: documentoFake(), window: null, console, Date, Math, JSON, setTimeout, clearTimeout,
    setInterval() { return 1; }, clearInterval() {},
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: { href: '', pathname: '/preparacion/', search: '' },
    fetch: vi.fn(() => Promise.resolve({ status: respuesta.status, json: () => Promise.resolve(respuesta.body) })),
    alert() {}, confirm() { return true; }, addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/api.js'), 'utf8'), ctx);
  vm.runInContext(extraerScript(HTML), ctx, { filename: 'preparacion-inline.js' });
});

describe('preparación abierta que Woo anula', () => {
  it('un 409 PREPARACION_ANULADA_EN_WOO (heartbeat o acción) corta el heartbeat y recarga la vista de solo lectura UNA sola vez', async () => {
    ctx.VISTA = 'detalle';
    ctx.PREP = { id: 7, estado: 'en_preparacion' };
    ctx.detenerHeartbeat = vi.fn();
    let terminar;
    ctx.abrirDetalle = vi.fn(() => new Promise((r) => { terminar = r; }));
    await ctx.api('/7/heartbeat', { method: 'POST' });
    await ctx.api('/7/escanear', { method: 'POST' }); // otra respuesta 409 mientras recarga
    expect(ctx.detenerHeartbeat).toHaveBeenCalledTimes(1);
    expect(ctx.abrirDetalle).toHaveBeenCalledTimes(1);
    expect(ctx.abrirDetalle).toHaveBeenCalledWith(7, false);
    terminar();
  });

  it('un 409 de OTRA preparación (heartbeat tardío) no marca la vista abierta', async () => {
    ctx.VISTA = 'detalle';
    ctx.PREP = { id: 7, estado: 'en_preparacion' };
    ctx.detenerHeartbeat = vi.fn();
    ctx.abrirDetalle = vi.fn(() => Promise.resolve());
    await ctx.api('/9/heartbeat', { method: 'POST' });
    expect(ctx.abrirDetalle).not.toHaveBeenCalled();
    expect(ctx.detenerHeartbeat).not.toHaveBeenCalled();
    await ctx.api('/7/heartbeat', { method: 'POST' });
    expect(ctx.abrirDetalle).toHaveBeenCalledWith(7, false);
  });

  it('fuera de la vista de detalle, o con otro código 409, no hace nada', async () => {
    ctx.VISTA = 'pendientes';
    ctx.PREP = null;
    ctx.abrirDetalle = vi.fn();
    await ctx.api('/7/heartbeat', { method: 'POST' });
    ctx.VISTA = 'detalle';
    ctx.PREP = { id: 7, estado: 'en_preparacion' };
    respuesta = { status: 409, body: { ok: false, code: 'OTRO' } };
    await ctx.api('/7/heartbeat', { method: 'POST' });
    expect(ctx.abrirDetalle).not.toHaveBeenCalled();
  });
});

describe('etiquetas legibles del estado previo', () => {
  it('la insignia usa la etiqueta con tilde', () => {
    const b = ctx.badgeEstadoPrep('anulado_en_woo', 'en_preparacion');
    expect(b).toContain('Anulado en Woo (estaba: en preparación)');
    expect(ctx.badgeEstadoPrep('anulado_en_woo', 'despachada_sin_verificar')).toContain('estaba: despachada sin verificar');
    expect(ctx.etiquetaEstadoPrep('estado_raro_nuevo')).toBe('estado raro nuevo');
  });
});

describe('detalle del lote con un pedido anulado', () => {
  it('el estado del lote se muestra con etiqueta legible, no en crudo', () => {
    expect(ctx.etiquetaEstadoLote('en_preparacion')).toBe('en preparación');
    expect(HTML).not.toContain("esc(l.estado)+' · Jornada");
    expect(HTML).not.toContain("esc(l.estado)+' · Miembros");
  });

  it('el detalle del lote tiene su contenedor de aviso (aria-live) para mostrar el 409', () => {
    const detalle = HTML.slice(HTML.indexOf('async function verDetalleLote'), HTML.indexOf('async function accionLote'));
    expect(detalle).toContain('id="desp-live" class="flash" role="status" aria-live="polite"');
  });

  it('«Cerrar lote» con PREPARACION_ANULADA_EN_WOO muestra el mensaje y NO pide motivo excepcional', async () => {
    const prompt = vi.fn();
    ctx.prompt = prompt;
    ctx.despAviso = vi.fn();
    respuesta = { status: 409, body: { ok: false, code: 'PREPARACION_ANULADA_EN_WOO', error: 'El lote tiene un pedido anulado en Woo (#500)' } };
    await ctx.cerrarLote(3);
    expect(prompt).not.toHaveBeenCalled();
    expect(ctx.despAviso).toHaveBeenCalledWith('El lote tiene un pedido anulado en Woo (#500)', 'bad');
    expect(ctx.fetch.mock.calls.filter((c) => /\/cerrar$/.test(c[0]))).toHaveLength(1); // sin segundo intento con motivo
  });

  it('iniciar y escanear muestran el error del 409 (no se tragan la respuesta)', async () => {
    ctx.despAviso = vi.fn();
    await ctx.accionLote(3, 'iniciar');
    await ctx.escanearLote(3);
    expect(ctx.despAviso).toHaveBeenCalledWith('anulado', 'bad'); // iniciar
  });
});
