import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Este test aísla, sin jsdom, la lógica JS embebida en public/etiquetas/index.html
// que decide qué columna "categoría" se escribe en el editor al usar:
//   - "Agregar todos × stock" / "× 1" por categoría (agregarCategoriaConStock/agregarCategoriaTodos)
//   - "Agregar todos × stock" / "× 1" por marca (agregarMarcaConStock/agregarMarcaTodos)
//   - el botón "+ Agregar" / "×stock" de un producto individual (agregarProdCategoria)
//
// Bug reproducido: antes del fix, esas funciones no completaban la categoría al
// armar la línea que se manda al editor (aunque el usuario tuviera activado
// "Mostrar categoría: Sí" en las opciones de impresión), así que la etiqueta
// se imprimía sin categoría.
//
// Estrategia: como es un <script> plano embebido en HTML (sin build/export),
// se extrae el contenido del script y se ejecuta en un contexto vm con un
// `document` fake mínimo (solo getElementById que soporta los pocos ids que
// tocan estas funciones), para poder invocar las funciones reales tal cual
// están escritas en el archivo.

function extraerScript(html) {
  // Hay dos <script> inline (sin src): el principal con toda la lógica de la
  // página, y uno chico al final que solo valida permisos. Nos quedamos con
  // el más largo, que es el que define las funciones que probamos acá.
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!matches.length) throw new Error('No se encontró ningún <script> inline en index.html');
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

function crearElementoFake() {
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    className: '',
    disabled: false,
    addEventListener() {},
    querySelector() { return crearElementoFake(); },
    appendChild() {},
  };
}

function crearDocumentoFake() {
  const elementos = new Map();
  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, crearElementoFake());
      return elementos.get(id);
    },
    createElement() { return crearElementoFake(); },
    addEventListener() {},
  };
}

let ctx;

beforeAll(() => {
  const htmlPath = path.resolve(__dirname, '../public/etiquetas/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptSrc = extraerScript(html);

  const documentoFake = crearDocumentoFake();
  const sandbox = {
    document: documentoFake,
    window: { addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) }); },
    location: { pathname: '/etiquetas/', href: '' },
    // Api real (public/lib/api.js) no se importa; alcanza con un stub que
    // acepte cualquier método invocado (get/post/installAuth/etc.) sin romper
    // la carga del script principal.
    Api: new Proxy({}, {
      get() { return (..._args) => Promise.resolve({ ok: true, data: [] }); },
    }),
    console,
    setTimeout,
    clearTimeout,
  };
  ctx = vm.createContext(sandbox);
  vm.runInContext(scriptSrc, ctx, { filename: 'etiquetas-inline.js' });
});

// _catalogo está declarado con `let` en el script original, así que no queda
// expuesto como propiedad del objeto global del contexto vm (a diferencia de
// las `var` y de las funciones, que sí). Para poder inyectarlo desde afuera,
// lo pasamos por una propiedad auxiliar y lo asignamos ejecutando código
// dentro del mismo contexto.
function setCatalogo(prods) {
  ctx.__prodsInyectados = prods;
  vm.runInContext('_catalogo = __prodsInyectados;', ctx);
}

describe('etiquetas/index.html — columna categoría al agregar filas', () => {
  it('agregarProdCategoria completa la categoría con _catSeleccionada cuando hay una elegida', () => {
    ctx._catSeleccionada = 'Bicicletas';
    ctx.document.getElementById('datos').value = '';
    const producto = { sku: 'ABC1', nombre: 'Bici X', categorias: ['Otra categoría'], stock: 5 };

    ctx.agregarProdCategoria(producto, 2);

    const lineas = ctx.document.getElementById('datos').value.split('\n');
    const [sku, nombre, categoria, qty] = lineas[lineas.length - 1].split('\t');
    expect(sku).toBe('ABC1');
    expect(categoria).toBe('Bicicletas');
    expect(qty).toBe('2');
  });

  it('agregarProdCategoria usa categorias[0] del producto si no hay categoría seleccionada', () => {
    ctx._catSeleccionada = null;
    ctx.document.getElementById('datos').value = '';
    const producto = { sku: 'XYZ9', nombre: 'Rueda', categorias: ['Repuestos', 'Otra'], stock: 1 };

    ctx.agregarProdCategoria(producto, 1);

    const linea = ctx.document.getElementById('datos').value.split('\n').pop();
    const categoria = linea.split('\t')[2];
    expect(categoria).toBe('Repuestos');
  });

  it('agregarCategoriaConStock completa la categoría en todas las filas agregadas', () => {
    ctx._catSeleccionada = 'Accesorios';
    setCatalogo([
      { sku: 'A1', nombre: 'Prod A', categorias: ['Accesorios'], stock: 3 },
      { sku: 'A2', nombre: 'Prod B', categorias: ['Accesorios'], stock: 0 },
      { sku: 'A3', nombre: 'Prod C', categorias: ['Accesorios'], stock: 7 },
    ]);
    ctx.document.getElementById('datos').value = '';

    ctx.agregarCategoriaConStock();

    const filas = ctx.document.getElementById('datos').value.split('\n').filter(Boolean);
    // solo los que tienen stock > 0
    expect(filas.length).toBe(2);
    filas.forEach((f) => {
      const cols = f.split('\t');
      expect(cols[2]).toBe('Accesorios');
    });
  });

  it('agregarCategoriaTodos completa la categoría aunque el producto tenga stock 0', () => {
    ctx._catSeleccionada = 'Cascos';
    setCatalogo([
      { sku: 'C1', nombre: 'Casco A', categorias: ['Cascos'], stock: 0 },
      { sku: 'C2', nombre: 'Casco B', categorias: ['Cascos'], stock: 4 },
    ]);
    ctx.document.getElementById('datos').value = '';

    ctx.agregarCategoriaTodos();

    const filas = ctx.document.getElementById('datos').value.split('\n').filter(Boolean);
    expect(filas.length).toBe(2);
    filas.forEach((f) => {
      const cols = f.split('\t');
      expect(cols[2]).toBe('Cascos');
    });
  });

  it('agregarMarcaConStock y agregarMarcaTodos completan la categoría con categorias[0] del producto', () => {
    ctx._marcaActual = 'FusionBikes';
    // _catalogoListo también es `let` (no expuesto como propiedad global);
    // se actualiza igual que _catalogo, corriendo la asignación en el mismo contexto.
    vm.runInContext('_catalogoListo = true;', ctx);
    setCatalogo([
      { sku: 'M1', nombre: 'FusionBikes Rodado 29', categorias: ['MTB', 'Otra'], stock: 2 },
      { sku: 'M2', nombre: 'FusionBikes Urbana', categorias: [], stock: 0 },
    ]);

    ctx.document.getElementById('datos').value = '';
    ctx.agregarMarcaConStock();
    let filas = ctx.document.getElementById('datos').value.split('\n').filter(Boolean);
    expect(filas.length).toBe(1);
    expect(filas[0].split('\t')[2]).toBe('MTB');

    ctx.document.getElementById('datos').value = '';
    ctx.agregarMarcaTodos();
    filas = ctx.document.getElementById('datos').value.split('\n').filter(Boolean);
    expect(filas.length).toBe(2);
    expect(filas[0].split('\t')[2]).toBe('MTB');
    expect(filas[1].split('\t')[2]).toBe(''); // sin categorias -> queda vacía, comportamiento esperado
  });
});
