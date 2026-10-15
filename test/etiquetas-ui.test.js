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
    querySelector() { return null; },
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

describe('Completar envío: polling de la foto y tracking automático', () => {
  const respuesta = (body, status = 200) => Promise.resolve({ status, ok: status < 400, json: () => Promise.resolve(body) });
  function fila(id, wc) {
    ctx.document.querySelector = (sel) => (sel.includes(`data-prep="${id}"`) ? { getAttribute: () => String(wc) } : null);
    ctx.document.getElementById(`cierre-trk-${id}`).value = '360003042094910';
  }
  it('al llegar a listo manda el tracking tipeado con el mismo POST /seguimientos', async () => {
    fila(5, 55);
    const estados = ['procesando', 'listo'];
    ctx.fetch = vi.fn((url) => String(url).includes('/estado')
      ? respuesta({ ok: true, foto: { estado_proceso: estados.shift() } })
      : respuesta({ ok: true }));
    ctx.window.fetch = ctx.fetch;
    ctx.CIERRE_SONDEO_MS = 1;
    ctx.cargarCierres = vi.fn();
    await ctx.cierreEsperarFoto(5, 9);
    const post = ctx.fetch.mock.calls.find(([u]) => String(u).endsWith('/seguimientos/55'));
    expect(post).toBeTruthy();
    expect(JSON.parse(post[1].body)).toEqual({ tracking: '360003042094910' });
  });
  it('si la foto queda en error ofrece Reintentar, no manda el tracking y no pierde lo tipeado', async () => {
    fila(6, 66);
    ctx.fetch = vi.fn(() => respuesta({ ok: true, foto: { estado_proceso: 'error', error: 'boom' } }));
    ctx.window.fetch = ctx.fetch;
    await ctx.cierreEsperarFoto(6, 10);
    expect(ctx.document.getElementById('cierre-msg-6').innerHTML).toContain('Reintentar');
    expect(ctx.fetch.mock.calls.some(([u]) => String(u).includes('/seguimientos/'))).toBe(false);
    expect(ctx.document.getElementById('cierre-trk-6').value).toBe('360003042094910');
  });
  it('si se agota la espera también ofrece Reintentar', async () => {
    fila(7, 77);
    ctx.CIERRE_ESPERA_MS = 5; ctx.CIERRE_SONDEO_MS = 1;
    ctx.fetch = vi.fn(() => respuesta({ ok: true, foto: { estado_proceso: 'procesando' } }));
    ctx.window.fetch = ctx.fetch;
    await ctx.cierreEsperarFoto(7, 11);
    expect(ctx.document.getElementById('cierre-msg-7').innerHTML).toContain('sigue procesándose');
  });
});

describe('«No salieron con el lote»: Descartar conserva el lote', () => {
  it('el botón lleva el lote_id y el POST lo manda junto al motivo', async () => {
    const html = ctx.cierreFilaHtml({ id: 12, canal: 'ml', numero_pedido: '1', acciones: ['descartar'], lote_id: 31 });
    expect(html).toContain("cierreResolver(12,'descartar-envio',31)");
    ctx.cierreResolver(12, 'descartar-envio', 31);
    ctx.document.getElementById('cierre-motivo-12').value = 'no salió';
    ctx.fetch = vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }));
    ctx.window.fetch = ctx.fetch; ctx.cargarCierres = vi.fn();
    await ctx.cierreConfirmar(12, 'descartar-envio');
    const post = ctx.fetch.mock.calls.find(([u]) => String(u).includes('/12/descartar-envio'));
    expect(JSON.parse(post[1].body)).toEqual({ motivo: 'no salió', lote_id: 31 });
  });
});

describe('Reintentar la foto de etiqueta', () => {
  const resp = (body, status = 200) => Promise.resolve({ status, json: () => Promise.resolve(body) });
  it('en error: primero POST /:id/foto/:fotoId/reintentar y recién después sondea', async () => {
    const orden = [];
    ctx.fetch = vi.fn((url, opts) => {
      orden.push(`${opts?.method || 'GET'} ${url}`);
      return String(url).includes('/estado') ? resp({ ok: true, foto: { estado_proceso: 'listo' } }) : resp({ ok: true });
    });
    ctx.window.fetch = ctx.fetch; ctx.cargarCierres = vi.fn();
    await ctx.cierreReintentarFoto(4, 20, true);
    expect(orden[0]).toBe('POST /api/preparacion/4/foto/20/reintentar');
    expect(orden[1]).toContain('/api/preparacion/fotos/20/estado');
  });
  it('si el servidor rechaza el reintento no sondea y vuelve a ofrecer Reintentar', async () => {
    ctx.fetch = vi.fn(() => resp({ ok: false, error: 'no' }, 409));
    ctx.window.fetch = ctx.fetch;
    await ctx.cierreReintentarFoto(4, 20, true);
    expect(ctx.fetch.mock.calls.some(([u]) => String(u).includes('/estado'))).toBe(false);
    expect(ctx.document.getElementById('cierre-msg-4').innerHTML).toContain('Reintentar');
  });
  it('por timeout (sigue pendiente): solo re-sondea, sin POST de reintento', async () => {
    ctx.fetch = vi.fn(() => resp({ ok: true, foto: { estado_proceso: 'listo' } }));
    ctx.window.fetch = ctx.fetch; ctx.cargarCierres = vi.fn();
    await ctx.cierreReintentarFoto(4, 20, false);
    expect(ctx.fetch.mock.calls.every(([, o]) => !o || o.method !== 'POST')).toBe(true);
    expect(ctx.fetch.mock.calls.some(([u]) => String(u).includes('/estado'))).toBe(true);
  });
});

describe('aviso visible de la barra de etiquetas', () => {
  it('muestra rechazos con motivo y el éxito dentro de la vista (role=status), y sobrevive al re-render', async () => {
    ctx.VISTA = 'pendientes'; ctx.PEND_STATUS = 'ready'; ctx.PEND_META = {}; ctx.PEND_CACHE = [ml()];
    ctx.cargarPendientes = vi.fn();
    ctx.fetch = vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, pdf_base64: null, aceptados: [], rechazados: [{ clave: 'ml:2001', motivo: 'no se pudo verificar el pack' }] }) }));
    ctx.window.fetch = ctx.fetch;
    await ctx.bajarEtiquetasMl(['ml:2001']);
    expect(ctx.document.getElementById('etq-aviso').textContent).toContain('#2001 — no se pudo verificar el pack');
    ctx.renderPendientes();
    const html = ctx.document.getElementById('cuerpo').innerHTML;
    expect(html).toContain('id="etq-aviso"');
    expect(html).toContain('role="status"');
    expect(html).toContain('no se pudo verificar el pack');
  });
  it('si el navegador bloquea la ventana del PDF no lo da por bajado', async () => {
    ctx.VISTA = 'otra'; ctx.PEND_STATUS = 'ready'; ctx.PEND_META = {}; ctx.PEND_CACHE = [ml()];
    ctx.fetch = vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, pdf_base64: 'JVBERg==', aceptados: ['ml:2001'], rechazados: [] }) }));
    ctx.window.fetch = ctx.fetch;
    ctx.URL = { createObjectURL: () => 'blob:x' }; ctx.Blob = Blob; ctx.atob = atob; ctx.Uint8Array = Uint8Array;
    ctx.window.open = () => null;
    await ctx.bajarEtiquetasMl(['ml:2001']);
    const t = ctx.document.getElementById('etq-aviso').textContent;
    expect(t).not.toContain('PDF bajado');
    expect(t).toContain('bloqueó la ventana');
  });
  it('tras re-renderizar con casillas tildadas la barra vuelve a mostrarse', () => {
    const toggles = [];
    ctx.document.getElementById('etq-lote').classList.toggle = (c, on) => toggles.push([c, on]);
    ctx.PEND_STATUS = 'ready'; ctx.PEND_META = {}; ctx.PEND_CACHE = [ml()];
    ctx.ETQ_SEL = { 'ml:2001': true };
    ctx.renderPendientes();
    expect(toggles).toContainEqual(['on', true]);
  });
  it('«Ver lista» usa clase con color de tokens', () => {
    ctx.PEND_STATUS = 'ready'; ctx.PEND_META = {}; ctx.PEND_CACHE = [ml()];
    ctx.renderPendientes();
    expect(ctx.document.getElementById('cuerpo').innerHTML).toContain('class="lnk-tema"');
  });
});

describe('Descartar con motivo vacío', () => {
  it('mantiene el campo abierto y le devuelve el foco', async () => {
    ctx.cierreResolver(12, 'descartar-envio', 31);
    const input = ctx.document.getElementById('cierre-motivo-12');
    input.value = '   '; input.focus = vi.fn(); input.parentNode = { appendChild() {} };
    ctx.document.createElement = () => ({});
    const antes = ctx.document.getElementById('cierre-msg-12').innerHTML;
    await ctx.cierreConfirmar(12, 'descartar-envio');
    expect(input.focus).toHaveBeenCalled();
    expect(ctx.document.getElementById('cierre-msg-12').innerHTML).toBe(antes);
  });
});

describe('contenedor de mensaje vacío', () => {
  it('.ped-nota sin texto se oculta (no deja franja amarilla)', () => {
    expect(HTML).toMatch(/\.ped-nota:empty\s*\{\s*display:\s*none/);
  });
});

