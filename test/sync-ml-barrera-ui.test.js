import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// Sin jsdom en el repo (ver test/api.test.js): el script de public/sync-ml/index.html se ejecuta en un vm con un DOM
// mínimo a mano. Cubre el formulario "Confirmar descuento" de la barrera de venta (E-0).
const html = fs.readFileSync('./public/sync-ml/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const formato = fs.readFileSync('./public/lib/format.js', 'utf8');

const FILA = (over = {}) => ({
  sku: 'BIKE-001', ml_order_id: 'ORD-1', estado: 'bloqueante', woo_confirmado: 1, wc_order_id: 7001,
  incidente_motivo: 'sin_nota_30min', creado_en: new Date().toISOString(), orden_error: null,
  lineas: [{ idx: 0, nombre: 'Bici', cantidad: 1, reduced_stock: 1, confirmada: false, puede_confirmar: true }], ...over,
});

async function montar({ filas = [FILA()], barreraStatus = 200, postRespuesta = { status: 200, body: { ok: true } } } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', hidden: false, className: '', disabled: false, textContent: '', setAttribute() {}, focus() { this.enfocado = true; } });
  const handlers = {};
  const posts = [];
  const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opt) => {
    if (opt?.method === 'POST') { posts.push({ url, body: JSON.parse(opt.body) }); return json(postRespuesta.status, postRespuesta.body); }
    if (url === '/api/sync/barrera') return barreraStatus === 200 ? json(200, { ok: true, filas }) : json(barreraStatus, { ok: false });
    if (url === '/api/sync/dashboard') return json(200, { ok: true, atencion: {}, stock: {}, token: { vigente: true, vence: '2030-01-01' }, ultimasSyncsOk: [], pedidos: {} });
    return json(200, { ok: true, data: [] });
  };
  const sandbox = {
    addEventListener() {}, fetch: fetchImpl, location: { hash: '', replace() {} }, console, Date, Promise, JSON, Math, Set, Array, Object, String, Number, isFinite,
    Api: { installAuth() {} },
    document: {
      querySelector: (s) => el(s), getElementById: (id) => el(id), querySelectorAll: () => [],
      addEventListener: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    },
  };
  sandbox.window = sandbox; // format.js cuelga esc/money/n del window: así quedan como globales del script
  vm.createContext(sandbox);
  vm.runInContext(formato, sandbox);
  vm.runInContext(scripts[0].replace('Api.installAuth();', ''), sandbox);
  await new Promise((r) => setTimeout(r, 20)); // cargar() inicial
  vm.runInContext("open.add('barr'); renderInc();", sandbox);
  const click = async (dataset) => {
    for (const h of handlers.click) h({ target: { closest: () => ({ id: '', dataset, closest: () => null }) } });
    await new Promise((r) => setTimeout(r, 20));
  };
  const escribir = (v) => handlers.input.forEach((h) => h({ target: { value: v, dataset: { confMotivo: '' } } }));
  return { sandbox, els, click, escribir, posts, inc: () => els['#inc'].innerHTML };
}

describe('sync-ml: formulario "Confirmar descuento" de la barrera', () => {
  it('muestra el botón solo si la línea califica y abre un textarea inline (sin prompt)', async () => {
    const t = await montar();
    expect(t.inc()).toContain('data-conf-abrir');
    expect(t.inc()).not.toContain('<textarea');
    await t.click({ confAbrir: 'BIKE-001|ORD-1|0' });
    expect(t.inc()).toContain('<textarea');
    expect(html).not.toMatch(/\b(prompt|confirm|alert)\s*\(/);
  });

  it('sin botón si puede_confirmar=false, si ya está confirmada o si el usuario no es admin', async () => {
    const no = await montar({ filas: [FILA({ lineas: [{ idx: 0, nombre: 'Bici', cantidad: 1, reduced_stock: 2, confirmada: false, puede_confirmar: false }] })] });
    expect(no.inc()).not.toContain('data-conf-abrir');
    const ya = await montar({ filas: [FILA({ lineas: [{ idx: 0, nombre: 'Bici', cantidad: 1, reduced_stock: 1, confirmada: true, puede_confirmar: false }] })] });
    expect(ya.inc()).toContain('Descuento confirmado');
    expect(ya.inc()).not.toContain('data-conf-abrir');
    const noAdmin = await montar({ barreraStatus: 403 });
    expect(noAdmin.inc()).not.toContain('data-conf-abrir');
  });

  it('un motivo vacío o de solo espacios no envía nada y muestra el error', async () => {
    const t = await montar();
    await t.click({ confAbrir: 'BIKE-001|ORD-1|0' });
    await t.click({ confOk: '', sku: 'BIKE-001', ord: 'ORD-1', idx: '0' });
    expect(t.posts).toHaveLength(0);
    t.escribir('   ');
    await t.click({ confOk: '', sku: 'BIKE-001', ord: 'ORD-1', idx: '0' });
    expect(t.posts).toHaveLength(0);
    expect(t.inc()).toContain('Escribí el motivo');
  });

  it('con motivo envía el POST con sku, orden, línea y motivo', async () => {
    const t = await montar();
    await t.click({ confAbrir: 'BIKE-001|ORD-1|0' });
    t.escribir('  Woo descontó, la nota viene con otro texto  ');
    await t.click({ confOk: '', sku: 'BIKE-001', ord: 'ORD-1', idx: '0' });
    expect(t.posts).toEqual([{ url: '/api/sync/barrera/confirmar-descuento', body: { sku: 'BIKE-001', ml_order_id: 'ORD-1', linea: 0, motivo: 'Woo descontó, la nota viene con otro texto' } }]);
  });

  it('un 502 se muestra con el mensaje legible del servidor y el formulario sigue abierto', async () => {
    const t = await montar({ postRespuesta: { status: 502, body: { ok: false, error: 'No se pudo leer el pedido 7001 en Woo. Reintentá en unos minutos.' } } });
    await t.click({ confAbrir: 'BIKE-001|ORD-1|0' });
    t.escribir('motivo');
    await t.click({ confOk: '', sku: 'BIKE-001', ord: 'ORD-1', idx: '0' });
    expect(t.inc()).toContain('Reintentá en unos minutos');
    expect(t.inc()).toContain('<textarea');
  });

  it('no-admin (403): no se afirma "✓ Ventas esperando descuento" en la línea de al día', async () => {
    const t = await montar({ barreraStatus: 403 });
    expect(t.inc()).not.toContain('Ventas esperando descuento');
  });

  it('con la consulta sana y sin barreras sí figura al día', async () => {
    const t = await montar({ filas: [] });
    expect(t.inc()).toContain('Ventas esperando descuento');
  });

  it('tras confirmar con éxito el formulario se cierra y el error viejo se limpia antes del recargado', async () => {
    const t = await montar();
    await t.click({ confAbrir: 'BIKE-001|ORD-1|0' });
    await t.click({ confOk: '', sku: 'BIKE-001', ord: 'ORD-1', idx: '0' }); // vacío → error
    expect(t.inc()).toContain('Escribí el motivo');
    t.escribir('motivo');
    // el recargado queda colgado: el estado visible debe estar ya actualizado
    t.sandbox.fetch = async (u, o) => (o?.method === 'POST' ? { status: 200, text: async () => '{"ok":true}' } : new Promise(() => {}));
    await t.click({ confOk: '', sku: 'BIKE-001', ord: 'ORD-1', idx: '0' });
    expect(t.inc()).not.toContain('<textarea');
    expect(t.inc()).not.toContain('Escribí el motivo');
  });

  it('el copy de orden_error es el humano del servidor, sin "WooCommerce API error"', async () => {
    const t = await montar({ filas: [FILA({ orden_error: 'El pedido ya no existe en la web.' })] });
    expect(t.inc()).toContain('El pedido ya no existe en la web.');
    expect(t.inc()).not.toMatch(/WooCommerce API error/);
  });

  it('al abrir/cerrar la sección con el teclado el foco vuelve a la cabecera', async () => {
    const t = await montar();
    await t.click({ k: 'barr' });
    expect(t.els['ih-barr'].enfocado).toBe(true);
  });
});
