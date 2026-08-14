/**
 * Tests de CARACTERIZACIÓN del contrato de datos que expone routes/preparacion.js
 * al frontend (public/preparacion/index.html), corridos ANTES de adoptar el modelo
 * canónico de Orden de venta (Fase 3 de lib/modelos/). Fijan:
 *   - las 14 claves exactas de normalizarEnvio (planilla Andreani, contrato con
 *     public/preparacion/index.html:461-468)
 *   - la forma completa de un pendiente 'web' y uno 'ml' (GET /pendientes)
 * Deben seguir en verde, sin modificarse, después del refactor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { normalizarEnvio } from '../lib/preparacion.js';

vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});
vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { wooFetch } from '../routes/woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { preparacionRouter, reintentarColgadosTracking, crearPreparacion } from '../routes/preparacion.js';

const TEST_DB = './test/tmp-preparacion-contrato.sqlite';

const CFG = {
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  andreaniStatus: 'lpaandreani',
};

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'tester', is_admin: 1 }; next(); });
  app.use('/api/preparacion', preparacionRouter(db, CFG));
  return app;
}

describe('contrato normalizarEnvio (planilla Andreani)', () => {
  it('expone exactamente las 14 claves que consume public/preparacion/index.html', () => {
    const order = {
      id: 77, number: '77',
      shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', address_2: '2B', city: 'Córdoba', state: 'Córdoba', postcode: '5000', phone: '0351 4567890' },
      billing: { email: 'ana@mail.com' },
      customer_note: 'tocar timbre',
      meta_data: [{ key: '_billing_dni', value: '30123456' }],
    };
    const envio = normalizarEnvio(order);
    expect(Object.keys(envio).sort()).toEqual([
      'apellido', 'calle', 'caracteristica', 'cp', 'dni_cuit', 'email', 'localidad',
      'nombre', 'notas', 'numeracion', 'pedido', 'piso_depto', 'provincia', 'telefono',
    ].sort());
  });
});

describe('contrato GET /pendientes', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();

    // Catálogo para resolver categoría del ítem web (id_woo = variation_id||product_id).
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?,?)'
    ).run(501, 'Bici Rodado', 'BIKE-1', 'simple', null, 3, '["Bicicletas"]', new Date().toISOString());

    // Mapeo + catálogo para resolver SKU/categoría del ítem ML.
    db.prepare(
      'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?,?,?,?,?)'
    ).run('MLA900|', 'CASCO-9', 'Casco L', 'confirmar', new Date().toISOString());
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?,?)'
    ).run(601, 'Casco L', 'CASCO-9', 'simple', null, 5, '["Cascos"]', new Date().toISOString());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('un pendiente web y uno ml tienen exactamente la forma que espera el frontend', async () => {
    const app = buildTestApp(db); // ensureTables corre acá; hace falta antes de sembrar pedidos_cache
    const itemsWeb = [{ line_item_id: 1, product_id: 501, variation_id: null, sku: 'BIKE-1', nombre: 'Bici Rodado', categoria: 'Bicicletas', cantidad: 2 }];
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('web:900','web',900,NULL,'900','Juan Perez','2026-07-01T00:00:00Z','pendiente','lpaandreani',0,NULL,NULL,?,?)
    `).run(JSON.stringify(itemsWeb), new Date().toISOString());

    const itemsMl = [{ line_item_id: null, product_id: 601, variation_id: null, sku: 'CASCO-9', nombre: 'Casco L', categoria: 'Cascos', cantidad: 1 }];
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:ORD-ML-1','ml',NULL,'ORD-ML-1','ORD-ML-1','comprador_ml','2026-07-02T00:00:00Z','pendiente',NULL,0,'self_service',NULL,?,?)
    `).run(JSON.stringify(itemsMl), new Date().toISOString());

    const res = await request(app).get('/api/preparacion/pendientes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(2);

    const web = res.body.data.find(p => p.canal === 'web');
    expect(Object.keys(web).sort()).toEqual([
      'canal', 'comprador', 'espejo_ml', 'estado_preparacion', 'estado_wc', 'etiqueta_lista',
      'fecha', 'items', 'numero_pedido', 'preparacion_id', 'wc_order_id',
    ].sort());
    expect(web.wc_order_id).toBe(900);
    expect(web.espejo_ml).toBe(false);
    expect(web.comprador).toBe('Juan Perez');
    expect(Object.keys(web.items[0]).sort()).toEqual([
      'cantidad', 'categoria', 'line_item_id', 'nombre', 'product_id', 'sku', 'variation_id',
    ].sort());
    expect(web.items[0]).toMatchObject({ sku: 'BIKE-1', categoria: 'Bicicletas', cantidad: 2 });

    const ml = res.body.data.find(p => p.canal === 'ml');
    expect(Object.keys(ml).sort()).toEqual([
      'canal', 'comprador', 'estado_preparacion', 'fecha', 'items', 'logistic_type',
      'ml_order_id', 'numero_pedido', 'preparacion_id', 'substatus', 'wc_order_id',
    ].sort());
    expect(ml.ml_order_id).toBe('ORD-ML-1');
    expect(ml.comprador).toBe('comprador_ml');
    expect(ml.logistic_type).toBe('self_service');
    expect(Object.keys(ml.items[0]).sort()).toEqual([
      'cantidad', 'categoria', 'line_item_id', 'nombre', 'product_id', 'sku', 'variation_id',
    ].sort());
    expect(ml.items[0]).toMatchObject({ sku: 'CASCO-9', categoria: 'Cascos', cantidad: 1 });
  });
});

describe('GET /historial', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('un pedido enviado con preparación asociada no aparece duplicado como enviado_sin_preparar', async () => {
    const app = buildTestApp(db); // ensureTables corre acá
    const now = new Date().toISOString();

    // Pedido 900: en pedidos_cache como 'enviado' Y tiene preparación completada.
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('web:900','web',900,NULL,'900','Juan Perez','2026-07-01T00:00:00Z','enviado','completed',0,NULL,NULL,?,?)
    `).run(JSON.stringify([{ sku: 'BIKE-1', nombre: 'Bici', cantidad: 1 }]), now);
    db.prepare(`
      INSERT INTO preparaciones (canal, clave, wc_order_id, numero_pedido, comprador, estado, creado_en, completado_en)
      VALUES ('web','web:900',900,'900','Juan Perez','completada',?,?)
    `).run(now, now);

    // Pedido 901: en pedidos_cache como 'enviado' pero SIN preparación → sí debe listarse como enviado_sin_preparar.
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('web:901','web',901,NULL,'901','Beto Diaz','2026-07-02T00:00:00Z','enviado','completed',0,NULL,NULL,?,?)
    `).run(JSON.stringify([{ sku: 'CUB-1', nombre: 'Cubierta', cantidad: 1 }]), now);

    const res = await request(app).get('/api/preparacion/historial');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const claves900 = res.body.data.filter(d => d.wc_order_id === 900);
    expect(claves900).toHaveLength(1);
    expect(claves900[0].estado).toBe('completada');

    const claves901 = res.body.data.filter(d => d.wc_order_id === 901);
    expect(claves901).toHaveLength(1);
    expect(claves901[0].estado).toBe('enviado_sin_preparar');
  });
});

describe('GET /seguimientos (contrato nuevo: 3 secciones + contadores, plan 2026-08-13)', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('reparte TODO el universo lpaandreani entre esperando y sin_preparacion, sin excluir en_preparacion', async () => {
    const mk = (id) => ({ id, number: String(id), shipping: { first_name: 'N', last_name: 'A', address_1: 'Calle 1', city: 'Cordoba', state: 'Cordoba', postcode: '5000' }, billing: {}, meta_data: [] });
    // 900: preparación 'completada' (verificada) -> esperando
    // 901: sin ninguna fila local -> sin_preparacion
    // 902: en_preparacion (p.ej. solo "etiqueta lista") -> sin_preparacion, NO se excluye
    // 903: despachada_sin_verificar -> sin_preparacion
    wooFetch.mockResolvedValueOnce({ data: [mk(900), mk(901), mk(902), mk(903)] }); // status=lpaandreani (única llamada del universo)

    const app = buildTestApp(db); // ensureTables corre acá
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:900',900,1,'completada',?)`).run(now);
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:902',902,1,'en_preparacion',?)`).run(now);
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:903',903,1,'despachada_sin_verificar',?)`).run(now);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(res.body.data.esperando.map(f => f.wc_order_id)).toEqual([900]);
    expect(res.body.data.esperando[0].envio.pedido).toBe('900');
    expect(res.body.data.esperando[0].estado_preparacion).toBe('completada');

    const sinPrepIds = res.body.data.sin_preparacion.map(f => f.wc_order_id).sort();
    expect(sinPrepIds).toEqual([901, 902, 903]);
    const fila901 = res.body.data.sin_preparacion.find(f => f.wc_order_id === 901);
    expect(fila901.preparacion_id).toBeNull();
    expect(fila901.estado_preparacion).toBeNull();
    const fila902 = res.body.data.sin_preparacion.find(f => f.wc_order_id === 902);
    expect(fila902.estado_preparacion).toBe('en_preparacion');

    // Nunca se llama a Woo con status=completed: eso era la fuente de los 70 falsos positivos.
    expect(wooFetch).toHaveBeenCalledTimes(1);
  });

  it('a_medias sale SOLO de woo_paso2_pendiente=1 (dato local), nunca de la meta _andreani_tracking de Woo', async () => {
    // Pedido viejo con tracking cargado a mano en Woo (nunca pasó por esta herramienta):
    // no debe aparecer en ningún lado, ni siquiera si estuviera en lpaandreani.
    wooFetch.mockResolvedValueOnce({ data: [] }); // status=lpaandreani, universo vacío

    const app = buildTestApp(db);
    const now = new Date().toISOString();
    // woo_paso2_pendiente=1 puesto por esta misma herramienta, con tracking ya guardado local.
    // numero_pedido/comprador también quedan guardados localmente (mismo INSERT del paso 1
    // real, ver POST /seguimientos/:wcOrderId) — de ahí sale `envio` acá, SIN pedirle nada
    // a Woo fila por fila (hallazgo del revisor: I4).
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, numero_pedido, comprador, etiqueta_lista, estado, creado_en, woo_paso2_pendiente, tracking)
      VALUES ('web','web:905',905,'905','Caro Lopez',1,'en_preparacion',?,1,'AND555')`).run(now);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    // Una sola llamada a Woo (el universo lpaandreani): a_medias ya no pide nada fila por fila.
    expect(wooFetch).toHaveBeenCalledTimes(1);
    expect(res.body.data.a_medias).toHaveLength(1);
    expect(res.body.data.a_medias[0]).toMatchObject({ wc_order_id: 905, tracking: 'AND555' });
    expect(res.body.data.a_medias[0].envio).toMatchObject({ pedido: '905', nombre: 'Caro Lopez' });
    expect(res.body.data.a_medias_total).toBe(1);
  });

  it('despachados_sin_verificar y cargados_hoy son solo números, calculados de tablas locales', async () => {
    wooFetch.mockResolvedValueOnce({ data: [] });
    const app = buildTestApp(db);
    const now = new Date().toISOString();
    const prepId = db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:910',910,1,'despachada_sin_verificar',?)`).run(now).lastInsertRowid;
    db.prepare(`INSERT INTO preparacion_eventos (preparacion_id, tipo, usuario, detalle_json, creado_en) VALUES (?, 'tracking_cargado', 'tester', '{}', ?)`).run(prepId, now);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.data.despachados_sin_verificar).toBe(1);
    expect(res.body.data.cargados_hoy).toBe(1);
  });

  it('a_medias: LIMIT 20 en la lista pero a_medias_total cuenta el universo entero (hallazgo I4)', async () => {
    wooFetch.mockResolvedValueOnce({ data: [] });
    const app = buildTestApp(db);
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, numero_pedido, comprador, etiqueta_lista, estado, creado_en, woo_paso2_pendiente, tracking)
      VALUES ('web',?,?,?,?,1,'en_preparacion',?,1,?)`);
    for (let i = 0; i < 25; i++) {
      const id = 2000 + i;
      ins.run(`web:${id}`, id, String(id), `Comprador ${i}`, now, `AND${id}`);
    }

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.data.a_medias).toHaveLength(20);
    expect(res.body.data.a_medias_total).toBe(25);
    // Nunca golpea Woo por fila, ni con 25 colgados: una sola llamada (el universo lpaandreani).
    expect(wooFetch).toHaveBeenCalledTimes(1);
  });

  it('cargados_hoy no dobla cuenta un pedido con dos eventos tracking_cargado (reintento manual, hallazgo I6)', async () => {
    wooFetch.mockResolvedValueOnce({ data: [] });
    const app = buildTestApp(db);
    const now = new Date().toISOString();
    const prepId = db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:911',911,1,'despachada_sin_verificar',?)`).run(now).lastInsertRowid;
    db.prepare(`INSERT INTO preparacion_eventos (preparacion_id, tipo, usuario, detalle_json, creado_en) VALUES (?, 'tracking_cargado', 'tester', '{}', ?)`).run(prepId, now);
    db.prepare(`INSERT INTO preparacion_eventos (preparacion_id, tipo, usuario, detalle_json, creado_en) VALUES (?, 'tracking_cargado', 'tester', '{}', ?)`).run(prepId, now);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    // Dos eventos, un solo pedido: cuenta 1, no 2.
    expect(res.body.data.cargados_hoy).toBe(1);
  });

  it('despachados_sin_verificar solo cuenta canal web (hallazgo menor del revisor)', async () => {
    wooFetch.mockResolvedValueOnce({ data: [] });
    const app = buildTestApp(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:912',912,1,'despachada_sin_verificar',?)`).run(now);
    db.prepare(`INSERT INTO preparaciones (canal, clave, ml_order_id, etiqueta_lista, estado, creado_en) VALUES ('ml','ml:ORD-1',NULL,1,'despachada_sin_verificar',?)`).run(now);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.data.despachados_sin_verificar).toBe(1);
  });

  it('truncado:true si el universo lpaandreani viene al tope de per_page (100), truncado:false si no (hallazgo I9)', async () => {
    const mk = (id) => ({ id, number: String(id), shipping: {}, billing: {}, meta_data: [] });
    wooFetch.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => mk(3000 + i)) });
    const app = buildTestApp(db);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.data.truncado).toBe(true);
  });

  it('truncado:false con menos de 100 en el universo', async () => {
    const mk = (id) => ({ id, number: String(id), shipping: {}, billing: {}, meta_data: [] });
    wooFetch.mockResolvedValueOnce({ data: [mk(4000)] });
    const app = buildTestApp(db);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.data.truncado).toBe(false);
  });
});

describe('POST /seguimientos/:wcOrderId', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('preserva el id del meta existente y encadena completed → enviadoandreani; sin verificación previa queda despachada_sin_verificar, NO completada', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: { id: 900, status: 'lpaandreani', meta_data: [{ id: 55, key: '_andreani_tracking', value: '' }] } }) // GET actual
      .mockResolvedValueOnce({ data: { id: 900, status: 'completed' } }) // PUT paso 1
      .mockResolvedValueOnce({ data: { id: 900, status: 'enviadoandreani' } }); // PUT paso 2

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/900').send({ tracking: 'AND123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(wooFetch).toHaveBeenCalledTimes(3);
    expect(wooFetch.mock.calls[1][2]).toBe('put');
    expect(wooFetch.mock.calls[1][3]).toEqual({
      status: 'completed',
      meta_data: [{ id: 55, key: '_andreani_tracking', value: 'AND123' }],
    });
    expect(wooFetch.mock.calls[2][2]).toBe('put');
    expect(wooFetch.mock.calls[2][3]).toEqual({ status: 'enviadoandreani' });

    // Este flujo (etiqueta lista -> nunca se abre -> cargar tracking) es EXACTAMENTE el
    // atajo que reportó el revisor: la preparación acá no tuvo ni un escaneo ni una foto.
    // El pedido salió igual (Woo ya mandó el mail) pero el estado LOCAL tiene que decir
    // la verdad: no se verificó nada. (MUTATION: bloqueante crítico del revisor)
    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:900'").get();
    expect(prep.estado).toBe('despachada_sin_verificar');
    expect(prep.etiqueta_lista).toBe(1);
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='despachado_sin_verificar'").get(prep.id);
    expect(ev).toBeTruthy();

    // Evento que alimenta GET /seguimientos.data.cargados_hoy (antes no se registraba nada acá).
    const evCargado = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='tracking_cargado'").get(prep.id);
    expect(evCargado).toBeTruthy();
    expect(JSON.parse(evCargado.detalle_json)).toEqual({ tracking: 'AND123' });
    expect(prep.tracking).toBe('AND123');
  });

  it('si la preparación YA estaba completamente verificada antes de cargar el tracking, queda completada', async () => {
    // Arma la preparación con ítems y fotos de verdad (via crearPreparacion, como hace
    // /iniciar) ANTES de que el operario cargue el tracking.
    const prepId = crearPreparacion(db, {
      canal: 'web', wcOrderId: 930, numeroPedido: '930', comprador: 'Ana',
      items: [{ line_item_id: 1, product_id: 1, sku: 'CASCO-1', nombre: 'Casco', categoria: 'CASCOS', cantidad: 1 }],
    });
    const item = db.prepare('SELECT id FROM preparacion_items WHERE preparacion_id=?').get(prepId);
    db.prepare("UPDATE preparacion_items SET estado_item='verificado', cantidad_escaneada=1 WHERE id=?").run(item.id);
    const iso = new Date().toISOString();
    const insFoto = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,?,?,?,?)');
    insFoto.run(prepId, item.id, 'articulo', '/x.jpg', iso);
    insFoto.run(prepId, null, 'paquete_abierto', '/a.jpg', iso);
    insFoto.run(prepId, null, 'paquete_cerrado', '/c.jpg', iso);

    wooFetch
      .mockResolvedValueOnce({ data: { id: 930, status: 'lpaandreani', meta_data: [] } })
      .mockResolvedValueOnce({ data: { id: 930, status: 'completed' } })
      .mockResolvedValueOnce({ data: { id: 930, status: 'enviadoandreani' } });

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/930').send({ tracking: 'AND777' });
    expect(res.status).toBe(200);

    const prep = db.prepare('SELECT * FROM preparaciones WHERE id=?').get(prepId);
    expect(prep.estado).toBe('completada');
  });

  it('NUNCA pisa una cerrada_sin_evidencia con completada ni con despachada_sin_verificar al cargar el tracking', async () => {
    const app = buildTestApp(db); // ensureTables corre acá; hace falta antes del INSERT
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en)
      VALUES ('web','web:940',940,1,'cerrada_sin_evidencia',?)`).run(new Date().toISOString());

    wooFetch
      .mockResolvedValueOnce({ data: { id: 940, status: 'lpaandreani', meta_data: [] } })
      .mockResolvedValueOnce({ data: { id: 940, status: 'completed' } })
      .mockResolvedValueOnce({ data: { id: 940, status: 'enviadoandreani' } });

    const res = await request(app).post('/api/preparacion/seguimientos/940').send({ tracking: 'AND888' });
    expect(res.status).toBe(200); // el pedido sale igual del lado Woo

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:940'").get();
    expect(prep.estado).toBe('cerrada_sin_evidencia'); // el estado local NO se lava
  });

  it('si el PUT 2 falla, deja woo_paso2_pendiente=1 y responde 502 con colgado:true (no 500)', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: { id: 910, status: 'lpaandreani', meta_data: [] } }) // GET actual
      .mockResolvedValueOnce({ data: { id: 910, status: 'completed' } }) // PUT paso 1 (ok)
      .mockRejectedValueOnce(new Error('WC caído')); // PUT paso 2 (falla)

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/910').send({ tracking: 'AND555' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, colgado: true });

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:910'").get();
    expect(prep).toBeTruthy();
    expect(prep.woo_paso2_pendiente).toBe(1);
    expect(prep.estado).not.toBe('completada');

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_colgado'").get();
    expect(ev).toBeTruthy();

    // I1 (revisor, plan 2026-08-13-seguimientos.md): el paso 1 SÍ terminó bien (Woo ya tiene
    // el tracking guardado y el mail nativo ya salió) aunque el paso 2 haya fallado —
    // cargados_hoy tiene que contarlo, no solo el camino de éxito completo.
    const evCargado = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_cargado'").get();
    expect(evCargado).toBeTruthy();
  });

  it('I2 (revisor): llena numero_pedido/comprador/localidad desde el GET a Woo, aunque no exista fila local previa (caso central: "sin_preparacion")', async () => {
    wooFetch
      .mockResolvedValueOnce({
        data: {
          id: 950, number: 'FB-9950', status: 'lpaandreani', meta_data: [],
          billing: { first_name: 'Caro', last_name: 'Lopez', city: 'CABA' },
          shipping: { city: 'Cordoba' },
        },
      })
      .mockResolvedValueOnce({ data: { id: 950, status: 'completed' } })
      .mockResolvedValueOnce({ data: { id: 950, status: 'enviadoandreani' } });

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/950').send({ tracking: 'AND950' });
    expect(res.status).toBe(200);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:950'").get();
    // número real de Woo (numeración custom vía order.number), NUNCA el wc_order_id crudo —
    // ese id no es lo que el operario va a buscar en Woo.
    expect(prep.numero_pedido).toBe('FB-9950');
    expect(prep.comprador).toBe('Caro Lopez');
    // localidad de envío, con fallback a la de facturación (mismo criterio que normalizarEnvio).
    expect(prep.localidad).toBe('Cordoba');
  });

  it('crea el meta sin id cuando el pedido no tenía tracking previo', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: { id: 901, status: 'lpaandreani', meta_data: [] } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} });

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/901').send({ tracking: 'XYZ' });
    expect(res.status).toBe(200);
    expect(wooFetch.mock.calls[1][3]).toEqual({
      status: 'completed',
      meta_data: [{ key: '_andreani_tracking', value: 'XYZ' }],
    });
  });

  it('reintento: pedido ya en completed con el mismo tracking → solo hace el PUT2 (no reenvía el mail)', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: { id: 902, status: 'completed', meta_data: [{ id: 71, key: '_andreani_tracking', value: 'AND999' }] } }) // GET actual
      .mockResolvedValueOnce({ data: { id: 902, status: 'enviadoandreani' } }); // PUT paso 2 (único)

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/902').send({ tracking: 'AND999' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Solo GET + un único PUT: nunca se vuelve a mandar status:'completed'
    expect(wooFetch).toHaveBeenCalledTimes(2);
    const puts = wooFetch.mock.calls.filter(c => c[2] === 'put');
    expect(puts).toHaveLength(1);
    expect(puts[0][3]).toEqual({ status: 'enviadoandreani' });
    expect(puts.some(c => c[3]?.status === 'completed')).toBe(false);

    // Sin ítems ni fotos de paquete puestas: igual que en el resto de estos tests, sin
    // verificación real el estado local queda 'despachada_sin_verificar', no 'completada'.
    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:902'").get();
    expect(prep.estado).toBe('despachada_sin_verificar');
  });

  it('fail-closed: pedido en otro estado (ni lpaandreani ni completed-con-tracking) → 409 sin ningún PUT', async () => {
    wooFetch.mockResolvedValueOnce({ data: { id: 903, status: 'processing', meta_data: [] } }); // GET actual

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/903').send({ tracking: 'NOPE' });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);

    // Solo el GET; jamás se llama a wooFetch con método PUT
    expect(wooFetch).toHaveBeenCalledTimes(1);
    expect(wooFetch.mock.calls.some(c => c[2] === 'put')).toBe(false);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:903'").get();
    expect(prep).toBeUndefined();
  });

  it('fail-closed: completed con un tracking guardado DISTINTO al recibido → 409 sin ningún PUT', async () => {
    // El pedido ya está confirmado con AND999; llega uno distinto (AND111).
    // No se debe pisar: dispararía el PUT1 (status:completed) y reenviaría el mail.
    wooFetch.mockResolvedValueOnce({ data: { id: 905, status: 'completed', meta_data: [{ id: 90, key: '_andreani_tracking', value: 'AND999' }] } }); // GET actual

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/905').send({ tracking: 'AND111' });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);

    // Solo el GET; jamás se escribe nada
    expect(wooFetch).toHaveBeenCalledTimes(1);
    expect(wooFetch.mock.calls.some(c => c[2] === 'put')).toBe(false);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:905'").get();
    expect(prep).toBeUndefined();
  });

  it('wcOrderId=0 → 400 sin tocar Woo', async () => {
    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/0').send({ tracking: 'AND123' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('tracking vacío (o solo espacios) → 400 sin tocar Woo', async () => {
    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/900').send({ tracking: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('si falla el GET a Woo, responde 500 sin crear la preparación', async () => {
    wooFetch.mockRejectedValueOnce(new Error('woo caído'));
    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/906').send({ tracking: 'AND123' });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:906'").get();
    expect(prep).toBeUndefined();
  });
});

describe('reintentarColgadosTracking', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  // Inserta las dos fotos generales del paquete (item_id NULL) — desde que /completar y el
  // criterio de "verificada" las exigen, un test que quiere ver 'completada' tiene que
  // dejarlas puestas, si no la preparación (aunque no tenga ítems) queda "sin verificar".
  function insertarFotosPaquete(prepId) {
    const iso = new Date().toISOString();
    const ins = db.prepare('INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, creado_en) VALUES (?,NULL,?,?,?)');
    ins.run(prepId, 'paquete_abierto', '/uploads/a.jpg', iso);
    ins.run(prepId, 'paquete_cerrado', '/uploads/c.jpg', iso);
  }

  it('reintenta el PUT 2 de cada colgado; si tiene éxito, limpia la bandera y, si estaba verificada, marca completada', async () => {
    buildTestApp(db); // ensureTables
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:920',920,1,'en_preparacion',?,1)`).run(now);
    insertarFotosPaquete(ins.lastInsertRowid); // sin ítems + las dos fotos de paquete = verificada

    wooFetch.mockResolvedValueOnce({ data: { id: 920, status: 'enviadoandreani' } });

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(1);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:920'").get();
    expect(prep.estado).toBe('completada');
    expect(prep.woo_paso2_pendiente).toBe(0);

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_recuperado'").get();
    expect(ev).toBeTruthy();
  });

  it('si el paso 2 se recupera pero la preparación NO estaba verificada (sin las fotos de paquete), queda despachada_sin_verificar, no completada (MUTATION: bloqueante crítico del revisor)', async () => {
    buildTestApp(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:922',922,1,'en_preparacion',?,1)`).run(now);
    // Sin fotos de paquete puestas: el camino real de "etiqueta lista -> nunca se abre ->
    // se carga el tracking" que describió el revisor.

    wooFetch.mockResolvedValueOnce({ data: { id: 922, status: 'enviadoandreani' } });

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(1);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:922'").get();
    expect(prep.estado).toBe('despachada_sin_verificar');
    expect(prep.woo_paso2_pendiente).toBe(0);

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='despachado_sin_verificar'").get();
    expect(ev).toBeTruthy();
  });

  it('NUNCA pisa una cerrada_sin_evidencia con completada, aunque se recupere el paso 2 (MUTATION: bloqueante crítico del revisor)', async () => {
    buildTestApp(db);
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:923',923,1,'cerrada_sin_evidencia',?,1)`).run(now);
    insertarFotosPaquete(ins.lastInsertRowid); // aunque "estaría verificada", el estado manda

    wooFetch.mockResolvedValueOnce({ data: { id: 923, status: 'enviadoandreani' } });

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(1); // el paso 2 de Woo sí se resolvió...

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:923'").get();
    expect(prep.estado).toBe('cerrada_sin_evidencia'); // ...pero el estado local no se lava
    expect(prep.woo_paso2_pendiente).toBe(0); // esto sí se limpia (flag del lado Woo, no de verificación)
  });

  it('si vuelve a fallar, deja la bandera puesta para la corrida siguiente (fail-open, no lanza)', async () => {
    buildTestApp(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:921',921,1,'en_preparacion',?,1)`).run(now);

    wooFetch.mockRejectedValueOnce(new Error('sigue caído'));

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(0);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:921'").get();
    expect(prep.woo_paso2_pendiente).toBe(1);
    expect(prep.estado).not.toBe('completada');
  });

  it('sin colgados pendientes, no llama a wooFetch y devuelve 0', async () => {
    buildTestApp(db);
    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(0);
    expect(wooFetch).not.toHaveBeenCalled();
  });

  it('I3 (revisor): si Woo devuelve 404/410 (pedido borrado o en papelera), limpia la bandera y registra tracking_abandonado en vez de reintentar para siempre', async () => {
    buildTestApp(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:924',924,1,'en_preparacion',?,1)`).run(now);

    wooFetch.mockRejectedValueOnce(new Error('WooCommerce API error 404'));

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(0); // no se "resolvió" en el sentido de completar el paso 2

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:924'").get();
    expect(prep.woo_paso2_pendiente).toBe(0); // pero deja de ser ruido permanente
    expect(prep.estado).not.toBe('completada');

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_abandonado'").get();
    expect(ev).toBeTruthy();
  });

  it('I3: otros errores (5xx, red) siguen fail-closed — no tocan la bandera', async () => {
    buildTestApp(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:925',925,1,'en_preparacion',?,1)`).run(now);

    wooFetch.mockRejectedValueOnce(new Error('WooCommerce API error 500'));

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(0);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:925'").get();
    expect(prep.woo_paso2_pendiente).toBe(1);

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_abandonado'").get();
    expect(ev).toBeFalsy();
  });
});
