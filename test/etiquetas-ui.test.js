// Etiquetas en Preparación: UI de «Pedidos a preparar» (parte C, chips, botón de etiqueta ML) y de «Etiquetas pendientes».
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
        addEventListener() {}, removeEventListener() {}, focus() {}, contains() { return false; },
        querySelector() { return { classList: { toggle() {}, add() {} , remove() {} } }; },
      });
      return elementos.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

let ctx;
beforeEach(() => {
  const sandbox = {
    document: documentoFake(), window: null, console, Date, Math, JSON, setTimeout, clearTimeout,
    setInterval() { return 1; }, clearInterval() {},
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: { href: '', pathname: '/preparacion/', search: '' },
    fetch: vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false }) })),
    navigator: {}, alert() {}, confirm() { return true; }, addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/api.js'), 'utf8'), ctx);
  vm.runInContext(extraerScript(HTML), ctx, { filename: 'preparacion-inline.js' });
  ctx.PEND_BASELINE_LISTA = false; ctx.PEND_NUEVOS = {}; ctx.PEND_CACHE = [];
});

const ml = (extra = {}) => ({ canal: 'ml', ml_order_id: '2001', numero_pedido: '2001', items: [{ sku: 'A', nombre: 'Pieza', cantidad: 1 }], estado_preparacion: 'en_preparacion', ...extra });

describe('Pedidos a preparar: menos scroll (parte C)', () => {
  it('ya no incrusta la lista consolidada: muestra «N productos para buscar → Ver lista»', () => {
    ctx.PEND_STATUS = 'ready';
    ctx.PEND_META = {};
    ctx.PEND_CACHE = [ml(), ml({ ml_order_id: '2002', items: [{ sku: 'B', nombre: 'Otra', cantidad: 2 }] })];
    ctx.renderPendientes();
    const html = ctx.document.getElementById('cuerpo').innerHTML;
    expect(html).toContain('2 productos para buscar');
    expect(html).toContain("ir(\\'recoleccion\\')".replace(/\\/g, ''));
    expect(html).not.toContain('Productos a buscar</h');
  });
});

describe('chips de etiqueta', () => {
  it('«etiqueta ✓» solo con foto vigente; «Falta etiqueta» si la marca durable no está', () => {
    expect(ctx.cardPendiente(ml({ etiqueta_foto: true }))).toContain('etiqueta ✓');
    const falta = ctx.cardPendiente(ml({ falta_etiqueta: true }));
    expect(falta).toContain('Falta etiqueta');
    expect(falta).not.toContain('etiqueta ✓');
  });
  it('la marca manual «etiqueta_lista» de web se rotula «etiqueta generada», no «etiqueta ✓»', () => {
    const html = ctx.cardPendiente({ canal: 'web', wc_order_id: 5, numero_pedido: '5', items: [], etiqueta_lista: 1 });
    expect(html).toContain('etiqueta generada');
    expect(html).not.toContain('etiqueta ✓');
  });
});

describe('botón «Etiqueta» de ML', () => {
  it('elegible: botón, casilla y aviso de PDF ya bajado', () => {
    const html = ctx.cardPendiente(ml({ etiqueta_ml: { elegible: true, descargada_en: '2026-10-15T15:00:00Z', descargada_por: 'ana' } }));
    expect(html).toContain('🖨 Etiqueta');
    expect(html).toContain("bajarEtiquetasMl(['ml:2001'])");
    expect(html).toContain('PDF bajado el');
    expect(html).toContain('por ana');
  });
  it('no elegible: muestra el motivo corto y ningún botón', () => {
    const html = ctx.cardPendiente(ml({ etiqueta_ml: { elegible: false, motivo: 'Full' } }));
    expect(html).toContain('Etiqueta: Full');
    expect(html).not.toContain('bajarEtiquetasMl');
  });
  it('substatus printed sin descarga local: «Ya impresa en ML»; web nunca ofrece el botón', () => {
    expect(ctx.cardPendiente(ml({ etiqueta_ml: { elegible: true, impresa_en_ml: true } }))).toContain('Ya impresa en ML');
    expect(ctx.cardPendiente({ canal: 'web', wc_order_id: 1, numero_pedido: '1', items: [] })).not.toContain('bajarEtiquetasMl');
  });
  it('escapa el HTML de los textos que vienen del servidor', () => {
    const html = ctx.cardPendiente(ml({ etiqueta_ml: { elegible: true, descargada_en: '2026-10-15T15:00:00Z', descargada_por: '<img src=x>' } }));
    expect(html).not.toContain('<img src=x>');
  });
});

describe('vista «Etiquetas pendientes»', () => {
  it('está en el menú Más y enruta a cargarCierres', () => {
    expect(HTML).toContain("ir('cierres')");
    expect(HTML).toContain("v==='cierres'");
  });
  it('web sin etiqueta ofrece «Completar envío» con campo de tracking; ML ofrece subir foto; «Salió sin foto» solo si salió', () => {
    const web = ctx.cierreFilaHtml({ id: 7, canal: 'web', wc_order_id: 70, numero_pedido: '70', acciones: ['completar_envio'] });
    expect(web).toContain('Completar envío');
    expect(web).toContain('cierre-trk-7');
    const mlFila = ctx.cierreFilaHtml({ id: 8, canal: 'ml', numero_pedido: '80', acciones: ['subir_foto', 'salio_sin_foto'], salio: true });
    expect(mlFila).toContain('Subir foto con etiqueta');
    expect(mlFila).toContain('Salió sin foto');
    expect(mlFila).not.toContain('cierre-trk-8');
  });
  it('descartar exige motivo antes de llamar al servidor', async () => {
    ctx.cierreResolver(9, 'descartar-envio');
    ctx.document.getElementById('cierre-motivo-9').value = '  ';
    await ctx.cierreConfirmar(9, 'descartar-envio');
    expect(ctx.fetch.mock.calls.filter(([u]) => String(u).includes('descartar-envio'))).toHaveLength(0);
  });
  it('tracking: la foto en proceso no pide volver a subirla', async () => {
    ctx.document.getElementById('cierre-trk-3').value = 'AND123456';
    ctx.fetch = vi.fn(() => Promise.resolve({ status: 409, json: () => Promise.resolve({ ok: false, code: 'FOTO_ETIQUETA_PROCESANDO', error: 'x' }) }));
    ctx.window.fetch = ctx.fetch;
    await ctx.cierreTracking(3, 33);
    expect(ctx.document.getElementById('cierre-msg-3').textContent).toContain('no hace falta volver a subirla');
  });
});

describe('cerrar una preparación web', () => {
  it('sin foto con etiqueta no abre el tracking: deriva a «Etiquetas pendientes»', () => {
    ctx.PREP = { id: 1, canal: 'web', wc_order_id: 5 };
    ctx.abrirFlujoTracking = vi.fn(); ctx.refrescarDetalle = vi.fn();
    ctx.completarTrasRespuesta({ ok: true, estado: 'completada', falta_etiqueta: true });
    expect(ctx.abrirFlujoTracking).not.toHaveBeenCalled();
    expect(ctx.refrescarDetalle).toHaveBeenCalled();
  });
  it('con la etiqueta cargada sigue el comportamiento actual (abre el tracking)', () => {
    ctx.PREP = { id: 1, canal: 'web', wc_order_id: 5 };
    ctx.abrirFlujoTracking = vi.fn(); ctx.refrescarDetalle = vi.fn();
    ctx.completarTrasRespuesta({ ok: true, estado: 'completada', falta_etiqueta: false });
    expect(ctx.abrirFlujoTracking).toHaveBeenCalled();
  });
});

