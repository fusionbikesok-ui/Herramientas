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

  it('acepta un GTIN válido si no coincide con un código del pedido', () => {
    expect(ctx.validarTrackingEscaneo('4006381333931', []))
      .toEqual({ ok: true, valor: '4006381333931' });
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

  it('bloquea todo el flujo mientras el POST está en vuelo y libera enviando al terminar', async () => {
    let resolver;
    ctx.api = vi.fn(() => new Promise((resolve) => { resolver = resolve; }));
    ctx.PREP = { canal: 'web', estado: 'completada', wc_order_id: 45, comprador: 'Ana', items: [] };
    ctx.renderTrackingConfirmacion('360003042094910', null);

    const confirmacion = ctx.confirmarTrackingFlujo();
    expect(ctx.TRACKING_FLUJO.enviando).toBe(true);
    expect(ctx.document.getElementById('cuerpo').innerHTML).toContain('Escanear de nuevo');
    expect(ctx.document.getElementById('cuerpo').innerHTML).toMatch(/disabled[^>]*>Escanear de nuevo/);
    expect(ctx.document.getElementById('cuerpo').innerHTML).toMatch(/disabled[^>]*>Lo cargo después/);

    ctx.loCargoDespuesTracking();
    expect(ctx.TRACKING_FLUJO.enviando).toBe(true);
    expect(ctx.ir).not.toHaveBeenCalled();

    resolver({ status: 200, body: { ok: true } });
    await confirmacion;
    expect(ctx.TRACKING_FLUJO.enviando).toBe(false);
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

  it('distingue un resultado incierto de un tracking guardado con paso interno pendiente', async () => {
    ctx.PREP = { canal: 'web', estado: 'completada', wc_order_id: 46, comprador: 'Ana', items: [] };
    ctx.api = vi.fn(async () => ({ status: 502, body: { ok: false, colgado: true, incierto: true } }));
    ctx.renderTrackingConfirmacion('360003042094910', null);
    await ctx.confirmarTrackingFlujo();
    expect(ctx.document.getElementById('cuerpo').innerHTML)
      .toContain('Resultado incierto: el sistema lo reconcilia solo; no vuelvas a cargarlo');
    expect(ctx.document.getElementById('cuerpo').innerHTML).not.toContain('El tracking se guardó');
  });

  it('usa el mismo mensaje prudente en Cargar seguimientos ante una respuesta incierta', async () => {
    ctx.SEG = { data: { esperando: [{ wc_order_id: 47, envio: { nombre: 'Ana', pedido: 'W-47' } }], sin_preparacion: [], a_medias: [] }, guardadosSesion: {} };
    ctx.api = vi.fn(async () => ({ status: 502, body: { ok: false, colgado: true, incierto: true } }));
    ctx.refrescarCargadosHoy = vi.fn();
    ctx.toastSeg = vi.fn();
    const input = ctx.document.getElementById('trk-47');
    input.value = '360003042094910';
    await ctx.guardarTracking(47);
    expect(ctx.toastSeg).toHaveBeenCalledWith(
      'Resultado incierto: el sistema lo reconcilia solo; no vuelvas a cargarlo',
      'warn',
    );
  });
});

describe('seguimiento Andreani desde Cargar seguimientos', () => {
  it('abre el mismo flujo desde el botón de una tarjeta y conserva los ítems disponibles', () => {
    const fila = {
      wc_order_id: 77,
      envio: { pedido: 'W-77', nombre: 'Ana', apellido: 'Gómez', localidad: 'Córdoba' },
      items: [{ sku: 'CASCO-9', nombre: 'Casco', cantidad: 2 }],
    };
    expect(ctx.cardSeguimiento(fila, 'esperando')).toContain('abrirFlujoTrackingDesdeSeguimiento(77)');
    ctx.SEG = { data: { esperando: [fila], sin_preparacion: [], a_medias: [] }, guardadosSesion: {} };
    ctx.abrirFlujoTracking = vi.fn();
    ctx.abrirFlujoTrackingDesdeSeguimiento(77);
    expect(ctx.abrirFlujoTracking).toHaveBeenCalledWith({
      wcOrderId: 77,
      cliente: fila.envio,
      items: fila.items,
      fila,
      origen: 'seguimientos',
    });
  });

  it('filtra por número, nombre, apellido o localidad sin acentos y abre con Enter si queda uno', () => {
    const filas = [
      { wc_order_id: 1, envio: { pedido: 'A-100', nombre: 'Ana', apellido: 'Gómez', localidad: 'Córdoba' } },
      { wc_order_id: 2, envio: { pedido: 'B-200', nombre: 'Bruno', apellido: 'Pérez', localidad: 'Rosario' } },
    ];
    expect(ctx.filasSeguimientoCoincidentes(filas, 'CORDOBA')).toHaveLength(1);
    expect(ctx.filasSeguimientoCoincidentes(filas, 'perez')[0].wc_order_id).toBe(2);
    ctx.abrirFlujoTrackingDesdeSeguimiento = vi.fn();
    ctx.onBuscarSegKeydown({ key: 'Enter', preventDefault: vi.fn() }, filas, 'rosario');
    expect(ctx.abrirFlujoTrackingDesdeSeguimiento).toHaveBeenCalledWith(2);
  });

  it('deja el botón secundario visible y diferido sin POST ni confirmación', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(source).toContain('Lo cargo después');
    expect(source.match(/function loCargoDespuesTracking\(\)\{[^}]*\}/)?.[0]).not.toContain('confirm(');
    ctx.confirm = vi.fn(() => false);
    ctx.PREP = { canal: 'web', estado: 'completada', wc_order_id: 77, items: [] };
    ctx.SEG = { data: { esperando: [], sin_preparacion: [], a_medias: [] }, guardadosSesion: {} };
    ctx.loCargoDespuesTracking();
    expect(respuestas).toHaveLength(0);
    expect(ctx.ir).toHaveBeenCalledWith('seguimientos');
    expect(ctx.confirm).not.toHaveBeenCalled();
  });

  it('usa una única apertura parametrizada para completar y tarjeta', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect((source.match(/function abrirFlujoTracking\(/g) || []).length).toBe(1);
    expect(source).toContain('function abrirFlujoTracking(opciones)');
    expect(source).toContain('abrirFlujoTrackingDesdeSeguimiento');
  });

  it('al confirmar desde una tarjeta quita esa tarjeta del DOM', async () => {
    const card = { remove: vi.fn(), focus: vi.fn(), closest: vi.fn(() => null) };
    ctx.document.getElementById = vi.fn(() => card);
    ctx.PREP = { canal: 'web', wc_order_id: 77, items: [] };
    ctx.SEG = { data: { esperando: [], sin_preparacion: [], a_medias: [] }, guardadosSesion: {} };
    ctx.VISTA = 'seguimientos';
    ctx.abrirFlujoTracking({ wcOrderId: 77, origen: 'seguimientos', fila: { wc_order_id: 77, envio: {} }, items: [] });
    ctx.renderTrackingConfirmacion('360003042094910', null);
    await ctx.confirmarTrackingFlujo();
    expect(card.remove).toHaveBeenCalled();
  });
});

// Hotfix prod f26bcd91 (pedido web 70502): un refrescarDetalle en vuelo resolvía después de abrirFlujoTracking y
// renderDetalle() pisaba #cuerpo, borrando el overlay "Escaneá el seguimiento".
describe('el flujo de seguimiento no se borra con repintados tardíos del detalle', () => {
  let real;
  let cuerpo;
  beforeEach(() => {
    const document = documentoFake();
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
    real = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8'), real);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/api.js'), 'utf8'), real);
    vm.runInContext(extraerScript(fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8')), real);
    real.beep = vi.fn();
    cuerpo = document.getElementById('cuerpo');
  });

  const prep = () => ({ id: 493, canal: 'web', estado: 'completada', wc_order_id: 70502, numero_pedido: '70502', comprador: 'Ana', items: [], eventos: [], fotos_generales: [] });

  it('un refrescarDetalle en vuelo que resuelve después no pisa el overlay', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    let liberar;
    const tardia = new Promise((r) => { liberar = r; });
    real.api = vi.fn(async (url) => {
      if (url === '/493') { await tardia; return { status: 200, body: { ok: true, data: prep() } }; }
      if (url === '/493/etiquetas-manuales') return { status: 200, body: { ok: true, data: [] } };
      if (url === '/seguimientos') return { status: 200, body: { ok: true, data: {} } };
      return { status: 200, body: { ok: true } };
    });
    const refresco = real.refrescarDetalle();
    await real.abrirFlujoTracking();
    const overlay = cuerpo.innerHTML;
    expect(overlay).toContain('tracking-flujo-input');
    liberar();
    await refresco;
    expect(cuerpo.innerHTML).toBe(overlay);
    expect(real.TRACKING_FLUJO.activo).toBe(true);
  });

  it('renderDetalle no pinta mientras el flujo de preparación está abierto, y pinta al cerrarlo', () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true, data: {} } }));
    real.abrirFlujoTracking();
    const overlay = cuerpo.innerHTML;
    real.renderDetalle();
    expect(cuerpo.innerHTML).toBe(overlay);
    real.TRACKING_FLUJO.activo = false;
    real.renderDetalle();
    expect(cuerpo.innerHTML).not.toBe(overlay);
  });

  it('un refresco tardío no resucita el detalle después de salir a Cargar seguimientos', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    let liberar;
    const tardia = new Promise((r) => { liberar = r; });
    real.api = vi.fn(async (url) => {
      if (url === '/493') { await tardia; return { status: 200, body: { ok: true, data: prep() } }; }
      return { status: 200, body: { ok: true, data: [] } };
    });
    const refresco = real.refrescarDetalle();
    real.PREP = null; real.VISTA = 'seguimientos';
    cuerpo.innerHTML = 'SEGUIMIENTOS';
    liberar();
    await refresco;
    expect(cuerpo.innerHTML).toBe('SEGUIMIENTOS');
    expect(real.PREP).toBe(null);
  });

  it('completar espera a que terminen las subidas de foto antes de llamar /completar', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.SUBIDAS_PENDIENTES['tmp-1'] = { itemId: null, tipo: 'paquete' };
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true, estado: 'pendiente_deposito', data: prep() } }));
    real.alert = () => {};
    let ticks = 0;
    real.setTimeout = (fn) => { ticks++; if (ticks === 2) delete real.SUBIDAS_PENDIENTES['tmp-1']; fn(); return 1; };
    await real.completar();
    const llamadas = real.api.mock.calls.map((c) => c[0]);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(llamadas).toContain('/493/completar');
  });

  it('una subida fallida corta de inmediato con aviso claro, sin esperar ni llamar /completar', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.SUBIDAS_PENDIENTES['tmp-1'] = { itemId: null, tipo: 'paquete', fallida: true };
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    real.flash = vi.fn();
    let esperas = 0;
    real.setTimeout = (fn) => { esperas++; fn(); return 1; };
    await real.completar();
    expect(esperas).toBe(0);
    expect(real.api).not.toHaveBeenCalled();
    expect(real.flash).toHaveBeenCalledWith('bad', expect.stringContaining('1 foto sin subir'));
  });

  it('un doble toque en Finalizar hace un solo /completar', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.SUBIDAS_PENDIENTES['tmp-1'] = { itemId: null, tipo: 'paquete' };
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true, estado: 'pendiente_deposito', data: prep() } }));
    let ticks = 0;
    real.setTimeout = (fn) => { ticks++; if (ticks === 2) delete real.SUBIDAS_PENDIENTES['tmp-1']; fn(); return 1; };
    await Promise.all([real.completar(), real.completar()]);
    expect(real.api.mock.calls.filter((c) => c[0] === '/493/completar')).toHaveLength(1);
  });

  it('si el operario cambia de pedido durante la espera, no completa el pedido equivocado', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.SUBIDAS_PENDIENTES['tmp-1'] = { itemId: null, tipo: 'paquete' };
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    let ticks = 0;
    real.setTimeout = (fn) => {
      ticks++;
      if (ticks === 2) { delete real.SUBIDAS_PENDIENTES['tmp-1']; real.PREP = { ...prep(), id: 777 }; }
      fn(); return 1;
    };
    await real.completar();
    expect(real.api).not.toHaveBeenCalled();
  });

  it('salir del overlay con ir() cierra el flujo y abrir otro pedido pinta (Atrás del celular)', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.api = vi.fn(async (url) => {
      if (url === '/seguimientos') return { status: 200, body: { ok: true, data: {} } };
      if (url === '/777') return { status: 200, body: { ok: true, data: { ...prep(), id: 777, wc_order_id: 70999, numero_pedido: '70999', estado: 'en_preparacion' } } };
      return { status: 200, body: { ok: true, data: [] } };
    });
    await real.abrirFlujoTracking();
    expect(real.TRACKING_FLUJO.activo).toBe(true);
    // ir() y abrirDetalle() arrancan con esta llamada (se verifica abajo); ir() entero necesita un DOM real.
    real.cerrarFlujoTrackingAlSalir();
    expect(real.TRACKING_FLUJO.activo).toBe(false);
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(html).toMatch(/function ir\(v\)\{\n {2}cerrarFlujoTrackingAlSalir\(\);/);
    expect(html).toMatch(/async function abrirDetalle\(id,empujar\)\{\n {2}cerrarFlujoTrackingAlSalir\(\);/);
    real.modoPedido = vi.fn(); real.ocultarAvisoNuevosPendientes = vi.fn();
    real.PREP = null; real.VISTA = 'pendientes';
    cuerpo.innerHTML = 'Cargando…';
    await real.abrirDetalle(777);
    expect(cuerpo.innerHTML).not.toBe('Cargando…');
  });

  it('con el flag activo pero otra pantalla/pedido, renderDetalle igual pinta', () => {
    real.PREP = { ...prep(), id: 888, wc_order_id: 71000, estado: 'en_preparacion' };
    real.VISTA = 'detalle';
    real.TRACKING_FLUJO.activo = true;
    real.TRACKING_FLUJO.wcOrderId = 70502; // flujo de otro pedido
    cuerpo.innerHTML = 'Cargando…';
    real.renderDetalle();
    expect(cuerpo.innerHTML).not.toBe('Cargando…');
  });

  it('con un POST en vuelo, salir de la pantalla no cierra el flujo', () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true, data: {} } }));
    real.abrirFlujoTracking();
    real.TRACKING_FLUJO.enviando = true;
    real.cerrarFlujoTrackingAlSalir();
    expect(real.TRACKING_FLUJO.activo).toBe(true);
  });

  it('el reintento de una foto fallida limpia la marca fallida', () => {
    real.PREP = prep();
    real.SUBIDAS_PENDIENTES['tmp-9'] = { itemId: null, tipo: 'paquete', archivo: {}, fallida: true };
    real.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
    real.fetch = vi.fn(() => new Promise(() => {}));
    real.FormData = class { append() {} };
    real.AbortController = class { constructor() { this.signal = {}; } abort() {} };
    real.document.querySelector = () => ({ classList: { remove() {} }, querySelector() { return null; } });
    real.reintentarSubidaLocal('tmp-9');
    expect(real.SUBIDAS_PENDIENTES['tmp-9'].fallida).toBeUndefined();
  });

  async function confirmarSaliendoEnVuelo(respuesta) {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true, data: {} } }));
    await real.abrirFlujoTracking();
    real.TRACKING_FLUJO.tracking = 'AND123';
    real.TRACKING_FLUJO.fila = { envio: { pedido: '70502' } };
    let liberar;
    real.enviarTracking = vi.fn(() => new Promise((r) => { liberar = r; }));
    real.flash = vi.fn();
    real.ir = vi.fn();
    const p = real.confirmarTrackingFlujo();
    // el operario sale con el POST en vuelo: el flujo sigue activo (enviando) pero la pantalla es otro pedido
    real.cerrarFlujoTrackingAlSalir();
    real.PREP = { ...prep(), id: 777, wc_order_id: 70999, estado: 'en_preparacion' };
    cuerpo.innerHTML = 'OTRO PEDIDO';
    liberar(respuesta);
    await p;
  }

  it('POST en vuelo que termina bien con el operario ya en otro pedido: no navega ni repinta', async () => {
    await confirmarSaliendoEnVuelo({ status: 200, body: { ok: true } });
    expect(real.ir).not.toHaveBeenCalled();
    expect(cuerpo.innerHTML).toBe('OTRO PEDIDO');
    expect(real.TRACKING_FLUJO.activo).toBe(false);
    expect(real.flash).toHaveBeenCalledWith('ok', expect.stringContaining('AND123'));
  });

  it('POST en vuelo que falla con el operario ya en otro pedido: avisa con flash y no repinta', async () => {
    await confirmarSaliendoEnVuelo({ status: 500, body: { ok: false, error: 'Falló Andreani' } });
    expect(cuerpo.innerHTML).toBe('OTRO PEDIDO');
    expect(real.TRACKING_FLUJO.activo).toBe(false);
    expect(real.flash).toHaveBeenCalledWith('bad', 'Falló Andreani');
  });

  it('POST en vuelo que termina bien con el flujo todavía abierto: navega a seguimientos', async () => {
    real.PREP = prep();
    real.VISTA = 'detalle';
    real.api = vi.fn(async () => ({ status: 200, body: { ok: true, data: {} } }));
    await real.abrirFlujoTracking();
    real.TRACKING_FLUJO.tracking = 'AND123';
    real.TRACKING_FLUJO.fila = { envio: { pedido: '70502' } };
    real.enviarTracking = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    real.ir = vi.fn();
    await real.confirmarTrackingFlujo();
    expect(real.ir).toHaveBeenCalledWith('seguimientos');
  });
});
