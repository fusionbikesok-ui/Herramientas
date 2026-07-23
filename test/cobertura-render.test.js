import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Aísla, sin jsdom, la lógica JS embebida en public/cobertura/index.html que
// arma el mensaje de "vacío" de la pestaña Faltantes ML (mismo patrón que
// test/etiquetas-categoria.test.js: se extrae el <script> inline más largo y
// se corre con un `document` fake mínimo).
//
// Bug/fix cubierto: la pestaña Faltantes distinguía dos casos que antes
// mostraban el mismo mensaje genérico "Sin resultados":
//   - no hay faltantes en absoluto (bueno: todo está publicado en ML) → mensaje
//     verde "No hay faltantes..."
//   - hay faltantes, pero la búsqueda del usuario no matchea ninguno → mensaje
//     neutro "Sin resultados para tu búsqueda."

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
  const htmlPath = path.resolve(__dirname, '../public/cobertura/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptSrc = extraerScriptMasLargo(html);

  const documentoFake = crearDocumentoFake();
  const sandbox = {
    document: documentoFake,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({}) }); },
    location: { pathname: '/cobertura/', href: '', search: '' },
    Api: new Proxy({}, { get() { return (..._a) => Promise.resolve({}); } }),
    console,
    setTimeout,
    clearTimeout,
  };
  // `window` es el propio objeto global del contexto (igual que en un navegador
  // real), así las globales que format.js cuelga con `root.esc = esc` quedan
  // accesibles como identificador suelto (`esc(...)`) tal cual las usa el script
  // principal de cobertura.
  sandbox.window = sandbox;
  ctx = vm.createContext(sandbox);
  // format.js expone esc()/money()/fecha() como globales (ver public/lib/format.js);
  // el <script> principal de cobertura las usa sin importarlas explícitamente.
  const formatSrc = fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8');
  vm.runInContext(formatSrc, ctx, { filename: 'format.js' });
  vm.runInContext(scriptSrc, ctx, { filename: 'cobertura-inline.js' });
});

function setDatos(datosParciales) {
  ctx.__datosInyectados = {
    en_ambos: [], solo_ml: [], pausadas: [], excluidos: [], multiPub: [],
    faltantes: [],
    ...datosParciales,
  };
  vm.runInContext('datos = __datosInyectados;', ctx);
}

describe('cobertura/index.html — mensaje vacío de la pestaña Faltantes', () => {
  it('muestra el mensaje "no hay faltantes" (verde) cuando la lista de faltantes está vacía', () => {
    setDatos({ faltantes: [] });
    ctx.tabActual = 'faltantes';
    ctx.verExcluidos = false;
    ctx.busqueda = '';

    ctx.render();

    const html = ctx.document.getElementById('lista').innerHTML;
    expect(html).toContain('No hay faltantes');
    expect(html).not.toContain('Sin resultados para tu búsqueda');
  });

  it('muestra "sin resultados para tu búsqueda" cuando hay faltantes pero el filtro no matchea ninguno', () => {
    setDatos({
      faltantes: [{ nombre: 'Bicicleta Rodado 29', sku: 'BIC29', stock: 3, categorias_json: '[]' }],
    });
    ctx.tabActual = 'faltantes';
    ctx.verExcluidos = false;
    ctx.busqueda = 'zzz-no-matchea-nada';

    ctx.render();

    const html = ctx.document.getElementById('lista').innerHTML;
    expect(html).toContain('Sin resultados para tu búsqueda');
    expect(html).not.toContain('No hay faltantes');
  });

  it('renderiza la lista normalmente cuando hay faltantes que sí matchean', () => {
    setDatos({
      faltantes: [{ nombre: 'Bicicleta Rodado 29', sku: 'BIC29', stock: 3, categorias_json: '[]' }],
    });
    ctx.tabActual = 'faltantes';
    ctx.verExcluidos = false;
    ctx.busqueda = '';

    ctx.render();

    const html = ctx.document.getElementById('lista').innerHTML;
    expect(html).toContain('Bicicleta Rodado 29');
    expect(html).not.toContain('Sin resultados');
    expect(html).not.toContain('No hay faltantes');
  });
});

describe('cobertura/index.html — aplicarFiltrosYOrden (filtro + orden en memoria)', () => {
  // Fija el estado de filtros/orden dentro del contexto vm y devuelve el resultado.
  function correr(lista, filtros, orden) {
    ctx.filtros = {
      categoria: '', marca: '', stockMin: null, stockMax: null,
      precioMin: null, precioMax: null, conImagen: null, conGtin: null,
      ...(filtros || {}),
    };
    ctx.orden = orden || { campo: 'nombre', direccion: 'asc' };
    return ctx.aplicarFiltrosYOrden(lista);
  }

  const filas = [
    { nombre: 'Cubierta 29', sku: 'B-CUB', stock: 5, precio: 15000, marca: 'Maxxis', categorias_json: '["CUBIERTAS"]', img: 'x.jpg', gtin: '779' },
    { nombre: 'Casco Rojo', sku: 'A-CAS', stock: 0, precio: 8000, marca: 'Bell', categorias_json: '["CASCOS"]', img: '', gtin: '' },
    { nombre: 'Aro 26', sku: 'C-ARO', stock: 12, precio: 22000, marca: 'Maxxis', categorias_json: '["RUEDAS"]', img: 'y.jpg', gtin: '' },
  ];

  it('filtra por categoría', () => {
    const r = correr(filas, { categoria: 'CUBIERTAS' });
    expect(r.map((x) => x.sku)).toEqual(['B-CUB']);
  });

  it('filtra por marca', () => {
    const r = correr(filas, { marca: 'Maxxis' });
    expect(r.map((x) => x.sku).sort()).toEqual(['B-CUB', 'C-ARO']);
  });

  it('filtra por rango de stock', () => {
    const r = correr(filas, { stockMin: 1, stockMax: 10 });
    expect(r.map((x) => x.sku)).toEqual(['B-CUB']);
  });

  it('filtra por rango de precio', () => {
    const r = correr(filas, { precioMin: 10000, precioMax: 20000 });
    expect(r.map((x) => x.sku)).toEqual(['B-CUB']);
  });

  it('filtra por con/sin imagen', () => {
    expect(correr(filas, { conImagen: true }).map((x) => x.sku).sort()).toEqual(['B-CUB', 'C-ARO']);
    expect(correr(filas, { conImagen: false }).map((x) => x.sku)).toEqual(['A-CAS']);
  });

  it('filtra por con/sin GTIN', () => {
    expect(correr(filas, { conGtin: true }).map((x) => x.sku)).toEqual(['B-CUB']);
    expect(correr(filas, { conGtin: false }).map((x) => x.sku).sort()).toEqual(['A-CAS', 'C-ARO']);
  });

  it('combina filtros con AND', () => {
    const r = correr(filas, { marca: 'Maxxis', conGtin: true });
    expect(r.map((x) => x.sku)).toEqual(['B-CUB']);
  });

  it('usa stock_wc cuando la fila no trae stock (en_ambos/pausadas)', () => {
    const conStockWc = [{ nombre: 'X', sku: 'X1', stock_wc: 3 }, { nombre: 'Y', sku: 'Y1', stock_wc: 20 }];
    const r = correr(conStockWc, { stockMax: 10 });
    expect(r.map((x) => x.sku)).toEqual(['X1']);
  });

  it('excluye filas sin marca cuando se pide una marca específica', () => {
    const conVacia = filas.concat([{ nombre: 'Sin marca', sku: 'Z', stock: 1, marca: null, categorias_json: '[]' }]);
    const r = correr(conVacia, { marca: 'Maxxis' });
    expect(r.map((x) => x.sku)).not.toContain('Z');
  });

  it('ordena por nombre asc y desc', () => {
    expect(correr(filas, {}, { campo: 'nombre', direccion: 'asc' }).map((x) => x.nombre))
      .toEqual(['Aro 26', 'Casco Rojo', 'Cubierta 29']);
    expect(correr(filas, {}, { campo: 'nombre', direccion: 'desc' }).map((x) => x.nombre))
      .toEqual(['Cubierta 29', 'Casco Rojo', 'Aro 26']);
  });

  it('ordena por stock descendente', () => {
    const r = correr(filas, {}, { campo: 'stock', direccion: 'desc' });
    expect(r.map((x) => x.sku)).toEqual(['C-ARO', 'B-CUB', 'A-CAS']);
  });

  it('ordena por precio ascendente', () => {
    const r = correr(filas, {}, { campo: 'precio', direccion: 'asc' });
    expect(r.map((x) => x.sku)).toEqual(['A-CAS', 'B-CUB', 'C-ARO']);
  });

  it('ordena por SKU', () => {
    const r = correr(filas, {}, { campo: 'sku', direccion: 'asc' });
    expect(r.map((x) => x.sku)).toEqual(['A-CAS', 'B-CUB', 'C-ARO']);
  });

  it('en orden DESCENDENTE las filas con precio null quedan al final (no arriba)', () => {
    const conNulls = [
      { nombre: 'Con precio bajo', sku: 'P1', precio: 5000 },
      { nombre: 'Sin precio', sku: 'P2', precio: null },
      { nombre: 'Con precio alto', sku: 'P3', precio: 30000 },
    ];
    const r = correr(conNulls, {}, { campo: 'precio', direccion: 'desc' });
    // Mayor→menor entre los que tienen precio, y el null SIEMPRE último.
    expect(r.map((x) => x.sku)).toEqual(['P3', 'P1', 'P2']);
  });

  it('en orden DESCENDENTE por marca las filas con marca null quedan al final', () => {
    const conNulls = [
      { nombre: 'A', sku: 'M1', marca: 'Bell' },
      { nombre: 'B', sku: 'M2', marca: null },
      { nombre: 'C', sku: 'M3', marca: 'Shimano' },
    ];
    const r = correr(conNulls, {}, { campo: 'marca', direccion: 'desc' });
    // Z→A entre las que tienen marca (Shimano antes que Bell), el null último.
    expect(r.map((x) => x.sku)).toEqual(['M3', 'M1', 'M2']);
  });

  it('no muta el array original', () => {
    const copia = filas.slice();
    correr(filas, {}, { campo: 'stock', direccion: 'desc' });
    expect(filas).toEqual(copia);
  });

  it('respeta rango de stock con solo el mínimo (sin máximo)', () => {
    const r = correr(filas, { stockMin: 6 });
    expect(r.map((x) => x.sku)).toEqual(['C-ARO']);
  });

  it('respeta rango de stock con solo el máximo (sin mínimo)', () => {
    const r = correr(filas, { stockMax: 5 });
    expect(r.map((x) => x.sku).sort()).toEqual(['A-CAS', 'B-CUB']);
  });

  it('respeta rango de precio con solo el mínimo (sin máximo)', () => {
    const r = correr(filas, { precioMin: 20000 });
    expect(r.map((x) => x.sku)).toEqual(['C-ARO']);
  });

  it('respeta rango de precio con solo el máximo (sin mínimo)', () => {
    const r = correr(filas, { precioMax: 15000 });
    expect(r.map((x) => x.sku).sort()).toEqual(['A-CAS', 'B-CUB']);
  });

  it('combina categoría + marca + con/sin GTIN (AND de 3 condiciones)', () => {
    const conExtra = filas.concat([
      { nombre: 'Cubierta 700', sku: 'D-CUB', stock: 2, precio: 9000, marca: 'Maxxis', categorias_json: '["CUBIERTAS"]', img: '', gtin: '' },
    ]);
    const r = correr(conExtra, { marca: 'Maxxis', categoria: 'CUBIERTAS', conGtin: true });
    expect(r.map((x) => x.sku)).toEqual(['B-CUB']);
  });
});

describe('cobertura/index.html — render() combina búsqueda de texto libre con filtros (AND)', () => {
  it('la búsqueda por texto se combina con el filtro de marca: solo matchea lo que cumple ambos', () => {
    setDatos({
      en_ambos: [
        { nombre: 'Cubierta Maxxis 29', sku: 'B-CUB', stock: 5, precio: 15000, marca: 'Maxxis', categorias_json: '["CUBIERTAS"]' },
        { nombre: 'Casco Bell Rojo', sku: 'A-CAS', stock: 0, precio: 8000, marca: 'Bell', categorias_json: '["CASCOS"]' },
        { nombre: 'Aro Maxxis 26', sku: 'C-ARO', stock: 12, precio: 22000, marca: 'Maxxis', categorias_json: '["RUEDAS"]' },
      ],
    });
    ctx.tabActual = 'ambos';
    ctx.verExcluidos = false;
    ctx.filtros = { categoria: '', marca: 'Maxxis', stockMin: null, stockMax: null, precioMin: null, precioMax: null, conImagen: null, conGtin: null };
    ctx.orden = { campo: 'nombre', direccion: 'asc' };
    ctx.busqueda = 'aro';

    ctx.render();

    const html = ctx.document.getElementById('lista').innerHTML;
    expect(html).toContain('Aro Maxxis 26');
    expect(html).not.toContain('Cubierta Maxxis 29');
    expect(html).not.toContain('Casco Bell Rojo');
  });
});

describe('cobertura/index.html — modo Excel: cruzar() propaga campos de catalogo_cache', () => {
  it('enAmbos y pausadas incluyen marca/categorias_json/precio/img/gtin/actualizado_en desde wc', () => {
    // Simula el catálogo WC (como lo devuelve /api/woo/catalogo con SELECT *).
    const wcProductos = [
      { id_woo: 1, nombre: 'Cubierta 29', sku: 'FB-CUB', stock: 5, tipo: 'simple',
        marca: 'Maxxis', categorias_json: '["CUBIERTAS"]', precio: 15000,
        img: 'http://img/x.jpg', gtin: '779', actualizado_en: '2026-07-01T00:00:00Z' },
    ];
    // Simula publicaciones ML leídas del Excel: una activa y una pausada, misma SKU.
    const mlItems = [
      { ml_item_id: 'MLA1', ml_variation_id: '', ml_title: 'Cubierta activa', ml_sku: 'FB-CUB', ml_status: 'active', ml_variante: '' },
      { ml_item_id: 'MLA2', ml_variation_id: '', ml_title: 'Cubierta pausada', ml_sku: 'FB-CUB', ml_status: 'paused', ml_variante: '' },
    ];

    ctx.cruzar(mlItems, wcProductos, 'test.xlsx');

    const amb = ctx.datos.en_ambos.find((x) => x.sku === 'FB-CUB');
    expect(amb).toBeTruthy();
    expect(amb.marca).toBe('Maxxis');
    expect(amb.categorias_json).toBe('["CUBIERTAS"]');
    expect(amb.precio).toBe(15000);
    expect(amb.img).toBe('http://img/x.jpg');
    expect(amb.gtin).toBe('779');
    expect(amb.actualizado_en).toBe('2026-07-01T00:00:00Z');

    // pausadas deriva de enAmbos → hereda los mismos campos.
    const pau = ctx.datos.pausadas.find((x) => x.sku === 'FB-CUB');
    expect(pau).toBeTruthy();
    expect(pau.marca).toBe('Maxxis');
    expect(pau.precio).toBe(15000);
    expect(pau.categorias_json).toBe('["CUBIERTAS"]');
  });
});

describe('cobertura/index.html — poblarFiltros ordena opciones de los selects', () => {
  function ordenOpciones(id) {
    const html = ctx.document.getElementById(id).innerHTML;
    // Extrae los value de cada <option>, descartando el "" (Todas).
    return [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  }

  it('ordena categorías y marcas alfabéticamente (no en orden de aparición)', () => {
    // en_ambos con categorías/marcas deliberadamente desordenadas.
    setDatos({
      en_ambos: [
        { nombre: 'X', sku: 'X1', marca: 'Shimano', categorias_json: '["RUEDAS"]' },
        { nombre: 'Y', sku: 'Y1', marca: 'Bell', categorias_json: '["CASCOS"]' },
        { nombre: 'Z', sku: 'Z1', marca: 'Maxxis', categorias_json: '["ACCESORIOS"]' },
      ],
    });
    ctx.tabActual = 'ambos';
    ctx.verExcluidos = false;
    ctx.busqueda = '';
    // Resetea filtros para que poblarFiltros no descarte selección previa.
    ctx.filtros = { categoria: '', marca: '', stockMin: null, stockMax: null, precioMin: null, precioMax: null, conImagen: null, conGtin: null };

    ctx.poblarFiltros();

    expect(ordenOpciones('f-categoria')).toEqual(['ACCESORIOS', 'CASCOS', 'RUEDAS']);
    expect(ordenOpciones('f-marca')).toEqual(['Bell', 'Maxxis', 'Shimano']);
  });
});
