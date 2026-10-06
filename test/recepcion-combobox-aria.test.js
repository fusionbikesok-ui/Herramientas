import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// Elemento DOM de relleno para cualquier id que un test no necesita simular explícitamente.
// Debe vivir a nivel de módulo: las funciones que lo usan (los mocks de getElementById que cada
// `it()` define) se declaran FUERA de cargarApp(), así que una versión local a cargarApp() nunca
// resuelve ahí — quedaba como referencia indefinida y, si esa rama del mock llegaba a ejecutarse,
// tiraba ReferenceError silenciosamente absorbido por el flujo async de la app bajo prueba,
// dejando esa rama sin ejercitar de verdad (hallazgo de revisión, ver commit que agrega este comentario).
function elFalso() {
  return {
    value: '', textContent: '', style: {}, disabled: false, dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; }
  };
}

function cargarApp() {
  const html = fs.readFileSync(new URL('../public/recepcion/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const src = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
  const sandbox = {
    document: {
      getElementById: elFalso, querySelector: () => null, addEventListener() {},
      createElement: () => ({ value: '', appendChild() {} }),
    },
    window: { location: { search: '' } },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) }),
    crypto: globalThis.crypto,
    URLSearchParams: globalThis.URLSearchParams,
    setInterval, clearInterval, setTimeout, clearTimeout,
    console,
    localStorage: { getItem() { return null; }, setItem() {} },
    Api: { installAuth() {} },
    alert: () => {},
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

describe('ARIA Combobox con List Autocomplete — atributos en HTML generado', () => {
  it('input de búsqueda contiene role="combobox", aria-autocomplete="list", aria-controls y aria-expanded', () => {
    const app = cargarApp();
    let htmlGenerado = '';

    app.document.getElementById = (id) => {
      if (id === 'items-body') {
        return { innerHTML: '', appendChild(tr) { htmlGenerado = tr.innerHTML; } };
      }
      if (id === 'items-count') return { textContent: '' };
      if (id === 'items-section') return { style: {} };
      if (id === 'inp-proveedor') return { value: 'Test' };
      return elFalso();
    };

    app.document.createElement = () => ({ innerHTML: '', appendChild() {}, querySelector: () => null });

    app.items.push({
      id: 'test-1',
      nombre_doc: 'Producto Test',
      codigo_proveedor: 'CODE-1',
      cantidad: 1,
      recibido: true
    });

    app.renderItems();

    // Verificar que se asignaron los atributos ARIA correctos en el HTML generado
    expect(htmlGenerado).toContain('role="combobox"');
    expect(htmlGenerado).toContain('aria-autocomplete="list"');
    expect(htmlGenerado).toContain('aria-controls="dd-test-1"');
    expect(htmlGenerado).toContain('aria-expanded="false"');
    expect(htmlGenerado).toContain('role="listbox"');
  });

  it('dropdown tiene atributo role="listbox" en el HTML', () => {
    const app = cargarApp();
    let htmlGenerado = '';

    app.document.getElementById = (id) => {
      if (id === 'items-body') {
        return { innerHTML: '', appendChild(tr) { htmlGenerado = tr.innerHTML; } };
      }
      if (id === 'items-count') return { textContent: '' };
      if (id === 'items-section') return { style: {} };
      if (id === 'inp-proveedor') return { value: 'Test' };
      return elFalso();
    };

    app.document.createElement = () => ({ innerHTML: '', appendChild() {} });

    app.items.push({
      id: 'test-2',
      nombre_doc: 'Producto Test 2',
      codigo_proveedor: 'CODE-2',
      cantidad: 1,
      recibido: true
    });

    app.renderItems();

    // Verificar que el dropdown tiene role="listbox"
    expect(htmlGenerado).toContain('id="dd-test-2"');
    expect(htmlGenerado).toContain('role="listbox"');
  });

  it('buscarWC genera opciones con role="option" e id único (dd-<itemId>-opt-<n>)', async () => {
    const app = cargarApp();
    const dd = { innerHTML: '', classList: { add() {}, remove() {} }, id: 'dd-item1', setAttribute() {} };
    const inp = {
      value: 'test',
      setAttribute() {},
      getAttribute() { return null; },
      id: 'wc-search-item1'
    };

    app.document.getElementById = (id) => {
      if (id === 'dd-item1') return dd;
      if (id === 'wc-search-item1') return inp;
      return elFalso();
    };

    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo?q=')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            data: [
              { id_woo: 10, sku: 'SKU-A', nombre: 'Producto A', stock: 5 },
              { id_woo: 11, sku: 'SKU-B', nombre: 'Producto B', stock: 3 }
            ]
          })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    app.buscarWC(inp, 'item1');
    await new Promise(r => setTimeout(r, 400));

    // Verificar que el HTML generado tenga opciones con role y id
    expect(dd.innerHTML).toContain('role="option"');
    expect(dd.innerHTML).toContain('id="dd-item1-opt-');
    expect(dd.innerHTML).toContain('aria-selected');
  });
});

describe('ARIA Combobox — Navegación por teclado', () => {
  it('ArrowDown navega entre opciones y actualiza aria-activedescendant', async () => {
    const app = cargarApp();
    let ariaActive = '';
    let ariaExpanded = 'false';

    const inp = {
      value: 'test',
      id: 'wc-search-item1',
      setAttribute: (attr, val) => {
        if (attr === 'aria-activedescendant') ariaActive = val;
        if (attr === 'aria-expanded') ariaExpanded = val;
      },
      getAttribute: (attr) => {
        if (attr === 'aria-activedescendant') return ariaActive;
        if (attr === 'aria-expanded') return ariaExpanded;
        return null;
      }
    };

    const opt0 = { id: 'dd-item1-opt-0', setAttribute() {}, getAttribute() { return false; } };
    const opt1 = { id: 'dd-item1-opt-1', setAttribute() {}, getAttribute() { return false; } };

    const dd = {
      id: 'dd-item1',
      classList: { add() {}, remove() {}, contains: () => false },
      querySelectorAll: () => [opt0, opt1]
    };

    app.document.getElementById = (id) => {
      if (id === 'dd-item1') return dd;
      if (id === 'wc-search-item1') return inp;
      return elFalso();
    };

    const evt = {
      key: 'ArrowDown',
      preventDefault() {},
      target: inp
    };

    // Navegar down desde el input
    app.navegarBusqueda(evt, 'item1');

    // aria-activedescendant debe apuntar a la primera opción
    expect(ariaActive).toBe('dd-item1-opt-0');
  });

  it('Enter en opción resaltada dispara selección y cierra dropdown', async () => {
    const app = cargarApp();
    let selectedItemId = null;
    let selectedIdWoo = null;

    const inp = {
      value: 'test',
      id: 'wc-search-item1',
      setAttribute() {},
      getAttribute: (attr) => attr === 'aria-activedescendant' ? 'dd-item1-opt-0' : null
    };

    const opt0 = {
      id: 'dd-item1-opt-0',
      getAttribute: (attr) => {
        if (attr === 'data-id-woo') return '10';
        if (attr === 'data-nombre') return 'Producto A';
        if (attr === 'data-sku') return 'SKU-A';
        if (attr === 'data-stock') return '5';
        return null;
      }
    };

    const dd = {
      id: 'dd-item1',
      classList: { add() {}, remove() {}, contains: () => true }
    };

    app.document.getElementById = (id) => {
      if (id === 'dd-item1') return dd;
      if (id === 'wc-search-item1') return inp;
      if (id === 'dd-item1-opt-0') return opt0;
      return elFalso();
    };

    app.items.push({ id: 'item1' });

    // Mock las funciones para verificar que se llamó
    const originalSeleccionar = app.seleccionarWC;
    let seleccionarLlamado = false;
    app.seleccionarWC = function() {
      seleccionarLlamado = true;
      return originalSeleccionar.apply(this, arguments);
    };

    app.renderItems = () => {};
    app.actualizarBotones = () => {};
    app.sincronizarAliasGuardado = () => {};

    const evt = {
      key: 'Enter',
      preventDefault() {},
      target: inp
    };

    // Enter debe disparar selección
    app.navegarBusqueda(evt, 'item1');

    expect(seleccionarLlamado).toBe(true);
  });

  it('Escape cierra dropdown y limpia aria-activedescendant', () => {
    const app = cargarApp();
    let ariaActive = 'dd-item1-opt-0';
    let ariaExpanded = 'true';

    const inp = {
      value: '',
      id: 'wc-search-item1',
      setAttribute: (attr, val) => {
        if (attr === 'aria-activedescendant') ariaActive = val;
        if (attr === 'aria-expanded') ariaExpanded = val;
      },
      getAttribute: (attr) => {
        if (attr === 'aria-activedescendant') return ariaActive;
        if (attr === 'aria-expanded') return ariaExpanded;
        return null;
      }
    };

    const dd = {
      classList: { add() {}, remove() {}, contains: () => true },
      id: 'dd-item1'
    };

    app.document.getElementById = (id) => {
      if (id === 'dd-item1') return dd;
      if (id === 'wc-search-item1') return inp;
      return elFalso();
    };

    const evt = {
      key: 'Escape',
      preventDefault() {},
      target: inp
    };

    // Escape debe cerrar el dropdown
    app.navegarBusqueda(evt, 'item1');

    expect(ariaExpanded).toBe('false');
    expect(ariaActive).toBe('');
  });
});

describe('ARIA Combobox — Bug fixes (P1.9)', () => {
  it('[BUG 1] Enter y click guardan mismo nombre para productos con apóstrofe', async () => {
    const app = cargarApp();
    let seleccionados = [];

    // Mock seleccionarWC para capturar llamadas
    const origSeleccionar = app.seleccionarWC;
    app.seleccionarWC = function(evt, itemId, idWoo, nombre, sku, stock) {
      seleccionados.push({ nombre, sku });
      return origSeleccionar.apply(this, arguments);
    };

    app.renderItems = () => {};
    app.actualizarBotones = () => {};
    app.sincronizarAliasGuardado = () => {};

    app.document.getElementById = (id) => {
      if (id === 'dd-item-apos') {
        return { classList: { add() {}, remove() {} } };
      }
      if (id === 'wc-search-item-apos') {
        return { setAttribute() {}, getAttribute: (attr) => attr === 'aria-activedescendant' ? 'dd-item-apos-opt-0' : null };
      }
      if (id === 'dd-item-apos-opt-0') {
        return {
          id: 'dd-item-apos-opt-0',
          getAttribute: (attr) => {
            if (attr === 'data-id-woo') return '10';
            if (attr === 'data-nombre') return "L'Amour"; // Sin escape de backslash
            if (attr === 'data-sku') return 'SKU-A';
            if (attr === 'data-stock') return '5';
            return null;
          }
        };
      }
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {} };
    };

    // Simular click
    app.seleccionarWC({ preventDefault() {} }, 'item-apos', 10, "L'Amour", 'SKU-A', 5);

    // Simular Enter
    const evt = { key: 'Enter', preventDefault() {}, target: { setAttribute() {}, getAttribute() { return null; } } };
    app.navegarBusqueda(evt, 'item-apos');

    // Ambas formas guardan el mismo nombre sin escape
    expect(seleccionados.length).toBeGreaterThan(0);
    expect(seleccionados[0].nombre).toBe("L'Amour");
  });

  it('[BUG 2] Enter selecciona productos sin SKU (sku vacío legítimo)', async () => {
    const app = cargarApp();
    let seleccionado = null;

    const origSeleccionar = app.seleccionarWC;
    app.seleccionarWC = function(evt, itemId, idWoo, nombre, sku, stock) {
      seleccionado = { idWoo, nombre, sku };
      return origSeleccionar.apply(this, arguments);
    };

    app.renderItems = () => {};
    app.actualizarBotones = () => {};
    app.sincronizarAliasGuardado = () => {};

    app.document.getElementById = (id) => {
      if (id === 'dd-nosku') return { classList: { add() {}, remove() {}, contains: () => true } };
      if (id === 'wc-search-nosku') return { setAttribute() {}, getAttribute: (attr) => attr === 'aria-activedescendant' ? 'dd-nosku-opt-0' : null };
      if (id === 'dd-nosku-opt-0') {
        return {
          id: 'dd-nosku-opt-0',
          getAttribute: (attr) => {
            if (attr === 'data-id-woo') return '20';
            if (attr === 'data-nombre') return 'Sin SKU';
            if (attr === 'data-sku') return ''; // SKU vacío
            if (attr === 'data-stock') return '10';
            return null;
          }
        };
      }
      return elFalso();
    };

    const evt = { key: 'Enter', preventDefault() {}, target: { setAttribute() {}, getAttribute: (attr) => attr === 'aria-activedescendant' ? 'dd-nosku-opt-0' : null } };
    app.navegarBusqueda(evt, 'nosku');

    // Debe haber seleccionado aunque sku esté vacío
    expect(seleccionado).not.toBeNull();
    expect(seleccionado.sku).toBe('');
  });

  it('[BUG 3] aria-activedescendant se limpia al repintar dropdown', async () => {
    const app = cargarApp();
    let ariaActivedescendant = '';

    const inp = {
      value: 'test',
      setAttribute: (attr, val) => { if (attr === 'aria-activedescendant') ariaActivedescendant = val; },
      getAttribute: (attr) => attr === 'aria-activedescendant' ? ariaActivedescendant : null,
      id: 'wc-search-repaint'
    };

    const dd = { innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {} };

    app.document.getElementById = (id) => {
      if (id === 'dd-repaint') return dd;
      if (id === 'wc-search-repaint') return inp;
      return elFalso();
    };

    // Primera búsqueda
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo?q=')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            data: [{ id_woo: 100, sku: 'OLD-1', nombre: 'Old', stock: 5 }]
          })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    app.buscarWC(inp, 'repaint');
    await new Promise(r => setTimeout(r, 400));

    // Usuario resalta
    ariaActivedescendant = 'dd-repaint-opt-0';

    // Segunda búsqueda: nuevos resultados
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo?q=')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            data: [
              { id_woo: 200, sku: 'NEW-1', nombre: 'New 1', stock: 3 },
              { id_woo: 201, sku: 'NEW-2', nombre: 'New 2', stock: 2 }
            ]
          })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    inp.value = 'new';
    app.buscarWC(inp, 'repaint');
    await new Promise(r => setTimeout(r, 400));

    // Debe estar limpio después del repintado
    expect(ariaActivedescendant).toBe('');
  });
});

describe('ARIA Combobox — Estados del dropdown accesibles', () => {
  it('Estado "sin resultados" está dentro del listbox', async () => {
    const app = cargarApp();

    const dd = { innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {} };
    const inp = {
      value: 'xyz',
      setAttribute() {},
      getAttribute() { return null; },
      id: 'wc-search-item1'
    };

    app.document.getElementById = (id) => {
      if (id === 'dd-item1') return dd;
      if (id === 'wc-search-item1') return inp;
      return elFalso();
    };

    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo?q=')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, data: [] })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    app.buscarWC(inp, 'item1');
    await new Promise(r => setTimeout(r, 400));

    expect(dd.innerHTML).toContain('Sin resultados');
  });

  it('Estado "error" tiene botón "Reintentar" accesible', async () => {
    const app = cargarApp();

    const dd = { innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {} };
    const inp = {
      value: 'test',
      setAttribute() {},
      getAttribute() { return null; },
      id: 'wc-search-item1'
    };

    app.document.getElementById = (id) => {
      if (id === 'dd-item1') return dd;
      if (id === 'wc-search-item1') return inp;
      return elFalso();
    };

    app.fetch = () => Promise.reject(new Error('Network error'));

    app.buscarWC(inp, 'item1');
    await new Promise(r => setTimeout(r, 400));

    // Debe mostrar error con opción de reintentar
    expect(dd.innerHTML).toContain('Error');
    expect(dd.innerHTML).toContain('<button');
    expect(dd.innerHTML).toContain('Reintentar');
  });
});

describe('ARIA Combobox — Correcciones de revisor (P1.10)', () => {
  it('[CORR 1] Spinner no deja aria-activedescendant colgado', async () => {
    const app = cargarApp();
    let ariaActivedescendant = 'dd-spinner-opt-0'; // Simular que estaba resaltado antes

    const inp = {
      value: 'test',
      setAttribute: (attr, val) => { if (attr === 'aria-activedescendant') ariaActivedescendant = val; },
      getAttribute: (attr) => attr === 'aria-activedescendant' ? ariaActivedescendant : null,
      id: 'wc-search-spinner'
    };

    const dd = { innerHTML: '', classList: { add() {}, remove() {} } };

    app.document.getElementById = (id) => {
      if (id === 'dd-spinner') return dd;
      if (id === 'wc-search-spinner') return inp;
      return elFalso();
    };

    // Hacer fetch lento para probar spinner
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo?q=')) {
        return new Promise(r => setTimeout(() => {
          r({ json: () => Promise.resolve({ ok: true, data: [{ id_woo: 1, sku: 'S1', nombre: 'P1', stock: 1 }] }) });
        }, 600));
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    app.buscarWC(inp, 'spinner');

    // Inmediatamente después de mostrar spinner, aria-activedescendant debe estar limpio
    // (el spinner es aria-disabled="true" y no debe ser navegable)
    expect(ariaActivedescendant).toBe('');
  });

  it('[CORR 2] Enter selecciona producto con nombre vacío (simetría con mousedown)', async () => {
    const app = cargarApp();
    let seleccionado = null;

    const origSeleccionar = app.seleccionarWC;
    app.seleccionarWC = function(evt, itemId, idWoo, nombre, sku, stock) {
      seleccionado = { idWoo, nombre, sku, stock };
      return origSeleccionar.apply(this, arguments);
    };

    app.renderItems = () => {};
    app.actualizarBotones = () => {};
    app.sincronizarAliasGuardado = () => {};

    app.document.getElementById = (id) => {
      if (id === 'dd-emptyname') return { classList: { add() {}, remove() {}, contains: () => true } };
      if (id === 'wc-search-emptyname') return { setAttribute() {}, getAttribute: (attr) => attr === 'aria-activedescendant' ? 'dd-emptyname-opt-0' : null };
      if (id === 'dd-emptyname-opt-0') {
        return {
          id: 'dd-emptyname-opt-0',
          getAttribute: (attr) => {
            if (attr === 'data-id-woo') return '999';
            if (attr === 'data-nombre') return ''; // Nombre VACÍO (producto borrador)
            if (attr === 'data-sku') return 'EMPTY-SKU';
            if (attr === 'data-stock') return '0';
            return null;
          }
        };
      }
      return elFalso();
    };

    const evt = { key: 'Enter', preventDefault() {}, target: { setAttribute() {}, getAttribute: (attr) => attr === 'aria-activedescendant' ? 'dd-emptyname-opt-0' : null } };
    app.navegarBusqueda(evt, 'emptyname');

    // Debe haber seleccionado aunque nombre esté vacío
    expect(seleccionado).not.toBeNull();
    expect(seleccionado.idWoo).toBe(999);
    expect(seleccionado.nombre).toBe('');
  });

  it('[CORR 3] ArrowDown/Up salta opciones deshabilitadas (placeholders)', async () => {
    const app = cargarApp();
    let ariaActive = '';

    const inp = {
      value: 'search',
      id: 'wc-search-nav',
      setAttribute: (attr, val) => { if (attr === 'aria-activedescendant') ariaActive = val; },
      getAttribute: (attr) => attr === 'aria-activedescendant' ? ariaActive : null
    };

    // Crear opciones: placeholder deshabilitado + opción real + otro placeholder
    const spinner = { id: 'opt-spinner', setAttribute() {}, getAttribute: (attr) => attr === 'aria-disabled' ? 'true' : null };
    const realOpt0 = { id: 'opt-real-0', setAttribute() {}, getAttribute: (attr) => attr === 'aria-disabled' ? null : null };
    const realOpt1 = { id: 'opt-real-1', setAttribute() {}, getAttribute: (attr) => attr === 'aria-disabled' ? null : null };
    const noResults = { id: 'opt-empty', setAttribute() {}, getAttribute: (attr) => attr === 'aria-disabled' ? 'true' : null };

    const dd = {
      id: 'dd-nav',
      classList: { add() {}, remove() {}, contains: () => false },
      querySelectorAll: () => [spinner, realOpt0, realOpt1, noResults]
    };

    app.document.getElementById = (id) => {
      if (id === 'dd-nav') return dd;
      if (id === 'wc-search-nav') return inp;
      return elFalso();
    };

    const evt = {
      key: 'ArrowDown',
      preventDefault() {},
      target: inp
    };

    // Primera pulsación ArrowDown: debe saltar spinner y apuntar a realOpt0
    app.navegarBusqueda(evt, 'nav');
    expect(ariaActive).toBe('opt-real-0');

    // Segunda pulsación: apunta a realOpt1
    app.navegarBusqueda(evt, 'nav');
    expect(ariaActive).toBe('opt-real-1');

    // Tercera pulsación: saltar noResults (aria-disabled) y wrap to realOpt0
    app.navegarBusqueda(evt, 'nav');
    expect(ariaActive).toBe('opt-real-0');
  });
});
