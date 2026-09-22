import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// Ejecuta el <script> principal de public/recepcion/index.html en un sandbox mínimo (sin jsdom:
// stubs de document/window/fetch/crypto solo para que las declaraciones de nivel superior no
// exploten) y llama a las funciones reales del archivo — no reimplementa su lógica ni matchea
// contra el texto fuente, así que un cambio que rompa el comportamiento real hace fallar el test.
function cargarApp() {
  const html = fs.readFileSync(new URL('../public/recepcion/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const src = scripts.reduce((a, b) => (b.length > a.length ? b : a), ''); // el script grande con la lógica de la app
  const elFalso = () => ({
    value: '', textContent: '', style: {}, disabled: false, dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
  });
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
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), // lib/format.js
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

describe('public/recepcion/index.html — payloadRecepcion()', () => {
  it('P1: un ítem con alta de producto nuevo confirmada (alta_estado="creado") se envía como estado_item="creado" con su alta_operation_id', () => {
    const app = cargarApp();
    app.items.push({
      id: 1, nombre_doc: 'Casco Nuevo', id_woo: 55, sku_wc: 'FB-55',
      alta_estado: 'creado', alta_operation_id: '550e8400-e29b-41d4-a716-446655440000',
      cantidad: 1, recibido: true,
    });
    const it = app.payloadRecepcion().items[0];
    // Si esto se pierde, el backend nunca vuelve a verificar la alta contra Woo antes de aplicar
    // stock (verificarAltaCreado) y el primer stock de la alta se sincroniza a Mercado Libre por
    // error — ver P0.3 en routes/recepciones.js.
    expect(it.estado_item).toBe('creado');
    expect(it.alta_operation_id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('un ítem con match normal (sin alta) sigue viajando como "pendiente" sin alta_operation_id', () => {
    const app = cargarApp();
    app.items.push({ id: 2, nombre_doc: 'Casco', id_woo: 10, sku_wc: 'CASCO', cantidad: 1, recibido: true });
    const it = app.payloadRecepcion().items[0];
    expect(it.estado_item).toBe('pendiente');
    expect(it.alta_operation_id).toBeFalsy();
  });

  it('un ítem sin match sigue viajando como "sin_match"', () => {
    const app = cargarApp();
    app.items.push({ id: 3, nombre_doc: 'Producto raro', id_woo: null, cantidad: 1, recibido: true });
    const it = app.payloadRecepcion().items[0];
    expect(it.estado_item).toBe('sin_match');
  });

  it('P1: window.onload dispara la carga del catálogo (si no, buscarWC queda "no disponible" para siempre)', () => {
    // catalogoEstado arranca en 'cargando' y buscarWC() solo busca cuando está en 'ok'. Si nada
    // llama a cargarCatalogo() en algún momento, el buscador manual de "Buscar en catálogo" queda
    // permanentemente roto (muestra "Catálogo no disponible" en cada recepción, para siempre) —
    // no es un test de que exista el string en el código, es que la carga realmente se dispare.
    const app = cargarApp();
    let catalogoCargado = false;
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo')) catalogoCargado = true;
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };
    app.window.onload();
    expect(catalogoCargado).toBe(true);
  });

  it('una alta "incierta" (Woo no confirmó, no repetir) NO se envía como "creado"', () => {
    const app = cargarApp();
    // abrirAltaBorrador setea id_woo recién en el .then de éxito; una alta incierta nunca llega a
    // tener id_woo, así que igual cae en sin_match — pero lo cubrimos explícitamente por si algún
    // día se le asigna un id_woo optimista antes de confirmar.
    app.items.push({ id: 4, nombre_doc: 'Casco', id_woo: null, alta_estado: 'incierto', alta_operation_id: 'op-x', cantidad: 1, recibido: true });
    const it = app.payloadRecepcion().items[0];
    expect(it.estado_item).not.toBe('creado');
  });
});

describe('public/recepcion/index.html — P1.3: sincronizarAliasGuardado() usa /resolver sobre ítems ya guardados', () => {
  it('con db_id + recepcionGuardadaId + id_woo, llama a POST /:id/items/:itemId/resolver con id_woo/aprender/motivo', () => {
    const app = cargarApp();
    app.recepcionGuardadaId = 77;
    const llamadas = [];
    app.fetch = (url, opts) => { llamadas.push({ url: String(url), opts }); return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); };
    app.items.push({ id: 'x', db_id: 501, id_woo: 10, aprender_alias: true, motivo_alias: 'discontinuado' });
    app.sincronizarAliasGuardado('x');
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe('/api/recepciones/77/items/501/resolver');
    const body = JSON.parse(llamadas[0].opts.body);
    expect(body).toEqual({ id_woo: 10, aprender: true, motivo: 'discontinuado' });
  });

  it('sin db_id (ítem todavía no guardado) NO llama a la red', () => {
    const app = cargarApp();
    app.recepcionGuardadaId = 77;
    let llamado = false;
    app.fetch = () => { llamado = true; return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); };
    app.items.push({ id: 'y', db_id: null, id_woo: 10 });
    app.sincronizarAliasGuardado('y');
    expect(llamado).toBe(false);
  });

  it('sin recepcionGuardadaId (recepción todavía no guardada) NO llama a la red', () => {
    const app = cargarApp();
    app.recepcionGuardadaId = null;
    let llamado = false;
    app.fetch = () => { llamado = true; return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); };
    app.items.push({ id: 'z', db_id: 501, id_woo: 10 });
    app.sincronizarAliasGuardado('z');
    expect(llamado).toBe(false);
  });

  it('un rechazo del servidor (ok:false) se muestra al usuario, no se traga en silencio', async () => {
    const app = cargarApp();
    app.recepcionGuardadaId = 77;
    let mensajeMostrado = null;
    app.mostrarStatus = (id, tipo, msg) => { mensajeMostrado = msg; };
    app.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'motivo requerido para reasignar alias' }) });
    app.items.push({ id: 'w', db_id: 501, id_woo: 10, aprender_alias: true });
    app.sincronizarAliasGuardado('w');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(mensajeMostrado).toMatch(/motivo requerido/);
  });
});

describe('public/recepcion/index.html — P1.4: la clave del alias se muestra completa en pantalla', () => {
  it('renderItems incluye proveedor, código/descripción y producto Woo en el texto del toggle', () => {
    const app = cargarApp();
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Bike Group' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, querySelector: () => null };
    };
    app.items.push({ id: 1, nombre_doc: 'Casco', codigo_proveedor: 'BX-1', id_woo: 10, sku_wc: 'FB-10', nombre_wc: 'Casco MTB', cantidad: 1, recibido: true });
    let htmlGenerado = '';
    const tbody = { innerHTML: '', appendChild(tr) { htmlGenerado += tr.innerHTML; } };
    const contadorFalso = { textContent: '' };
    const seccionFalsa = { style: {} };
    const idsEsperados = { 'items-section': seccionFalsa, 'items-body': tbody, 'items-count': contadorFalso, 'inp-proveedor': { value: 'Bike Group' } };
    app.document.getElementById = (id) => idsEsperados[id] || { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, querySelector: () => null };
    app.document.createElement = () => ({ innerHTML: '', appendChild() {}, querySelector: () => null });
    app.renderItems();
    expect(htmlGenerado).toContain('Bike Group');
    expect(htmlGenerado).toContain('BX-1');
    expect(htmlGenerado).toContain('Casco MTB');
  });
});

describe('public/recepcion/index.html — P1.4: estados visuales y confirmar bloqueado', () => {
  it('un ítem recibido con match automático (sin confirmar) bloquea el botón confirmar', () => {
    const app = cargarApp();
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'btn-confirmar') return { disabled: false };
      if (id === 'btn-confirmar-solo') return { disabled: false };
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };
    // Match automático (sin confirmar): id_woo asignado, pero match_confirmado NO es true
    app.items.push({
      id: 1, nombre_doc: 'Casco', id_woo: 10, sku_wc: 'FB-10', nombre_wc: 'Casco MTB',
      recibido: true, match_confirmado: false, match_origen: 'auto_sugerencia',
      cantidad: 1
    });
    const btn1 = { disabled: false };
    const btn2 = { disabled: false };
    const btns = { 'btn-confirmar': btn1, 'btn-confirmar-solo': btn2 };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return btns[id] || { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };
    app.actualizarBotones();
    // Debe estar bloqueado por tener un match sin confirmar recibido
    expect(btn1.disabled).toBe(true);
    expect(btn2.disabled).toBe(true);
  });

  it('un ítem recibido con match confirmado manualmente NO bloquea el botón', () => {
    const app = cargarApp();
    const btn1 = { disabled: false };
    const btn2 = { disabled: false };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'btn-confirmar') return btn1;
      if (id === 'btn-confirmar-solo') return btn2;
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };
    // Match confirmado manualmente
    app.items.push({
      id: 2, nombre_doc: 'Rueda', id_woo: 20, sku_wc: 'FB-20', nombre_wc: 'Rueda MTB',
      recibido: true, match_confirmado: true, match_origen: 'seleccion_manual',
      cantidad: 2
    });
    app.actualizarBotones();
    // NO debe estar bloqueado, porque el match fue confirmado
    expect(btn1.disabled).toBe(false);
    expect(btn2.disabled).toBe(false);
  });

  it('un ítem recibido con alta creada NO bloquea el botón', () => {
    const app = cargarApp();
    const btn1 = { disabled: false };
    const btn2 = { disabled: false };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'btn-confirmar') return btn1;
      if (id === 'btn-confirmar-solo') return btn2;
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };
    // Alta creada (estado 'creado')
    app.items.push({
      id: 3, nombre_doc: 'Nuevo Producto', id_woo: 30, sku_wc: 'FB-30', nombre_wc: 'Nuevo Producto',
      recibido: true, alta_estado: 'creado', alta_operation_id: 'op-123',
      cantidad: 1
    });
    app.actualizarBotones();
    // NO debe estar bloqueado, porque la alta fue creada
    expect(btn1.disabled).toBe(false);
    expect(btn2.disabled).toBe(false);
  });

  it('el mensaje de status incluye advertencia si hay items recibidos que requieren revisión', () => {
    const app = cargarApp();
    const status = { textContent: '' };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'status-confirm') return status;
      if (id === 'btn-confirmar') return { disabled: false };
      if (id === 'btn-confirmar-solo') return { disabled: false };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };
    // Item con match_estado='revisar' (backend dice que necesita revisión) sin confirmar
    app.items.push({
      id: 1, nombre_doc: 'Item Dudoso', id_woo: 10, sku_wc: 'FB-10', nombre_wc: 'Item WC',
      recibido: true, match_confirmado: false, match_estado: 'revisar', match_origen: 'auto_sugerencia',
      cantidad: 1
    });
    app.items.push({
      id: 2, nombre_doc: 'Item No Recibido', id_woo: null, sku_wc: null, nombre_wc: null,
      recibido: false,
      cantidad: 1
    });
    app.actualizarBotones();
    // El mensaje debe reflejar que hay un item que requiere confirmación manual
    expect(status.textContent).toMatch(/requieren confirmación|revisar/i);
  });

  it('un ítem recibido sin id_woo sigue bloqueando el botón (sin match y sin alta)', () => {
    const app = cargarApp();
    const btn1 = { disabled: false };
    const btn2 = { disabled: false };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'btn-confirmar') return btn1;
      if (id === 'btn-confirmar-solo') return btn2;
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };
    // Sin match, sin alta
    app.items.push({
      id: 4, nombre_doc: 'Sin Match', id_woo: null,
      recibido: true,
      cantidad: 1
    });
    app.actualizarBotones();
    // Debe estar bloqueado (esto ya funciona, pero lo verificamos)
    expect(btn1.disabled).toBe(true);
    expect(btn2.disabled).toBe(true);
  });

  it('renderItems muestra estado VERDE (Resuelto) para ítem con match confirmado o resuelto por backend', () => {
    const app = cargarApp();
    let htmlGenerado = '';
    app.document.getElementById = (id) => {
      if (id === 'items-body') return { innerHTML: '', appendChild(tr) { htmlGenerado += tr.innerHTML; } };
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'items-section') return { style: {} };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} };
    };
    app.document.createElement = () => ({ innerHTML: '', appendChild() {}, querySelector: () => null });
    // Backend dice que es resuelto (match_estado='resuelto' de auto_aplicable)
    app.items.push({
      id: 1, nombre_doc: 'Casco', id_woo: 10, sku_wc: 'FB-10', nombre_wc: 'Casco MTB',
      recibido: true, match_confirmado: true, match_estado: 'resuelto', match_origen: 'sku_exacto',
      cantidad: 1
    });
    app.renderItems();
    // Debe contener un badge verde (Resuelto o Confirmado)
    expect(htmlGenerado).toMatch(/Resuelto|Confirmado/);
    expect(htmlGenerado).toMatch(/match-ok/);
  });

  it('renderItems muestra estado ÁMBAR (Confirmar asignación) para ítem con match automático sin confirmar', () => {
    const app = cargarApp();
    let htmlGenerado = '';
    app.document.getElementById = (id) => {
      if (id === 'items-body') return { innerHTML: '', appendChild(tr) { htmlGenerado += tr.innerHTML; } };
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'items-section') return { style: {} };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} };
    };
    app.document.createElement = () => ({ innerHTML: '', appendChild() {}, querySelector: () => null });
    app.items.push({
      id: 2, nombre_doc: 'Rueda', id_woo: 20, sku_wc: 'FB-20', nombre_wc: 'Rueda MTB',
      recibido: true, match_confirmado: false, match_origen: 'auto_sugerencia',
      cantidad: 1
    });
    app.renderItems();
    // Debe contener el badge ámbar "Confirmar asignación" o "Revisar candidato"
    expect(htmlGenerado).toMatch(/Confirmar asignación|Revisar candidato/);
    expect(htmlGenerado).toMatch(/match-warn/);
  });

  it('renderItems muestra estado ROJO (Sin candidato) para ítem sin match', () => {
    const app = cargarApp();
    let htmlGenerado = '';
    app.document.getElementById = (id) => {
      if (id === 'items-body') return { innerHTML: '', appendChild(tr) { htmlGenerado += tr.innerHTML; } };
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'items-section') return { style: {} };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} };
    };
    app.document.createElement = () => ({ innerHTML: '', appendChild() {}, querySelector: () => null });
    app.items.push({
      id: 3, nombre_doc: 'Producto Raro', id_woo: null,
      recibido: true,
      cantidad: 1
    });
    app.renderItems();
    // Debe contener el badge rojo "Sin candidato" o "Sin match"
    expect(htmlGenerado).toMatch(/Sin candidato|Sin match/);
    expect(htmlGenerado).toMatch(/match-no/);
  });

  it('renderItems muestra estado ERROR para ítem con alta fallida o incierta', () => {
    const app = cargarApp();
    let htmlGenerado = '';
    app.document.getElementById = (id) => {
      if (id === 'items-body') return { innerHTML: '', appendChild(tr) { htmlGenerado += tr.innerHTML; } };
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'items-section') return { style: {} };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} };
    };
    app.document.createElement = () => ({ innerHTML: '', appendChild() {}, querySelector: () => null });
    app.items.push({
      id: 4, nombre_doc: 'Alta Fallida', id_woo: null, alta_estado: 'incierto',
      recibido: true,
      cantidad: 1
    });
    app.renderItems();
    // Debe contener el badge de error
    expect(htmlGenerado).toMatch(/Error.*incierto/);
    expect(htmlGenerado).toMatch(/match-no/);
  });

  it('CASO REAL P1.4: match automático seguro (match_estado=resuelto) NO bloquea', () => {
    // Este es el caso más común en producción: backend devuelve estado:'resuelto', auto_aplicable:true
    // Con el fix en solicitarMatchesBackend, ahora setea match_confirmado=true cuando auto_aplicable
    const app = cargarApp();
    const btn1 = { disabled: false };
    const btn2 = { disabled: false };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'btn-confirmar') return btn1;
      if (id === 'btn-confirmar-solo') return btn2;
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };
    // Ítem con match_estado='resuelto' (backend lo certificó como seguro)
    app.items.push({
      id: 5, nombre_doc: 'Producto Común', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto Woo',
      recibido: true,
      match_estado: 'resuelto',
      match_origen: 'sku_exacto',
      match_confirmado: true,  // Con el fix, solicitarMatchesBackend seteará esto
      cantidad: 5
    });
    app.actualizarBotones();
    // NO debe bloquear
    expect(btn1.disabled).toBe(false);
    expect(btn2.disabled).toBe(false);
  });

  it('solicitarMatchesBackend setea match_confirmado=true cuando auto_aplicable es true', async () => {
    // Reproducer: el fix debe setear match_confirmado cuando auto_aplicable
    const app = cargarApp();
    let fetchCalled = false;
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'items-section') return { style: {} };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    app.items.push({
      id: 6, nombre_doc: 'Test Item', variacion: '', codigo_proveedor: 'TEST-001',
      marca: 'TestMarca', cantidad: 1
    });

    // Mock fetch para simular respuesta con auto_aplicable=true
    const originalFetch = app.fetch;
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/matchear')) {
        fetchCalled = true;
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            resultados: [{
              linea_id: String(app.items[0].id),
              estado: 'resuelto',
              auto_aplicable: true,
              candidato: {
                id_woo: 200,
                sku: 'FB-200',
                nombre: 'Test Product',
                stock: 10,
                razones: [{ tipo: 'sku', resultado: 'exacto_unico' }]
              },
              origen: 'sku_exacto'
            }]
          })
        });
      }
      return originalFetch(url);
    };

    app.solicitarMatchesBackend();
    // Esperar a que se procese la promesa
    await new Promise(r => setTimeout(r, 10));

    const item = app.items[0];
    expect(fetchCalled).toBe(true);
    expect(item.id_woo).toBe(200);
    expect(item.match_estado).toBe('resuelto');
    expect(item.match_confirmado).toBe(true); // Con el fix, debe ser true
  });

  it('renderItems muestra razones cuando match_estado=revisar con candidato', () => {
    // Las razones deben mostrarse en tooltip y en subfila
    const app = cargarApp();
    let htmlGenerado = '';
    app.document.getElementById = (id) => {
      if (id === 'items-body') return { innerHTML: '', appendChild(tr) { htmlGenerado += tr.innerHTML; } };
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'items-section') return { style: {} };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} };
    };
    app.document.createElement = () => ({ innerHTML: '', appendChild() {}, querySelector: () => null });
    app.items.push({
      id: 7, nombre_doc: 'Dudoso', id_woo: 300, sku_wc: 'FB-300', nombre_wc: 'Producto Dudoso',
      recibido: true, match_estado: 'revisar', match_confirmado: false,
      match_resultado: {
        candidato: {
          id_woo: 300,
          razones: [
            { tipo: 'sku', resultado: 'coincide', documento: 'FB-ABC', producto: 'FB-300' },
            { tipo: 'titulo', resultado: 'similar', documento: 'Dudoso', producto: 'Producto Dudoso' }
          ]
        }
      },
      cantidad: 1
    });
    app.renderItems();
    // Debe mostrar las razones en formato "tipo: resultado"
    expect(htmlGenerado).toContain('sku: coincide');
    expect(htmlGenerado).toContain('titulo: similar');
    expect(htmlGenerado).toContain('Razones:');
  });
});
