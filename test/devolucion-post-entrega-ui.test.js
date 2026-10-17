import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// Sin jsdom: la pantalla corre en un vm con un DOM mínimo.
const script = [...fs.readFileSync('./public/excepciones/index.html', 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
const json = (body) => ({ ok: true, status: 200, json: async () => body });

async function montar(incidentes) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: '', textContent: '', addEventListener() {} });
  const posts = [];
  const sandbox = {
    console, Date, Promise, JSON, Math, Map, Set, Array, Object, String, Number, setTimeout,
    alert() {}, prompt: () => 'cuadro rajado',
    fetch: async (url, opt) => {
      if (opt?.method === 'POST') { posts.push({ url, body: JSON.parse(opt.body) }); return json({ ok: true }); }
      return json({ ok: true, data: url.includes('incidentes') ? incidentes : [] });
    },
    document: { getElementById: el, querySelector: el, addEventListener() {} },
  };
  sandbox.window = sandbox;
  for (const id of ['status', 'refresh', 'incidentes', 'proveedor', 'clientes']) sandbox[id] = el(id); // ids globales, como en el navegador
  vm.createContext(sandbox);
  vm.runInContext(script + '\n;this.__load=load;this.__cla=clasificarCliente;', sandbox);
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
  it('muestra el estado del cierre en Woo, incluido el error que se reintenta', async () => {
    const t = await montar([dev({ recibido_en: 'x', clasificacion: 'disponible', woo_cierre_estado: 'error', woo_cierre_error: 'woo caído' })]);
    expect(t.els.clientes.innerHTML).toContain('woo caído');
  });
});
