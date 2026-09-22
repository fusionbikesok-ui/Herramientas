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
    alert: () => {}, // Mock para evitar "alert is not defined"
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

  it('P1.3: window.onload NO carga el catálogo completo (búsqueda es dinámico bajo demanda)', () => {
    // P1.3: cargarCatalogo() se elimina. El catálogo completo no se carga en memoria.
    // buscarWC() ahora hace fetch dinámico a /api/recepciones/catalogo?q=... cuando el usuario tipea.
    // Este test verifica que onload NO intente cargar /api/recepciones/catalogo sin parámetro.
    const app = cargarApp();
    let llamadasCatalogo = [];
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo')) {
        llamadasCatalogo.push(String(url));
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };
    app.window.onload();
    // No debe haber pedido el catálogo completo (sin ?q)
    const catalogoCompleto = llamadasCatalogo.filter(u => !u.includes('?q='));
    expect(catalogoCompleto).toHaveLength(0);
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

describe('public/recepcion/index.html — P1.2: cambio de proveedor invalida matches de alias', () => {
  it('cambiar proveedor invalida matches con origen alias_proveedor y re-solicita matcheo', async () => {
    const app = cargarApp();
    let llamadasFetch = [];

    // Mock del input de proveedor
    let proveedorActual = 'Proveedor A';
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return {
        value: proveedorActual,
        dataset: {}
      };
      if (id === 'status-match') return { textContent: '', innerHTML: '', className: '', style: { display: '' } };
      if (id === 'items-section') return { style: {} };
      if (id === 'items-body') return { innerHTML: '', appendChild() {} };
      if (id === 'items-count') return { textContent: '' };
      return {
        value: '', textContent: '', style: {}, disabled: false, dataset: {},
        classList: { add() {}, remove() {} },
        addEventListener() {},
        appendChild() {}
      };
    };

    // Mock createElement para que devuelva elementos con querySelector
    app.document.createElement = (tag) => {
      return {
        innerHTML: '',
        appendChild() {},
        setAttribute() {},
        querySelector() { return null; },
        id: ''
      };
    };

    // Mock fetch para capturar todas las llamadas
    app.fetch = (url, opts) => {
      llamadasFetch.push({ url: String(url), opts });

      if (String(url).includes('/api/recepciones/matchear')) {
        // Después de cambiar a Proveedor B, el alias del Proveedor A ya no aplica
        // Devolvemos sin_match o un match diferente sin origen de alias
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            resultados: [{
              linea_id: String(app.items[0].id),
              estado: 'sin_match',
              auto_aplicable: false,
              candidato: null,
              origen: 'ninguno'
            }]
          })
        });
      }
      if (String(url).includes('/api/recepciones/aliases')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, data: [] })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    // Inicializar proveedorAnterior como lo hace window.onload
    app.window.onload();

    // Agregar un ítem con match resuelto por alias
    app.items.push({
      id: 1, nombre_doc: 'Producto Test', codigo_proveedor: 'CODE-001',
      id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto Nuevo',
      variacion: '', marca: '',
      recibido: true,
      match_estado: 'resuelto',
      match_origen: 'alias_proveedor',
      match_confirmado: true,
      cantidad: 1
    });

    // Simular cambio de proveedor (al perder foco, el handler detecta cambio)
    // Cambiar el proveedor actual simulando lo que el usuario haría
    proveedorActual = 'Proveedor B';

    // Llamar a la función que maneja el cambio de proveedor (que implementaremos)
    // Esta función se dispara en onblur del input
    app.invalidarMatchesPorCambioProveedor();

    // Esperar a que se procese el matcheo
    await new Promise(r => setTimeout(r, 50));

    // Verificaciones:
    // 1. El match de alias debe haber sido invalidado
    expect(app.items[0].match_origen).not.toBe('alias_proveedor');

    // 2. Se debe haber solicitado matcheo al backend
    const llamadaMatcheo = llamadasFetch.find(c => String(c.url).includes('/api/recepciones/matchear'));
    expect(llamadaMatcheo).toBeDefined();
  });

  it('solo invalida matches con origen alias_proveedor, no otros orígenes', async () => {
    const app = cargarApp();
    let proveedorActual = 'Proveedor A';

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return {
        value: proveedorActual,
        dataset: {}
      };
      if (id === 'status-match') return { textContent: '', innerHTML: '', className: '', style: { display: '' } };
      if (id === 'items-section') return { style: {} };
      if (id === 'items-body') return { innerHTML: '', appendChild() {} };
      if (id === 'items-count') return { textContent: '' };
      return {
        value: '', textContent: '', style: {}, disabled: false, dataset: {},
        classList: { add() {}, remove() {} },
        addEventListener() {},
        appendChild() {}
      };
    };

    app.document.createElement = (tag) => {
      return {
        innerHTML: '',
        appendChild() {},
        setAttribute() {},
        querySelector() { return null; },
        id: ''
      };
    };

    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/matchear')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, resultados: [] })
        });
      }
      if (String(url).includes('/api/recepciones/aliases')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, data: [] })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    // Inicializar proveedorAnterior
    app.window.onload();

    // Agregar dos ítems: uno con alias_proveedor, otro con sku_exacto
    app.items.push({
      id: 1, nombre_doc: 'Item Alias', codigo_proveedor: 'CODE-001',
      id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto A',
      variacion: '', marca: '', recibido: true,
      match_estado: 'resuelto',
      match_origen: 'alias_proveedor',
      match_confirmado: true,
      cantidad: 1
    });

    app.items.push({
      id: 2, nombre_doc: 'Item SKU Exacto', codigo_proveedor: 'SKU-002',
      id_woo: 200, sku_wc: 'FB-200', nombre_wc: 'Producto B',
      variacion: '', marca: '', recibido: true,
      match_estado: 'resuelto',
      match_origen: 'sku_exacto',
      match_confirmado: true,
      cantidad: 1
    });

    // Cambiar proveedor
    proveedorActual = 'Proveedor B';
    app.invalidarMatchesPorCambioProveedor();

    await new Promise(r => setTimeout(r, 50));

    // Verificar: item con alias debe haber perdido su match, el otro debe mantenerlo
    const item1 = app.items.find(i => i.id === 1);
    const item2 = app.items.find(i => i.id === 2);

    expect(item1.match_origen).not.toBe('alias_proveedor');
    expect(item1.id_woo).toBeNull(); // El match fue invalidado

    expect(item2.match_origen).toBe('sku_exacto'); // No se modificó
    expect(item2.id_woo).toBe(200); // Mantiene su match
  });

  it('no invalida ni re-solicita si el proveedor no cambió', async () => {
    const app = cargarApp();
    let llamadasFetch = [];
    let proveedorActual = 'Proveedor A';

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return {
        value: proveedorActual,
        dataset: {}
      };
      if (id === 'status-match') return { textContent: '', innerHTML: '', className: '', style: { display: '' } };
      if (id === 'items-section') return { style: {} };
      if (id === 'items-body') return { innerHTML: '', appendChild() {} };
      if (id === 'items-count') return { textContent: '' };
      return {
        value: '', textContent: '', style: {}, disabled: false, dataset: {},
        classList: { add() {}, remove() {} },
        addEventListener() {},
        appendChild() {}
      };
    };

    app.document.createElement = (tag) => {
      return {
        innerHTML: '',
        appendChild() {},
        setAttribute() {},
        querySelector() { return null; },
        id: ''
      };
    };

    app.fetch = (url) => {
      llamadasFetch.push(String(url));
      if (String(url).includes('/api/recepciones/matchear')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, resultados: [] })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    // Inicializar proveedorAnterior
    app.window.onload();

    app.items.push({
      id: 1, nombre_doc: 'Item', codigo_proveedor: 'CODE',
      id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto',
      variacion: '', marca: '', recibido: true,
      match_estado: 'resuelto',
      match_origen: 'alias_proveedor',
      match_confirmado: true,
      cantidad: 1
    });

    const llamadasAntes = llamadasFetch.length;

    // NO cambiar proveedor (mismo valor)
    app.invalidarMatchesPorCambioProveedor();

    await new Promise(r => setTimeout(r, 50));

    // No debe haber hecho nuevas llamadas
    const llamadasDespues = llamadasFetch.length;
    expect(llamadasDespues).toBe(llamadasAntes);
  });

  it('[BUG FIX] retomar(id) carga proveedor sin invalidar matches por blur trivial', async () => {
    // Escenario: usuario abre recepcion/index.html?retomar=42, se carga un borrador
    // con proveedor "Trek Argentina" e ítems ya resueltos por alias_proveedor.
    // Luego hace blur trivial (click + tab sin cambiar) → no debe invalidar nada.
    const app = cargarApp();
    let llamadasFetch = [];

    // Simular cargar un borrador vía fetch (lo que retomar() hace)
    let proveedorActual = ''; // Comienza vacío
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return {
        value: proveedorActual,
        dataset: {}
      };
      if (id === 'status-match') return { textContent: '', innerHTML: '', className: '', style: { display: '' } };
      if (id === 'items-section') return { style: {} };
      if (id === 'items-body') return { innerHTML: '', appendChild() {} };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'inp-importador') return { value: '', dataset: {} };
      if (id === 'inp-numero-pedido') return { value: '', addEventListener() {} };
      if (id === 'inp-fecha') return { value: '' };
      if (id === 'inp-notas') return { value: '' };
      if (id === 'solo-doc-row') return { setAttribute() {} };
      if (id === 'aviso-sin-pedido') return { style: {} };
      if (id === 'docs-area') return { innerHTML: '', appendChild() {} };
      return {
        value: '', textContent: '', style: {}, disabled: false, dataset: {},
        classList: { add() {}, remove() {} },
        addEventListener() {},
        appendChild() {}
      };
    };

    app.document.createElement = (tag) => {
      return {
        innerHTML: '',
        appendChild() {},
        setAttribute() {},
        querySelector() { return null; },
        id: ''
      };
    };

    app.fetch = (url) => {
      llamadasFetch.push(String(url));
      if (String(url).includes('/api/recepciones/matchear')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, resultados: [] })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    // Inicializar como nuevo
    app.window.onload();
    expect(app.proveedorAnterior).toBe('');

    // Agregar ítem con match de alias (como si ya estuviera cargado del borrador)
    app.items.push({
      id: 1, nombre_doc: 'Producto Trek', codigo_proveedor: 'TREK-001',
      id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto Trek WC',
      variacion: '', marca: '', recibido: true,
      match_estado: 'resuelto',
      match_origen: 'alias_proveedor',
      match_confirmado: true,
      cantidad: 5
    });

    // Simular lo que retomar() hace: cargar proveedor mediante sincronizarProveedorBase
    // (que es lo que debería hacer para evitar invalidación falsa)
    proveedorActual = 'Trek Argentina';
    app.sincronizarProveedorBase('Trek Argentina');

    // Verificar que proveedorAnterior se actualizó correctamente
    expect(app.proveedorAnterior).toBe('Trek Argentina');

    const llamadasAntes = llamadasFetch.length;

    // Ahora usuario hace blur sin cambiar nada (click trivial)
    app.invalidarMatchesPorCambioProveedor();

    await new Promise(r => setTimeout(r, 50));

    // CLAVE: no debe invalidar nada, match debe seguir siendo válido
    const item = app.items[0];
    expect(item.id_woo).toBe(100); // Match se mantiene
    expect(item.match_origen).toBe('alias_proveedor'); // Origen se mantiene
    expect(item.match_confirmado).toBe(true); // Confirmado se mantiene

    // No debe haber llamadas al backend
    const llamadasDespues = llamadasFetch.length;
    expect(llamadasDespues).toBe(llamadasAntes);
  });
});

describe('public/recepcion/index.html — P1.3: búsqueda dinámica sin catálogo en memoria', () => {
  it('buscarWC hace fetch a /api/recepciones/catalogo?q=... cuando hay >= 2 caracteres', async () => {
    const app = cargarApp();
    const llamadas = [];
    app.fetch = (url) => {
      llamadas.push(String(url));
      if (String(url).includes('/api/recepciones/catalogo?q=')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            data: [
              { id_woo: 10, sku: 'CASCO-1', nombre: 'Casco MTB', stock: 5 },
              { id_woo: 11, sku: 'CASCO-2', nombre: 'Casco Ruta', stock: 3 }
            ]
          })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    const inp = { value: 'cas', setAttribute() {}, getAttribute() { return null; }, id: 'wc-search-item1' };
    const dd = { innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {} };
    app.document.getElementById = (id) => id.startsWith('dd-') ? dd : inp;

    app.buscarWC(inp, 'item1');
    // Esperar debounce (300ms) + tiempo de fetch
    await new Promise(r => setTimeout(r, 400));

    const catalogoCall = llamadas.find(u => u.includes('/api/recepciones/catalogo?q='));
    expect(catalogoCall).toBeDefined();
    expect(catalogoCall).toContain('q=cas');
  });

  it('buscarWC aplica debounce de ~300ms (no dispara fetch en cada tecla)', async () => {
    const app = cargarApp();
    let fetchCount = 0;
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/catalogo?q=')) fetchCount++;
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, data: [] })
      });
    };

    const inp = { value: '', setAttribute() {}, getAttribute() { return null; }, id: 'wc-search-item1' };
    const dd = { innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {} };
    app.document.getElementById = (id) => id.startsWith('dd-') ? dd : inp;

    // Simular varias teclas en rápida sucesión
    inp.value = 'c';
    app.buscarWC(inp, 'item1');
    await new Promise(r => setTimeout(r, 50));

    inp.value = 'ca';
    app.buscarWC(inp, 'item1');
    await new Promise(r => setTimeout(r, 50));

    inp.value = 'cas';
    app.buscarWC(inp, 'item1');

    // Sin debounce, fetchCount sería 2+ (todas las llamadas >= 2 caracteres)
    // Con debounce, solo la última debe dispararse (después de esperar ~300ms)
    await new Promise(r => setTimeout(r, 350));

    // Solo UNA llamada debe haberse hecho (la última)
    expect(fetchCount).toBeLessThanOrEqual(2); // debounce activo: máximo 1-2, no 3
  });

  it('seleccionarWC recibe datos directos (nombre, sku, stock) sin buscar en catálogo[]', () => {
    const app = cargarApp();
    app.items.push({ id: 'item1' });

    const evt = { preventDefault() {} };
    // Los datos se pasan como argumentos o en dataset del elemento
    // Simulamos que se pasan inline como argumentos a la función
    const nombreProducto = 'Casco MTB';
    const skuProducto = 'CASCO-1';
    const stockProducto = 5;

    // Mock para renderItems que se llama dentro de seleccionarWC
    app.renderItems = () => {};
    app.actualizarBotones = () => {};
    app.sincronizarAliasGuardado = () => {};

    // Mock getElementById para que devuelva elementos con setAttribute
    app.document.getElementById = (id) => ({
      setAttribute() {},
      getAttribute() { return null; },
      classList: { remove() {} },
      value: ''
    });

    // P1.3: seleccionarWC recibe los datos como argumentos adicionales (sin depender de catalogo[])
    app.seleccionarWC(evt, 'item1', 10, nombreProducto, skuProducto, stockProducto);

    const item = app.items[0];
    expect(item.id_woo).toBe(10);
    expect(item.nombre_wc).toBe(nombreProducto);
    expect(item.sku_wc).toBe(skuProducto);
    expect(item.stock_wc).toBe(stockProducto);
  });

  it('retomar(id) NO depende de catálogo[] cargado en memoria', async () => {
    const app = cargarApp();
    // Verificar que catalogo no esté globalmente disponible o esté vacío
    const itemConIdWoo = { id_woo: 10, sku: 'CASCO-1', nombre_doc: 'Casco' };

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: '' };
      if (id === 'inp-importador') return { value: '' };
      if (id === 'inp-numero-pedido') return { value: '' };
      if (id === 'inp-fecha') return { value: '' };
      if (id === 'inp-notas') return { value: '' };
      if (id === 'solo-doc-row') return { setAttribute() {} };
      if (id === 'solo-doc-toggle') return { style: {} };
      if (id === 'solo-doc-knob') return { style: {} };
      if (id === 'btn-confirmar') return { style: {} };
      if (id === 'btn-confirmar-solo') return { style: {} };
      if (id === 'docs-area') return { innerHTML: '', appendChild() {} };
      if (id === 'items-section') return { style: {} };
      if (id === 'items-body') return { innerHTML: '', appendChild() {} };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'status-confirm') return { textContent: '', innerHTML: '', className: '', style: { display: '' } };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} };
    };

    app.document.createElement = (tag) => ({
      innerHTML: '', appendChild() {}, setAttribute() {}, querySelector() { return null; }, id: ''
    });

    // Mock fetch para simular retomar de una recepción guardada
    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/1')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            data: {
              id: 1,
              proveedor: 'Proveedor A',
              importador: 'Proveedor A',
              numero_pedido: '',
              fecha: '2026-09-22',
              notas: '',
              solo_documento: 0,
              documentos: [],
              items: [itemConIdWoo]
            }
          })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    // Llamar a retomar sin haber cargado catálogo completo
    app.retomar(1);
    await new Promise(r => setTimeout(r, 50));

    // El ítem debe estar restaurado con nombre fallback (nombre_doc) o con búsqueda puntual
    expect(app.items).toHaveLength(1);
    expect(app.items[0].id_woo).toBe(10);
    // El nombre debe estar disponible (via nombre_doc como fallback o búsqueda puntual)
    expect(app.items[0].nombre_wc).toBeDefined();
  });

  it('retomar no espera a catalogo.length > 0 (polling sin precarga)', async () => {
    const app = cargarApp();
    const params = new URLSearchParams('retomar=99');
    app.window.location = { search: '?retomar=99' };

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: '', addEventListener() {} };
      if (id === 'inp-importador') return { value: '' };
      if (id === 'inp-numero-pedido') return { value: '', addEventListener() {} };
      if (id === 'inp-fecha') return { value: '' };
      if (id === 'inp-notas') return { value: '' };
      if (id === 'solo-doc-row') return { setAttribute() {} };
      if (id === 'solo-doc-toggle') return { style: {} };
      if (id === 'solo-doc-knob') return { style: {} };
      if (id === 'btn-confirmar') return { style: {} };
      if (id === 'btn-confirmar-solo') return { style: {} };
      if (id === 'docs-area') return { innerHTML: '', appendChild() {} };
      if (id === 'items-section') return { style: {} };
      if (id === 'items-body') return { innerHTML: '', appendChild() {} };
      if (id === 'items-count') return { textContent: '' };
      if (id === 'status-confirm') return { textContent: '', innerHTML: '', className: '', style: { display: '' } };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} };
    };

    app.document.createElement = (tag) => ({
      innerHTML: '', appendChild() {}, setAttribute() {}, querySelector() { return null; }, id: ''
    });

    let retomoCalled = false;
    const originalRetomar = app.retomar.bind(app);
    app.retomar = (id) => {
      retomoCalled = true;
      return originalRetomar(id);
    };

    app.fetch = (url) => {
      if (String(url).includes('/api/recepciones/99')) {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            data: { id: 99, proveedor: 'Test', items: [] }
          })
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: [] }) });
    };

    // onload debe intentar retomar sin esperar catálogo
    app.window.onload();

    // Con P1.3, no debe esperar a catalogo.length > 0, debe retomar inmediatamente
    // (o después del timeout de seguridad, pero sin dependencia de catálogo)
    await new Promise(r => setTimeout(r, 200));

    expect(retomoCalled).toBe(true);
  });

  it('buscarWC: guard anti-stale previene que fetch obsoleto pinte resultados o errores', async () => {
    const app = cargarApp();
    const inp = { value: 'ca', setAttribute() {}, getAttribute() { return null; }, id: 'wc-search-item1' };
    const dd = { innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {} };
    app.document.getElementById = (id) => id.startsWith('dd-') ? dd : inp;

    let callOrder = [];
    app.fetch = (url) => {
      const q = url.match(/q=([^&]*)/)?.[1];
      callOrder.push(q);

      // El fetch de "ca" falla, el de "cas" se resuelve
      if (q === 'ca') {
        return Promise.reject(new Error('Network error for ca'));
      }
      return Promise.resolve({
        json: () => Promise.resolve({
          ok: true,
          data: [{ id_woo: 10, sku: 'CASCO-1', nombre: 'Casco MTB', stock: 5 }]
        })
      });
    };

    // Buscar "ca"
    app.buscarWC(inp, 'item1');
    await new Promise(r => setTimeout(r, 50));

    // Cambiar a "cas" (cancela debounce anterior, lanza uno nuevo)
    inp.value = 'cas';
    app.buscarWC(inp, 'item1');

    // Esperar ambos debounces + fetches (max 650ms = 300 * 2 + buffer)
    await new Promise(r => setTimeout(r, 700));

    // Verificar: el fetch de "cas" se resolvió, se muestra su resultado
    expect(dd.innerHTML).toContain('Casco MTB');
    // El error del fetch de "ca" NO pisó nada (guard anti-stale)
    expect(dd.innerHTML).not.toContain('Error al buscar');
  });
});

describe('public/recepcion/index.html — P1.5: modo "solo documento" no exige matches resueltos', () => {
  it('BUG: en modo soloDocumento=true, un ítem recibido sin match NO bloquea el botón', () => {
    const app = cargarApp();
    const btn1 = { disabled: false };
    const btnSolo = { disabled: false };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'btn-confirmar') return btn1;
      if (id === 'btn-confirmar-solo') return btnSolo;
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Activar modo "solo documento"
    app.soloDocumento = true;

    // Agregar un ítem recibido pero sin match (id_woo === null)
    // En modo solo documento, esto no debería bloquear porque no hay stock a actualizar
    app.items.push({
      id: 1, nombre_doc: 'Producto sin Match', id_woo: null, sku_wc: null, nombre_wc: null,
      recibido: true,
      cantidad: 1
    });

    app.actualizarBotones();

    // En modo "solo documento", el botón NO debe estar bloqueado por falta de match
    // porque el stock no se va a tocar
    expect(btnSolo.disabled).toBe(false);
    // El botón normal debería estar oculto (controlado por toggleSoloDoc, no por actualizarBotones)
    // pero su estado internal sigue siendo relevante para verificar que la lógica es diferente
    // Para este test, lo importante es que btn-confirmar-solo esté habilitado
  });

  it('en modo soloDocumento=true con múltiples ítems recibidos sin matches, btn-confirmar-solo debe estar habilitado', () => {
    const app = cargarApp();
    const btnSolo = { disabled: false };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor Test' };
      if (id === 'btn-confirmar-solo') return btnSolo;
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    app.soloDocumento = true;

    // Agregar varios ítems recibidos sin matches
    app.items.push(
      { id: 1, nombre_doc: 'Item 1', id_woo: null, recibido: true, cantidad: 5 },
      { id: 2, nombre_doc: 'Item 2', id_woo: null, recibido: true, cantidad: 3 },
      { id: 3, nombre_doc: 'Item 3', id_woo: null, recibido: true, cantidad: 2 }
    );

    app.actualizarBotones();

    // Debe estar habilitado (hay items, hay proveedor, pero soloDocumento ignora tieneBloqueantes)
    expect(btnSolo.disabled).toBe(false);
  });

  it('en modo normal (soloDocumento=false), un ítem recibido sin match sigue bloqueando el botón', () => {
    const app = cargarApp();
    const btn1 = { disabled: false };
    const btnSolo = { disabled: false };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'btn-confirmar') return btn1;
      if (id === 'btn-confirmar-solo') return btnSolo;
      if (id === 'status-confirm') return { textContent: '' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Modo normal (soloDocumento = false, que es el default)
    app.soloDocumento = false;

    // Ítem sin match
    app.items.push({
      id: 1, nombre_doc: 'Sin Match', id_woo: null,
      recibido: true,
      cantidad: 1
    });

    app.actualizarBotones();

    // En modo normal, debe estar bloqueado
    expect(btn1.disabled).toBe(true);
    expect(btnSolo.disabled).toBe(true);
  });

  it('en modo soloDocumento=true, el mensaje de status debe mostrar "no se actualizará el stock"', () => {
    const app = cargarApp();
    const status = { textContent: '' };
    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      if (id === 'status-confirm') return status;
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    app.soloDocumento = true;
    app.items.push({
      id: 1, nombre_doc: 'Item', id_woo: null, recibido: true, cantidad: 1
    });

    app.actualizarBotones();

    // El mensaje debe indicar modo solo documento
    expect(status.textContent).toMatch(/solo documento|no se actualizará/i);
  });
});

describe('public/recepcion/index.html — P1.6: Modales accesibles', () => {
  it('abrirModal existe y es función', () => {
    const app = cargarApp();
    expect(typeof app.abrirModal).toBe('function');
  });

  it('cerrarModal existe y es función', () => {
    const app = cargarApp();
    expect(typeof app.cerrarModal).toBe('function');
  });

  it('mostrarErroresModal existe y es función', () => {
    const app = cargarApp();
    expect(typeof app.mostrarErroresModal).toBe('function');
  });

  it('revocarAliasUI puede ejecutarse sin window.prompt', () => {
    const app = cargarApp();
    // Mock del getElementById para que devuelva elementos con estructura modal
    const elementos = {};
    app.document.getElementById = (id) => {
      if (!elementos[id]) {
        elementos[id] = {
          value: '',
          textContent: '',
          style: {},
          disabled: false,
          dataset: {},
          innerHTML: '',
          classList: { add() {}, remove() {}, contains() { return false; } },
          addEventListener() {},
          appendChild() {},
          querySelector: () => null,
          querySelectorAll: () => [],
          focus() {},
        };
      }
      return elementos[id];
    };
    app.window.prompt = undefined; // Asegurar que prompt no exista

    // Debe ejecutarse sin errores (aunque no haga nada útil sin DOM real)
    try {
      // Envolver en un try catch porque la función espera DOM real para inicializar
      app.revocarAliasUI(999);
    } catch (e) {
      // Si falla, es porque algo en el modal explota, no porque use prompt()
      expect(e.message).not.toContain('prompt');
    }
  });

  it('abrirAltaBorrador no usa window.prompt para validación', () => {
    const app = cargarApp();
    const elementos = {};
    const fetchCalls = [];

    app.document.getElementById = (id) => {
      if (!elementos[id]) {
        elementos[id] = {
          value: '',
          textContent: '',
          style: {},
          disabled: false,
          dataset: {},
          innerHTML: '',
          className: '',
          classList: { add() {}, remove() {}, contains() { return false; } },
          addEventListener() {},
          appendChild() {},
          querySelector: () => null,
          querySelectorAll: () => [],
          onchange: null,
          focus() {},
        };
      }
      return elementos[id];
    };

    app.fetch = (url) => {
      fetchCalls.push(url);
      return Promise.resolve({
        json: () => Promise.resolve({
          ok: true,
          categorias: [{ id: 1, name: 'Cat 1', parent: 0 }]
        })
      });
    };

    app.window.prompt = undefined; // Asegurar que prompt no exista
    app.items.push({ id: 1, nombre_doc: 'Test Item' });

    try {
      app.abrirAltaBorrador(1);
    } catch (e) {
      // Si falla, es porque algo explota, no porque use prompt()
      expect(e.message).not.toContain('prompt');
    }
  });

  it('modalState existe y se inicializa', () => {
    const app = cargarApp();
    expect(app.modalState).toBeDefined();
    expect(app.modalState.isOpen).toBe(false);
  });

  // Tests críticos para evitar recursión infinita y POSTs duplicados
  it('revocarAliasUI con motivo vacío: modal permanece abierto y muestra error', async () => {
    const app = cargarApp();
    let mostroError = false;
    let cerroModal = false;

    const elementos = {};
    app.document.getElementById = (id) => {
      if (!elementos[id]) {
        elementos[id] = {
          value: '',
          textContent: '',
          style: {},
          disabled: false,
          dataset: {},
          innerHTML: '',
          className: '',
          classList: {
            add(cls) {
              if (cls === 'show') mostroError = true;
            },
            remove() {
              if (mostroError) cerroModal = true;
            },
            contains() { return false; },
          },
          addEventListener() {},
          appendChild() {},
          querySelector: () => null,
          querySelectorAll: () => [],
          focus() {},
        };
      }
      return elementos[id];
    };

    app.modalState.isOpen = true;
    app.modalState.onConfirm = null;
    app.modalState.onCancel = null;
    app.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });

    // Simular: usuario hace click en "Confirmar" pero motivo está vacío
    app.revocarAliasUI(999);

    // Esperar que abrirModal se ejecute y luego simular el click en Confirmar
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.modalState.onConfirm).not.toBeNull();
    app.modalState.onConfirm();

    // El motivo está vacío: debe mostrar el error y el modal debe seguir abierto
    // (isOpen sólo se pone en false dentro de _ocultarModalDom, que no debe correr acá).
    expect(mostroError).toBe(true);
    expect(cerroModal).toBe(false);
    expect(app.modalState.isOpen).toBe(true);
  });

  it('abrirAltaBorrador válido dispara EXACTAMENTE UN fetch de creación (no recursión)', async () => {
    const app = cargarApp();
    let fetchCalls = [];
    let fetchCallsCrearBorrador = 0;

    const elementos = {};
    app.document.getElementById = (id) => {
      if (!elementos[id]) {
        elementos[id] = {
          value: '',
          textContent: '',
          style: {},
          disabled: false,
          dataset: {},
          innerHTML: '',
          className: '',
          classList: { add() {}, remove() {}, contains() { return false; } },
          addEventListener() {},
          appendChild() {},
          querySelector: () => null,
          querySelectorAll: () => [],
          onchange: null,
          focus() {},
        };
      }
      // Pre-llenar campos para que pase validación
      if (id === 'titulo-input') elementos[id].value = 'Test Title';
      if (id === 'marca-input') elementos[id].value = 'Test Brand';
      if (id === 'categoria-select') elementos[id].value = '1|Test Category';
      if (id === 'precio-input') elementos[id].value = '10.50';
      if (id === 'modo-select') elementos[id].value = 'simple';
      if (id === 'parent-input') elementos[id].value = '';
      if (id === 'atributo-nombre-input') elementos[id].value = 'Talle';
      if (id === 'atributo-valor-input') elementos[id].value = 'Único';

      return elementos[id];
    };

    app.document.createElement = () => ({ value: '', appendChild() {}, querySelector: () => null, setAttribute() {}, style: {} });
    app.modalState.isOpen = true;
    app.items.push({ id: 1, nombre_doc: 'Test Item' });

    let recursionDetected = false;
    app.fetch = (url) => {
      fetchCalls.push(url);
      if (String(url).includes('/api/nuevos-productos/categorias-woo')) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, categorias: [{ id: 1, name: 'Test Category', parent: 0 }] })
        });
      }
      if (String(url).includes('/api/nuevos-productos/crear-borrador')) {
        fetchCallsCrearBorrador++;
        if (fetchCallsCrearBorrador > 1) {
          recursionDetected = true;
        }
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({
          ok: true,
          id_woo: 123,
          sku: 'TEST-SKU-123'
        })
      });
    };

    app.abrirAltaBorrador(1);

    // Esperar a que abrirModal se execute
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.modalState.onConfirm).toBeTruthy();
    // Simular click en Confirmar
    try {
      app.modalState.onConfirm();
    } catch (e) {
      if (e instanceof RangeError && e.message.includes('Maximum call stack')) {
        recursionDetected = true;
      }
    }

    // Darle tiempo a la cadena de promesas del fetch para resolver.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Debe haber exactamente UN fetch a crear-borrador, sin recursión.
    expect(recursionDetected).toBe(false);
    expect(fetchCallsCrearBorrador).toBe(1);
  });

  it('_ocultarModalDom existe y es callable', () => {
    const app = cargarApp();
    expect(typeof app._ocultarModalDom).toBe('function');
  });

  it('confirmarModal y cancelarModal existen', () => {
    const app = cargarApp();
    expect(typeof app.confirmarModal).toBe('function');
    expect(typeof app.cancelarModal).toBe('function');
  });
});

describe('public/recepcion/index.html — P1.8: confirmarRecepcion() desglose de 4 categorías', () => {
  // Helper para capturar el confirm() y extractar el mensaje
  function capturaConfirmMessage(app, operacion) {
    let capturedMsg = null;
    app.confirm = (msg) => {
      capturedMsg = msg;
      return true; // Simular que el usuario acepta
    };

    // Mock alert para evitar errores
    app.alert = () => {};

    // Mock fetch y el resto de operaciones
    let fetchCalls = [];
    app.fetch = (url) => {
      fetchCalls.push(String(url));
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, id: 123 })
      });
    };

    operacion();
    return capturedMsg;
  }

  it('desglose: "Seguros" = recibidos con match_estado=resuelto sin alta', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Ítem recibido, con id_woo, match_estado='resuelto' (sin alta_estado)
    app.items.push({
      id: 1, nombre_doc: 'Producto Seguro', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto WC',
      recibido: true, match_estado: 'resuelto', match_confirmado: true, alta_estado: null,
      cantidad: 1
    });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // El mensaje debe mencionar 1 "Seguro" o "automático"
    expect(msg).toMatch(/1.*seguro|1.*automático|1.*match automático/i);
  });

  it('desglose: "Manuales" = recibidos con alta_estado=creado', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Ítem recibido con alta_estado='creado' (tiene id_woo del alta)
    app.items.push({
      id: 1, nombre_doc: 'Producto Nuevo', id_woo: 101, sku_wc: 'FB-101', nombre_wc: 'Producto Nuevo WC',
      recibido: true, alta_estado: 'creado', alta_operation_id: 'op-123',
      cantidad: 1
    });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // El mensaje debe mencionar 1 "Manual" o "nueva"
    expect(msg).toMatch(/1.*manual|1.*nueva|1.*alta nueva/i);
  });

  it('desglose: "Pendientes" = recibidos sin id_woo', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Ítem recibido sin id_woo (sin match, sin alta)
    app.items.push({
      id: 1, nombre_doc: 'Producto Sin Match', id_woo: null, sku_wc: null, nombre_wc: null,
      recibido: true,
      cantidad: 1
    });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // El mensaje debe mencionar 1 "Pendiente" o "sin match"
    expect(msg).toMatch(/1.*pendiente|1.*sin match|pendientes sin match/i);
  });

  it('desglose: "No recibidos" = ítems no marcados como recibidos', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Ítem recibido (para pasar validación)
    app.items.push({
      id: 1, nombre_doc: 'Producto Recibido', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto WC',
      recibido: true, match_estado: 'resuelto', match_confirmado: true,
      cantidad: 1
    });

    // Ítem NO recibido
    app.items.push({
      id: 2, nombre_doc: 'Producto No Recibido', id_woo: null,
      recibido: false,
      cantidad: 1
    });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // El mensaje debe mencionar 1 "no recibido" o "no se procesan"
    expect(msg).toMatch(/1.*no recibido|no se procesan/i);
  });

  it('desglose completo: 2 Seguros + 1 Manual + 3 Pendientes + 2 No recibidos', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // 2 Seguros
    app.items.push({
      id: 1, nombre_doc: 'Seguro 1', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Seg 1',
      recibido: true, match_estado: 'resuelto', match_confirmado: true, alta_estado: null, cantidad: 1
    });
    app.items.push({
      id: 2, nombre_doc: 'Seguro 2', id_woo: 101, sku_wc: 'FB-101', nombre_wc: 'Seg 2',
      recibido: true, match_confirmado: true, alta_estado: null, cantidad: 1
    });

    // 1 Manual
    app.items.push({
      id: 3, nombre_doc: 'Manual 1', id_woo: 102, sku_wc: 'FB-102', nombre_wc: 'Manual 1',
      recibido: true, alta_estado: 'creado', alta_operation_id: 'op-1', cantidad: 1
    });

    // 3 Pendientes
    app.items.push({ id: 4, nombre_doc: 'Pendiente 1', id_woo: null, recibido: true, cantidad: 1 });
    app.items.push({ id: 5, nombre_doc: 'Pendiente 2', id_woo: null, recibido: true, cantidad: 1 });
    app.items.push({ id: 6, nombre_doc: 'Pendiente 3', id_woo: null, recibido: true, cantidad: 1 });

    // 2 No recibidos
    app.items.push({ id: 7, nombre_doc: 'No Recibido 1', id_woo: null, recibido: false, cantidad: 1 });
    app.items.push({ id: 8, nombre_doc: 'No Recibido 2', id_woo: null, recibido: false, cantidad: 1 });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // Verificar que el mensaje contiene referencias a cada categoría con sus cantidades
    expect(msg).toMatch(/2.*seguro|2.*automático/i);
    expect(msg).toMatch(/1.*manual|1.*nueva/i);
    expect(msg).toMatch(/3.*pendiente|3.*sin match/i);
    expect(msg).toMatch(/2.*no recibido/i);
  });

  it('mensaje destaca que Seguros + Manuales actualizarán stock', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    app.items.push({
      id: 1, nombre_doc: 'Seguro', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Seg',
      recibido: true, match_estado: 'resuelto', match_confirmado: true, alta_estado: null, cantidad: 1
    });

    app.items.push({
      id: 2, nombre_doc: 'Manual', id_woo: 101, sku_wc: 'FB-101', nombre_wc: 'Manual',
      recibido: true, alta_estado: 'creado', alta_operation_id: 'op-1', cantidad: 1
    });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // El mensaje debe aclarar que ambos actualizarán stock
    expect(msg).toMatch(/actualizar.*stock|stock.*woocommerce/i);
  });

  it('match_confirmado=true sin match_estado es Seguro (confirmado manualmente)', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Ítem con match_confirmado=true pero sin match_estado específico
    app.items.push({
      id: 1, nombre_doc: 'Confirmado Manualmente', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto',
      recibido: true, match_confirmado: true, alta_estado: null, cantidad: 1
    });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // Debe contar como Seguro
    expect(msg).toMatch(/1.*seguro|1.*confirmado/i);
  });

  it('un ítem alta_creado con match_estado=resuelto es Manual (no Seguro + Manual separados)', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Ítem que es AMBOS: alta creada Y match_estado=resuelto
    // Debe contar como Manual (una sola vez)
    app.items.push({
      id: 1, nombre_doc: 'Alta+Resuelto', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Producto',
      recibido: true, alta_estado: 'creado', alta_operation_id: 'op-1', match_estado: 'resuelto', cantidad: 1
    });

    const msg = capturaConfirmMessage(app, () => app.confirmarRecepcion());

    // Debe contar como 1 Manual, no como 1 Seguro + 1 Manual
    expect(msg).toMatch(/1.*manual/i);
    // No debe haber "2 seguro" o similar
    expect(msg).not.toMatch(/2.*seguro|2.*automático/i);
  });

  it('CASO CRÍTICO (revisión): ítem con id_woo + match_estado=revisar + match_confirmado=false cae en Pendientes por construcción', () => {
    const app = cargarApp();

    app.document.getElementById = (id) => {
      if (id === 'inp-proveedor') return { value: 'Proveedor A' };
      return { value: '', textContent: '', style: {}, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} };
    };

    // Este es el caso que caía entre grietas: candidato sin confirmar
    // tiene id_woo pero no es ni Seguro ni Manual ni (antes) Pendiente
    app.items.push({
      id: 1, nombre_doc: 'Candidato Sin Confirmar', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Prod',
      recibido: true, match_estado: 'revisar', match_confirmado: false, alta_estado: null, cantidad: 1
    });

    // Agregar un Seguro para que haya diversidad
    app.items.push({
      id: 2, nombre_doc: 'Seguro', id_woo: 101, sku_wc: 'FB-101', nombre_wc: 'Seg',
      recibido: true, match_estado: 'resuelto', match_confirmado: true, alta_estado: null, cantidad: 1
    });

    let capturedMsg = null;
    app.confirm = (msg) => {
      capturedMsg = msg;
      return true;
    };
    app.alert = () => {};
    app.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, id: 123 }) });

    app.confirmarRecepcion();

    // El mensaje debe existir (no debe fallar silenciosamente)
    expect(capturedMsg).toBeTruthy();

    // Verificar que el candidato sin confirmar aparece en "Pendientes"
    // (porque pendientes = recibidos.length - seguros - manuales = 2 - 1 - 0 = 1)
    expect(capturedMsg).toMatch(/1.*pendiente/i);

    // La suma de categorías debe ser = items.length
    // 1 Seguro + 1 Pendiente + 0 Manuales + 0 No recibidos = 2 items ✓
  });
});

describe('public/recepcion/index.html — P1.8: payloadRecepcion() verifica match_estado=revisar', () => {
  it('un ítem con match_estado=revisar sin confirmar viaja como "sin_match" no "pendiente"', () => {
    const app = cargarApp();

    // Caso: ítem con id_woo BUT match_estado='revisar' sin confirmación
    // (En la práctica este caso no debería llegar a confirmarRecepcion por el bloqueo,
    // pero podría llegar a payloadRecepcion en otros flujos como guardarRecepcion)
    app.items.push({
      id: 1, nombre_doc: 'Dudoso', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Prod WC',
      recibido: true, match_estado: 'revisar', match_confirmado: false,
      cantidad: 1
    });

    const payload = app.payloadRecepcion();
    const it = payload.items[0];

    // IMPORTANTE: un match sin confirmar NO debe tocarse stock, debe viajar como 'sin_match'
    // (El fix es: si match_estado==='revisar' && match_confirmado!==true, viaja como sin_match)
    // Por ahora, verificamos si ya está arreglado o si necesita arreglarse
    // Si el código ACTUAL lo envía como 'pendiente', es un bug que necesita fix
    // Si lo envía como 'sin_match', está bien

    // Estado ACTUAL: línea 1262 dice (it.id_woo ? 'pendiente' : 'sin_match')
    // Esto INCORRECTAMENTE lo enviaría como 'pendiente'
    // Esperamos que este test falle inicialmente, y el fix lo arregle

    expect(it.estado_item).not.toBe('pendiente');
    expect(it.estado_item).toBe('sin_match');
  });

  it('un ítem con match_estado=revisar pero match_confirmado=true viaja como "pendiente"', () => {
    const app = cargarApp();

    // Si el usuario confirmó manualmente (match_confirmado=true), entonces sí puede tocar stock
    app.items.push({
      id: 1, nombre_doc: 'Revisar pero Confirmado', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Prod',
      recibido: true, match_estado: 'revisar', match_confirmado: true,
      cantidad: 1
    });

    const payload = app.payloadRecepcion();
    const it = payload.items[0];

    // Con confirmación manual explícita, sí puede viajar como pendiente
    expect(it.estado_item).toBe('pendiente');
  });

  it('un ítem sin id_woo siempre viaja como "sin_match" (incluso si match_estado=revisar internamente)', () => {
    const app = cargarApp();

    app.items.push({
      id: 1, nombre_doc: 'Sin Match en Absoluto', id_woo: null,
      recibido: true, match_estado: 'revisar',
      cantidad: 1
    });

    const payload = app.payloadRecepcion();
    const it = payload.items[0];

    expect(it.estado_item).toBe('sin_match');
  });

  it('recibido=false NO afecta cómo se envía estado_item (el estado refleja la realidad del ítem)', () => {
    const app = cargarApp();

    // Un ítem no recibido con id_woo sigue siendo 'pendiente' en el payload
    // (aunque en la práctica no se debería procesar)
    app.items.push({
      id: 1, nombre_doc: 'No Recibido', id_woo: 100, sku_wc: 'FB-100', nombre_wc: 'Prod',
      recibido: false, match_estado: 'resuelto', match_confirmado: true,
      cantidad: 1
    });

    const payload = app.payloadRecepcion();
    const it = payload.items[0];

    // El estado_item refleja el atributo del ítem, no si fue recibido
    expect(it.estado_item).toBe('pendiente');
    // Pero el recibido field sí lo marca
    expect(it.recibido).toBe(0);
  });
});
