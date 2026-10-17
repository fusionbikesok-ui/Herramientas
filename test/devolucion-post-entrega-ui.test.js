import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// Sin jsdom: la pantalla corre en un vm con un DOM mínimo.
const script = [...fs.readFileSync('./public/excepciones/index.html', 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
const json = (body) => ({ ok: true, status: 200, json: async () => body });

async function montar(incidentes, me = { ok: true, is_admin: false }, fallaLista = false) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: '', textContent: '', addEventListener() {} });
  const posts = [];
  const sandbox = {
    console, Date, Promise, JSON, Math, Map, Set, Array, Object, String, Number, setTimeout,
    alert() {}, prompt: () => 'cuadro rajado',
    fetch: async (url, opt) => {
      if (opt?.method === 'POST') { posts.push({ url, body: JSON.parse(opt.body) }); return json({ ok: true }); }
      if (url === '/api/auth/me') return json(me);
      if (fallaLista && url.includes('incidentes')) return { ok: false, status: 500, json: async () => ({}) };
      return json({ ok: true, data: url.includes('incidentes') ? incidentes : [] });
    },
    document: { getElementById: el, querySelector: el, addEventListener() {} },
  };
  sandbox.window = sandbox;
  for (const id of ['refresh', 'incidentes', 'proveedor', 'clientes']) sandbox[id] = el(id); // ids globales, como en el navegador
  sandbox.status = ''; // en el navegador `status` suelto es window.status (un string), NO el elemento #status
  vm.createContext(sandbox);
  vm.runInContext(script + '\n;this.__load=load;this.__cla=clasificarCliente;this.__nol=noLlegoCliente;', sandbox);
  await sandbox.__load();
  return { els, posts, sandbox };
}
const dev = (extra = {}) => ({ id: 7, tipo: 'otro', severidad: 'normal', sku: 'FB-65235', producto: 'Atix EX M blanca', cantidad: 1, origen: 'devolucion_cliente',
  ml_order_id: '2000018588847374', creado_en: '2026-10-14T20:00:00Z', expected_version: 1, ...extra });

describe('Excepciones: devoluciones de clientes', () => {
  it('lista la devolución pendiente con Recibir, y no la mezcla con los incidentes comunes', async () => {
    const t = await montar([dev()]);
    expect(t.els.clientes.innerHTML).toContain('FB-65235');
    expect(t.els.clientes.innerHTML).toContain('Atix EX M blanca');
    expect(t.els.clientes.innerHTML).toContain('2000018588847374');
    expect(t.els.clientes.innerHTML).toContain('Recibir');
    expect(t.els.incidentes.innerHTML).not.toContain('FB-65235');
  });
  it('recibida: ofrece Disponible y Dañada; cada una llama a su endpoint', async () => {
    const t = await montar([dev({ recibido_en: '2026-10-16T10:00:00Z', expected_version: 2 })]);
    expect(t.els.clientes.innerHTML).toContain('Disponible');
    await t.sandbox.__cla(7, true);
    await t.sandbox.__cla(7, false);
    expect(t.posts[0]).toMatchObject({ url: '/api/stock-exceptions/devoluciones/7/clasificar', body: { clasificacion: 'disponible', expected_version: 2 } });
    expect(t.posts[1]).toMatchObject({ url: '/api/stock-exceptions/devoluciones/7/dano', body: { motivo: 'cuadro rajado' } });
  });
  it('«No llegó» solo se ofrece a un admin y pide motivo; llama a su endpoint', async () => {
    const comun = await montar([dev()]);
    expect(comun.els.clientes.innerHTML).not.toContain('No llegó');
    const t = await montar([dev()], { ok: true, is_admin: true });
    expect(t.els.clientes.innerHTML).toContain('No llegó');
    await t.sandbox.__nol(7);
    expect(t.posts[0]).toMatchObject({ url: '/api/stock-exceptions/devoluciones/7/no-llego', body: { motivo: 'cuadro rajado', expected_version: 1 } });
    t.sandbox.prompt = () => '   ';
    await t.sandbox.__nol(7);
    expect(t.posts).toHaveLength(1); // sin motivo no se envía
  });
  it('con scopes [all] pero sin is_admin NO se ofrece «No llegó» (el endpoint exige is_admin)', async () => {
    const t = await montar([dev()], { ok: true, is_admin: false, scopes: ['all'] });
    expect(t.els.clientes.innerHTML).not.toContain('No llegó');
  });
  it('una devolución ya recibida no ofrece «No llegó»', async () => {
    const t = await montar([dev({ recibido_en: 'x' })], { ok: true, is_admin: true });
    expect(t.els.clientes.innerHTML).not.toContain('No llegó');
  });
  it('muestra la orden ML y también el pedido Woo', async () => {
    const t = await montar([dev({ wc_order_id: 70010 })]);
    expect(t.els.clientes.innerHTML).toContain('2000018588847374');
    expect(t.els.clientes.innerHTML).toContain('pedido Woo 70010');
  });
  it('el estado de la pantalla sale del elemento #status: «Actualizado» al cargar y el error si falla', async () => {
    const ok = await montar([dev()]);
    expect(ok.els.status.textContent).toMatch(/^Actualizado/);
    const mal = await montar([dev()], { ok: true, is_admin: false }, true);
    expect(mal.els.status.textContent).toMatch(/^No se pudo cargar/);
  });
  it('muestra el estado del cierre en Woo, incluido el error que se reintenta', async () => {
    const t = await montar([dev({ recibido_en: 'x', clasificacion: 'disponible', woo_cierre_estado: 'error', woo_cierre_error: 'woo caído' })]);
    expect(t.els.clientes.innerHTML).toContain('woo caído');
  });
});
