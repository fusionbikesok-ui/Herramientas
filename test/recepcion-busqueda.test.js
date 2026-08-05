import { describe, it, expect, beforeEach } from 'vitest';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraerScriptPrincipal } from './_helpers/extraerScriptInline.js';

// Cubre el fix de public/recepcion/index.html: buscarWC() filtraba solo por nombre
// (no se podía buscar/asignar por SKU). Ahora matchea sku + nombre + gtin (gtin solo
// exacto/prefijo, para no dar falsos positivos por substring arbitrario en medio del
// código), con campos precalculados _skuNorm/_gtinNorm/_busq y sort que prioriza SKU
// exacto/prefijo.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'public', 'recepcion', 'index.html');

function fakeElement() {
  return {
    style: {},
    innerHTML: '',
    textContent: '',
    value: '',
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
    location: { pathname: '/herramientas/recepcion/', search: '' },
    Api: { installAuth() {} },
    esc: (s) => String(s == null ? '' : s),
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch no esperado en este test'))),
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Set,
    isNaN,
    parseInt,
    parseFloat,
    URLSearchParams,
  };
  vm.createContext(sandbox);
  vm.runInContext(extraerScriptPrincipal(HTML_PATH), sandbox);
  return sandbox;
}

const CATALOGO_FIXTURE = [
  { id_woo: 1, sku: 'ABC123', nombre: 'Bicicleta Trek Rodado 27', gtin: '7791234567890', stock: 5 },
  { id_woo: 2, sku: 'DEF999', nombre: 'Casco MTB Talle M', gtin: '1112223334445', stock: 2 },
  { id_woo: 3, sku: null, nombre: 'Producto sin código', gtin: null, stock: 1 },
];

async function cargarCatalogoFixture(ctx) {
  ctx.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: CATALOGO_FIXTURE }) });
  ctx.cargarCatalogo();
  await flushPromises();
  await flushPromises();
}

function ddFake() {
  const dd = fakeElement();
  return dd;
}

describe('recepcion/index.html — buscarWC() (búsqueda/match por SKU + nombre + GTIN)', () => {
  let ctx;
  let dd;

  beforeEach(async () => {
    ctx = crearContexto();
    await cargarCatalogoFixture(ctx);
    dd = ddFake();
    ctx.document.getElementById = (id) => (id === 'dd-item1' ? dd : fakeElement());
  });

  it('SKU exacto devuelve el producto correspondiente', () => {
    ctx.buscarWC({ value: 'ABC123' }, 'item1');
    expect(dd.innerHTML).toContain('Bicicleta Trek Rodado 27');
    expect(dd.innerHTML).not.toContain('Casco MTB');
  });

  it('SKU por prefijo también devuelve el producto (no hace falta el código completo)', () => {
    ctx.buscarWC({ value: 'ABC' }, 'item1');
    expect(dd.innerHTML).toContain('Bicicleta Trek Rodado 27');
  });

  it('GTIN exacto devuelve el producto', () => {
    ctx.buscarWC({ value: '7791234567890' }, 'item1');
    expect(dd.innerHTML).toContain('Bicicleta Trek Rodado 27');
  });

  it('GTIN por prefijo devuelve el producto', () => {
    ctx.buscarWC({ value: '779123' }, 'item1');
    expect(dd.innerHTML).toContain('Bicicleta Trek Rodado 27');
  });

  it('GTIN por substring arbitrario (no prefijo) NO da falso positivo', () => {
    // '234567' está en medio del gtin de Trek ('7791234567890') pero no es prefijo.
    ctx.buscarWC({ value: '234567' }, 'item1');
    expect(dd.innerHTML).not.toContain('Bicicleta Trek Rodado 27');
    expect(dd.innerHTML).toContain('Sin resultados');
  });

  it('búsqueda por nombre sigue funcionando', () => {
    ctx.buscarWC({ value: 'casco' }, 'item1');
    expect(dd.innerHTML).toContain('Casco MTB Talle M');
    expect(dd.innerHTML).not.toContain('Bicicleta Trek');
  });

  it('un producto sin sku/gtin no rompe la búsqueda y no aparece en búsquedas ajenas', () => {
    expect(() => ctx.buscarWC({ value: 'casco' }, 'item1')).not.toThrow();
    expect(dd.innerHTML).not.toContain('Producto sin código');
  });

  it('un producto sin sku/gtin SÍ aparece cuando se lo busca por su nombre', () => {
    ctx.buscarWC({ value: 'sin codigo' }, 'item1');
    expect(dd.innerHTML).toContain('Producto sin código');
  });

  it('una query que se parte en fragmentos de 1 carácter NO devuelve el catálogo entero', () => {
    // Regresión: normalizar() parte "A-1" por el guión y el filtro descartaba los
    // fragmentos de 1 carácter, dejando `palabras` vacío. Un every() sobre un array
    // vacío da true, así que devolvía TODO el catálogo (resultados sin relación con
    // lo buscado, el síntoma que reportó el usuario).
    ctx.buscarWC({ value: 'A-1' }, 'item1');
    expect(dd.innerHTML).not.toContain('Casco MTB Talle M');
    expect(dd.innerHTML).not.toContain('Producto sin código');
  });

  it('query corta (<2 caracteres) limpia el dropdown sin buscar', () => {
    dd.innerHTML = 'algo previo';
    ctx.buscarWC({ value: 'a' }, 'item1');
    expect(dd.innerHTML).toBe('');
  });
});
