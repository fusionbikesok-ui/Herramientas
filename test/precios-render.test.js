import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Aísla, sin jsdom, la lógica JS embebida en public/precios/index.html que
// implementa la capa de filtro + orden en memoria (aplicarFiltrosYOrden,
// cmpNum/cmpTexto con null-last, poblarFiltros). Mismo patrón que
// test/cobertura-render.test.js: se extrae el <script> inline más largo y se
// corre con un `document` fake mínimo + format.js para las globales esc/money.

function extraerScriptMasLargo(html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!matches.length) throw new Error('No se encontró ningún <script> inline en index.html');
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

function crearElementoFake() {
  return {
    innerHTML: '', textContent: '', className: '', style: {}, value: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function crearDocumentoFake() {
  const elementos = new Map();
  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, crearElementoFake());
      return elementos.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

let ctx;

beforeEach(() => {
  const htmlPath = path.resolve(__dirname, '../public/precios/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptSrc = extraerScriptMasLargo(html);

  const documentoFake = crearDocumentoFake();
  const sandbox = {
    document: documentoFake,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({}) }); },
    location: { pathname: '/precios/', href: '', search: '' },
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  ctx = vm.createContext(sandbox);
  const formatSrc = fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8');
  vm.runInContext(formatSrc, ctx, { filename: 'format.js' });
  vm.runInContext(scriptSrc, ctx, { filename: 'precios-inline.js' });
});

describe('precios/index.html — aplicarFiltrosYOrden (filtro + orden en memoria)', () => {
  function correr(lista, filtros, orden, busqueda) {
    ctx.busqueda = (busqueda || '').toLowerCase();
    ctx.filtros = {
      categoria: '', marca: '', stockMin: null, stockMax: null, precioMin: null, precioMax: null,
      ...(filtros || {}),
    };
    ctx.orden = orden || { campo: 'deficit', direccion: 'desc' };
    return ctx.aplicarFiltrosYOrden(lista);
  }

  const filas = [
    { titulo: 'Cubierta 29', sku: 'B-CUB', stock: 5, precio_web: 15000, neto: 14000, deficit_pct: 8, marca: 'Maxxis', categorias_json: '["CUBIERTAS"]', actualizado_en: '2026-07-03T00:00:00Z' },
    { titulo: 'Casco Rojo', sku: 'A-CAS', stock: 0, precio_web: 8000, neto: 7000, deficit_pct: 12, marca: 'Bell', categorias_json: '["CASCOS"]', actualizado_en: '2026-07-01T00:00:00Z' },
    { titulo: 'Aro 26', sku: 'C-ARO', stock: 12, precio_web: 22000, neto: 25000, deficit_pct: 3, marca: 'Maxxis', categorias_json: '["RUEDAS"]', actualizado_en: '2026-07-02T00:00:00Z' },
  ];

  it('filtra por texto libre (título o SKU)', () => {
    expect(correr(filas, {}, null, 'aro').map((x) => x.sku)).toEqual(['C-ARO']);
    expect(correr(filas, {}, null, 'a-cas').map((x) => x.sku)).toEqual(['A-CAS']);
  });

  it('filtra por categoría', () => {
    expect(correr(filas, { categoria: 'CUBIERTAS' }).map((x) => x.sku)).toEqual(['B-CUB']);
  });

  it('filtra por marca', () => {
    expect(correr(filas, { marca: 'Maxxis' }).map((x) => x.sku).sort()).toEqual(['B-CUB', 'C-ARO']);
  });

  it('excluye filas sin marca cuando se pide una marca específica', () => {
    const conVacia = filas.concat([{ titulo: 'Sin marca', sku: 'Z', stock: 1, marca: null, categorias_json: '[]' }]);
    expect(correr(conVacia, { marca: 'Maxxis' }).map((x) => x.sku)).not.toContain('Z');
  });

  it('filtra por rango de stock (min y max)', () => {
    expect(correr(filas, { stockMin: 1, stockMax: 10 }).map((x) => x.sku)).toEqual(['B-CUB']);
    expect(correr(filas, { stockMin: 6 }).map((x) => x.sku)).toEqual(['C-ARO']);
    expect(correr(filas, { stockMax: 5 }).map((x) => x.sku).sort()).toEqual(['A-CAS', 'B-CUB']);
  });

  it('filtra por rango de precio contado (precio_web)', () => {
    expect(correr(filas, { precioMin: 10000, precioMax: 20000 }).map((x) => x.sku)).toEqual(['B-CUB']);
    expect(correr(filas, { precioMin: 20000 }).map((x) => x.sku)).toEqual(['C-ARO']);
    expect(correr(filas, { precioMax: 15000 }).map((x) => x.sku).sort()).toEqual(['A-CAS', 'B-CUB']);
  });

  it('combina filtros con AND (marca + categoría + texto)', () => {
    const conExtra = filas.concat([
      { titulo: 'Cubierta 700', sku: 'D-CUB', stock: 2, precio_web: 9000, marca: 'Maxxis', categorias_json: '["CUBIERTAS"]' },
    ]);
    expect(correr(conExtra, { marca: 'Maxxis', categoria: 'CUBIERTAS' }, null, '29').map((x) => x.sku)).toEqual(['B-CUB']);
  });

  it('ordena por neto asc y desc', () => {
    expect(correr(filas, {}, { campo: 'neto', direccion: 'asc' }).map((x) => x.sku)).toEqual(['A-CAS', 'B-CUB', 'C-ARO']);
    expect(correr(filas, {}, { campo: 'neto', direccion: 'desc' }).map((x) => x.sku)).toEqual(['C-ARO', 'B-CUB', 'A-CAS']);
  });

  it('ordena por déficit % desc', () => {
    expect(correr(filas, {}, { campo: 'deficit', direccion: 'desc' }).map((x) => x.sku)).toEqual(['A-CAS', 'B-CUB', 'C-ARO']);
  });

  it('ordena por stock, marca y categoría', () => {
    expect(correr(filas, {}, { campo: 'stock', direccion: 'desc' }).map((x) => x.sku)).toEqual(['C-ARO', 'B-CUB', 'A-CAS']);
    expect(correr(filas, {}, { campo: 'marca', direccion: 'asc' }).map((x) => x.marca)).toEqual(['Bell', 'Maxxis', 'Maxxis']);
    expect(correr(filas, {}, { campo: 'categoria', direccion: 'asc' }).map((x) => x.sku)).toEqual(['A-CAS', 'B-CUB', 'C-ARO']);
  });

  it('ordena por última actualización desc', () => {
    expect(correr(filas, {}, { campo: 'actualizado', direccion: 'desc' }).map((x) => x.sku)).toEqual(['B-CUB', 'C-ARO', 'A-CAS']);
  });

  it('null-last en orden ASC: neto null queda al final', () => {
    const conNulls = [
      { titulo: 'Bajo', sku: 'P1', neto: 5000 },
      { titulo: 'Sin neto', sku: 'P2', neto: null },
      { titulo: 'Alto', sku: 'P3', neto: 30000 },
    ];
    expect(correr(conNulls, {}, { campo: 'neto', direccion: 'asc' }).map((x) => x.sku)).toEqual(['P1', 'P3', 'P2']);
  });

  it('null-last en orden DESC: neto null queda al final (no arriba)', () => {
    const conNulls = [
      { titulo: 'Bajo', sku: 'P1', neto: 5000 },
      { titulo: 'Sin neto', sku: 'P2', neto: null },
      { titulo: 'Alto', sku: 'P3', neto: 30000 },
    ];
    expect(correr(conNulls, {}, { campo: 'neto', direccion: 'desc' }).map((x) => x.sku)).toEqual(['P3', 'P1', 'P2']);
  });

  it('null-last por marca en ASC y DESC', () => {
    const conNulls = [
      { titulo: 'A', sku: 'M1', marca: 'Bell' },
      { titulo: 'B', sku: 'M2', marca: null },
      { titulo: 'C', sku: 'M3', marca: 'Shimano' },
    ];
    expect(correr(conNulls, {}, { campo: 'marca', direccion: 'asc' }).map((x) => x.sku)).toEqual(['M1', 'M3', 'M2']);
    expect(correr(conNulls, {}, { campo: 'marca', direccion: 'desc' }).map((x) => x.sku)).toEqual(['M3', 'M1', 'M2']);
  });

  it('no muta el array original', () => {
    const copia = filas.slice();
    correr(filas, {}, { campo: 'stock', direccion: 'desc' });
    expect(filas).toEqual(copia);
  });
});

describe('precios/index.html — wiring del DOM (colisión de nombres setFiltro)', () => {
  // Regresión: había DOS `function setFiltro` en el mismo scope (la de filtros en
  // memoria y la de tabs). Por hoisting ganaba la de tabs, así que los selects de
  // categoría/marca invocaban la función equivocada. Estos tests atrapan esa clase
  // de colisión leyendo el HTML crudo.
  const html = fs.readFileSync(path.resolve(__dirname, '../public/precios/index.html'), 'utf8');

  it('existe exactamente una definición de setFiltroMem y sigue existiendo la setFiltro de tabs', () => {
    const memDefs = [...html.matchAll(/function\s+setFiltroMem\s*\(/g)];
    expect(memDefs).toHaveLength(1);
    // La función de tabs (preexistente) no debe haberse tocado.
    expect(html).toMatch(/function\s+setFiltro\s*\(\s*f\s*\)\s*\{[^}]*FILTRO\s*=\s*f/);
  });

  it('los selects de categoría y marca invocan setFiltroMem, no la setFiltro de tabs', () => {
    const cat = html.match(/id="f-categoria"[^>]*onchange="([^"]+)"/);
    const marca = html.match(/id="f-marca"[^>]*onchange="([^"]+)"/);
    expect(cat).toBeTruthy();
    expect(marca).toBeTruthy();
    expect(cat[1]).toContain('setFiltroMem(');
    expect(marca[1]).toContain('setFiltroMem(');
    expect(cat[1]).not.toMatch(/(^|[^A-Za-z])setFiltro\(/);
    expect(marca[1]).not.toMatch(/(^|[^A-Za-z])setFiltro\(/);
  });

  it('la función setFiltroMem quedó realmente disponible en el contexto y actualiza filtros', () => {
    ctx.filtros = { categoria: '', marca: '', stockMin: null, stockMax: null, precioMin: null, precioMax: null };
    ctx.ROWS = [];
    ctx.setFiltroMem('categoria', 'CUBIERTAS');
    expect(ctx.filtros.categoria).toBe('CUBIERTAS');
    // No debe haber tocado FILTRO (el estado de las tabs server-side).
    expect(ctx.FILTRO).not.toBe('categoria');
  });
});

describe('precios/index.html — poblarFiltros ordena las opciones de los selects', () => {
  function ordenOpciones(id) {
    const html = ctx.document.getElementById(id).innerHTML;
    return [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  }

  it('puebla categorías y marcas alfabéticamente (no en orden de aparición)', () => {
    ctx.ROWS = [
      { titulo: 'X', sku: 'X1', marca: 'Shimano', categorias_json: '["RUEDAS"]' },
      { titulo: 'Y', sku: 'Y1', marca: 'Bell', categorias_json: '["CASCOS"]' },
      { titulo: 'Z', sku: 'Z1', marca: 'Maxxis', categorias_json: '["ACCESORIOS"]' },
    ];
    ctx.filtros = { categoria: '', marca: '', stockMin: null, stockMax: null, precioMin: null, precioMax: null };
    ctx.poblarFiltros();
    expect(ordenOpciones('f-categoria')).toEqual(['ACCESORIOS', 'CASCOS', 'RUEDAS']);
    expect(ordenOpciones('f-marca')).toEqual(['Bell', 'Maxxis', 'Shimano']);
  });
});
