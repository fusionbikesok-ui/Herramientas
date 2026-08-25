import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { ensureVentasHistorialTables, backfillVentas, calcularCriticidad } from '../lib/criticidad.js';
import { criticidadRouter } from '../routes/criticidad.js';

vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
import { wooFetch } from '../routes/woo.js';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = './test/tmp-criticidad.sqlite';
const now = () => new Date().toISOString();
const CFG = {
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
  ml: { userId: '99999', clientId: 'cid', clientSecret: 'cs' },
};

function buildApp(db, usuario = 'jose', isAdmin = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: isAdmin ? 1 : 0 }; next(); });
  app.use('/api/criticidad', criticidadRouter(db, CFG));
  return app;
}

function insertProducto(db, extra) {
  const base = {
    id_woo: 1, nombre: 'Producto', sku: 'FB-1', tipo: 'simple', id_padre: null,
    stock: 5, categorias_json: null, img: null, precio: 1000, atributos_json: null,
    marca: null, gtin: null, actualizado_en: now(),
  };
  const row = { ...base, ...extra };
  db.prepare(`
    INSERT INTO catalogo_cache
      (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, marca, gtin, actualizado_en)
    VALUES
      (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @marca, @gtin, @actualizado_en)
  `).run(row);
}

afterEach(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  // resetAllMocks (no clearAllMocks): también vacía la cola de mockResolvedValueOnce sin
  // consumir del todo (ej. un test que arma 2 páginas pero el backfill corta en la 1ra
  // porque vino corta) — si no, esa 2da respuesta quedaba en cola y se filtraba al
  // siguiente test, pisando su propio mock.
  vi.resetAllMocks();
});

describe('ensureVentasHistorialTables', () => {
  it('es idempotente', () => {
    const db = openDb(TEST_DB);
    expect(() => { ensureVentasHistorialTables(db); ensureVentasHistorialTables(db); }).not.toThrow();
  });
});

describe('backfillVentas — WooCommerce', () => {
  it('inserta ventas de line_items con sku, ignora los que no tienen', async () => {
    const db = openDb(TEST_DB);
    mlFetch.mockResolvedValue({ status: 200, data: { results: [] } });
    wooFetch.mockResolvedValueOnce({
      headers: { 'x-wp-totalpages': '1' },
      data: [{
        id: 100, date_created: '2026-08-01T00:00:00',
        line_items: [
          { sku: 'FB-1', quantity: 2, price: 500, total: '1000' },
          { sku: '', quantity: 1, price: 300, total: '300' }, // sin sku: se omite
        ],
      }],
    });
    const r = await backfillVentas(db, CFG);
    expect(r.woo.ordenes).toBe(1);
    expect(r.woo.insertados).toBe(1);
    const rows = db.prepare('SELECT * FROM ventas_historial WHERE canal=?').all('woo');
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('FB-1');
    expect(rows[0].cantidad).toBe(2);
  });

  it('no duplica si se corre dos veces con la misma orden (dedup por canal+orden+sku)', async () => {
    const db = openDb(TEST_DB);
    mlFetch.mockResolvedValue({ status: 200, data: { results: [] } });
    const pagina = {
      headers: { 'x-wp-totalpages': '1' },
      data: [{ id: 100, date_created: '2026-08-01T00:00:00', line_items: [{ sku: 'FB-1', quantity: 2, price: 500, total: '1000' }] }],
    };
    wooFetch.mockResolvedValueOnce(pagina);
    await backfillVentas(db, CFG);
    wooFetch.mockResolvedValueOnce(pagina);
    const r2 = await backfillVentas(db, CFG);
    expect(r2.woo.insertados).toBe(0);
    const rows = db.prepare('SELECT * FROM ventas_historial WHERE canal=?').all('woo');
    expect(rows).toHaveLength(1);
  });

  it('sigue paginando hasta agotar x-wp-totalpages', async () => {
    const db = openDb(TEST_DB);
    mlFetch.mockResolvedValue({ status: 200, data: { results: [] } });
    wooFetch
      .mockResolvedValueOnce({
        headers: { 'x-wp-totalpages': '2' },
        data: [{ id: 1, date_created: '2026-08-01T00:00:00', line_items: [{ sku: 'FB-1', quantity: 1, price: 100, total: '100' }] }],
      })
      .mockResolvedValueOnce({
        headers: { 'x-wp-totalpages': '2' },
        data: [{ id: 2, date_created: '2026-08-02T00:00:00', line_items: [{ sku: 'FB-2', quantity: 1, price: 100, total: '100' }] }],
      });
    const r = await backfillVentas(db, CFG);
    expect(r.woo.ordenes).toBe(2);
    expect(wooFetch).toHaveBeenCalledTimes(2);
  });

  it('un error de Woo no bloquea el backfill de ML (fail-open entre canales)', async () => {
    const db = openDb(TEST_DB);
    wooFetch.mockRejectedValue(new Error('WooCommerce API error 500'));
    mlFetch.mockResolvedValue({ status: 200, data: { results: [] } });
    const r = await backfillVentas(db, CFG);
    expect(r.woo.error).toContain('500');
    expect(r.ml.ordenes).toBe(0);
  });
});

describe('backfillVentas — MercadoLibre', () => {
  it('usa seller_sku como fallback cuando no hay vínculo confirmado', async () => {
    const db = openDb(TEST_DB);
    wooFetch.mockResolvedValue({ headers: { 'x-wp-totalpages': '1' }, data: [] });
    mlFetch
      .mockResolvedValueOnce({
        status: 200,
        data: {
          results: [{
            id: 555, date_created: '2026-08-01T00:00:00',
            order_items: [{ item: { id: '111', seller_sku: 'FB-9' }, quantity: 3, unit_price: 200 }],
          }],
        },
      })
      .mockResolvedValueOnce({ status: 200, data: { results: [] } });
    const r = await backfillVentas(db, CFG);
    expect(r.ml.ordenes).toBe(1);
    expect(r.ml.insertados).toBe(1);
    const rows = db.prepare('SELECT * FROM ventas_historial WHERE canal=?').all('ml');
    expect(rows[0].sku).toBe('FB-9');
    expect(rows[0].cantidad).toBe(3);
  });

  it('un item sin vínculo ni seller_sku no se cuenta, pero no rompe el resto de la orden', async () => {
    const db = openDb(TEST_DB);
    wooFetch.mockResolvedValue({ headers: { 'x-wp-totalpages': '1' }, data: [] });
    mlFetch
      .mockResolvedValueOnce({
        status: 200,
        data: {
          results: [{
            id: 556, date_created: '2026-08-01T00:00:00',
            order_items: [
              { item: { id: '222', seller_sku: '' }, quantity: 1, unit_price: 100 },
              { item: { id: '333', seller_sku: 'FB-3' }, quantity: 2, unit_price: 100 },
            ],
          }],
        },
      })
      .mockResolvedValueOnce({ status: 200, data: { results: [] } });
    const r = await backfillVentas(db, CFG);
    expect(r.ml.insertados).toBe(1);
    const rows = db.prepare('SELECT * FROM ventas_historial WHERE canal=?').all('ml');
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe('FB-3');
  });

  it('un status distinto de 200 corta esa corrida sin lanzar', async () => {
    const db = openDb(TEST_DB);
    wooFetch.mockResolvedValue({ headers: { 'x-wp-totalpages': '1' }, data: [] });
    mlFetch.mockResolvedValueOnce({ status: 429, data: null });
    const r = await backfillVentas(db, CFG);
    expect(r.ml.ordenes).toBe(0);
  });
});

describe('calcularCriticidad', () => {
  it('pondera ventas 40%, diferencias 30%, categoría crítica 20%, valor de stock 10%', () => {
    const db = openDb(TEST_DB);
    ensureVentasHistorialTables(db);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', stock: 10, precio: 100, categorias_json: '["CASCOS"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', stock: 1, precio: 10, categorias_json: '["PEDALES"]' });
    db.prepare('INSERT INTO ventas_historial (canal, orden_id, sku, cantidad, precio_unitario, fecha, creado_en) VALUES (?,?,?,?,?,?,?)')
      .run('woo', '1', 'FB-1', 20, 100, now(), now());
    db.prepare(`INSERT INTO categorias_criticas (categoria, marcado_por, marcado_en) VALUES ('CASCOS','jose',?)`).run(now());

    const filas = calcularCriticidad(db);
    const fb1 = filas.find(f => f.sku === 'FB-1');
    const fb2 = filas.find(f => f.sku === 'FB-2');
    // FB-1: ventas 20/20=1×0.4=0.4, diferencias 0/1=0×0.3=0, categoría crítica 1×0.2=0.2,
    // valor stock 1000/1000=1×0.1=0.1 → 0.7. FB-2: todo 0 salvo valor stock 10/1000=0.01×0.1=0.001.
    expect(fb1.score).toBeCloseTo(0.7, 5);
    expect(fb2.score).toBeCloseTo(0.001, 5);
    expect(fb1.categoria_critica).toBe(true);
    expect(fb2.categoria_critica).toBe(false);
    expect(filas[0].sku).toBe('FB-1'); // ordenado de mayor a menor score
  });

  it('sin ninguna venta/diferencia/categoría marcada, no explota (división por cero evitada)', () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', stock: 0, precio: null });
    expect(() => calcularCriticidad(db)).not.toThrow();
    const filas = calcularCriticidad(db);
    expect(filas[0].score).toBe(0);
  });
});

describe('router /api/criticidad', () => {
  it('GET /top devuelve la lista ordenada, respetando limit', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2' });
    const res = await request(buildApp(db)).get('/api/criticidad/top?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.criticidad).toHaveLength(1);
  });

  it('POST/DELETE categorias-criticas exige admin', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db, 'operario', false);
    const post = await request(app).post('/api/criticidad/categorias-criticas').send({ categoria: 'CASCOS' });
    expect(post.status).toBe(403);
  });

  it('marca y desmarca una categoría crítica (admin)', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    await request(app).post('/api/criticidad/categorias-criticas').send({ categoria: 'CASCOS' });
    const lista = await request(app).get('/api/criticidad/categorias-criticas');
    expect(lista.body.categorias.map(c => c.categoria)).toEqual(['CASCOS']);

    const borrar = await request(app).delete('/api/criticidad/categorias-criticas/CASCOS');
    expect(borrar.status).toBe(200);
    const lista2 = await request(app).get('/api/criticidad/categorias-criticas');
    expect(lista2.body.categorias).toHaveLength(0);
  });

  it('POST /backfill exige admin y devuelve el resultado real del backfill', async () => {
    const db = openDb(TEST_DB);
    wooFetch.mockResolvedValue({ headers: { 'x-wp-totalpages': '1' }, data: [] });
    mlFetch.mockResolvedValue({ status: 200, data: { results: [] } });
    const res = await request(buildApp(db)).post('/api/criticidad/backfill');
    expect(res.status).toBe(200);
    expect(res.body.resultado.woo.ordenes).toBe(0);
  });
});
