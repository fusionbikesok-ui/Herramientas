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
  it('ofrece recarga explícita cuando guardar horarios recibe VERSION_CONFLICT', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(html).toContain("r.status===409 && r.body.code==='VERSION_CONFLICT'");
    expect(html).toContain("recargar.textContent='Recargar horarios'");
    expect(html).toContain('recargar.onclick=cargarHorarios');
  });
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
  it('mantiene error visible y ofrece reintento en vez de presentar cola vacía', () => {
    ctx.PEND_STATUS = 'error';
    ctx.PEND_CACHE = [];
    ctx.renderPendientes();
    const html = ctx.document.getElementById('cuerpo').innerHTML;
    expect(html).toContain('No se pudo cargar la cola');
    expect(html).toContain('cargarPendientes()');
  });
  it('abre por clave estable y conserva controles de accesibilidad de la jornada', () => {
    const pedido = { canal: 'ml', ml_order_id: 'ML-9', numero_pedido: 'ML-9', items: [] };
    expect(ctx.cardPendiente(pedido)).toContain("prepararClave('ml:ML-9')");
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('min-height:44px');
  });
  it('muestra la lista consolidada con cantidades e imágenes', () => {
    const pedidos = [
      { canal:'ml', ml_order_id:'1', items:[{sku:'CASCO-1',nombre:'Casco',cantidad:2,imagen:'https://img.example/casco.jpg'}] },
      { canal:'web', wc_order_id:2, items:[{sku:'CASCO-1',nombre:'Casco',cantidad:1,imagen:'https://img.example/casco.jpg'}] },
    ];
    const html = ctx.renderListaRecoleccion(pedidos);
    expect(html).toContain('Lista de recolección');
    expect(html).toContain('https://img.example/casco.jpg');
    expect(html).toContain('>3<small>unidades</small>');
    expect(html).toContain('2 pedidos');
  });
  it('muestra un fallback explícito cuando el producto no tiene imagen', () => {
    const html = ctx.renderListaRecoleccion([{canal:'web',wc_order_id:2,items:[{sku:'X',nombre:'Producto X',cantidad:1}]}]);
    expect(html).toContain('Producto sin imagen');
    expect(html).toContain('Sin imagen');
  });
  it('conserva foco visible para los controles de la cola', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(html).toContain('.jornada-panel button:focus-visible');
  });
  it('muestra ambos límites para ML/Andreani sin inventar horarios', () => {
    const pedido = { canal: 'ml', logistic_type: 'cross_docking', shipment_limite_original: '2026-09-02T15:30:00-03:00', fecha_despacho_limite: '2026-09-02T15:00:00-03:00', estado_despacho: 'activo', items: [] };
    const html = ctx.cardPendiente(pedido);
    expect(html).toContain('Entrega en acopio:');
    expect(html).toContain('Límite interno:');
    expect(html).not.toContain('17:00');
    expect(ctx.cardPendiente({ canal: 'ml', logistic_type: 'cross_docking', estado_despacho: 'activo', items: [] })).not.toContain('Límite interno:');
    expect(html).toContain('02/09/2026, 15:30');
  });
  it('muestra las reglas operativas de Flex y Web y el diferimiento', () => {
    expect(ctx.cardPendiente({ canal: 'ml', logistic_type: 'self_service', estado_despacho: 'activo', items: [] })).toContain('Salida máxima Flex: 17:00');
    expect(ctx.cardPendiente({ canal: 'web', estado_despacho: 'activo', items: [] })).toContain('Preparar antes de las 15:00');
    const diferido = ctx.cardPendiente({ canal: 'ml', estado_despacho: 'diferido', despacho_motivo: 'SLA_SHIPMENT_HORA_FALTANTE', items: [] });
    expect(diferido).toContain('Despacho diferido');
    expect(diferido).toContain('MercadoLibre no informó una hora límite');
    expect(diferido).toContain('Ver código para diagnóstico');
    expect(diferido).toContain('SLA_SHIPMENT_HORA_FALTANTE');
    expect(diferido).toContain('Queda para el siguiente día');
    expect(ctx.cardPendiente({ canal: 'ml', estado_despacho: 'diferido', despacho_motivo: 'MARGEN_30_MIN_SUPERADO', items: [] })).toContain('margen operativo de 30 minutos');
    expect(ctx.cardPendiente({ canal: 'ml', logistic_type: 'self_service', estado_despacho: 'diferido', despacho_motivo: 'FLEX_SALIDA_17:00_SUPERADA', items: [] })).toContain('salida máxima de Flex');
  });
  it('actualiza la cola en segundo plano sin consultar jornadas ni olas', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    const silencioso = html.match(/async function cargarPendientesSilencioso\(\)\{([\s\S]*?)\n\}/)?.[1] || '';
    expect(silencioso).not.toContain('renderPendientes()');
    expect(html).toContain('async function cargarDatosSilenciosos()');
    expect(html).toContain("var pr=await api('/pendientes')");
    expect(html).toContain('document.getElementById(foco.id)');
    expect(html).toContain('setSelectionRange(seleccion.inicio,seleccion.fin)');
    expect(html).toContain('--focus-ring:#67e8f9');
  });
});
