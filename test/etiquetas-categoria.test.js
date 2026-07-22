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

// _catalogoBySku también es `let` (no expuesto como propiedad global). Se
// inyecta corriendo la asignación dentro del mismo contexto vm.
function setCatalogoBySku(map) {
  ctx.__bySkuInyectado = map;
  vm.runInContext('_catalogoBySku = __bySkuInyectado;', ctx);
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

  it('importarInventario completa la categoría desde el producto del catálogo', () => {
    // Path: contar stock con cámara -> importar al editor. Antes del fix la
    // línea forzaba categoría vacía en lugar de usar catProd.categorias[0].
    setCatalogoBySku({
      'inv1': { sku: 'INV1', nombre: 'Producto Inventario', categorias: ['Herramientas', 'Otra'], stock: 5 },
    });
    const session = { rows: [{ code: 'INV1', qty: 3 }] };
    const originalGetItem = ctx.localStorage.getItem;
    ctx.localStorage.getItem = (k) => {
      if (k === 'fb_inv_session_v1') return JSON.stringify(session);
      if (k === 'fb_inv_descmap_v1') return '{}';
      return null;
    };
    ctx.document.getElementById('datos').value = '';

    try {
      ctx.importarInventario(true);
    } finally {
      ctx.localStorage.getItem = originalGetItem;
    }

    const filas = ctx.document.getElementById('datos').value.split('\n').filter(Boolean);
    expect(filas.length).toBe(1);
    const cols = filas[0].split('\t');
    expect(cols[0]).toBe('INV1');
    expect(cols[2]).toBe('Herramientas');
    expect(cols[3]).toBe('3');
  });

  it('importarInventario deja la categoría vacía (sin romper) cuando el SKU contado no está en el catálogo', () => {
    setCatalogoBySku({});
    const session = { rows: [{ code: 'DESCONOCIDO', qty: 2 }] };
    ctx.localStorage.getItem = (k) => {
      if (k === 'fb_inv_session_v1') return JSON.stringify(session);
      if (k === 'fb_inv_descmap_v1') return '{}';
      return null;
    };
    ctx.document.getElementById('datos').value = '';

    expect(() => ctx.importarInventario(true)).not.toThrow();

    const filas = ctx.document.getElementById('datos').value.split('\n').filter(Boolean);
    expect(filas.length).toBe(1);
    const cols = filas[0].split('\t');
    expect(cols[0]).toBe('DESCONOCIDO');
    expect(cols[2]).toBe('');
    expect(cols[3]).toBe('2');
  });

  it('agregarCategoriaConStock/Todos no agregan filas si no hay categoría seleccionada (_catSeleccionada vacío)', () => {
    ctx._catSeleccionada = null;
    setCatalogo([{ sku: 'Z1', nombre: 'Prod Z', categorias: ['X'], stock: 5 }]);
    ctx.document.getElementById('datos').value = '';

    ctx.agregarCategoriaConStock();
    expect(ctx.document.getElementById('datos').value).toBe('');

    ctx.agregarCategoriaTodos();
    expect(ctx.document.getElementById('datos').value).toBe('');
  });

  // A 203dpi la etiqueta de 25mm tiene ~184px útiles. maxAltoBc() garantiza que el
  // barcode nunca empuje el SKU/categoría fuera del label (overflow:hidden los recortaría
  // dejando texto ilegible en la impresora térmica real).
  it('maxAltoBc reserva menos alto de barcode cuando se muestra la categoría', () => {
    expect(ctx.maxAltoBc(true)).toBe(12);   // con categoría: título + SKU + categoría
    expect(ctx.maxAltoBc(false)).toBe(14);  // sin categoría: título + SKU
    // Nunca supera el maximo del input (14mm) ni deja algo ilegiblemente alto (>15mm ~ recorte).
    expect(ctx.maxAltoBc(true)).toBeLessThanOrEqual(14);
    expect(ctx.maxAltoBc(false)).toBeLessThanOrEqual(15);
  });

  it('sincronizarMaxBarcode clampea el alto del barcode al pasar a "con categoría"', () => {
    const verCat = ctx.document.getElementById('verCat');
    const altoBc = ctx.document.getElementById('altoBc');
    // Usuario con 14mm y categoría desactivada -> valido
    verCat.value = 'no';
    altoBc.value = '14';
    ctx.sincronizarMaxBarcode();
    expect(String(altoBc.max)).toBe('14');
    expect(parseFloat(altoBc.value)).toBe(14);
    // Activa la categoría -> el max baja a 12 y el valor se clampea
    verCat.value = 'si';
    ctx.sincronizarMaxBarcode();
    expect(String(altoBc.max)).toBe('12');
    expect(parseFloat(altoBc.value)).toBe(12);
  });
});
