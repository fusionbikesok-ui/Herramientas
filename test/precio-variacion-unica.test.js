import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// Bug: "Found different prices in variations | User has not mode me1". ML exige el mismo precio para TODAS las
// variaciones de una publicación, así que ninguna pantalla puede cambiar una variación sola: toda clave con '|'
// va por /actualizar-precio-item. Sin jsdom: los scripts se ejecutan en un vm con un DOM mínimo.
const formato = fs.readFileSync('./public/lib/format.js', 'utf8');
const scriptsDe = (ruta) => [...fs.readFileSync(ruta, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const json = (status, body) => ({ status, text: async () => JSON.stringify(body), json: async () => body });
const esperar = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function elemento() {
  return { innerHTML: '', textContent: '', className: '', style: {}, value: '', dataset: {}, disabled: false, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, focus() {}, closest: () => null };
}

function montar(ruta, extra = {}) {
  const els = {};
  const el = (id) => (els[id] ||= elemento());
  const posts = [];
  const respuestas = extra.respuestas || {};
  const fetchImpl = async (url, opt) => {
    if (opt?.method === 'POST') {
      const body = JSON.parse(opt.body);
      posts.push({ url, body });
      const r = respuestas[url];
      return typeof r === 'function' ? r(body) : json(200, { ok: true });
    }
    if (url === '/api/sync/dashboard') return json(200, { ok: true, atencion: {}, stock: {}, token: { vigente: true, vence: '2030-01-01' }, ultimasSyncsOk: [], pedidos: {} });
    return json(200, { ok: true, data: [], filas: [], resultados: [] });
  };
  const sandbox = {
    addEventListener() {}, fetch: fetchImpl, location: { hash: '', replace() {}, pathname: '/x/', href: '', search: '' }, console,
    Date, Promise, JSON, Math, Set, Array, Object, String, Number, isFinite, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    confirm: () => true, alert() {},
    Api: { installAuth() {} },
    document: { querySelector: (s) => el(s), getElementById: (id) => el(id), querySelectorAll: () => [], addEventListener() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(formato, sandbox);
  const scripts = scriptsDe(ruta);
  const principal = scripts.reduce((a, b) => (b.length > a.length ? b : a));
  vm.runInContext(principal.replace('Api.installAuth();', ''), sandbox);
  return { sandbox, posts };
}

describe('precios: aplicar objetivos en lote', () => {
  async function aplicar(claves, precios) {
    const t = montar('./public/precios/index.html');
    const obj = Object.fromEntries(claves.map((k, i) => [k, { clave: k, precio: precios[i], delta: 1 }]));
    t.sandbox.__obj = obj; t.sandbox.__claves = claves;
    vm.runInContext("OBJ=__obj; SEL={}; __claves.forEach(function(k){SEL[k]=true}); cargar=async function(){}; estado=function(){}; refrescarBarra=function(){};", t.sandbox);
    await vm.runInContext('aplicarObjetivos()', t.sandbox);
    await esperar();
    return t.posts;
  }

  it('UNA sola variación de una publicación con variaciones va por /actualizar-precio-item', async () => {
    const posts = await aplicar(['MLA1479615111|187088788927'], [75000]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ url: '/api/precios/actualizar-precio-item', body: { itemId: 'MLA1479615111', precio: 75000 } });
  });

  it('varias variaciones juntas usan el precio más alto; una publicación simple sigue por /actualizar-precio', async () => {
    const posts = await aplicar(['MLA1|11', 'MLA1|12', 'MLA2'], [70000, 80000, 50000]);
    expect(posts).toEqual([
      { url: '/api/precios/actualizar-precio-item', body: { itemId: 'MLA1', precio: 80000 } },
      { url: '/api/precios/actualizar-precio', body: { clave: 'MLA2', precio: 50000 } },
    ]);
  });
});

describe('sync-ml: aplicarPlan', () => {
  async function aplicar(plan, respuestas) {
    const t = montar('./public/sync-ml/index.html', { respuestas });
    t.sandbox.__plan = plan;
    vm.runInContext('planPrecios=__plan; cargar=async function(){};', t.sandbox);
    await vm.runInContext('aplicarPlan()', t.sandbox);
    await esperar();
    return t.posts;
  }
  const fila = (clave, precio) => ({ clave, item_id: clave.split('|')[0], precio });

  it('una sola variación va por /actualizar-precio-item y la reactivación recibe el item_id', async () => {
    const posts = await aplicar([fila('MLA1|11', 75000)]);
    expect(posts[0]).toEqual({ url: '/api/precios/actualizar-precio-item', body: { itemId: 'MLA1', precio: 75000 } });
    expect(posts[1]).toEqual({ url: '/api/sync/reactivar', body: { itemIds: ['MLA1'] } });
  });

  it('agrupa las variaciones por item con el precio máximo; las simples quedan como están; reactivar sin duplicados', async () => {
    const posts = await aplicar([fila('MLA1|11', 70000), fila('MLA1|12', 80000), fila('MLA2', 50000)]);
    expect(posts.filter((p) => p.url.includes('actualizar-precio'))).toEqual([
      { url: '/api/precios/actualizar-precio-item', body: { itemId: 'MLA1', precio: 80000 } },
      { url: '/api/precios/actualizar-precio', body: { clave: 'MLA2', precio: 50000 } },
    ]);
    expect(posts.find((p) => p.url === '/api/sync/reactivar').body.itemIds.sort()).toEqual(['MLA1', 'MLA2']);
  });

  it('un error del grupo marca fallado a todo el grupo y no se reactiva', async () => {
    const posts = await aplicar(
      [fila('MLA1|11', 70000), fila('MLA1|12', 80000)],
      { '/api/precios/actualizar-precio-item': () => json(400, { ok: false, error: 'Found different prices' }) },
    );
    expect(posts.some((p) => p.url === '/api/sync/reactivar')).toBe(false);
  });
});
