import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Aísla, sin jsdom, la lógica JS embebida en public/usuarios/index.html que
// cierra el modal de alta/edición con la tecla Esc (mismo patrón que
// test/etiquetas-categoria.test.js).
//
// Bug/fix cubierto: el modal solo se cerraba clickeando el fondo o el botón
// "Cancelar"; faltaba el atajo estándar de teclado Esc.

function extraerScriptMasLargo(html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!matches.length) throw new Error('No se encontró ningún <script> inline en index.html');
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

function crearClassList(estadoInicial) {
  const clases = new Set(estadoInicial ? estadoInicial.split(' ') : []);
  return {
    add: (c) => clases.add(c),
    remove: (c) => clases.delete(c),
    contains: (c) => clases.has(c),
  };
}

function crearElementoFake(id) {
  const listeners = {};
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    disabled: false,
    checked: false,
    classList: crearClassList(''),
    parentElement: { style: {} },
    addEventListener(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach((fn) => fn(evt)); },
    querySelector() { return crearElementoFake('sub'); },
    querySelectorAll() { return []; },
  };
}

let ctx;
let documentListeners;
let modalBg;

beforeEach(() => {
  const htmlPath = path.resolve(__dirname, '../public/usuarios/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptSrc = extraerScriptMasLargo(html);

  const elementos = new Map();
  modalBg = crearElementoFake('modal-bg');
  elementos.set('modal-bg', modalBg);
  documentListeners = {};

  const documentoFake = {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, crearElementoFake(id));
      return elementos.get(id);
    },
    querySelector() { return crearElementoFake('sub'); },
    querySelectorAll() { return []; },
    addEventListener(evt, fn) { (documentListeners[evt] = documentListeners[evt] || []).push(fn); },
  };

  const sandbox = {
    document: documentoFake,
    window: { addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch() { return Promise.resolve({ json: () => Promise.resolve({ usuarios: [] }) }); },
    location: { pathname: '/usuarios/', href: '', search: '' },
    Api: new Proxy({}, { get() { return (..._a) => Promise.resolve({ usuarios: [] }); } }),
    api: () => Promise.resolve({ usuarios: [] }),
    prompt: () => null,
    confirm: () => false,
    console,
    setTimeout,
    clearTimeout,
  };
  ctx = vm.createContext(sandbox);
  vm.runInContext(scriptSrc, ctx, { filename: 'usuarios-inline.js' });
});

function dispararEsc() {
  const handlers = documentListeners.keydown || [];
  handlers.forEach((fn) => fn({ key: 'Escape' }));
}

describe('usuarios/index.html — cierre del modal con Esc', () => {
  it('cierra el modal (quita la clase show) al presionar Escape estando abierto', () => {
    modalBg.classList.add('show');
    expect(modalBg.classList.contains('show')).toBe(true);

    dispararEsc();

    expect(modalBg.classList.contains('show')).toBe(false);
  });

  it('no rompe nada si se presiona Escape con el modal ya cerrado', () => {
    expect(modalBg.classList.contains('show')).toBe(false);
    expect(() => dispararEsc()).not.toThrow();
    expect(modalBg.classList.contains('show')).toBe(false);
  });

  it('ignora otras teclas (no cierra el modal con, por ejemplo, Enter)', () => {
    modalBg.classList.add('show');
    const handlers = documentListeners.keydown || [];
    handlers.forEach((fn) => fn({ key: 'Enter' }));
    expect(modalBg.classList.contains('show')).toBe(true);
  });
});
