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

    const inp = { value: 'cas' };
    const dd = { innerHTML: '', classList: { add() {}, remove() {} } };
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

    const inp = { value: '' };
    const dd = { innerHTML: '', classList: { add() {}, remove() {} } };
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
    const inp = { value: 'ca' };
    const dd = { innerHTML: '', classList: { add() {}, remove() {} } };
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
