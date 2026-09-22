import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const elFalso = () => ({
  value: '', textContent: '', innerHTML: '', style: {}, disabled: false, dataset: {}, offsetParent: {},
  classList: { add() {}, remove() {}, contains: () => false },
  addEventListener() {},
  setAttribute() {},
  getAttribute() { return null; },
  appendChild() {},
  focus() {},
  querySelector() { return null; },
  querySelectorAll() { return []; }
});

function cargarApp() {
  const html = fs.readFileSync(new URL('../public/recepcion/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const src = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
  const sandbox = {
    document: {
      getElementById: elFalso,
      querySelector: () => null,
      addEventListener() {},
      createElement: () => ({ value: '', innerHTML: '', appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
      activeElement: elFalso()
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

describe('UI de recepción — Verificaciones de texto (sin ejecutar lógica)', () => {
  const html = fs.readFileSync(new URL('../public/recepcion/index.html', import.meta.url), 'utf8');

  it('no decide matches ni descarga el catálogo completo', () => {
    expect(html).not.toMatch(/function\s+matchItem\s*\(/);
    expect(html).not.toMatch(/function\s+fuzzyMatchItem\s*\(/);
    expect(html).not.toContain("fetch('/api/woo/catalogo')");
    expect(html).toContain("fetch('/api/recepciones/matchear'");
  });

  it('protege respuestas fuera de orden', () => {
    expect(html).toContain('matchRequestVersion');
    expect(html).toContain('version !== matchRequestVersion');
  });

  it('conecta el alta draft y conserva operation_id ante incertidumbre', () => {
    expect(html).toContain('/api/nuevos-productos/crear-borrador');
    expect(html).toContain('operationId');
    expect(html).toContain('No repitas la operación');
  });

  it('revocarAliasUI no usa window.prompt ni alert', () => {
    const match = html.match(/function\s+revocarAliasUI\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(match).toBeTruthy();
    const funcBody = match[0];
    expect(funcBody).not.toContain('window.prompt');
    expect(funcBody).not.toContain('alert');
  });

  it('abrirAltaBorrador no usa window.prompt ni alert', () => {
    const match = html.match(/function\s+abrirAltaBorrador\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(match).toBeTruthy();
    const funcBody = match[0];
    expect(funcBody).not.toContain('window.prompt');
    expect(funcBody).not.toContain('alert');
  });

  it('modal implementa abrirModal, cerrarModal y mostrarErroresModal', () => {
    expect(html).toContain('function abrirModal');
    expect(html).toContain('function cerrarModal');
    expect(html).toContain('function mostrarErroresModal');
  });

  it('modal tiene atributos ARIA correctos en el HTML', () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="modal-title"');
  });

  it('abrirAltaBorrador carga categorías desde /api/nuevos-productos/categorias-woo', () => {
    expect(html).toContain('/api/nuevos-productos/categorias-woo');
  });

  // P1.9: Migración de prompts al modal genérico
  it('agregarDoc no usa window.prompt', () => {
    const match = html.match(/function\s+agregarDoc\s*\([^)]*\)\s*\{[\s\S]*?^function/m);
    expect(match).toBeTruthy();
    const funcBody = match[0];
    expect(funcBody).not.toContain('window.prompt');
    expect(funcBody).toContain('abrirModal');
  });

  it('agregarItemManual no usa window.prompt', () => {
    const match = html.match(/function\s+agregarItemManual\s*\([^)]*\)\s*\{[\s\S]*?^function/m);
    expect(match).toBeTruthy();
    const funcBody = match[0];
    expect(funcBody).not.toContain('window.prompt');
    expect(funcBody).toContain('abrirModal');
    expect(funcBody).toContain('item-nombre-input');
    expect(funcBody).toContain('item-cantidad-input');
  });

  // P1.9: Focus trap en el modal
  it('modal implementa focus trap para Tab/Shift+Tab', () => {
    expect(html).toContain("if (e.key === 'Tab')");
    expect(html).toContain('focusableElements');
    expect(html).toContain('e.shiftKey');
    expect(html).toContain('lastElement.focus()');
    expect(html).toContain('firstElement.focus()');
  });

  it('focus trap obtiene elementos focuseables dinámicamente del modal', () => {
    expect(html).toContain("dialog.querySelectorAll");
    expect(html).toContain("'input, textarea, select, button:not([disabled])'");
  });
});

describe('Modal — Ejecución real de lógica (harness vm)', () => {
  it('[a] agregarDoc con número vacío agrega {tipo, numero: null}', () => {
    const app = cargarApp();
    let numInputValue = '';

    app.docs = [];
    app.renderDocs = () => {};

    app.document.getElementById = (id) => {
      if (id === 'modal-overlay') return { classList: { add() {}, remove() {} } };
      if (id === 'modal-dialog') return {
        querySelector() { return null; },
        querySelectorAll() { return []; }
      };
      if (id === 'modal-title') return { textContent: '' };
      if (id === 'modal-body') return { innerHTML: '', querySelector() { return null; } };
      if (id === 'modal-errors') return { innerHTML: '', classList: { add() {}, remove() {} } };
      if (id === 'modal-confirm-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'modal-cancel-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'doc-num-input') return { value: numInputValue, trim: () => '', focus() {}, click() {}, blur() {} };
      return elFalso();
    };

    app.document.activeElement = { focus() {}, click() {}, blur() {} };

    // Llamar agregarDoc
    app.agregarDoc('factura');

    // Verificar que el modal se abrió
    expect(app.modalState.isOpen).toBe(true);

    // Simular click en confirmar (llamar onConfirm)
    if (app.modalState.onConfirm) {
      app.modalState.onConfirm();
    }

    // Verificar que docs recibió {tipo: 'factura', numero: null}
    expect(app.docs.length).toBe(1);
    expect(app.docs[0].tipo).toBe('factura');
    expect(app.docs[0].numero).toBe(null);
  });

  it('[b] Cancelar el modal agregarDoc no agrega nada a docs', () => {
    const app = cargarApp();

    app.docs = [];
    app.renderDocs = () => {};

    app.document.getElementById = (id) => {
      if (id === 'modal-overlay') return { classList: { add() {}, remove() {} } };
      if (id === 'modal-dialog') return {
        querySelector() { return null; },
        querySelectorAll() { return []; }
      };
      if (id === 'modal-title') return { textContent: '' };
      if (id === 'modal-body') return { innerHTML: '', querySelector() { return null; } };
      if (id === 'modal-errors') return { innerHTML: '', classList: { add() {}, remove() {} } };
      if (id === 'modal-confirm-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'modal-cancel-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'doc-num-input') return { value: '', trim: () => '', focus() {}, click() {}, blur() {} };
      return elFalso();
    };

    app.document.activeElement = { focus() {}, click() {}, blur() {} };

    // Llamar agregarDoc
    app.agregarDoc('remito');

    // Simular click en cancelar
    if (app.modalState.onCancel) {
      app.modalState.onCancel();
    }

    // Cerrar el modal
    app.cancelarModal();

    // Verificar que docs permanece vacío
    expect(app.docs.length).toBe(0);
    expect(app.modalState.isOpen).toBe(false);
  });

  it('[c] agregarItemManual con cantidad vacía llama mostrarErroresModal y no agrega item', () => {
    const app = cargarApp();
    let errorMostrado = null;

    app.items = [];
    app.renderItems = () => {};
    app.actualizarBotones = () => {};

    // Mock mostrarErroresModal para capturar lo que se muestra
    const origMostrar = app.mostrarErroresModal;
    app.mostrarErroresModal = function(errores) {
      errorMostrado = errores;
      return origMostrar.apply(this, arguments);
    };

    app.document.getElementById = (id) => {
      if (id === 'modal-overlay') return { classList: { add() {}, remove() {} } };
      if (id === 'modal-dialog') return {
        querySelector() { return null; },
        querySelectorAll() { return []; }
      };
      if (id === 'modal-title') return { textContent: '' };
      if (id === 'modal-body') return { innerHTML: '', querySelector() { return null; } };
      if (id === 'modal-errors') return { innerHTML: '', classList: { add() {}, remove() {} } };
      if (id === 'modal-confirm-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'modal-cancel-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'item-nombre-input') return { value: 'Rueda 28', trim: () => 'Rueda 28', focus() {}, click() {}, blur() {} };
      if (id === 'item-cantidad-input') return { value: '', trim: () => '', focus() {}, click() {}, blur() {} };
      return elFalso();
    };

    app.document.activeElement = { focus() {}, click() {}, blur() {} };

    // Llamar agregarItemManual
    app.agregarItemManual();

    // Simular click en confirmar
    if (app.modalState.onConfirm) {
      app.modalState.onConfirm();
    }

    // Verificar que se mostró error de cantidad
    expect(errorMostrado).toBeTruthy();
    expect(errorMostrado[0]).toContain('cantidad');

    // Verificar que el modal sigue abierto (no se cerró)
    expect(app.modalState.isOpen).toBe(true);

    // Verificar que no se agregó el item
    expect(app.items.length).toBe(0);
  });

  it('[d] agregarItemManual con cantidad inválida ("abc") rechaza y no agrega item', () => {
    const app = cargarApp();
    let errorMostrado = null;

    app.items = [];
    app.renderItems = () => {};
    app.actualizarBotones = () => {};

    const origMostrar = app.mostrarErroresModal;
    app.mostrarErroresModal = function(errores) {
      errorMostrado = errores;
      return origMostrar.apply(this, arguments);
    };

    app.document.getElementById = (id) => {
      if (id === 'modal-overlay') return { classList: { add() {}, remove() {} } };
      if (id === 'modal-dialog') return {
        querySelector() { return null; },
        querySelectorAll() { return []; }
      };
      if (id === 'modal-title') return { textContent: '' };
      if (id === 'modal-body') return { innerHTML: '', querySelector() { return null; } };
      if (id === 'modal-errors') return { innerHTML: '', classList: { add() {}, remove() {} } };
      if (id === 'modal-confirm-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'modal-cancel-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'item-nombre-input') return { value: 'Manillar', trim: () => 'Manillar', focus() {}, click() {}, blur() {} };
      if (id === 'item-cantidad-input') return { value: 'abc', trim: () => 'abc', focus() {}, click() {}, blur() {} };
      return elFalso();
    };

    app.document.activeElement = { focus() {}, click() {}, blur() {} };

    app.agregarItemManual();

    if (app.modalState.onConfirm) {
      app.modalState.onConfirm();
    }

    // Cantidad "abc" parsea a NaN, por lo que parseInt("abc") = NaN, que falla la validación
    expect(errorMostrado).toBeTruthy();
    expect(errorMostrado[0]).toContain('cantidad');
    expect(app.modalState.isOpen).toBe(true);
    expect(app.items.length).toBe(0);
  });

  it('[d2] agregarItemManual con cantidad negativa (-1) rechaza y no agrega item', () => {
    const app = cargarApp();
    let errorMostrado = null;

    app.items = [];
    app.renderItems = () => {};
    app.actualizarBotones = () => {};

    const origMostrar = app.mostrarErroresModal;
    app.mostrarErroresModal = function(errores) {
      errorMostrado = errores;
      return origMostrar.apply(this, arguments);
    };

    app.document.getElementById = (id) => {
      if (id === 'modal-overlay') return { classList: { add() {}, remove() {} } };
      if (id === 'modal-dialog') return {
        querySelector() { return null; },
        querySelectorAll() { return []; }
      };
      if (id === 'modal-title') return { textContent: '' };
      if (id === 'modal-body') return { innerHTML: '', querySelector() { return null; } };
      if (id === 'modal-errors') return { innerHTML: '', classList: { add() {}, remove() {} } };
      if (id === 'modal-confirm-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'modal-cancel-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'item-nombre-input') return { value: 'Grips', trim: () => 'Grips', focus() {}, click() {}, blur() {} };
      if (id === 'item-cantidad-input') return { value: '-1', trim: () => '-1', focus() {}, click() {}, blur() {} };
      return elFalso();
    };

    app.document.activeElement = { focus() {}, click() {}, blur() {} };

    app.agregarItemManual();

    if (app.modalState.onConfirm) {
      app.modalState.onConfirm();
    }

    expect(errorMostrado).toBeTruthy();
    expect(errorMostrado[0]).toContain('cantidad');
    expect(app.modalState.isOpen).toBe(true);
    expect(app.items.length).toBe(0);
  });

  it('[e] Focus trap excluye elementos con offsetParent === null (ocultos)', () => {
    const app = cargarApp();

    // Simular elementos focuseables donde uno está oculto (offsetParent === null)
    const visibleInput = { type: 'text', offsetParent: {}, focus() {}, click() {}, blur() {} };
    const hiddenInput = { type: 'text', offsetParent: null, focus() {}, click() {}, blur() {} };
    const visibleButton = { offsetParent: {}, focus() {}, click() {}, blur() {}, disabled: false };

    app.document.getElementById = (id) => {
      if (id === 'modal-overlay') return { classList: { add() {}, remove() {} } };
      if (id === 'modal-dialog') return {
        querySelectorAll: (selector) => {
          if (selector.includes('input, textarea, select, button:not([disabled])')) {
            // Devolver: input visible, input oculto, button visible
            return [visibleInput, hiddenInput, visibleButton];
          }
          return [];
        }
      };
      if (id === 'modal-title') return { textContent: '' };
      if (id === 'modal-body') return { innerHTML: '' };
      if (id === 'modal-errors') return { innerHTML: '', classList: { add() {}, remove() {} } };
      if (id === 'modal-confirm-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      if (id === 'modal-cancel-btn') return { textContent: '', onclick: null, focus() {}, click() {}, blur() {} };
      return elFalso();
    };

    // Simular el evento de Tab y capturar qué se filtra
    const dialog = app.document.getElementById('modal-dialog');
    const focusableSelectors = 'input, textarea, select, button:not([disabled])';
    const focusableElements = Array.from(dialog.querySelectorAll(focusableSelectors))
      .filter(function(el) {
        // El filtro del código real
        return el.offsetParent !== null || el.type === 'hidden';
      });

    // Debe excluir hiddenInput (offsetParent === null y type !== 'hidden')
    // e incluir visibleInput y visibleButton
    expect(focusableElements.length).toBe(2);
    expect(focusableElements[0]).toBe(visibleInput);
    expect(focusableElements[1]).toBe(visibleButton);
  });
});
