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
  return { innerHTML: '', textContent: '', className: '', style: {} };
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
