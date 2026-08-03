import { describe, it, expect, beforeEach } from 'vitest';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraerScriptPrincipal } from './_helpers/extraerScriptInline.js';

// Cubre el fix de public/stock/index.html: normalizarCatalogo()/attrsDeFila() (que
// mapean las filas crudas de /api/woo/catalogo, sin columna `status`, al shape que
// usa la página) y setMatch() (bug de fondo: selectedId quedaba undefined/string y
// el ítem se descartaba en silencio).
//
// Es JS inline ES5 sin exports, así que el script se extrae del HTML y se corre en
// un contexto vm con document/window/fetch falsificados a mano (mismo patrón que
// test/scannerZoomState.test.js usa para public/lib/scanner.js).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'public', 'stock', 'index.html');

function fakeElement() {
  return {
    style: {},
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    appendChild() {},
  };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function crearContexto(fetchImpl) {
  const sandbox = {
    window: {},
    document: {
      getElementById: () => fakeElement(),
      querySelectorAll: () => [],
      createElement: () => fakeElement(),
      head: { appendChild() {} },
    },
    location: { pathname: '/herramientas/stock/', search: '' },
    Api: { installAuth() {} },
    esc: (s) => String(s == null ? '' : s),
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch no esperado en este test'))),
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(extraerScriptPrincipal(HTML_PATH), sandbox);
  return sandbox;
}

describe('stock/index.html — cargarCatalogo()/normalizarCatalogo() (mapeo de filas crudas de catalogo_cache)', () => {
  it('mapea id_woo→id, id_padre→idPadre y arma attrs para distintas formas de atributos_json', async () => {
    const filas = [
      { id_woo: 10, id_padre: 1, nombre: 'Bici Rodado 27 — Rojo / L', sku: 'BR27-RL', stock: 3, tipo: 'variation', precio: 100, marca: 'Trek', gtin: '111', atributos_json: '[{"option":"Rojo"},{"option":"L"}]' },
      { id_woo: 11, id_padre: 1, nombre: 'Bici Rodado 27 — Azul', sku: 'BR27-AZ', stock: 1, tipo: 'variation', precio: 100, marca: 'Trek', gtin: '222', atributos_json: [{ option: 'Azul' }] },
      { id_woo: 12, id_padre: null, nombre: 'Casco', sku: 'CASCO-1', stock: 0, tipo: 'simple', precio: 50, marca: 'Bell', gtin: '333', atributos_json: null },
      { id_woo: 13, id_padre: null, nombre: 'Guantes', sku: 'GTE-1', stock: 5, tipo: 'simple', precio: 20, marca: 'Bell', gtin: '444', atributos_json: 'esto no es JSON válido' },
      { id_woo: 14, id_padre: 2, nombre: 'Sin option', sku: 'SO-1', stock: 2, tipo: 'variation', precio: 30, marca: 'X', gtin: '555', atributos_json: [{ foo: 'bar' }] },
    ];
    const fetchImpl = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: filas }) });
    const ctx = crearContexto(fetchImpl);

    ctx.cargarCatalogo();
    await flushPromises();
    await flushPromises();

    expect(ctx.catalogo).toHaveLength(5);

    const conAtributosString = ctx.catalogo.find((p) => p.id === 10);
    expect(conAtributosString.idPadre).toBe(1);
    expect(conAtributosString.attrs).toBe('Rojo / L');

    const conArrayYaParseado = ctx.catalogo.find((p) => p.id === 11);
    expect(conArrayYaParseado.attrs).toBe('Azul');

    const conNull = ctx.catalogo.find((p) => p.id === 12);
    expect(conNull.attrs).toBe('');
    expect(conNull.idPadre).toBeNull();

    const conJsonInvalido = ctx.catalogo.find((p) => p.id === 13);
    expect(conJsonInvalido.attrs).toBe('');

    const sinOption = ctx.catalogo.find((p) => p.id === 14);
    expect(sinOption.attrs).toBe('');
  });
});

describe('stock/index.html — setMatch() (bug: selectedId quedaba undefined/string y el ítem se descartaba en silencio)', () => {
  let ctx;

  beforeEach(() => {
    ctx = crearContexto();
    // Aislamos la lógica del renderizado del DOM: no es responsabilidad de este test.
    ctx.renderItems = () => {};
  });

  it('recibiendo el id como STRING (como lo emite el HTML real vía onmousedown) deja selectedId numérico', () => {
    ctx.items = [{ id_local: 1, selectedId: null, estado: 'nuevo' }];
    ctx.setMatch(1, '4009876543');
    const item = ctx.items[0];
    expect(item.selectedId).toBe(4009876543);
    expect(typeof item.selectedId).toBe('number');
    // Efecto colateral esperado: al asignar match, un ítem "nuevo" pasa a "pendiente".
    expect(item.estado).toBe('pendiente');
  });

  it('string vacío, null o undefined dejan selectedId en null (no lo descarta con basura)', () => {
    ctx.items = [
      { id_local: 1, selectedId: 99, estado: 'pendiente' },
      { id_local: 2, selectedId: 99, estado: 'pendiente' },
      { id_local: 3, selectedId: 99, estado: 'pendiente' },
    ];
    ctx.setMatch(1, '');
    ctx.setMatch(2, null);
    ctx.setMatch(3, undefined);
    expect(ctx.items[0].selectedId).toBeNull();
    expect(ctx.items[1].selectedId).toBeNull();
    expect(ctx.items[2].selectedId).toBeNull();
  });

  it('un id no numérico ("NaN") también deja selectedId en null en vez de propagar NaN', () => {
    ctx.items = [{ id_local: 1, selectedId: null, estado: 'nuevo' }];
    ctx.setMatch(1, 'no-es-un-numero');
    expect(ctx.items[0].selectedId).toBeNull();
  });

  it('si el id_local no corresponde a ningún ítem, no rompe (getItem devuelve undefined)', () => {
    ctx.items = [{ id_local: 1, selectedId: null, estado: 'nuevo' }];
    expect(() => ctx.setMatch(999, '5')).not.toThrow();
    expect(ctx.items[0].selectedId).toBeNull();
  });
});
