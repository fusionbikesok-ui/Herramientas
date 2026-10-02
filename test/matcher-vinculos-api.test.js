import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { matcherRouter } from '../routes/matcher.js';
import { autoVincularPorSellerSku } from '../lib/mlMapeo.js';

const TEST_DB = './test/tmp-matcher-vinculos-api.sqlite';
const CFG = { ml: {}, woo: {} };

function ahora() { return new Date().toISOString(); }

function seedCatalogo(db, { id = 1, sku, nombre, stock = 5, precio = 1000, img = 'woo.jpg' }) {
  db.prepare(`INSERT INTO catalogo_cache
    (id_woo, sku, nombre, stock, precio, regular_price, img, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, sku, nombre, stock, precio, precio, img, ahora());
}

function seedPublicacion(db, {
  clave, itemId = clave.split('|')[0], variationId = '', titulo = 'Publicación',
  sellerSku = '', status = 'active', stock = 3, color = '', talle = '',
  variationsTexto = '', thumbnail = 'ml.jpg', permalink = 'https://ml.test/item',
  precio = 1200,
}) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle,
     seller_sku, variations_texto, thumbnail, permalink, precio, available_quantity,
     actualizado_en, precio_actualizado_en)
    VALUES (?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(clave, itemId, variationId, titulo, status, color, talle, sellerSku,
      variationsTexto, thumbnail, permalink, precio, stock, ahora(), ahora());
}

function seedDecision(db, { clave, sku = null, accion = 'asignar', confirmadoPor = null }) {
  db.prepare(`INSERT INTO sku_matcher_decisiones
    (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
    VALUES (?, ?, ?, ?, 'test', ?, ?)`)
    .run(clave, sku, sku ? `Producto ${sku}` : null, accion, confirmadoPor, ahora());
}

describe('API de vínculos del Matcher', () => {
  let db;
  let app;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'ana' }; next(); });
    app.use('/api/matcher', matcherRouter(db, CFG));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('rechaza no sincronizar sin usuario, con clave inválida o con clave inexistente', async () => {
    seedPublicacion(db, { clave: 'MLA-VALIDA|' });

    const sinUsuario = express();
    sinUsuario.use(express.json());
    sinUsuario.use('/api/matcher', matcherRouter(db, CFG));
    expect((await request(sinUsuario).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 'MLA-VALIDA|' })).status).toBe(401);
    expect((await request(app).post('/api/matcher/vinculos/no-sincronizar').send({})).status).toBe(400);
    expect((await request(app).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 42 })).status).toBe(400);
    expect((await request(app).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 'NO-EXISTE|' })).status).toBe(404);
  });

  it('persiste omitir, pisa una decisión previa, limpia revisiones y audita de forma idempotente', async () => {
    seedCatalogo(db, { sku: 'FB-1', nombre: 'Casco Giro' });
    seedPublicacion(db, { clave: 'MLA-1|10', sellerSku: 'FB-1' });
    seedDecision(db, { clave: 'MLA-1|10', sku: 'FB-1', accion: 'confirmar', confirmadoPor: 'otra' });
    db.prepare(`INSERT INTO ml_vinculos_revisados
      (clave, senal, valor_revisado, revisado_por, revisado_en)
      VALUES ('MLA-1|10', 'precio', 'viejo', 'otra', ?)`).run(ahora());

    const primera = await request(app).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 'MLA-1|10', expected_sku: 'FB-1' });
    const segunda = await request(app).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 'MLA-1|10', expected_sku: null });

    expect(primera.status).toBe(200);
    expect(primera.body).toMatchObject({ ok: true, clave: 'MLA-1|10', sku_anterior: 'FB-1', accion: 'omitir' });
    expect(segunda.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave=?').get('MLA-1|10').n).toBe(1);
    expect(db.prepare('SELECT * FROM sku_matcher_decisiones WHERE clave=?').get('MLA-1|10')).toMatchObject({
      sku: null, wc_nombre: null, accion: 'omitir', origen: 'matcher_no_sincronizar', confirmado_por: 'ana',
    });
    expect(db.prepare('SELECT COUNT(*) n FROM ml_vinculos_revisados WHERE clave=?').get('MLA-1|10').n).toBe(0);
    expect(db.prepare(`SELECT * FROM sync_log WHERE clave='MLA-1|10' ORDER BY id ASC LIMIT 1`).get()).toMatchObject({
      direccion: 'wc_ml', sku: 'FB-1', estado: 'no_sincronizar', error: 'no sincronizar por ana',
    });

    autoVincularPorSellerSku(db);
    expect(db.prepare('SELECT accion FROM sku_matcher_decisiones WHERE clave=?').get('MLA-1|10').accion).toBe('omitir');
  });

  it('exige expected_sku para un vínculo activo y null explícito para una clave sin vínculo', async () => {
    seedPublicacion(db, { clave: 'MLA-EXPECT|', sellerSku: 'FB-1' });
    seedDecision(db, { clave: 'MLA-EXPECT|', sku: 'FB-1', accion: 'confirmar' });
    expect((await request(app).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 'MLA-EXPECT|' })).status).toBe(400);

    seedPublicacion(db, { clave: 'MLA-SIN-VINCULO|' });
    expect((await request(app).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 'MLA-SIN-VINCULO|' })).status).toBe(400);
    expect((await request(app).post('/api/matcher/vinculos/no-sincronizar').send({ clave: 'MLA-SIN-VINCULO|', expected_sku: null })).status).toBe(200);
  });

  it('rechaza no sincronizar desde una vista vieja si cambió el SKU vinculado', async () => {
    seedCatalogo(db, { sku: 'FB-1', nombre: 'Casco Giro' });
    seedPublicacion(db, { clave: 'MLA-VIEJA|' });
    seedDecision(db, { clave: 'MLA-VIEJA|', sku: 'FB-1', accion: 'confirmar' });
    const res = await request(app).post('/api/matcher/vinculos/no-sincronizar')
      .send({ clave: 'MLA-VIEJA|', expected_sku: 'FB-OTRO' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'vista_vieja', sku_actual: 'FB-1' });
  });

  it('busca por SKU, nombre Woo, código MLA y título ML', async () => {
    seedCatalogo(db, { sku: 'FB-CASCO', nombre: 'Casco Giro Urbano' });
    seedPublicacion(db, { clave: 'MLA123456|', itemId: 'MLA123456', titulo: 'Casco Giro Urbano Negro', sellerSku: 'FB-CASCO' });
    seedDecision(db, { clave: 'MLA123456|', sku: 'FB-CASCO', accion: 'confirmar', confirmadoPor: 'ana' });

    for (const [query, campo] of [['FB-CASCO', 'sku'], ['giro urbano', 'nombre_woo'], ['123456', 'mla'], ['urbano negro', 'titulo_ml']]) {
      const res = await request(app).get('/api/matcher/productos/buscar').query({ q: query });
      expect(res.status).toBe(200);
      expect(res.body.data[0].sku).toBe('FB-CASCO');
      expect(res.body.data[0].coincidio_por).toContain(campo);
    }
  });

  it('busca nombres Woo con tildes y trae sus publicaciones vinculadas', async () => {
    seedCatalogo(db, { sku: 'FB-CAMARA', nombre: 'Cámara de aire 29' });
    seedPublicacion(db, { clave: 'MLA-CAMARA|', titulo: 'Cámara 29', sellerSku: 'FB-CAMARA' });
    seedDecision(db, { clave: 'MLA-CAMARA|', sku: 'FB-CAMARA', accion: 'confirmar' });
    const res = await request(app).get('/api/matcher/productos/buscar').query({ q: 'camara' });
    expect(res.status).toBe(200);
    expect(res.body.data[0].publicaciones.map(p => p.clave)).toEqual(['MLA-CAMARA|']);
  });

  it('devuelve publicaciones omitidas y sin vínculo con su estado y forma completa', async () => {
    seedCatalogo(db, { sku: 'FB-CASCO', nombre: 'Producto distinto' });
    seedPublicacion(db, { clave: 'MLA-OMITIDO|', titulo: 'Casco Giro', sellerSku: 'FB-CASCO' });
    seedDecision(db, { clave: 'MLA-OMITIDO|', accion: 'omitir', confirmadoPor: 'ana' });
    seedPublicacion(db, { clave: 'MLA-HUERFANA|', titulo: 'Casco Giro accesorio' });

    const res = await request(app).get('/api/matcher/productos/buscar').query({ q: 'casco giro' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.sin_producto_woo).toHaveLength(2);
    expect(res.body.sin_producto_woo.find(p => p.clave === 'MLA-OMITIDO|').vinculo).toMatchObject({
      estado: 'no_sincroniza', sku_vinculado: null, accion: 'omitir', confirmado_por: 'ana',
    });
    expect(res.body.sin_producto_woo.find(p => p.clave === 'MLA-HUERFANA|').vinculo.estado).toBe('sin_vinculo');
  });

  it('agrupa todas las publicaciones vinculadas al SKU y respeta el límite global', async () => {
    seedCatalogo(db, { sku: 'FB-UNO', nombre: 'Producto Uno' });
    seedCatalogo(db, { id: 2, sku: 'FB-DOS', nombre: 'Producto Dos' });
    seedPublicacion(db, { clave: 'MLA-UNO-A|', titulo: 'Producto Uno buscado', sellerSku: 'FB-UNO' });
    seedPublicacion(db, { clave: 'MLA-UNO-B|', titulo: 'Otro título', sellerSku: 'FB-UNO' });
    seedDecision(db, { clave: 'MLA-UNO-A|', sku: 'FB-UNO', accion: 'asignar' });
    seedDecision(db, { clave: 'MLA-UNO-B|', sku: 'FB-UNO', accion: 'confirmar' });
    seedPublicacion(db, { clave: 'MLA-DOS|', titulo: 'Producto Dos buscado', sellerSku: 'FB-DOS' });
    seedDecision(db, { clave: 'MLA-DOS|', sku: 'FB-DOS', accion: 'asignar' });
    seedPublicacion(db, { clave: 'MLA-HUERFANA-2|', titulo: 'Producto buscado sin Woo' });

    const agrupado = await request(app).get('/api/matcher/productos/buscar').query({ q: 'producto buscado' });
    expect(agrupado.status).toBe(200);
    expect(agrupado.body.data.find(p => p.sku === 'FB-UNO').publicaciones).toHaveLength(2);
    expect(agrupado.body.sin_producto_woo).toHaveLength(1);

    const limitado = await request(app).get('/api/matcher/productos/buscar').query({ q: 'producto', limite: 1 });
    expect(limitado.status).toBe(200);
    expect(limitado.body.data.length + limitado.body.sin_producto_woo.length).toBe(1);
  });

  it('exige al menos dos caracteres y limita el parámetro entre 1 y 50', async () => {
    expect((await request(app).get('/api/matcher/productos/buscar').query({ q: 'a' })).status).toBe(400);
    expect((await request(app).get('/api/matcher/productos/buscar').query({ q: 'ab', limite: 0 })).status).toBe(400);
    expect((await request(app).get('/api/matcher/productos/buscar').query({ q: 'ab', limite: 51 })).status).toBe(400);
    expect((await request(app).get('/api/matcher/productos/buscar').query({ q: '--' })).status).toBe(400);
  });

  it('no devuelve el catálogo entero cuando la búsqueda sólo tiene comodines', async () => {
    seedCatalogo(db, { sku: 'FB-UNO', nombre: 'Producto Uno' });
    seedCatalogo(db, { id: 2, sku: 'FB-DOS', nombre: 'Producto Dos' });
    const res = await request(app).get('/api/matcher/productos/buscar').query({ q: '%%' });
    expect(res.status).toBe(400);
  });
});
