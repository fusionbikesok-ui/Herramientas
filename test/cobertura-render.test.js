import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Aísla, sin jsdom, la lógica JS embebida en public/cobertura/index.html (pantalla
// nueva: cola de trabajo de a una tarjeta + vistas de gestión), mismo patrón que
// test/etiquetas-categoria.test.js: se extrae el <script> inline más largo y se
// corre con un `document` fake mínimo.
//
// NOTA sobre el archivo viejo: index.html se reemplazó entero (se eliminaron las
// cinco pestañas y la carga de Excel). Las funciones que probaba este archivo antes
// (aplicarFiltrosYOrden, poblarFiltros, cruzar(), el mensaje vacío de la pestaña
// "Faltantes") ya no existen — no eran una regresión, era una pantalla eliminada
// a propósito. Lo que seguía vivo (filtro por marca/categoría, vista Problemas)
// se reescribió abajo contra las funciones nuevas (cargarProblemas/renderProblemas).
// Lo que desapareció de verdad (Excel, pestañas, búsqueda de texto combinada con
// filtros de stock/precio/imagen/GTIN — esos filtros no existen más en la pantalla
// nueva) se borró sin reemplazo.

function extraerScriptMasLargo(html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!matches.length) throw new Error('No se encontró ningún <script> inline en index.html');
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

// Elemento fake con addEventListener funcional (guarda y permite disparar los
// handlers), necesario para probar botones reales del flujo de la cola (Saltear,
// Confirmar vínculo) sin jsdom.
function crearElementoFake(tag) {
  const handlers = {};
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    innerHTML: '', textContent: '', className: '', style: {}, value: '', hidden: false, type: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    addEventListener(tipo, fn) { (handlers[tipo] = handlers[tipo] || []).push(fn); },
    disparar(tipo) { (handlers[tipo] || []).forEach((fn) => fn()); },
    // Serialización mínima: alcanza para que las aserciones de texto (toContain)
    // encuentren el contenido de los toasts armados con createElement+appendChild.
    appendChild(child) {
      el.innerHTML += (child.innerHTML || child.textContent || '');
    },
    remove() {},
    // Con un solo candidato la lista compacta de alternativos queda vacía y
    // el código no necesita encontrar nada real acá; alcanza con no explotar.
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function crearDocumentoFake() {
  const elementos = new Map();
  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, crearElementoFake());
      return elementos.get(id);
    },
    createElement(tag) { return crearElementoFake(tag); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

let ctx;
let fetchLlamadas;

// jsonFetch() encadena varios .then() (fetch -> r.text() -> JSON.parse) antes
// de que el handler de la vista actualice el DOM; unos pocos ticks de
// microtask alcanzan y sobran para drenar esa cadena en los mocks síncronos
// de este archivo (no hay timers reales de por medio).
async function flush(vueltas) {
  for (let i = 0; i < (vueltas || 8); i++) await Promise.resolve();
}

beforeEach(() => {
  const htmlPath = path.resolve(__dirname, '../public/cobertura/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptSrc = extraerScriptMasLargo(html);

  fetchLlamadas = [];
  const documentoFake = crearDocumentoFake();
  const sandbox = {
    document: documentoFake,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch(url, opts) {
      fetchLlamadas.push({ url, opts });
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
    },
    location: { pathname: '/cobertura/', href: '', search: '', hash: '' },
    Api: new Proxy({}, { get() { return (..._a) => Promise.resolve({}); } }),
    navigator: { clipboard: null },
    console,
    // setTimeout inmediato: evita timers reales colgados (los toasts se
    // autodestruyen a los 4.5-8s) y no afecta a estos tests, que no dependen
    // del orden temporal de los timeouts.
    setTimeout(fn) { fn(); return 0; },
    clearTimeout() {},
  };
  // `window` es el propio objeto global del contexto (igual que en un navegador
  // real), así las globales que format.js cuelga con `root.esc = esc` quedan
  // accesibles como identificador suelto (`esc(...)`) tal cual las usa el script
  // principal de cobertura.
  sandbox.window = sandbox;
  sandbox.window.addEventListener = function () {};
  sandbox.window.scrollTo = function () {};
  ctx = vm.createContext(sandbox);
  // format.js expone esc()/money()/fecha()/n()/mlUrl() como globales (ver
  // public/lib/format.js); el <script> principal de cobertura las usa sin
  // importarlas explícitamente.
  const formatSrc = fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8');
  vm.runInContext(formatSrc, ctx, { filename: 'format.js' });
  vm.runInContext(scriptSrc, ctx, { filename: 'cobertura-inline.js' });
});

// ═══════════════════════════════════════════════════════════════════════
// Vista Problemas: cargarProblemas() + renderProblemas() — sobrevive del
// diseño viejo el filtro por marca/categoría (antes vivía en
// aplicarFiltrosYOrden + poblarFiltros sobre un array plano en memoria con
// muchos más criterios — stock, precio, imagen, GTIN — que ya no existen en
// la pantalla nueva). Acá se reescribe contra las funciones reales nuevas.
// ═══════════════════════════════════════════════════════════════════════

describe('cobertura/index.html — cargarProblemas puebla los selects ordenados alfabéticamente', () => {
  it('ordena marcas y categorías sin repetir, ignorando vacíos', async () => {
    sandbox_fetchCruce([
      { nombre: 'X', sku: 'X1', marca: 'Shimano', categorias_json: '["RUEDAS"]', ml_status: 'paused', ml_item_id: 'MLA1' },
      { nombre: 'Y', sku: 'Y1', marca: 'Bell', categorias_json: '["CASCOS"]', ml_status: 'paused', ml_item_id: 'MLA2' },
      { nombre: 'Z', sku: 'Z1', marca: 'Maxxis', categorias_json: '["ACCESORIOS"]', ml_status: 'paused', ml_item_id: 'MLA3' },
      { nombre: 'W', sku: 'W1', marca: 'Shimano', categorias_json: '["RUEDAS"]', ml_status: 'paused', ml_item_id: 'MLA4' },
      { nombre: 'V', sku: null, marca: null, categorias_json: '[]', ml_status: 'paused', ml_item_id: 'MLA5' },
    ]);

    ctx.cargarProblemas();
    await flush();

    const opcion = (sel) => [...ctx.document.getElementById(sel).innerHTML.matchAll(/<option value="([^"]*)"/g)]
      .map((m) => m[1]).filter(Boolean);
    expect(opcion('prob-marca')).toEqual(['Bell', 'Maxxis', 'Shimano']);
    expect(opcion('prob-categoria')).toEqual(['ACCESORIOS', 'CASCOS', 'RUEDAS']);
  });

  function sandbox_fetchCruce(pausadas) {
    ctx.fetch = function (url) {
      if (String(url).indexOf('/api/cobertura/cruce') !== -1) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ ok: true, pausadas: pausadas })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
    };
  }
});

describe('cobertura/index.html — renderProblemas filtra por marca y categoría (AND)', () => {
  beforeEach(() => {
    ctx.problemasCache = [
      { nombre: 'Cubierta 29', sku: 'B-CUB', marca: 'Maxxis', categorias_json: '["CUBIERTAS"]', ml_status: 'paused', ml_item_id: 'MLA1' },
      { nombre: 'Casco Rojo', sku: 'A-CAS', marca: 'Bell', categorias_json: '["CASCOS"]', ml_status: 'paused', ml_item_id: 'MLA2' },
      { nombre: 'Aro 26', sku: 'C-ARO', marca: 'Maxxis', categorias_json: '["RUEDAS"]', ml_status: 'paused', ml_item_id: 'MLA3' },
    ];
  });

  it('sin filtros, lista todo', () => {
    ctx.document.getElementById('prob-marca').value = '';
    ctx.document.getElementById('prob-categoria').value = '';
    ctx.renderProblemas();
    const html = ctx.document.getElementById('prob-lista').innerHTML;
    expect(html).toContain('Cubierta 29');
    expect(html).toContain('Casco Rojo');
    expect(html).toContain('Aro 26');
  });

  it('filtra solo por marca', () => {
    ctx.document.getElementById('prob-marca').value = 'Maxxis';
    ctx.document.getElementById('prob-categoria').value = '';
    ctx.renderProblemas();
    const html = ctx.document.getElementById('prob-lista').innerHTML;
    expect(html).toContain('Cubierta 29');
    expect(html).toContain('Aro 26');
    expect(html).not.toContain('Casco Rojo');
  });

  it('combina marca + categoría con AND (no alcanza con cumplir una sola)', () => {
    ctx.document.getElementById('prob-marca').value = 'Maxxis';
    ctx.document.getElementById('prob-categoria').value = 'RUEDAS';
    ctx.renderProblemas();
    const html = ctx.document.getElementById('prob-lista').innerHTML;
    expect(html).toContain('Aro 26');
    expect(html).not.toContain('Cubierta 29'); // es Maxxis pero no es RUEDAS
    expect(html).not.toContain('Casco Rojo');
  });

  it('muestra el mensaje "sin problemas" cuando el filtro no deja ninguna fila', () => {
    ctx.document.getElementById('prob-marca').value = 'Bell';
    ctx.document.getElementById('prob-categoria').value = 'RUEDAS';
    ctx.renderProblemas();
    const html = ctx.document.getElementById('prob-lista').innerHTML;
    expect(html).toContain('Sin problemas detectados');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cola de trabajo: transición de "salteado" NO es terminal — la tarjeta
// tiene que volver al final de la MISMA tanda (buffer en memoria), no
// perderse. Si se "simplificara" a un simple avanzar sin reinsertar, el
// usuario perdería tarjetas de la marca que estaba trabajando.
// ═══════════════════════════════════════════════════════════════════════

describe('cobertura/index.html — Saltear no es terminal: vuelve al final del buffer de la tanda', () => {
  it('al saltear, el ítem actual se reencola al final de colaEstado.items', () => {
    const prodA = { id_woo: 1, nombre: 'Producto A', candidatos: [] };
    const prodB = { id_woo: 2, nombre: 'Producto B', candidatos: [] };
    const prodC = { id_woo: 3, nombre: 'Producto C', candidatos: [] };

    // Estado con buffer suficiente para que avanzarSiguiente() no dispare un
    // fetch adicional de traerMasDeCola (colaEstado.items.length >= 3).
    ctx.colaEstado = {
      marca: 'Metha', items: [prodB, prodC], offset: 3, total: 3,
      actual: null, candidatoSeleccionado: null, cargandoMas: false, totalOriginal: 3,
    };

    // Sin candidatos, el botón real es "btn-saltear-directo" (misma acción que
    // "btn-saltear" cuando sí hay candidato — ver renderTarjeta()).
    ctx.renderTarjeta(prodA);
    ctx.document.getElementById('btn-saltear-directo').disparar('click');

    // El handler de "Saltear" llama accionProducto (fetch async) y recién
    // después reencola y avanza; esperamos a que drene la microtask queue.
    return flush().then(() => {
      // prodA (el salteado) tiene que aparecer reencolado al FINAL del buffer,
      // no perderse ni volver a mostrarse antes que los demás.
      expect(ctx.colaEstado.actual.id_woo).toBe(2); // avanzó a prodB, no repitió prodA
      expect(ctx.colaEstado.items.map((p) => p.id_woo)).toEqual([3, 1]); // C, y A al final
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Distinción vinculado vs pendiente_sync: si se diluye este mensaje, el
// usuario cree que vinculó algo en ML cuando en realidad solo quedó
// guardado local a la espera de sincronizar.
// ═══════════════════════════════════════════════════════════════════════

describe('cobertura/index.html — ligarAccionesTarjeta distingue vinculado de pendiente_sync en el toast', () => {
  const cand = {
    ml_clave: 'MLA1', ml_item_id: 'MLA1', ml_titulo: 'Producto Test ML', ml_img: '',
    ml_precio: 100, ml_stock: 1, ml_status: 'active', confianza: 'alta',
    diff: { coincide: [], solo_wc: [], solo_ml: [], discriminantes_conflicto: [] },
  };
  const prod = { id_woo: 10, nombre: 'Producto Test', img: '', candidatos: [cand] };

  function mockConfirmar(estado) {
    ctx.fetch = function (url) {
      if (String(url).indexOf('/confirmar') !== -1) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ ok: true, estado: estado, sku: 'FB-1' })) });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
    };
  }

  it('estado "vinculado" muestra el toast de confirmación efectiva en ML', () => {
    mockConfirmar('vinculado');
    ctx.renderTarjeta(prod);
    ctx.document.getElementById('btn-confirmar-vinculo').disparar('click');
    return flush().then(() => {
      const wrap = ctx.document.getElementById('toast-wrap');
      expect(wrap.innerHTML).toContain('Vinculado a');
      expect(wrap.innerHTML).not.toContain('se sincroniza');
    });
  });

  it('estado "pendiente_sync" muestra el toast de "se sincroniza apenas se pueda", no de vínculo confirmado', () => {
    mockConfirmar('pendiente_sync');
    ctx.renderTarjeta(prod);
    ctx.document.getElementById('btn-confirmar-vinculo').disparar('click');
    return flush().then(() => {
      const wrap = ctx.document.getElementById('toast-wrap');
      expect(wrap.innerHTML).toContain('se sincroniza con ML apenas se pueda');
      expect(wrap.innerHTML).not.toContain('Vinculado a');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// pausarConConfirmacion: el backend corta con 409 { requiere_confirmacion,
// variaciones_afectadas } ANTES de tocar ML cuando la clave es una variación
// con hermanas (pausar una arrastra toda la publicación). Hallazgo del
// revisor: el 409 caía en la rama de error genérica y el usuario veía
// "ML no confirmó la pausa" — mensaje FALSO, porque ML nunca fue consultado
// — sin ningún camino para confirmar y seguir. Estos tests cubren la rama
// que quedó sin cubrir de los once tests nuevos.
// ═══════════════════════════════════════════════════════════════════════

describe('cobertura/index.html — pausarConConfirmacion: el 409 pide confirmación real, nunca miente sobre ML', () => {
  it('con 409 + requiere_confirmacion, pregunta con el número real de variaciones y, si el usuario acepta, reenvía con { confirmado: true }', () => {
    const llamadas = [];
    ctx.fetch = function (url, opts) {
      llamadas.push({ url, opts });
      if (llamadas.length === 1) {
        return Promise.resolve({
          ok: false, status: 409,
          text: () => Promise.resolve(JSON.stringify({ ok: false, requiere_confirmacion: true, variaciones_afectadas: 3, error: 'ML no permite pausar una variación individual' })),
        });
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, estado: 'paused', variaciones_afectadas: 3 })) });
    };
    let mensajeConfirm = null;
    ctx.window.confirm = function (msg) { mensajeConfirm = msg; return true; };
    let exito = false;
    ctx.pausarConConfirmacion('/api/cobertura/multi-publicacion/MLA1%7CVAR1/pausar', function () { exito = true; });

    return flush(16).then(() => {
      // Mutation testing: si el código dejara de leer variaciones_afectadas del body del
      // 409 (ej. lo hardcodeara en 0, o leyera otro campo), este assert lo detecta.
      expect(mensajeConfirm).toContain('3');
      expect(llamadas.length).toBe(2); // reintentó exactamente una vez, no en loop
      expect(llamadas[1].opts.method).toBe('POST');
      // Si el código "confirmara" sin mandar { confirmado: true }, el backend volvería a
      // cortar con 409 en un loop infinito de confirmaciones — este assert lo evita.
      expect(JSON.parse(llamadas[1].opts.body)).toEqual({ confirmado: true });
      expect(exito).toBe(true);
      const wrap = ctx.document.getElementById('toast-wrap');
      expect(wrap.innerHTML).toContain('Pausada');
      expect(wrap.innerHTML).not.toContain('ML no confirmó');
    });
  });

  it('si el usuario cancela la confirmación, no reenvía ni pausa nada (y no llama a onExito)', () => {
    const llamadas = [];
    ctx.fetch = function (url, opts) {
      llamadas.push({ url, opts });
      return Promise.resolve({
        ok: false, status: 409,
        text: () => Promise.resolve(JSON.stringify({ ok: false, requiere_confirmacion: true, variaciones_afectadas: 2 })),
      });
    };
    ctx.window.confirm = function () { return false; };
    let exito = false;
    ctx.pausarConConfirmacion('/api/cobertura/solo-ml/MLA9/pausar', function () { exito = true; });

    return flush().then(() => {
      expect(llamadas.length).toBe(1); // ninguna segunda llamada: cancelar no reintenta
      expect(exito).toBe(false);
    });
  });

  it('el 409 NUNCA cae en el mensaje "ML no confirmó la pausa" (ese mensaje solo es cierto cuando ML fue consultado, vía 502)', () => {
    ctx.fetch = function () {
      return Promise.resolve({
        ok: false, status: 409,
        text: () => Promise.resolve(JSON.stringify({ ok: false, requiere_confirmacion: true, variaciones_afectadas: 1 })),
      });
    };
    ctx.window.confirm = function () { return false; };
    ctx.pausarConConfirmacion('/api/cobertura/multi-publicacion/MLA1%7CVAR1/pausar', function () {});
    return flush().then(() => {
      const wrap = ctx.document.getElementById('toast-wrap');
      expect(wrap.innerHTML).not.toContain('ML no confirmó');
    });
  });

  it('un 502 fail_closed (ML SÍ fue consultado y no confirmó) muestra "ML no confirmó la pausa" y no llama a onExito', () => {
    ctx.fetch = function () {
      return Promise.resolve({
        ok: false, status: 502,
        text: () => Promise.resolve(JSON.stringify({ ok: false, error: 'timeout ML', fail_closed: true })),
      });
    };
    let exito = false;
    ctx.pausarConConfirmacion('/api/cobertura/multi-publicacion/MLA2/pausar', function () { exito = true; });
    return flush().then(() => {
      const wrap = ctx.document.getElementById('toast-wrap');
      expect(wrap.innerHTML).toContain('ML no confirmó la pausa');
      expect(exito).toBe(false);
    });
  });
});
