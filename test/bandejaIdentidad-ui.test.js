import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Prueba el código real de public/bandeja-identidad/logica.js (no una copia).
// logica.js es un script clásico (UMD): en vitest se exporta como CommonJS-interop o cuelga de globalThis, como en el navegador.
const mod = await import('../public/bandeja-identidad/logica.js');
const L = mod.default?.marca ? mod.default : mod.marca ? mod : (globalThis.BandejaLogica ?? globalThis.window?.BandejaLogica);
const ev = (o = {}) => ({ key: 'j', target: { tagName: 'DIV', closest: () => null }, ...o });

function cargarBandejaConDomInyectado(fetchImpl = () => Promise.resolve({ status: 200, json: async () => ({}) })) {
  function nodo(tagName = 'DIV') {
    return {
      tagName, children: [], textContent: '', className: '', style: {},
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(hijo) { hijo.parentNode = this; this.children.push(hijo); return hijo; },
      addEventListener(tipo, fn) { this.listeners = this.listeners || {}; this.listeners[tipo] = fn; },
      click() { if (this.listeners?.click) this.listeners.click({ target: this }); },
      focus() {},
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector(selector) {
        if (selector === '.btn') return this.children.find((hijo) => hijo.tagName === 'BUTTON') || null;
        if (selector.startsWith('[data-clave="')) {
          const clave = selector.slice(13, -2);
          return this.children.find((hijo) => hijo.attrs?.['data-clave'] === clave) || null;
        }
        return null;
      },
      removeChild(hijo) { this.children = this.children.filter((x) => x !== hijo); },
    };
  }
  const avisos = nodo();
  const elementos = new Map([['avisos', avisos]]);
  const document = {
    getElementById(id) { if (id === 'chip-no-decidibles') return null; if (!elementos.has(id)) elementos.set(id, nodo()); return elementos.get(id); },
    createElement(tag) { const h = nodo(tag.toUpperCase()); const set = h.setAttribute; h.setAttribute = (k, v) => { h.attrs = h.attrs || {}; h.attrs[k] = v; set.call(h, k, v); }; return h; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const window = { __bandejaIdentidadTest: true, BandejaLogica: L, addEventListener() {}, removeEventListener() {}, localStorage: { getItem() { return null; }, setItem() {} }, navigator: { onLine: true } };
  window.window = window;
  const sandbox = { window, document, crypto: { randomUUID: () => 'generated-key' }, fetch: fetchImpl, navigator: window.navigator, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8'), sandbox);
  return { app: sandbox.window.__bandejaIdentidadTest, avisos };
}

describe('bandeja: logica pura', () => {
  it('cancelar sólo libera la decisión después de reconciliar el caso', () => {
    const claves = ['clave-1', 'clave-2'];
    const guardia = L.crearGuardiaDecisiones(() => claves.shift());
    const primera = guardia.iniciar({ caseId: 'caso-1', cuerpo: { eleccion: 'omitir' } }).entrada;

    guardia.terminar(primera, { status: 503 });
    expect(guardia.reconciliar(primera)).toBe(primera);
    expect(guardia.cancelar(primera, { status: 503 })).toBe(false);
    expect(guardia.estaBloqueado('caso-1')).toBe(true);
    expect(guardia.cancelar(primera, { status: 200 })).toBe(true);
    expect(guardia.estaBloqueado('caso-1')).toBe(false);
  });

  it('después de cancelar una decisión, la siguiente entrada usa una clave nueva', () => {
    const guardia = L.crearGuardiaDecisiones((() => {
      const claves = ['clave-1', 'clave-2'];
      return () => claves.shift();
    })());
    const primera = guardia.iniciar({ caseId: 'caso-1' });
    guardia.terminar(primera.entrada, { status: 503 });
    guardia.reconciliar(primera.entrada);
    expect(guardia.cancelar(primera.entrada, { status: 200 })).toBe(true);
    const segunda = guardia.iniciar({ caseId: 'caso-1' });
    expect(segunda.nueva).toBe(true);
    expect(segunda.entrada.key).toBe('clave-2');
  });

  it('tipo de caso y precio tienen copy legible para la estación', () => {
    expect(L.fraseTipo('sku_pendiente')).toMatch(/SKU/i);
    expect(L.fraseTipo('tipo_nuevo')).toMatch(/compar/i);
    expect(L.formatoPrecio(189900, 'ARS')).toBe('189.900 ARS');
  });

  it('diferenciasVisibles devuelve diferencias priorizadas, iguales y nombres sin duplicar', () => {
    const explicacion = { atributos: [
      { nombre: 'igual', marca: 'coincide', valorMl: 'x', valorCandidato: 'x' },
      { nombre: 'falta', marca: 'falta', valorMl: '', valorCandidato: '' },
      { nombre: 'cambia', marca: 'difiere', valorMl: 'm', valorCandidato: 'y', valorMlOriginal: 'ML m', valorCandidatoOriginal: 'Woo y' },
      { nombre: 'equiv', marca: 'equivalente', valorMl: 'negro', valorCandidato: 'negro mate' },
      { nombre: 'cambia', marca: 'difiere', valorMl: 'duplicado', valorCandidato: 'descartado' }
    ], otros_atributos: [{ nombre: 'marca', marca: 'difiere', valorMl: 'Shimano', valorCandidato: 'Trek' }] };
    const resultado = L.diferenciasVisibles(explicacion);
    expect(resultado.diferencias.map((x) => x.marca)).toEqual(['difiere', 'difiere', 'falta', 'equivalente']);
    expect(resultado.diferencias.map((x) => x.nombre)).toEqual(['cambia', 'marca', 'falta', 'equiv']);
    expect(resultado.diferencias[0]).toMatchObject({ texto: 'difiere', simbolo: '≠', valorMl: 'ML m', valorCandidato: 'Woo y' });
    expect(resultado.iguales).toBe(1);
    expect(resultado.nombresIguales).toEqual(['igual']);
  });

  it('formatea una fila de resultado con los datos visibles y su conteo', () => {
    const fila = L.formatoFilaResultado({ variant_id: 'v1', titulo: 'Casco Bell', sku: 'FB-1', precio: 12500, moneda: 'ARS', stock: 3, foto: '/casco.jpg', explicacion: { atributos: [{ nombre: 'color', marca: 'difiere' }] } });
    expect(fila).toMatchObject({ variant_id: 'v1', titulo: 'Casco Bell', sku: 'FB-1', foto: '/casco.jpg', precio: '12.500 ARS', stock: '3 en stock', diferencias: 1, textoDiferencias: '1 dif.' });
  });

  it('cuenta N dif. de un resultado usando diferenciasVisibles', () => {
    expect(L.diferenciasDeResultado({ explicacion: { atributos: [{ nombre: 'color', marca: 'difiere' }, { nombre: 'marca', marca: 'coincide' }], otros_atributos: [{ nombre: 'talle', marca: 'falta' }] } })).toBe(2);
  });

  it('navega resultados arriba/abajo de forma circular', () => {
    expect(L.indiceResultadoBusqueda(0, 3, -1)).toBe(2);
    expect(L.indiceResultadoBusqueda(2, 3, 1)).toBe(0);
    expect(L.indiceResultadoBusqueda(-1, 3, 1)).toBe(0);
  });

  it('pluraliza la barra y los chips, incluso cuando no hay diferencias', () => {
    expect(L.textoDiferencias(0)).toBe('sin diferencias');
    expect(L.textoDiferencias(1)).toBe('1 diferencia');
    expect(L.textoDiferencias(2)).toBe('2 diferencias');
    expect(L.textoDecision({ sku: 'FB-1' }, { diferencias: [{ marca: 'difiere' }] })).toMatch(/FB-1 \(1 diferencia\)/);
  });

  it('resume un candidato contando sólo diferenciasVisibles y acortando únicamente el título', () => {
    const explicacion = {
      atributos: [
        { nombre: 'marca', marca: 'coincide' },
        { nombre: 'modelo', marca: 'coincide' },
        { nombre: 'color', marca: 'coincide' },
        { nombre: 'talle', marca: 'coincide' },
        { nombre: 'rodado', marca: 'difiere' }
      ]
    };
    const resumen = L.resumenCandidato({
      titulo: 'Bicicleta urbana con canasto delantero y cambios',
      explicacion
    });

    expect(resumen.diferencias).toBe(1);
    expect(resumen.titulo).toHaveLength(28);
    expect(resumen.titulo.endsWith('…')).toBe(true);

    const sóloCoinciden = { atributos: [
      { nombre: 'marca', marca: 'coincide' },
      { nombre: 'modelo', marca: 'coincide' },
      { nombre: 'color', marca: 'coincide' },
      { nombre: 'talle', marca: 'coincide' }
    ] };
    expect(L.resumenCandidato({ titulo: 'Candidato exacto', explicacion: sóloCoinciden }).diferencias).toBe(0);
  });
  it('marcas: símbolo + texto para cada una y no se rompe con una desconocida', () => {
    expect(L.marca('coincide')).toMatchObject({ simbolo: '✓', texto: 'coincide' });
    expect(L.marca('difiere').simbolo).toBe('≠');
    expect(L.marca('falta').simbolo).toBe('—');
    expect(L.marca('equivalente').simbolo).toBe('≈');
    expect(L.marca('xyz').texto).toBe('xyz');
  });

  it('copy de errores: cada código de la API tiene su texto de la spec', () => {
    for (const c of ['version_conflict', 'caso_cerrado', 'revierte_no_vigente', 'solo_admin', 'variante_invalida',
      'caso_sin_publicacion', 'idempotency_mismatch', 'caso_inexistente', 'bandeja_apagada', 'plataforma_no_responde']) {
      expect(L.copyError(c)).not.toMatch(/No se pudo completar/);
    }
    expect(L.copyError('otro')).toMatch(/otro/);
  });

  it('atajos: apagados, con modificadores, escribiendo o dentro de un diálogo no disparan', () => {
    expect(L.puedeDispararAtajo(ev(), true)).toBe(true);
    expect(L.puedeDispararAtajo(ev(), false)).toBe(false);
    for (const m of ['ctrlKey', 'altKey', 'metaKey']) expect(L.puedeDispararAtajo(ev({ [m]: true }), true)).toBe(false);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(L.puedeDispararAtajo(ev({ target: { tagName, closest: () => null } }), true)).toBe(false);
    expect(L.puedeDispararAtajo(ev({ target: { tagName: 'DIV', closest: (s) => (s === 'dialog' ? {} : null) } }), true)).toBe(false);
    expect(L.puedeDispararAtajo(ev({ target: { tagName: 'DIV', isContentEditable: true, closest: () => null } }), true)).toBe(false);
  });

  it('reintento: sólo red caída, 429 y 5xx; un 4xx es definitivo', () => {
    for (const s of [0, 429, 500, 502, 503]) expect(L.esReintentable(s)).toBe(true);
    for (const s of [200, 400, 403, 404, 409, 422]) expect(L.esReintentable(s)).toBe(false);
    // backoff exponencial con jitter ±25 %, tope de 15 s, y 5 intentos en total
    expect(L.demora(0, () => 0.5)).toBe(1000);
    expect(L.demora(1, () => 0.5)).toBe(2000);
    expect(L.demora(3, () => 0.5)).toBe(8000);
    expect(L.demora(99, () => 0.5)).toBe(15000);
    expect(L.demora(2, () => 0)).toBe(3000);
    expect(L.demora(2, () => 1)).toBe(5000);
    expect(L.MAX_INTENTOS).toBe(5);
  });

  it('deshacer: vale 10 s, una sola vez, y sólo si hay una decisión', () => {
    const u = { ts: 1000, consumida: false };
    expect(L.puedeDeshacer(u, 1000 + 10000)).toBe(true);
    expect(L.puedeDeshacer(u, 1000 + 10001)).toBe(false);
    expect(L.puedeDeshacer({ ...u, consumida: true }, 1500)).toBe(false);
    expect(L.puedeDeshacer(null, 1500)).toBe(false);
  });

  it('total del filtro: suma de grupos (sin no_decidibles) o el del grupo elegido, incluye confirmable y sin_titulo', () => {
    const c = { conflictos: 1, d5: 2, sku_exacto: 3, activas_con_stock: 4, resto: 5, confirmable: 6, sin_titulo: 7, no_decidibles: 99 };
    expect(L.totalFiltro(c, null)).toBe(28);
    expect(L.totalFiltro(c, 1)).toBe(2);
    expect(L.totalFiltro(c, 5)).toBe(6);
    expect(L.totalFiltro(c, 6)).toBe(7);
    expect(L.totalFiltro({}, 4)).toBe(0);
  });

  it('grupos: confirmable (5) y sin_titulo (6) están en el mapa y el nombrero, en ese orden', () => {
    expect(L.GRUPOS.confirmable).toBe(5);
    expect(L.GRUPOS.sin_titulo).toBe(6);
    expect(L.GRUPO_NOMBRE[5]).toMatch(/confirm/i);
    expect(L.GRUPO_NOMBRE[6]).toMatch(/sin.*t[ií]tulo/i);
  });

  it('precio y stock sin dato no dicen «null»', () => {
    expect(L.formatoPrecio(null, null)).toBe('Sin precio');
    expect(L.formatoPrecio(1500, 'ARS')).toBe('1.500 ARS');
    expect(L.formatoStock(null)).toBe('Stock sin dato');
    expect(L.formatoStock(0)).toBe('0 en stock');
  });

  it('opciones = candidatos + búsqueda sin repetir la misma variante', () => {
    const c = [{ variant_id: 'a' }, { variant_id: 'b' }];
    expect(L.opcionesDe(c, [{ variant_id: 'b' }, { variant_id: 'c' }]).map((o) => o.variant_id)).toEqual(['a', 'b', 'c']);
  });

  it('sólo diferencias oculta las filas donde todo coincide y deja las que difieren o faltan', () => {
    const ops = [{ explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }, { nombre: 'talle', marca: 'difiere' }], otros_atributos: [{ nombre: 'marca', marca: 'falta' }] } }];
    expect(L.nombresAtributos(ops)).toEqual(['color', 'talle', 'marca']);
    expect(L.filaVisible(ops, 'color', true)).toBe(false);
    expect(L.filaVisible(ops, 'talle', true)).toBe(true);
    expect(L.filaVisible(ops, 'marca', true)).toBe(true);
    expect(L.filaVisible(ops, 'color', false)).toBe(true);
  });

  it('sólo diferencias: un candidato SIN dato para el atributo (ni siquiera "falta") no se oculta, aunque otro coincida', () => {
    // Corrección de un hallazgo Alto de Codex en T4: ocultar esta fila haría parecer que el candidato sin
    // dato coincide, empujando a un vínculo equivocado — justo lo que el rediseño busca evitar.
    const ops = [
      { explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }] } },
      { explicacion: { atributos: [] } }, // sin entrada para 'color': ni coincide, ni difiere, ni falta
    ];
    expect(L.filaVisible(ops, 'color', true)).toBe(true);
  });

  it('sólo diferencias: equivalente cuenta como coincidencia (no fuerza la fila a visible)', () => {
    const ops = [{ explicacion: { atributos: [{ nombre: 'rodado', marca: 'equivalente' }] } }];
    expect(L.filaVisible(ops, 'rodado', true)).toBe(false);
  });

  it('sólo diferencias: atributo ausente en TODOS los candidatos (no sólo en uno) se muestra', () => {
    // Sugerencia Baja de Codex tras el fix: pinnear el caso donde ningún candidato tiene el atributo,
    // no sólo el caso mixto (uno con dato, otro sin) que ya cubre el test anterior.
    const ops = [
      { explicacion: { atributos: [] } },
      { explicacion: { atributos: [] } },
    ];
    expect(L.filaVisible(ops, 'color', true)).toBe(true);
  });

  it('sólo diferencias: sin candidatos (arreglo vacío) no hay nada que difiera → oculta', () => {
    // Sugerencia Baja de Codex: comportamiento no especificado antes, ahora pinneado. Es inalcanzable desde
    // la UI real (los nombres de fila salen de los propios candidatos), pero queda fijado por si se llama
    // a filaVisible directamente desde otro lado.
    expect(L.filaVisible([], 'color', true)).toBe(false);
  });
});

describe('bandeja: atajos sobre radios', () => {
  it('un radio enfocado no bloquea los atajos (sólo los campos de texto)', () => {
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'radio', closest: () => null } }, true)).toBe(true);
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'search', closest: () => null } }, true)).toBe(false);
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'text', closest: () => null } }, true)).toBe(false);
  });
});

describe('bandeja: decisión bloqueada comunica el estado en el DOM', () => {
  const respuesta = (status, data = {}) => ({ status, json: async () => data });

  it('tras agotar los cinco intentos conserva la decisión y muestra Reintentar y Descartar', async () => {
    vi.useFakeTimers();
    const llamadas = [];
    const { app, avisos } = cargarBandejaConDomInyectado(async (request) => {
      llamadas.push(request);
      return respuesta(503);
    });
    app.state.cola = [{ id: 'caso-agotado' }];
    app.state.idx = 0;
    app.state.detalle = { id: 'caso-agotado', version: 4, candidatos: [] };

    app.decidir('omitir');
    await vi.runAllTimersAsync();

    const aviso = avisos.children.find((n) => n.children.some((hijo) => hijo.textContent.includes('Tu elección se conserva.')));
    expect(llamadas).toHaveLength(5);
    expect(aviso.children.filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent)).toEqual(['Reintentar', 'Descartar', 'Cerrar']);
    vi.useRealTimers();
  });

  it('una decisión fallida muestra aviso claro con Reintentar y Descartar', () => {
    const { app, avisos } = cargarBandejaConDomInyectado();
    app.state.cola = [{ id: 'caso-1' }];
    app.state.idx = 0;
    app.state.detalle = { id: 'caso-1', version: 4, candidatos: [] };
    const entrada = app.state.guardiaDecisiones.iniciar({ caseId: 'caso-1', cuerpo: {} }).entrada;
    app.state.guardiaDecisiones.terminar(entrada, { status: 503 });

    app.decidir('omitir');

    expect(avisos.children[0].children.map((hijo) => hijo.textContent).join(' ')).toContain('Hay una decisión sin confirmar para este caso.');
    expect(avisos.children.filter((aviso) => aviso.children.some((hijo) => hijo.textContent === 'Reintentar'))).toHaveLength(1);
    expect(avisos.children[0].children.some((hijo) => hijo.textContent === 'Descartar')).toBe(true);
  });

  it('una decisión en vuelo sólo avisa que espera confirmación y no ofrece Descartar', () => {
    const { app, avisos } = cargarBandejaConDomInyectado();
    app.state.cola = [{ id: 'caso-2' }];
    app.state.idx = 0;
    app.state.detalle = { id: 'caso-2', version: 1, candidatos: [] };
    app.state.guardiaDecisiones.iniciar({ caseId: 'caso-2', cuerpo: {} });

    app.decidir('omitir');

    const textos = avisos.children[0].children.map((hijo) => hijo.textContent).join(' ');
    expect(textos).toContain('Esperando confirmación…');
    expect(textos).not.toContain('Descartar');
  });

  it('Descartar aplica el detalle abierto y recién entonces libera la guardia', async () => {
    let resolver;
    const detalleNuevo = { id: 'caso-abierto', version: 8, candidatos: [{ variant_id: 'v2' }] };
    const { app, avisos } = cargarBandejaConDomInyectado(() => new Promise((resolve) => { resolver = resolve; }));
    app.state.cola = [{ id: 'caso-abierto', version: 4 }];
    app.state.idx = 0;
    app.state.detalle = { id: 'caso-abierto', version: 4, candidatos: [] };
    const entrada = app.state.guardiaDecisiones.iniciar({ caseId: 'caso-abierto', casoId: 'caso-abierto', cuerpo: {} }).entrada;
    app.state.guardiaDecisiones.terminar(entrada, { status: 503 });
    app.decidir('omitir');

    avisos.children[0].children.find((n) => n.textContent === 'Descartar').click();
    expect(entrada.estado).toBe('reconciliando');
    expect(app.state.guardiaDecisiones.estaBloqueado('caso-abierto')).toBe(true);
    resolver(respuesta(200, detalleNuevo));
    await vi.waitFor(() => expect(app.state.detalle).toEqual(detalleNuevo));

    expect(app.state.detalle).toEqual(detalleNuevo);
    expect(app.state.cola[0].version).toBe(8);
    expect(app.state.guardiaDecisiones.estaBloqueado('caso-abierto')).toBe(false);
  });

  it('Descartar retira un caso cerrado de la cola antes de liberar la guardia', async () => {
    let llamada = 0;
    const { app, avisos } = cargarBandejaConDomInyectado(async () => {
      llamada += 1;
      return llamada === 1
        ? respuesta(200, { id: 'caso-cerrado', version: 9, cerrado_en: '2026-09-26T00:00:00Z' })
        : respuesta(200, { id: 'siguiente', version: 1, candidatos: [] });
    });
    app.state.cola = [{ id: 'caso-cerrado', version: 4 }, { id: 'siguiente', version: 1 }];
    app.state.idx = 0;
    app.state.detalle = { id: 'caso-cerrado', version: 4, candidatos: [] };
    const entrada = app.state.guardiaDecisiones.iniciar({ caseId: 'caso-cerrado', casoId: 'caso-cerrado', cuerpo: {} }).entrada;
    app.state.guardiaDecisiones.terminar(entrada, { status: 503 });
    app.decidir('omitir');

    avisos.children[0].children.find((n) => n.textContent === 'Descartar').click();
    await vi.waitFor(() => expect(app.state.guardiaDecisiones.estaBloqueado('caso-cerrado')).toBe(false));

    expect(app.state.cola.map((c) => c.id)).toEqual(['siguiente']);
    expect(app.state.guardiaDecisiones.estaBloqueado('caso-cerrado')).toBe(false);
  });

  it('si falla el GET de reconciliación mantiene el bloqueo y vuelve a ofrecer ambas acciones', async () => {
    const { app, avisos } = cargarBandejaConDomInyectado(async () => respuesta(503));
    app.state.cola = [{ id: 'caso-sin-respuesta' }];
    app.state.idx = 0;
    app.state.detalle = { id: 'caso-sin-respuesta', version: 4, candidatos: [] };
    const entrada = app.state.guardiaDecisiones.iniciar({ caseId: 'caso-sin-respuesta', casoId: 'caso-sin-respuesta', cuerpo: {} }).entrada;
    app.state.guardiaDecisiones.terminar(entrada, { status: 503 });
    app.decidir('omitir');

    avisos.children[0].children.find((n) => n.textContent === 'Descartar').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(entrada.estado).toBe('fallido');
    expect(app.state.guardiaDecisiones.estaBloqueado('caso-sin-respuesta')).toBe(true);
    expect(avisos.children.some((n) => n.children.some((hijo) => hijo.textContent.includes('No se pudo reconciliar')))).toBe(true);
  });

  it('mientras se reconcilia no permite Reintentar ni iniciar otra decisión', async () => {
    let resolver;
    const { app, avisos } = cargarBandejaConDomInyectado(() => new Promise((resolve) => { resolver = resolve; }));
    app.state.cola = [{ id: 'caso-concurrente' }];
    app.state.idx = 0;
    app.state.detalle = { id: 'caso-concurrente', version: 4, candidatos: [] };
    const entrada = app.state.guardiaDecisiones.iniciar({ caseId: 'caso-concurrente', casoId: 'caso-concurrente', cuerpo: {} }).entrada;
    app.state.guardiaDecisiones.terminar(entrada, { status: 503 });
    app.decidir('omitir');
    const aviso = avisos.children[0];
    const reintentarViejo = aviso.children.find((n) => n.textContent === 'Reintentar');
    aviso.children.find((n) => n.textContent === 'Descartar').click();
    reintentarViejo.click();

    expect(entrada.estado).toBe('reconciliando');
    expect(app.state.pendientes.size).toBe(0);
    resolver(respuesta(200, { id: 'caso-concurrente', version: 5, candidatos: [] }));
    await Promise.resolve();
  });
});

describe('bandeja: deshacer() no se dispara dos veces (regresión de T3)', () => {
  // El bug real: al reescribir deshacer() para apartado/salteado se cambió el guard de entrada de
  // L.puedeDeshacer(u, ahora) (que exige !consumida) a un chequeo inline que sólo miraba `ts`, así que
  // una Z repetida dentro de los 10 s volvía a disparar el undo (POST/DELETE duplicado). Se corrigió
  // volviendo a delegar el guard en L.puedeDeshacer; este test fija ese comportamiento por código fuente
  // (no hay DOM real acá, ver la nota de la Tarea 3 sobre jsdom) y por la lógica pura ya cubierta arriba.
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it('el guard de entrada de deshacer() delega en L.puedeDeshacer (que exige !consumida)', () => {
    const cuerpo = js.match(/function deshacer\(\) \{[\s\S]*?\n {2}\}/)[0];
    expect(cuerpo).toMatch(/L\.puedeDeshacer\(u, Date\.now\(\)\)/);
  });

  it('las 3 formas de S.ultima (decisión, apartado, salteado) siempre incluyen ts y consumida', () => {
    // apartar(): S.ultima = { tipo: 'apartado', ... }
    const apartar = js.match(/function apartar\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(apartar).toMatch(/(?:var|const) undo = \{[^}]*ts: Date\.now\(\)[^}]*consumida: false[^}]*\}/);
    // omitirPorAhora(): S.ultima = { tipo: 'salteado', ... }
    const omitir = js.match(/function omitirPorAhora\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(omitir).toMatch(/S\.ultima = \{[^}]*ts: Date\.now\(\)[^}]*consumida: false[^}]*\}/);
    // decidir(): S.ultima = { entry, ts, consumida }
    const decidir = js.match(/function decidir\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(decidir).toMatch(/S\.ultima = \{ entry: entry, ts: Date\.now\(\), consumida: false \}/);
  });
});

describe('bandeja: visor comparativo', () => {
  it('cambia el nivel de zoom entre 1x, 2x y 3x y 0 vuelve a 1x', () => {
    expect(L.siguienteNivelZoom(1, 'click')).toBe(2);
    expect(L.siguienteNivelZoom(2, 'click')).toBe(3);
    expect(L.siguienteNivelZoom(3, 'click')).toBe(1);
    expect(L.siguienteNivelZoom(1, '+')).toBe(2);
    expect(L.siguienteNivelZoom(3, '+')).toBe(1);
    expect(L.siguienteNivelZoom(3, '-')).toBe(2);
    expect(L.siguienteNivelZoom(1, '-')).toBe(3);
    expect(L.siguienteNivelZoom(3, '0')).toBe(1);
  });

  it('cambia el candidato de forma circular', () => {
    expect(L.indiceCandidatoVisor(0, 3, 1)).toBe(1);
    expect(L.indiceCandidatoVisor(2, 3, 1)).toBe(0);
    expect(L.indiceCandidatoVisor(0, 3, -1)).toBe(2);
    expect(L.indiceCandidatoVisor(-1, 0, 1)).toBe(-1);
  });

  it('arma el par ML/candidato conservando título y SKU y deja null si no hay candidato', () => {
    const caso = {
      publicacion: { foto: 'ml.jpg', thumbnail: 'thumb.jpg', titulo: 'Casco ML', sku_observado: 'ML-1' },
      candidatos: [{ foto: 'woo.jpg', titulo: 'Casco Woo', sku: 'FB-1' }]
    };
    expect(L.paresParaVisor(caso, caso.candidatos[0])).toEqual({
      ml: { foto: 'ml.jpg', titulo: 'Casco ML', sku: 'ML-1' },
      candidato: { foto: 'woo.jpg', titulo: 'Casco Woo', sku: 'FB-1' }
    });
    expect(L.paresParaVisor(caso, null).candidato).toBeNull();
  });

  it('mantiene tamaños de imagen distintos en cada nivel del zoom', () => {
    expect(L.tamanoZoom(1)).toEqual({ nivel: 1, porcentaje: 100 });
    expect(L.tamanoZoom(2)).toEqual({ nivel: 2, porcentaje: 200 });
    expect(L.tamanoZoom(3)).toEqual({ nivel: 3, porcentaje: 300 });
    expect(L.tamanoZoom(99)).toEqual({ nivel: 1, porcentaje: 100 });

    const css = readFileSync(new URL('../public/bandeja-identidad/bandeja.css', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/bandeja-identidad/index.html', import.meta.url), 'utf8');
    expect(css).toMatch(/\.visor-pares\[data-zoom="2"\][\s\S]*?width:\s*200%[\s\S]*?max-inline-size:\s*none/);
    expect(css).toMatch(/\.visor-pares\[data-zoom="3"\][\s\S]*?width:\s*300%[\s\S]*?max-inline-size:\s*none/);
    expect(html).toMatch(/\.visor-foto-imagen[\s\S]*?max-inline-size:\s*100%/);
  });
});

describe('bandeja: contrato estático de accesibilidad y responsive', () => {
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/bandeja-identidad/bandeja.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/bandeja-identidad/index.html', import.meta.url), 'utf8');

  it('enuncia el caso y enfoca su título al cambiar de caso', () => {
    expect(js).toMatch(/el\('h1',[\s\S]*?tabindex: '-1', id: 'caso-focus'/);
    expect(js).toMatch(/Caso '\s*\+ \(S\.hechos \+ 1\)[\s\S]*?de[\s\S]*?: '\s*\+ tipo/);
    expect(js).toMatch(/var h = \$\('caso-focus'\); if \(h\) h\.focus\(\)/);
  });

  it('expone listas, opciones activas, diferencias y toasts con roles accesibles', () => {
    expect(js).toMatch(/role: 'list'/);
    expect(js).toMatch(/role: 'listitem'/);
    expect(js).toMatch(/aria-activedescendant/);
    expect(js).toMatch(/role: 'option'/);
    expect(html).toMatch(/id="aviso-deshacer"[^>]*role="status"/);
  });

  it('declara foco visible, reduce movimiento y no permite overflow horizontal al zoom', () => {
    expect(css + html).toMatch(/:focus-visible[\s\S]*outline/);
    expect(css + html).toMatch(/prefers-reduced-motion/);
    expect(css + html).toMatch(/overflow-x:\s*(hidden|clip)/);
    expect(css).toMatch(/\.barra-decision[\s\S]*max-inline-size:\s*100%/);
    expect(css).toMatch(/min-inline-size:\s*0/);
  });

  it('precarga la publicación actual y el primer candidato del siguiente caso, con decodificación async', () => {
    expect(js).toMatch(/precargarFotos\(d, token, \{ publicacion: true/);
    expect(js).toMatch(/precargarFotos\(d, token, \{ publicacion: false, candidato: true/);
    expect(js).toMatch(/new Image\(\)[\s\S]*?decoding\s*=\s*['"]async['"]/);
    expect(js).toMatch(/token !== S\.navToken/);
    expect(js).toMatch(/loading: 'lazy'/);
  });
});

describe('bandeja: consume el nombre real del tipo del detalle', () => {
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it('pasa detalle.tipo a la lógica de teclas, no el nombre inexistente tipo_caso', () => {
    expect(js).toMatch(/tipoCaso:\s*S\.detalle\.tipo\b/);
    expect(js).not.toMatch(/tipoCaso:\s*S\.detalle\.tipo_caso\b/);
  });
});

describe('bandeja: tecla X en confirmable — d5 (T5, hallazgo Alto de Codex)', () => {
  // Bug real preexistente (de la pantalla original, commit 1ca92ee4, no de T2-T4): la rama 'rechazar' del
  // switch de teclas leía `cs.detalle.d5`, pero `cs` es una fila de S.cola (GET /casos), donde d5 viene
  // PLANO (api/identidad-interna.ts: `d5: f.detalle && f.detalle.d5 === true`), no anidado bajo `.detalle`
  // como en el detalle de GET /casos/:id (que sí tiene `detalle: c.detalle` crudo). Como `cs.detalle` nunca
  // existe, `omisionVigente` daba siempre false y X mandaba 'sin_candidato' en vez de 'mantener_omision'
  // para un caso D5 vigente — cambiaba la decisión real que se le manda a la plataforma.
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it("la rama 'rechazar' lee cs.d5 (plano), no cs.detalle.d5 (anidado, no existe en la fila de cola)", () => {
    const cuerpo = js.match(/function eleccionNoEsNinguno\(\)[\s\S]*?\n {2}\}/)[0];
    expect(cuerpo).toMatch(/cs\.d5 === true/);
    expect(cuerpo).not.toMatch(/cs\.detalle/);
  });

  it("el botón 'No es este' en modo confirmable sí puede seguir leyendo d.detalle.d5 (el detalle, no la fila de cola)", () => {
    // d.detalle.d5 es correcto ACÁ porque `d` es el detalle de GET /casos/:id, que sí anida `detalle: c.detalle`.
    // No es el mismo bug: no hay que "unificar" los dos accesos, son formas distintas a propósito.
    expect(js).toMatch(/S\.detalle\.detalle && S\.detalle\.detalle\.d5 === true/);
  });
});

describe('bandeja: regresiones de concurrencia y decisiones contextuales', () => {
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it('el aviso de deshacer sólo se actualiza si sigue siendo la última entrada', () => {
    expect(js).toMatch(/function mostrarDeshacer\(texto, entry\)/);
    expect(js).toMatch(/S\.ultima\.entry === entry/);
    expect(js).toMatch(/mostrarDeshacer\(textoDecision\(entry\), entry\)/);
  });

  it('Apartar conserva su undo y no avanza si otra acción lo reemplazó', () => {
    const apartar = js.match(/function apartar\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(apartar).toMatch(/const undo =/);
    expect(apartar).toMatch(/undo\.versionNueva/);
    expect(apartar).toMatch(/S\.ultima === undo/);
  });

  it('renderiza todas las diferencias dentro del scroll interno', () => {
    expect(js).toMatch(/diferencias\.forEach\(function \(x\)/);
    expect(js).not.toMatch(/diferencias\.slice\(0, 8\)/);
  });

  it('teclado y clic usan la misma elección contextual para No es ninguno', () => {
    expect(js).toMatch(/function eleccionNoEsNinguno\(\)/);
    const rechazar = js.match(/case 'rechazar':[\s\S]*?break;/)[0];
    expect(rechazar).toMatch(/eleccionNoEsNinguno\(\)/);
    expect(js).toMatch(/t\.id === 'btn-rechazar'\) decidir\(eleccionNoEsNinguno\(\)\)/);
    expect(js).not.toMatch(/t\.id === 'btn-rechazar'\) decidir\('sin_candidato'\)/);
    expect(js).not.toMatch(/case 'rechazar':[\s\S]*?decidir\('omitir'\)/);
  });

  it('avanzar ignora una página que llega después de cambiar el token', async () => {
    let resolver;
    const { app } = cargarBandejaConDomInyectado(() => new Promise((resolve) => { resolver = resolve; }));
    app.state.cola = [{ id: 'actual' }];
    app.state.idx = 0;
    app.state.siguiente = 'cursor-viejo';
    app.state.navToken = 4;
    const colaOriginal = app.state.cola;
    app.avanzar();
    app.state.navToken = 5;
    resolver({ status: 200, json: async () => ({ casos: [{ id: 'tardio' }], siguiente: 'cursor-nuevo' }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(app.state.cola).toBe(colaOriginal);
    expect(app.state.siguiente).toBe('cursor-viejo');
    expect(app.state.idx).toBe(0);
  });

  it('traerMas ignora una página que llega después de cambiar el grupo', async () => {
    let resolver;
    const { app } = cargarBandejaConDomInyectado(() => new Promise((resolve) => { resolver = resolve; }));
    app.state.cola = [{ id: 'actual' }];
    app.state.idx = 0;
    app.state.siguiente = 'cursor-viejo';
    app.state.grupo = 1;
    const colaOriginal = app.state.cola;
    app.traerMas();
    app.state.grupo = 2;
    resolver({ status: 200, json: async () => ({ casos: [{ id: 'tardio' }], siguiente: 'cursor-nuevo' }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(app.state.cola).toBe(colaOriginal);
    expect(app.state.siguiente).toBe('cursor-viejo');
    expect(app.state.idx).toBe(0);
  });

  it('cargarCola ignora la respuesta inicial si llega después de cambiar el token', async () => {
    let resolver;
    const { app } = cargarBandejaConDomInyectado(() => new Promise((resolve) => { resolver = resolve; }));
    app.state.cola = [{ id: 'conservado' }];
    app.state.siguiente = 'cursor-conservado';
    app.state.idx = 0;
    app.state.navToken = 8;
    const colaOriginal = app.state.cola;
    app.cargarCola();
    app.state.navToken = 9;
    resolver({ status: 200, json: async () => ({ casos: [{ id: 'tardio' }], siguiente: 'cursor-nuevo', contadores: {} }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(app.state.cola).toBe(colaOriginal);
    expect(app.state.siguiente).toBe('cursor-conservado');
    expect(app.state.idx).toBe(0);
  });
});

describe('bandeja: objetivos táctiles', () => {
  const css = readFileSync(new URL('../public/bandeja-identidad/bandeja.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/bandeja-identidad/index.html', import.meta.url), 'utf8');

  it('chips de filtro y candidato respetan el mínimo táctil de 44px', () => {
    expect(css).toMatch(/\.candidato-chip\s*\{[\s\S]*min-height:\s*var\(--tap-min\)/);
    expect(css).toMatch(/\.chip-pri\s*\{[\s\S]*min-height:\s*var\(--tap-min\)/);
    expect(html).toMatch(/\.chip-pri\s*\{[\s\S]*min-height:\s*var\(--tap-min\)/);
  });
});

describe('bandeja: ejecutarAccion — Paso 2 de T3, sin DOM (decisión pura de qué llamar)', () => {
  function apiFalsa() {
    return { apartar: vi.fn(), desapartar: vi.fn(), decidir: vi.fn(), omitir: vi.fn(), reabrir: vi.fn(), mostrar: vi.fn() };
  }

  it('? aparta el caso actual con su versión, una sola vez', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1', version: 3, apartado: false }], idx: 0 };
    L.ejecutarAccion({ tipo: 'apartar' }, estado, api);
    expect(api.apartar).toHaveBeenCalledTimes(1);
    expect(api.apartar).toHaveBeenCalledWith('c1', 3);
  });

  it('? sobre un caso ya apartado no llama a apartar de nuevo', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1', version: 3, apartado: true }], idx: 0 };
    L.ejecutarAccion({ tipo: 'apartar' }, estado, api);
    expect(api.apartar).not.toHaveBeenCalled();
  });

  it('Z después de apartar llama a desapartar con la versión nueva, y NUNCA a decidir', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1', version: 3 }], idx: -1, ultimoTipo: 'apartado', ultimoApartadoId: 'c1', ultimoApartadoVersion: 4 };
    L.ejecutarAccion({ tipo: 'deshacer' }, estado, api);
    expect(api.desapartar).toHaveBeenCalledTimes(1);
    expect(api.desapartar).toHaveBeenCalledWith('c1', 4);
    expect(api.decidir).not.toHaveBeenCalled();
  });

  it('Z después de omitir por ahora reabre el caso salteado (sin apartar ni decidir)', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c2' }], idx: -1, ultimoTipo: 'salteado', ultimoSalteadoId: 'c2' };
    L.ejecutarAccion({ tipo: 'deshacer' }, estado, api);
    expect(api.reabrir).toHaveBeenCalledWith('c2');
    expect(api.apartar).not.toHaveBeenCalled();
    expect(api.decidir).not.toHaveBeenCalled();
  });

  it('2 solo (seleccionar) no llama a ninguna acción de la api: sólo Enter decide', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1' }], idx: 0, sel: null, detalle: { version: 1 } };
    // 'seleccionar' no es un caso manejado por ejecutarAccion (lo maneja bandeja.js con S.sel directamente,
    // no hace ninguna llamada a la api): confirma que no dispara nada.
    L.ejecutarAccion({ tipo: 'seleccionar', n: 2 }, estado, api);
    expect(api.decidir).not.toHaveBeenCalled();
    expect(api.apartar).not.toHaveBeenCalled();
  });

  it('2 y después Enter: decidir se llama con eleccion vincular y el variant_id seleccionado', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1' }], idx: 0, sel: 'variante-2', detalle: { version: 5 } };
    L.ejecutarAccion({ tipo: 'vincular' }, estado, api);
    expect(api.decidir).toHaveBeenCalledWith({ expected_version: 5, eleccion: 'vincular', variant_id: 'variante-2' });
  });

  it('Enter sin selección no decide y avisa "Elegí un candidato" en vez de vincular a undefined', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c1' }], idx: 0, sel: null, detalle: { version: 5 } };
    L.ejecutarAccion({ tipo: 'vincular' }, estado, api);
    expect(api.decidir).not.toHaveBeenCalled();
    expect(api.mostrar).toHaveBeenCalledWith('Elegí un candidato');
  });

  it('O (omitir_por_ahora) llama a omitir con el id del caso actual y no hace ningún decidir/apartar', () => {
    const api = apiFalsa();
    const estado = { cola: [{ id: 'c3' }], idx: 0 };
    L.ejecutarAccion({ tipo: 'omitir_por_ahora' }, estado, api);
    expect(api.omitir).toHaveBeenCalledWith('c3');
    expect(api.decidir).not.toHaveBeenCalled();
    expect(api.apartar).not.toHaveBeenCalled();
  });

  it('siguienteNoSalteado sobre el último caso, con sólo salteados restantes, no da vueltas infinitas (-1)', () => {
    const cola = [{ id: 'a' }, { id: 'b' }];
    expect(L.siguienteNoSalteado(cola, 0, new Set(['b']))).toBe(-1);
  });

  it('texto de cola agotada por salteados coincide con lo que muestra bandeja.js', () => {
    expect(L.TEXTO_SOLO_SALTEADOS).toBe('Sólo quedan casos que salteaste');
  });

  it('grupos: apartados (7) está en GRUPOS y GRUPO_NOMBRE', () => {
    expect(L.GRUPOS.apartados).toBe(7);
    expect(L.GRUPO_NOMBRE[7]).toMatch(/apartado/i);
  });
});

describe('bandeja: concurrencia de decisiones — comportamiento observable', () => {
  it('A/B/A reutiliza la entrada pendiente de A y su misma Idempotency-Key', () => {
    let siguienteClave = 0;
    const guardia = L.crearGuardiaDecisiones(() => 'clave-' + (++siguienteClave));
    const enviar = vi.fn();

    const a1 = guardia.iniciar({ caseId: 'A', version: 1, enviar });
    const b = guardia.iniciar({ caseId: 'B', version: 2, enviar });
    const a2 = guardia.iniciar({ caseId: 'A', version: 1, enviar });

    expect(a1.nueva).toBe(true);
    expect(b.nueva).toBe(true);
    expect(a2.nueva).toBe(false);
    expect(a2.entrada).toBe(a1.entrada);
    expect(a2.entrada.key).toBe('clave-1');
    expect(siguienteClave).toBe(2);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('una respuesta ambigua deja bloqueado el caso y reintentar conserva entrada y clave', () => {
    const guardia = L.crearGuardiaDecisiones(() => 'clave-original');
    const enviar = vi.fn();
    const primera = guardia.iniciar({ caseId: 'A', version: 1, enviar }).entrada;

    guardia.terminar(primera, { status: 0 });
    const nuevaDecision = guardia.iniciar({ caseId: 'A', version: 1, enviar });
    const reintento = guardia.reintentar(primera);

    expect(nuevaDecision.nueva).toBe(false);
    expect(nuevaDecision.entrada).toBe(primera);
    expect(reintento).toBe(primera);
    expect(primera.estado).toBe('pendiente');
    expect(primera.key).toBe('clave-original');
  });

  it('libera el bloqueo sólo ante una respuesta terminal conocida', () => {
    const guardia = L.crearGuardiaDecisiones(() => 'clave-1');
    const entrada = guardia.iniciar({ caseId: 'A', version: 1 }).entrada;

    guardia.terminar(entrada, { status: 409 });

    const siguiente = guardia.iniciar({ caseId: 'A', version: 2 });
    expect(siguiente.nueva).toBe(true);
    expect(siguiente.entrada.key).toBe('clave-1');
  });

  it('apartar sólo avanza si la cola todavía muestra el caso capturado', () => {
    expect(L.puedeAvanzarTrasGuardar([{ id: 'B' }, { id: 'C' }], 0, 'A')).toBe(false);
    expect(L.puedeAvanzarTrasGuardar([{ id: 'A' }, { id: 'B' }], 0, 'A')).toBe(true);
  });
});

describe('bandeja: aria-keyshortcuts (chequeo estático sobre bandeja.js, patrón del repo sin DOM)', () => {
  // Los botones de acciones se arman dinámicamente en bandeja.js (el('button', ..., { id, 'aria-keyshortcuts' })),
  // no son markup estático de index.html. Se busca la llamada a el(...) de cada botón con tecla.
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  const botonesConTecla = ['btn-vincular', 'btn-buscar', 'btn-apartar', 'btn-omitir-ahora', 'btn-no-existe', 'btn-confirmar', 'btn-rechazar'];

  it.each(botonesConTecla)('el botón %s se arma con aria-keyshortcuts y muestra la tecla en el texto', (id) => {
    const m = js.match(new RegExp("el\\('button'[^;]*?id: '" + id + "'[^}]*\\}\\)"));
    expect(m, `no se encontró el armado del botón ${id} en bandeja.js`).not.toBeNull();
    expect(m[0]).toMatch(/aria-keyshortcuts/);
    // El texto del botón (antes de los attrs) debe traer la tecla entre paréntesis, ej. "(Enter)"/"(?)"/"(O)".
    expect(m[0]).toMatch(/\([^)]+\)/);
  });

  it('x es No es ninguno (rechazar) y el botón No vincular no tiene tecla', () => {
    const rech = [...js.matchAll(/el\('button'[^;]*?id: 'btn-rechazar'[^}]*\}\)/g)].map((m) => m[0]);
    expect(rech.some((m) => m.includes("aria-keyshortcuts': 'x'"))).toBe(true);
    const nov = [...js.matchAll(/el\('button'[^;]*?id: 'btn-no-vincular'[^}]*\}\)/g)].map((m) => m[0]);
    expect(nov.length).toBeGreaterThan(0);
    expect(nov.some((m) => m.includes('aria-keyshortcuts'))).toBe(false);
  });
});

describe('bandeja: teclado fase 1 y deshacer visible', () => {
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/bandeja-identidad/index.html', import.meta.url), 'utf8');

  it('al seleccionar por número o chip renderiza el candidato grande y anuncia posición y diferencias', () => {
    expect(js).toMatch(/function seleccionarPorNumero\(n\)[\s\S]*?S\.sel = o\.variant_id;[\s\S]*?render\(\);[\s\S]*?Candidato .*?de .*?diferencia/);
    expect(js).toMatch(/data-candidato[\s\S]*?seleccionarPorNumero\(numero\)/);
  });

  it('Enter sin candidato anuncia cómo elegirlo y no dispara una decisión', () => {
    expect(js).toMatch(/if \(k === 'Enter' && !confirmable\) anunciar\('Elegí un candidato con 1\/2\/3 o buscá con \/'\)/);
    expect(js).toMatch(/candidatoVisible: S\.sel !== null && S\.sel !== undefined/);
  });

  it('la cuenta regresiva visible se actualiza cada segundo y limpia su intervalo al salir', () => {
    expect(js).toMatch(/Decisión guardada: ' \+ texto \+ ' · ' \+ L\.textoCuentaRegresiva\(segundos\)/);
    expect(js).toMatch(/S\.timerDeshacer = setInterval\(/);
    expect(js).toMatch(/clearInterval\(S\.timerDeshacer\)/);
    expect(js).toMatch(/window\.addEventListener\('pagehide'/);
  });

  it('el aviso de deshacer queda sobre la barra sin sumar altura al documento', () => {
    expect(html).toMatch(/\.aviso-deshacer\s*\{[\s\S]*position:\s*fixed[\s\S]*bottom:\s*4\.5rem[\s\S]*z-index:\s*60/);
  });

  it('la ayuda enumera los atajos vigentes de la fase 1', () => {
    for (const texto of ['1', '2', '3', 'Enter', 'X', '?', 'O', 'N', 'Z', 'F', '/', 'j', 'k', '←', '→']) {
      expect(html).toContain('<kbd>' + texto + '</kbd>');
    }
    expect(html).not.toContain('<kbd>D</kbd>');
    expect(html).not.toContain('<kbd>H</kbd>');
  });
});

describe('bandeja: renderMatriz — fila «Por qué» y fila «Iguales» colapsada (T4, chequeo estático)', () => {
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');
  const cuerpo = js.match(/function renderMatriz\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];

  it('la fila «Por qué» se arma después de las filas de atributos (última fila de la tabla)', () => {
    const idxIguales = cuerpo.indexOf('fila-iguales');
    const idxAtributos = cuerpo.indexOf('nombresAtributos(opciones).forEach');
    const idxPorQue = cuerpo.indexOf('fila-porque');
    expect(idxIguales).toBeGreaterThan(-1);
    expect(idxAtributos).toBeGreaterThan(-1);
    expect(idxPorQue).toBeGreaterThan(-1);
    // Orden en el código = orden en el que se appendean las filas a la matriz = orden visual.
    expect(idxIguales).toBeLessThan(idxAtributos);
    expect(idxAtributos).toBeLessThan(idxPorQue);
  });

  it('cada celda de «Por qué» usa L.porQue(o) por candidato', () => {
    expect(cuerpo).toMatch(/L\.porQue\(o\)/);
  });

  it('la fila «Iguales» tiene un botón que expande/colapsa (aria-expanded) y no depende de S.soloDif', () => {
    const filaIguales = cuerpo.slice(cuerpo.indexOf('fila-iguales'), cuerpo.indexOf('L.nombresAtributos(opciones).forEach'));
    expect(filaIguales).toMatch(/aria-expanded/);
    expect(filaIguales).toMatch(/S\.mostrarIguales = !S\.mostrarIguales/);
    // A diferencia de las filas de atributos sueltas, el bloque de «Iguales» no consulta L.filaVisible/S.soloDif:
    // sigue mostrándose con "Sólo diferencias" activo, tal como pide el plan.
    expect(filaIguales).not.toMatch(/filaVisible|S\.soloDif/);
  });

  it('un atributo colapsado en «Iguales» no se repite como fila suelta salvo que S.mostrarIguales esté activo', () => {
    const bucleAtributos = cuerpo.slice(cuerpo.indexOf('L.nombresAtributos(opciones).forEach'), cuerpo.indexOf('fila-porque'));
    expect(bucleAtributos).toMatch(/esIgual = !!igualesSet\[n\]/);
    expect(bucleAtributos).toMatch(/esIgual && !S\.mostrarIguales/);
  });

  it('el botón «Iguales» declara aria-controls apuntando a las filas que expande (hallazgo de Codex en T4)', () => {
    expect(cuerpo).toMatch(/btnIguales\.setAttribute\('aria-controls'/);
  });

  it('S.mostrarIguales se resetea al abrir cada caso (no es una preferencia de sesión como soloDif)', () => {
    const abrirCaso = js.match(/function abrirCaso\([^)]*\) \{[\s\S]*?\n {2}\}/)[0];
    expect(abrirCaso).toMatch(/S\.mostrarIguales = false/);
  });
});

describe('bandeja: estación compacta y confirmación por SKU', () => {
  const css = readFileSync(new URL('../public/bandeja-identidad/bandeja.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/bandeja-identidad/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/bandeja-identidad/bandeja.js', import.meta.url), 'utf8');

  it('usa el viewport como layout y deja el scroll sólo a diferencias', () => {
    expect(html).toMatch(/body\s*\{[\s\S]*height:\s*100dvh[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.bandeja-wrap\s*\{[\s\S]*min-height:\s*0[\s\S]*flex:\s*1/);
    expect(css).toMatch(/\.caso\s*\{[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.diferencias\s*\{[\s\S]*overflow-y:\s*auto/);
  });

  it('compacta filtros y estado en una sola banda y limita fotos a 30vh', () => {
    expect(css).toMatch(/\.chips-header\s*\{[\s\S]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/\.chip-pri\s*\{[\s\S]*min-height:\s*var\(--tap-min\)/);
    expect(css).toMatch(/\.ficha \.foto-btn, \.ficha \.foto-sin-disponible\s*\{[\s\S]*clamp\(200px,\s*30vh,\s*300px\)/);
    expect(js).toMatch(/querySelector\('\.chips-header'\)/);
    expect(js).toMatch(/chips\.appendChild\(banda\)/);
  });

  it('renderiza el SKU confirmable en el panel cuando no hay candidato sugerido', () => {
    expect(js).toMatch(/cs\.confirmar[\s\S]*renderFicha\(confirmable/);
    expect(js).toMatch(/SKU A CONFIRMAR/);
    expect(js).not.toMatch(/No hay candidato confiable; buscá por SKU o título/);
  });

  it('separa el encabezado en grupos: sólo el grupo izquierdo dibuja separadores', () => {
    expect(js).toMatch(/caso-header-izquierda/);
    expect(js).toMatch(/caso-header-derecha/);
    expect(css).toMatch(/\.caso-header-izquierda\s*>\s*\*\s*\+\s*\*::before/);
    expect(css).not.toMatch(/\.caso-header\s*>\s*\*\s*\+\s*\*::before/);
  });

  it('mantiene completo el conteo del chip y pone el title completo en el título corto', () => {
    expect(js).toMatch(/L\.resumenCandidato\(o\)/);
    expect(js).toMatch(/title:\s*o\.titulo\s*\|\|\s*'Sin título'/);
    expect(js).toMatch(/resumen\.diferencias \+ ' dif\.'/);
    expect(css).toMatch(/\.candidato-chip\s*\{[\s\S]*display:\s*inline-flex/);
    expect(css).toMatch(/\.candidato-chip-titulo\s*\{[\s\S]*text-overflow:\s*ellipsis/);
  });

  it('el visor compara las dos fotos, mantiene el espacio sin foto y conserva foco/aria', () => {
    expect(html).toMatch(/id="visor-foto-dialog"[^>]*aria-modal="true"/);
    expect(html).toMatch(/id="visor-pares"/);
    expect(js).toMatch(/L\.paresParaVisor\(S\.detalle, opcion\)/);
    expect(js).toMatch(/function cerrarVisor\(\)/);
    expect(js).toMatch(/v\.opener\.focus\(\)/);
    expect(js).toMatch(/aria-live.*polite/);
    expect(js).toMatch(/function moverVisor\(delta\)/);
  });

  it('el zoom es sincronizado y el visor ocupa el alto disponible sin scroll de página', () => {
    expect(css).toMatch(/\.visor-pares\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
    expect(css).toMatch(/\.visor-foto-marco\s*\{[\s\S]*overflow:\s*auto/);
    expect(css).toMatch(/\.visor-foto-imagen\s*\{[\s\S]*object-fit:\s*contain/);
    expect(css).toMatch(/\.visor-pares\[data-zoom="2"\]/);
    expect(css).toMatch(/\.visor-pares\[data-zoom="3"\]/);
    expect(js).toMatch(/precargarFotos\(d, token/);
    expect(js).toMatch(/new Image\(\)/);
  });

  it('separa el rango del título del chip y evita separadores de encabezado al inicio', () => {
    expect(css).toMatch(/\.candidato-chip-rango\s*\{[\s\S]*margin-inline-end/);
    expect(css).toMatch(/\.caso-header-izquierda\s*>\s*\*\s*\+\s*\*::before/);
    expect(css).not.toMatch(/\.caso-header\s*>\s*\*\s*\+\s*\*::before/);
  });
});
