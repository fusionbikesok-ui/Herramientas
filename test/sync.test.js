import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { skuDesdeMl, publicacionesDesdeWc, descartarVariacionMuerta } from '../lib/mlMapeo.js';
import { getAccessToken, bootstrapToken } from '../lib/mlClient.js';
import { getReactivablesRows, reactivarItems, syncRouter } from '../routes/sync.js';
import { mapConLimite } from '../lib/concurrencia.js';
import express from 'express';
import request from 'supertest';

// Mock axios para evitar llamadas reales a ML
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';

const TEST_DB = './test/tmp-sync.sqlite';

function seedMatcher(db) {
  const stmt = db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  // simple publicacion (sin variacion)
  stmt.run('MLA100|', 'BIKE-001', 'Bicicleta Rodado 26', 'confirmar', now);
  // publicacion con variacion
  stmt.run('MLA200|987654321', 'CASCO-L', 'Casco Talla L', 'asignar', now);
  // publicacion omitida (no debe sincronizarse)
  stmt.run('MLA300|', 'OMIT-001', 'Algo omitido', 'omitir', now);
  // mismo SKU en dos publicaciones ML
  stmt.run('MLA400|111', 'BIKE-001', 'Bicicleta var rojo', 'asignar', now);
  // variation_id con ".0" (formato float que puede venir de ML)
  stmt.run('MLA500|987654321', 'GUANTE-M', 'Guante M', 'confirmar', now);
}

describe('mlMapeo', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('skuDesdeMl', () => {
    it('devuelve SKU para publicacion simple (variation_id vacío)', () => {
      expect(skuDesdeMl(db, 'MLA100', '')).toBe('BIKE-001');
    });

    it('devuelve SKU para publicacion con variation_id', () => {
      expect(skuDesdeMl(db, 'MLA200', '987654321')).toBe('CASCO-L');
    });

    it('normaliza variation_id con sufijo .0', () => {
      // ML a veces envía variation_id como float "987654321.0"
      expect(skuDesdeMl(db, 'MLA500', '987654321.0')).toBe('GUANTE-M');
    });

    it('devuelve null si la accion es omitir', () => {
      expect(skuDesdeMl(db, 'MLA300', '')).toBeNull();
    });

    it('devuelve null si la clave no existe', () => {
      expect(skuDesdeMl(db, 'MLA999', '')).toBeNull();
    });

    it('devuelve null si variation_id no coincide', () => {
      expect(skuDesdeMl(db, 'MLA200', '000000')).toBeNull();
    });
  });

  describe('publicacionesDesdeWc', () => {
    it('devuelve todas las publicaciones ML para un SKU', () => {
      const pubs = publicacionesDesdeWc(db, 'BIKE-001');
      expect(pubs).toHaveLength(2);
      const claves = pubs.map(p => p.clave).sort();
      expect(claves).toEqual(['MLA100|', 'MLA400|111']);
    });

    it('devuelve los campos itemId y variationId correctamente', () => {
      const pubs = publicacionesDesdeWc(db, 'CASCO-L');
      expect(pubs).toHaveLength(1);
      expect(pubs[0].itemId).toBe('MLA200');
      expect(pubs[0].variationId).toBe('987654321');
    });

    it('devuelve array vacío para SKU sin mapeo activo', () => {
      expect(publicacionesDesdeWc(db, 'OMIT-001')).toHaveLength(0);
    });

    it('devuelve array vacío para SKU inexistente', () => {
      expect(publicacionesDesdeWc(db, 'NOEXISTE')).toHaveLength(0);
    });

    it('devuelve array vacío si SKU es string vacío', () => {
      expect(publicacionesDesdeWc(db, '')).toHaveLength(0);
    });
  });

  describe('descartarVariacionMuerta', () => {
    it('borra la decisión y descarta la clave', () => {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)')
        .run('MLA700|555', 'FB-9', 'Algo', 'asignar', now);

      descartarVariacionMuerta(db, 'MLA700|555', 'muerta');

      expect(db.prepare('SELECT 1 FROM sku_matcher_decisiones WHERE clave=?').get('MLA700|555')).toBeUndefined();
      const desc = db.prepare('SELECT clave, motivo FROM errores_descartados WHERE clave=?').get('MLA700|555');
      expect(desc).toMatchObject({ clave: 'MLA700|555', motivo: 'muerta' });
    });

    it('es idempotente y funciona sin decisión previa', () => {
      descartarVariacionMuerta(db, 'MLA701|9', 'a');
      descartarVariacionMuerta(db, 'MLA701|9', 'b');
      expect(db.prepare('SELECT COUNT(*) n FROM errores_descartados WHERE clave=?').get('MLA701|9').n).toBe(1);
      expect(db.prepare('SELECT motivo FROM errores_descartados WHERE clave=?').get('MLA701|9').motivo).toBe('b');
    });
  });
});

// ─── mlClient ────────────────────────────────────────────────────────────────

const ML_CFG = { clientId: 'client123', clientSecret: 'secret456', userId: '99999' };

function seedToken(db, { expiresInMs = 4 * 3600 * 1000 } = {}) {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1, 'tok-old', 'ref-old', ?, ?)
  `).run(expiresAt, now);
  return expiresAt;
}

describe('mlClient', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.resetAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('getAccessToken: devuelve token vigente sin hacer refresh', async () => {
    seedToken(db);
    const token = await getAccessToken(db, ML_CFG);
    expect(token).toBe('tok-old');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('getAccessToken: hace refresh si el token vence en < 60s', async () => {
    seedToken(db, { expiresInMs: 30 * 1000 }); // vence en 30s
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'tok-new', refresh_token: 'ref-new', expires_in: 21600 },
    });

    const token = await getAccessToken(db, ML_CFG);
    expect(token).toBe('tok-new');
    expect(axios.post).toHaveBeenCalledOnce();

    // verifica que el nuevo token quedó persistido en DB
    const row = db.prepare('SELECT access_token, refresh_token FROM ml_oauth_token WHERE id=1').get();
    expect(row.access_token).toBe('tok-new');
    expect(row.refresh_token).toBe('ref-new');
  });

  it('getAccessToken: lanza error si no hay token en DB', async () => {
    await expect(getAccessToken(db, ML_CFG)).rejects.toThrow('bootstrap');
  });

  it('getAccessToken: lanza error si no hay clientId', async () => {
    await expect(getAccessToken(db, {})).rejects.toThrow('ML_CLIENT_ID');
  });

  it('bootstrapToken: persiste tokens en DB y devuelve userId', async () => {
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { access_token: 'tok-boot', refresh_token: 'ref-boot', expires_in: 21600, user_id: 12345 },
    });

    const result = await bootstrapToken(db, ML_CFG, 'TT-CODE');
    expect(result.userId).toBe(12345);

    const row = db.prepare('SELECT access_token, refresh_token FROM ml_oauth_token WHERE id=1').get();
    expect(row.access_token).toBe('tok-boot');
    expect(row.refresh_token).toBe('ref-boot');
  });

  it('bootstrapToken: lanza error si ML responde con error', async () => {
    axios.post.mockResolvedValueOnce({
      status: 400,
      data: { message: 'invalid_code' },
    });
    await expect(bootstrapToken(db, ML_CFG, 'BAD-CODE')).rejects.toThrow('Bootstrap ML falló');
  });
});

// ─── reactivación de pausadas por falta de stock ────────────────────────────────

const ahora = () => new Date().toISOString();

function seedCatalogo(db, sku, stock, { tipo = 'variation', idWoo = 1, idPadre = 10 } = {}) {
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?,?,?,?,?,?,?)'
  ).run(idWoo, 'Prod ' + sku, sku, tipo, idPadre, stock, ahora());
}

function seedDecision(db, clave, sku, accion = 'confirmar') {
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?,?,?,?,?)'
  ).run(clave, sku, 'WC ' + sku, accion, ahora());
}

function seedPublicacion(db, { clave, itemId, varId = '', status, subStatus = '', titulo = 'Pub' }) {
  db.prepare(`
    INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(clave, itemId, varId, titulo, status, subStatus, varId ? 1 : 0, '', '', '', '', ahora());
}

describe('reactivación de pausadas por falta de stock', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.resetAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('getReactivablesRows: incluye pausada out_of_stock con stock web', () => {
    seedCatalogo(db, 'FB-1', 5);
    seedDecision(db, 'MLA1|v1', 'FB-1');
    seedPublicacion(db, { clave: 'MLA1|v1', itemId: 'MLA1', varId: 'v1', status: 'paused', subStatus: 'out_of_stock' });
    const rows = getReactivablesRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].item_id).toBe('MLA1');
    expect(rows[0].stock_disponible_ml).toBe(5);
  });

  it('getReactivablesRows: excluye pausada manual (sin out_of_stock)', () => {
    seedCatalogo(db, 'FB-2', 5);
    seedDecision(db, 'MLA2|v1', 'FB-2');
    seedPublicacion(db, { clave: 'MLA2|v1', itemId: 'MLA2', varId: 'v1', status: 'paused', subStatus: '' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: excluye out_of_stock que además es paused_by_seller (pausa manual)', () => {
    seedCatalogo(db, 'FB-2b', 5);
    seedDecision(db, 'MLA2b|v1', 'FB-2b');
    seedPublicacion(db, { clave: 'MLA2b|v1', itemId: 'MLA2b', varId: 'v1', status: 'paused', subStatus: 'out_of_stock,paused_by_seller' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: excluye out_of_stock sin stock web', () => {
    seedCatalogo(db, 'FB-3', 0);
    seedDecision(db, 'MLA3|v1', 'FB-3');
    seedPublicacion(db, { clave: 'MLA3|v1', itemId: 'MLA3', varId: 'v1', status: 'paused', subStatus: 'out_of_stock' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: excluye publicación activa', () => {
    seedCatalogo(db, 'FB-4', 5);
    seedDecision(db, 'MLA4|v1', 'FB-4');
    seedPublicacion(db, { clave: 'MLA4|v1', itemId: 'MLA4', varId: 'v1', status: 'active', subStatus: '' });
    expect(getReactivablesRows(db)).toHaveLength(0);
  });

  it('getReactivablesRows: respeta reserva de skus_config_ml', () => {
    seedCatalogo(db, 'FB-5', 3);
    seedDecision(db, 'MLA5|v1', 'FB-5');
    seedPublicacion(db, { clave: 'MLA5|v1', itemId: 'MLA5', varId: 'v1', status: 'paused', subStatus: 'out_of_stock' });
    db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('FB-5','x','reserva',2,?)").run(ahora());
    const rows = getReactivablesRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].stock_disponible_ml).toBe(1); // 3 - 2 reservadas
  });

  it('reactivarItems: empuja stock, activa en ML y persiste estado', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-9', 7);
    db.prepare("UPDATE catalogo_cache SET precio=1350, regular_price=1350 WHERE sku='FB-9'").run(); // lista 1350 → contado 900
    seedDecision(db, 'MLA9|v9', 'FB-9');
    seedPublicacion(db, { clave: 'MLA9|v9', itemId: 'MLA9', varId: 'v9', status: 'paused', subStatus: 'out_of_stock' });
    // GET item (precio 1000, sin envío gratis) + comisión 50 → neto 950 vs contado 900 (dentro de
    // tolerancia, no bloquea) + PUT stock -> 200 + PUT status active -> 200
    let getItemCount = 0;
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 50 }, headers: {} };
      if (method === 'get' && /\/items\/MLA9\?/.test(url)) {
        getItemCount++;
        return { status: 200, data: { id: 'MLA9', status: 'paused', sub_status: ['out_of_stock'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      }
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA9']);
    expect(r.procesados).toBe(1);
    expect(r.resultados[0].ok).toBe(true);
    // La revalidación de estado reusa el mismo GET del chequeo de neto en el path exitoso completo:
    // una sola consulta del item a ML aunque hubo push de stock + activación.
    expect(getItemCount).toBe(1);

    // status en cache pasó a active
    const pub = db.prepare('SELECT status, sub_status FROM ml_publicaciones_cache WHERE clave=?').get('MLA9|v9');
    expect(pub.status).toBe('active');
    // estado de stock persistido
    const est = db.prepare('SELECT cantidad_ml FROM ml_stock_estado WHERE clave=?').get('MLA9|v9');
    expect(est.cantidad_ml).toBe(7);
    // log 'reactivada'
    const log = db.prepare("SELECT COUNT(*) n FROM sync_log WHERE estado='reactivada' AND clave='MLA9|v9'").get();
    expect(log.n).toBe(1);
  });

  it('reactivarItems: si ML rechaza la activación, registra error y no marca activo', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-10', 4);
    db.prepare("UPDATE catalogo_cache SET precio=1350, regular_price=1350 WHERE sku='FB-10'").run(); // lista 1350 → contado 900
    seedDecision(db, 'MLA10|v10', 'FB-10');
    seedPublicacion(db, { clave: 'MLA10|v10', itemId: 'MLA10', varId: 'v10', status: 'paused', subStatus: 'out_of_stock' });
    // chequeo de neto OK (precio 1000, comisión 50, sin envío gratis → neto 950 vs contado 900, no bloquea)
    // + PUT stock OK + PUT activar falla
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 50 }, headers: {} };
      if (/\/items\/MLA10\?/.test(url)) return { status: 200, data: { id: 'MLA10', status: 'paused', sub_status: ['out_of_stock'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      if (method === 'put' && /\/items\/MLA10\/variations\/v10$/.test(url)) return { status: 200, data: {}, headers: {} };
      if (method === 'put' && /\/items\/MLA10$/.test(url)) return { status: 400, data: { message: 'no se puede activar' }, headers: {} };
      return { status: 404, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA10']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBeUndefined(); // no es un bloqueo por neto: ML rechazó la activación
    const pub = db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA10|v10');
    expect(pub.status).toBe('paused'); // sigue pausada
  });

  it('reactivarItems: bloquea si el neto ML queda >5% por debajo del precio web', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-11', 6);
    db.prepare("UPDATE catalogo_cache SET precio=1350, regular_price=1350 WHERE sku='FB-11'").run(); // lista 1350 → contado 900
    seedDecision(db, 'MLA11|v11', 'FB-11');
    seedPublicacion(db, { clave: 'MLA11|v11', itemId: 'MLA11', varId: 'v11', status: 'paused', subStatus: 'out_of_stock' });
    // GET item (precio 1000) + comisión 100 + envío 50 → neto 850 vs contado 900 (~5.6% debajo → bloqueado)
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 100 }, headers: {} };
      if (url.includes('/shipping_options/free')) return { status: 200, data: { coverage: { all_country: { list_cost: 50 } } }, headers: {} };
      if (/\/items\/MLA11/.test(url)) return { status: 200, data: { id: 'MLA11', status: 'paused', sub_status: ['out_of_stock'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: true }, variations: [] }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA11']);
    expect(r.resultados[0].bloqueado).toBe(true);
    expect(r.resultados[0].neto).toBe(850);
    // No se reactivó: sigue pausada, sin estado de stock ni log de reactivada
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA11|v11').status).toBe('paused');
    expect(db.prepare("SELECT COUNT(*) n FROM ml_stock_estado WHERE clave='MLA11|v11'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE estado='reactivada' AND clave='MLA11|v11'").get().n).toBe(0);
  });

  it('reactivarItems: bloquea (fail-closed) si no hay precio web mapeado para comparar', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-12', 5); // sin precio seteado en catalogo_cache
    seedDecision(db, 'MLA12|v12', 'FB-12');
    seedPublicacion(db, { clave: 'MLA12|v12', itemId: 'MLA12', varId: 'v12', status: 'paused', subStatus: 'out_of_stock' });
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (/\/items\/MLA12/.test(url)) return { status: 200, data: { id: 'MLA12', status: 'paused', sub_status: ['out_of_stock'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA12']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBe(true);
    // Pinnea el motivo real (sin precio web), no otro bloqueo fail-closed cualquiera.
    expect(r.resultados[0].error).toMatch(/sin precio web mapeado/i);
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA12|v12').status).toBe('paused');
  });

  it('reactivarItems: bloquea (fail-closed) si no se pudo calcular la comisión en ML', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-14', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000, regular_price=1000 WHERE sku='FB-14'").run();
    seedDecision(db, 'MLA14|v14', 'FB-14');
    seedPublicacion(db, { clave: 'MLA14|v14', itemId: 'MLA14', varId: 'v14', status: 'paused', subStatus: 'out_of_stock' });
    // item OK y precio web mapeado, pero ML no devuelve la comisión (antes de este fix: 'sin_precio', no bloqueaba)
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/listing_prices')) return { status: 404, data: {}, headers: {} };
      if (/\/items\/MLA14/.test(url)) return { status: 200, data: { id: 'MLA14', status: 'paused', sub_status: ['out_of_stock'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA14']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBe(true);
    expect(r.resultados[0].neto).toBeNull();
    // Pinnea el motivo real (comisión), para que este test no quede tapado por el bloqueo
    // "sin precio web mapeado" si algún día se rompe el fail-closed de la comisión.
    expect(r.resultados[0].error).toMatch(/comisión/i);
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA14|v14').status).toBe('paused');
  });

  it('reactivarItems: bloquea (fail-closed) si falla la consulta del item en ML', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-13', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000, regular_price=1000 WHERE sku='FB-13'").run();
    seedDecision(db, 'MLA13|v13', 'FB-13');
    seedPublicacion(db, { clave: 'MLA13|v13', itemId: 'MLA13', varId: 'v13', status: 'paused', subStatus: 'out_of_stock' });
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (/\/items\/MLA13/.test(url)) return { status: 500, data: null, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA13']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBe(true);
    // Pinnea el motivo real (falla al consultar el item), no el bloqueo "sin precio web".
    expect(r.resultados[0].error).toMatch(/no se pudo consultar el precio/i);
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA13|v13').status).toBe('paused');
  });

  it('reactivarItems: omite (no reactiva) si al momento de reactivar ya no está pausada en ML', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-15', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000, regular_price=1000 WHERE sku='FB-15'").run();
    seedDecision(db, 'MLA15|v15', 'FB-15');
    // El caché local la tiene pausada por out_of_stock (así entró a la lista de reactivables)...
    seedPublicacion(db, { clave: 'MLA15|v15', itemId: 'MLA15', varId: 'v15', status: 'paused', subStatus: 'out_of_stock' });
    let getItemCount = 0, putCount = 0;
    // ...pero en ML en vivo ya figura activa (alguien la reactivó manualmente).
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (method === 'get' && /\/items\/MLA15\?/.test(url)) {
        getItemCount++;
        return { status: 200, data: { id: 'MLA15', status: 'active', sub_status: [], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      }
      if (method === 'put') { putCount++; }
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA15']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].omitido).toBe(true);
    expect(r.resultados[0].bloqueado).toBeUndefined();
    expect(r.resultados[0].motivo).toMatch(/ya no está pausada/i);
    // No se tocó ML: ni stock ni activación
    expect(putCount).toBe(0);
    // La revalidación reusa el GET del chequeo de neto: una sola consulta del item a ML
    expect(getItemCount).toBe(1);
    // El caché se refresca con el estado real (active) para sacarla de reactivables — sin log de reactivada
    const pub15 = db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA15|v15');
    expect(pub15.status).toBe('active');
    expect(getReactivablesRows(db, ['MLA15'])).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE estado='reactivada' AND clave='MLA15|v15'").get().n).toBe(0);
  });

  it('reactivarItems: omite (por seguridad) si el vendedor la pausó manualmente entre la carga y la reactivación', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-16', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000, regular_price=1000 WHERE sku='FB-16'").run();
    seedDecision(db, 'MLA16|v16', 'FB-16');
    seedPublicacion(db, { clave: 'MLA16|v16', itemId: 'MLA16', varId: 'v16', status: 'paused', subStatus: 'out_of_stock' });
    let putCount = 0;
    // En vivo sigue pausada pero ahora con paused_by_seller (pausa manual reciente del vendedor).
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (method === 'get' && /\/items\/MLA16\?/.test(url)) {
        return { status: 200, data: { id: 'MLA16', status: 'paused', sub_status: ['out_of_stock', 'paused_by_seller'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      }
      if (method === 'put') { putCount++; }
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA16']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].omitido).toBe(true);
    expect(r.resultados[0].motivo).toMatch(/vendedor/i);
    expect(putCount).toBe(0);
    // Sigue pausada pero el caché ahora refleja paused_by_seller → sale de reactivables
    const pub16 = db.prepare('SELECT status, sub_status FROM ml_publicaciones_cache WHERE clave=?').get('MLA16|v16');
    expect(pub16.status).toBe('paused');
    expect(pub16.sub_status).toContain('paused_by_seller');
    expect(getReactivablesRows(db, ['MLA16'])).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE estado='reactivada' AND clave='MLA16|v16'").get().n).toBe(0);
  });

  it('reactivarItems: bloquea (fail-closed) si ML responde 200 pero sin el campo status', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-17', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000, regular_price=1000 WHERE sku='FB-17'").run();
    seedDecision(db, 'MLA17|v17', 'FB-17');
    seedPublicacion(db, { clave: 'MLA17|v17', itemId: 'MLA17', varId: 'v17', status: 'paused', subStatus: 'out_of_stock' });
    let putCount = 0;
    // Respuesta anómala: 200 pero sin status → no se puede afirmar que sigue pausada → bloquear, no omitir
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (method === 'get' && /\/items\/MLA17\?/.test(url)) {
        return { status: 200, data: { id: 'MLA17', price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      }
      if (method === 'put') { putCount++; }
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA17']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].bloqueado).toBe(true);
    expect(r.resultados[0].omitido).toBeUndefined();
    // Pinnea el motivo real (falta el campo status), no el bloqueo "sin precio web".
    expect(r.resultados[0].error).toMatch(/no devolvió el estado/i);
    expect(putCount).toBe(0);
    // No se tocó el caché: sigue pausada por out_of_stock (fail-closed, reintentable)
    expect(db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave=?').get('MLA17|v17').status).toBe('paused');
  });

  it('reactivarItems: omite (por seguridad) si ML devuelve sub_status como string (no array) con paused_by_seller', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-18', 5);
    db.prepare("UPDATE catalogo_cache SET precio=1000, regular_price=1000 WHERE sku='FB-18'").run();
    seedDecision(db, 'MLA18|v18', 'FB-18');
    seedPublicacion(db, { clave: 'MLA18|v18', itemId: 'MLA18', varId: 'v18', status: 'paused', subStatus: 'out_of_stock' });
    let putCount = 0;
    // Algunas respuestas de ML traen sub_status como string simple en vez de array.
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (method === 'get' && /\/items\/MLA18\?/.test(url)) {
        return { status: 200, data: { id: 'MLA18', status: 'paused', sub_status: 'paused_by_seller', price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      }
      if (method === 'put') { putCount++; }
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLA18']);
    expect(r.resultados[0].ok).toBe(false);
    expect(r.resultados[0].omitido).toBe(true);
    expect(r.resultados[0].motivo).toMatch(/vendedor/i);
    expect(putCount).toBe(0);
    const pub18 = db.prepare('SELECT status, sub_status FROM ml_publicaciones_cache WHERE clave=?').get('MLA18|v18');
    expect(pub18.status).toBe('paused');
    expect(pub18.sub_status).toContain('paused_by_seller');
    expect(getReactivablesRows(db, ['MLA18'])).toHaveLength(0);
  });

  it('reactivarItems: procesa el lote en paralelo sin superar la concurrencia máxima y con el mismo resultado', async () => {
    seedToken(db);
    const N = 8;
    const ids = [];
    for (let i = 1; i <= N; i++) {
      const sku = `FB-P${i}`;
      const item = `MLP${i}`;
      seedCatalogo(db, sku, 7, { idWoo: 100 + i, idPadre: 200 + i });
      db.prepare('UPDATE catalogo_cache SET precio=1350, regular_price=1350 WHERE sku=?').run(sku); // contado 900
      seedDecision(db, `${item}|v${i}`, sku);
      seedPublicacion(db, { clave: `${item}|v${i}`, itemId: item, varId: `v${i}`, status: 'paused', subStatus: 'out_of_stock' });
      ids.push(item);
    }

    // Instrumenta cuántas llamadas a ML corren realmente en simultáneo. Cada mock cede el
    // event loop (setTimeout) para que se solapen si el pool las dispara en paralelo.
    let enVuelo = 0, maxEnVuelo = 0;
    axios.request.mockImplementation(async (cfg) => {
      enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      try {
        await new Promise(r => setTimeout(r, 5));
        const url = cfg.url || '';
        if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 50 }, headers: {} };
        if (/\/items\/MLP\d+\?/.test(url)) {
          const id = url.match(/\/items\/(MLP\d+)\?/)[1];
          return { status: 200, data: { id, status: 'paused', sub_status: ['out_of_stock'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
        }
        return { status: 200, data: {}, headers: {} };
      } finally {
        enVuelo--;
      }
    });

    const r = await reactivarItems(db, ML_CFG, ids);
    expect(r.procesados).toBe(N);
    expect(r.resultados).toHaveLength(N);
    expect(r.resultados.every(x => x.ok)).toBe(true);
    // Nunca hubo más de ML_CONCURRENCIA_MAX (4) llamadas a ML en vuelo a la vez...
    expect(maxEnVuelo).toBeLessThanOrEqual(4);
    // ...pero SÍ hubo paralelismo real (más de una en simultáneo): confirma que no es serie.
    expect(maxEnVuelo).toBeGreaterThan(1);
    // Todas quedaron activas en el caché.
    const activas = db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE status='active'").get();
    expect(activas.n).toBe(N);
  });

  it('reactivarItems: en paralelo, un fallo aislado no frena ni afecta a las demás', async () => {
    seedToken(db);
    // 3 publicaciones OK + 1 que falla al activar (PUT /items/MLPF -> 400)
    for (const [item, sku, i] of [['MLPA', 'FB-A', 1], ['MLPB', 'FB-B', 2], ['MLPF', 'FB-F', 3], ['MLPC', 'FB-C', 4]]) {
      seedCatalogo(db, sku, 5, { idWoo: 300 + i, idPadre: 400 + i });
      db.prepare('UPDATE catalogo_cache SET precio=1350, regular_price=1350 WHERE sku=?').run(sku);
      seedDecision(db, `${item}|w${i}`, sku);
      seedPublicacion(db, { clave: `${item}|w${i}`, itemId: item, varId: `w${i}`, status: 'paused', subStatus: 'out_of_stock' });
    }
    axios.request.mockImplementation(async (cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      await new Promise(r => setTimeout(r, 2));
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 50 }, headers: {} };
      if (/\/items\/(MLP[A-F])\?/.test(url)) {
        const id = url.match(/\/items\/(MLP[A-F])\?/)[1];
        return { status: 200, data: { id, status: 'paused', sub_status: ['out_of_stock'], price: 1000, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] }, headers: {} };
      }
      // activar MLPF falla; el resto OK
      if (method === 'put' && /\/items\/MLPF$/.test(url)) return { status: 400, data: { message: 'no se puede activar' }, headers: {} };
      return { status: 200, data: {}, headers: {} };
    });

    const r = await reactivarItems(db, ML_CFG, ['MLPA', 'MLPB', 'MLPF', 'MLPC']);
    const porId = Object.fromEntries(r.resultados.map(x => [x.item_id, x]));
    expect(porId['MLPA'].ok).toBe(true);
    expect(porId['MLPB'].ok).toBe(true);
    expect(porId['MLPC'].ok).toBe(true);
    expect(porId['MLPF'].ok).toBe(false);
    expect(porId['MLPF'].error).toMatch(/activar/i);
    // Las 3 OK quedaron activas; la fallida sigue pausada.
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLPF|w3'").get().status).toBe('paused');
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE status='active'").get().n).toBe(3);
  });
});

describe('mapConLimite (concurrencia acotada)', () => {
  it('no supera el límite de tareas en vuelo y preserva el orden de los resultados', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let enVuelo = 0, maxEnVuelo = 0;
    const out = await mapConLimite(items, 5, async (n) => {
      enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      try {
        await new Promise(r => setTimeout(r, 3));
        return n * 10;
      } finally {
        enVuelo--;
      }
    });
    expect(maxEnVuelo).toBeLessThanOrEqual(5);
    expect(maxEnVuelo).toBeGreaterThan(1);
    expect(out).toEqual(items.map(n => n * 10)); // resultados en el mismo orden que la entrada
  });

  it('con límite 1 se comporta en serie (nunca 2 en vuelo)', async () => {
    let enVuelo = 0, maxEnVuelo = 0;
    await mapConLimite([1, 2, 3], 1, async () => {
      enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      try {
        await new Promise(r => setTimeout(r, 1));
      } finally {
        enVuelo--;
      }
    });
    expect(maxEnVuelo).toBe(1);
  });
});

// ─── vista de detalle: atencion/:cat y reintentar-item ──────────────────────────

function seedLog(db, { clave, estado, error = null, sku = null }) {
  db.prepare(`
    INSERT INTO sync_log (direccion, clave, sku, estado, error, intentos, creado_en, actualizado_en)
    VALUES ('wc_ml', ?, ?, ?, ?, 0, ?, ?)
  `).run(clave, sku, estado, error, ahora(), ahora());
}

function buildSyncApp(db, cfg) {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter(db, cfg));
  return app;
}

describe('vista de detalle', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.resetAllMocks();
    app = buildSyncApp(db, { ml: ML_CFG, woo: { url: 'https://x', ck: 'a', cs: 'b' } });
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('atencion/sin_mapeo: incluye no mapeados, excluye ya mapeados', async () => {
    seedLog(db, { clave: 'MLA1|', estado: 'sin_mapeo' });
    seedLog(db, { clave: 'MLA2|', estado: 'sin_mapeo' });
    seedDecision(db, 'MLA2|', 'FB-2', 'asignar'); // ya resuelto
    const res = await request(app).get('/api/sync/atencion/sin_mapeo');
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => r.clave)).toEqual(['MLA1|']);
  });

  it('atencion/sin_mapeo: marca variacion_muerta cuando la variación ya no existe en ML', async () => {
    seedToken(db);
    seedLog(db, { clave: 'MLA_M|555', estado: 'sin_mapeo' });  // variación que ML ya no tiene
    seedLog(db, { clave: 'MLA_V|666', estado: 'sin_mapeo' });  // variación viva
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (/\/items\?ids=/.test(url)) {
        return { status: 200, data: [
          { code: 200, body: { id: 'MLA_M', status: 'active', variations: [] } },
          { code: 200, body: { id: 'MLA_V', status: 'active', variations: [{ id: 666 }] } },
        ], headers: {} };
      }
      return { status: 200, data: {}, headers: {} };
    });

    const res = await request(app).get('/api/sync/atencion/sin_mapeo');
    expect(res.status).toBe(200);
    const byClave = Object.fromEntries(res.body.data.map(r => [r.clave, r]));
    expect(byClave['MLA_M|555'].variacion_muerta).toBe(true);
    expect(byClave['MLA_V|666'].variacion_muerta).toBeFalsy();
  });

  it('atencion/:cat: total es el COUNT real (no el LIMIT 500) y avisa truncado', async () => {
    for (let i = 0; i < 520; i++) seedLog(db, { clave: `MLBULK${i}|`, estado: 'sin_mapeo' });
    const res = await request(app).get('/api/sync/atencion/sin_mapeo');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(520);
    expect(res.body.truncado).toBe(true);
    expect(res.body.data).toHaveLength(500);
  });

  it('atencion/:cat: sin truncar, total coincide con la cantidad de filas devueltas', async () => {
    seedLog(db, { clave: 'MLA1|', estado: 'sin_mapeo' });
    const res = await request(app).get('/api/sync/atencion/sin_mapeo');
    expect(res.body.total).toBe(res.body.data.length);
    expect(res.body.truncado).toBe(false);
  });

  it('atencion/sin_mapeo: excluye lo descartado a mano', async () => {
    seedLog(db, { clave: 'MLA1|', estado: 'sin_mapeo' });
    db.prepare("INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES ('MLA1|', null, ?)").run(ahora());
    const res = await request(app).get('/api/sync/atencion/sin_mapeo');
    expect(res.body.data).toEqual([]);
  });

  it('atencion/remapeo_requerido: una variación vieja que ya no existe en ML queda pendiente para siempre hasta que se descarta', async () => {
    // La variación vieja MLA6|v6-vieja fue reemplazada por v6-nueva; el usuario
    // ya mapeó la variación actual, pero la clave vieja del log nunca va a
    // aparecer en sku_matcher_decisiones con esa clave exacta.
    seedLog(db, { clave: 'MLA6|v6-vieja', estado: 'remapeo_requerido' });
    seedDecision(db, 'MLA6|v6-nueva', 'FB-6', 'asignar');

    let res = await request(app).get('/api/sync/atencion/remapeo_requerido');
    expect(res.body.data.map(r => r.clave)).toEqual(['MLA6|v6-vieja']);

    const desc = await request(app).post('/api/sync/descartar-error').send({ claves: ['MLA6|v6-vieja'] });
    expect(desc.body.ok).toBe(true);

    res = await request(app).get('/api/sync/atencion/remapeo_requerido');
    expect(res.body.data).toEqual([]);
  });

  it('dashboard: sin_mapeo y remapeo_requerido no cuentan lo descartado', async () => {
    seedLog(db, { clave: 'MLA7|', estado: 'sin_mapeo' });
    seedLog(db, { clave: 'MLA8|v8', estado: 'remapeo_requerido' });
    db.prepare("INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES ('MLA7|', null, ?)").run(ahora());
    db.prepare("INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES ('MLA8|v8', null, ?)").run(ahora());

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.body.atencion.sin_mapeo).toBe(0);
    expect(res.body.atencion.remapeo_requerido).toBe(0);
  });

  it('atencion/errores: excluye los que ya están en ml_stock_estado', async () => {
    seedLog(db, { clave: 'MLA3|v3', estado: 'error', error: 'HTTP 400' });
    seedLog(db, { clave: 'MLA4|', estado: 'error', error: 'HTTP 500' });
    db.prepare("INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES ('MLA4|','FB-4',3,?)").run(ahora());
    const res = await request(app).get('/api/sync/atencion/errores');
    expect(res.body.data.map(r => r.clave)).toEqual(['MLA3|v3']);
  });

  it('atencion: categoría inválida → 400', async () => {
    const res = await request(app).get('/api/sync/atencion/cualquiera');
    expect(res.status).toBe(400);
  });

  it('limpiar-variaciones-muertas: descarta las que ML confirma inexistentes', async () => {
    seedToken(db);
    seedDecision(db, 'MLA_D|111', 'FB-D'); // item ahora simple → variación muerta
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (/\/items\?ids=/.test(url)) {
        return { status: 200, data: [{ code: 200, body: { id: 'MLA_D', status: 'active', variations: [] } }], headers: {} };
      }
      return { status: 200, data: {}, headers: {} };
    });

    const res = await request(app).post('/api/sync/limpiar-variaciones-muertas');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.muertas).toBe(1);
    expect(db.prepare("SELECT 1 FROM errores_descartados WHERE clave='MLA_D|111'").get()).toBeTruthy();
  });

  it('reintentar-item: publicación activa → push de stock OK', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-20', 6);
    seedDecision(db, 'MLA20|v20', 'FB-20');
    seedPublicacion(db, { clave: 'MLA20|v20', itemId: 'MLA20', varId: 'v20', status: 'active' });
    axios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });
    const res = await request(app).post('/api/sync/reintentar-item').send({ clave: 'MLA20|v20' });
    expect(res.body.ok).toBe(true);
    expect(res.body.cantidad).toBe(6);
    const est = db.prepare('SELECT cantidad_ml FROM ml_stock_estado WHERE clave=?').get('MLA20|v20');
    expect(est.cantidad_ml).toBe(6);
  });

  it('reintentar-item: publicación pausada → no reintenta, sugiere reactivar', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-21', 6);
    seedDecision(db, 'MLA21|v21', 'FB-21');
    seedPublicacion(db, { clave: 'MLA21|v21', itemId: 'MLA21', varId: 'v21', status: 'paused', subStatus: 'out_of_stock' });
    const res = await request(app).post('/api/sync/reintentar-item').send({ clave: 'MLA21|v21' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/reactiv/i);
  });

  it('reintentar-item: sin clave → 400', async () => {
    const res = await request(app).post('/api/sync/reintentar-item').send({});
    expect(res.status).toBe(400);
  });

  it('atencion: enriquece título + miniatura desde ML cuando faltan en cache', async () => {
    seedToken(db);
    seedLog(db, { clave: 'MLA50|v50', estado: 'error', error: 'HTTP 500' });
    // Publicación en cache pero sin miniatura (columna thumbnail NULL) → dispara enriquecimiento.
    seedPublicacion(db, { clave: 'MLA50|v50', itemId: 'MLA50', varId: 'v50', status: 'active', titulo: 'Pub 50' });
    axios.request.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA50', title: 'Título desde ML', secure_thumbnail: 'https://http2.mlstatic.com/x.jpg' } }],
      headers: {},
    });

    const res = await request(app).get('/api/sync/atencion/errores');
    expect(res.status).toBe(200);
    expect(res.body.data[0].thumbnail).toBe('https://http2.mlstatic.com/x.jpg');
    // Persistió en cache
    const pub = db.prepare('SELECT thumbnail FROM ml_publicaciones_cache WHERE item_id=?').get('MLA50');
    expect(pub.thumbnail).toBe('https://http2.mlstatic.com/x.jpg');
  });

  it('dashboard: cuenta publicaciones reactivables (excluye activas y paused_by_seller)', async () => {
    // Reactivable: pausada out_of_stock, mapeada, con stock web
    seedCatalogo(db, 'FB-30', 5, { idWoo: 30 });
    seedDecision(db, 'MLA30|v30', 'FB-30');
    seedPublicacion(db, { clave: 'MLA30|v30', itemId: 'MLA30', varId: 'v30', status: 'paused', subStatus: 'out_of_stock' });
    // No reactivable: pausa manual (paused_by_seller)
    seedCatalogo(db, 'FB-31', 5, { idWoo: 31 });
    seedDecision(db, 'MLA31|v31', 'FB-31');
    seedPublicacion(db, { clave: 'MLA31|v31', itemId: 'MLA31', varId: 'v31', status: 'paused', subStatus: 'out_of_stock,paused_by_seller' });
    // No reactivable: activa
    seedCatalogo(db, 'FB-32', 5, { idWoo: 32 });
    seedDecision(db, 'MLA32|v32', 'FB-32');
    seedPublicacion(db, { clave: 'MLA32|v32', itemId: 'MLA32', varId: 'v32', status: 'active' });

    const res = await request(app).get('/api/sync/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.reactivables).toBe(1);
  });

  // ─── Fase 2: triage de errores por diagnóstico ───
  function mockItem(body) {
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/items?ids=')) return { status: 200, data: [{ code: 200, body }], headers: {} };
      return { status: 200, data: {}, headers: {} };
    });
  }

  it('atencion/errores: diagnostica reactivable (pausada out_of_stock con stock web)', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-D1', 5, { idWoo: 401 });
    seedDecision(db, 'MLD1|v1', 'FB-D1');
    seedLog(db, { clave: 'MLD1|v1', estado: 'error', error: 'HTTP 400' });
    mockItem({ id: 'MLD1', title: 'Pub D1', status: 'paused', sub_status: ['out_of_stock'], variations: [{ id: 'v1' }] });
    const res = await request(app).get('/api/sync/atencion/errores');
    const row = res.body.data.find(r => r.clave === 'MLD1|v1');
    expect(row.diagnostico).toBe('reactivable');
    expect(row.accion).toBe('reactivar');
  });

  it('atencion/errores: diagnostica estructura_cambiada (activa, la variación no existe)', async () => {
    seedToken(db);
    seedCatalogo(db, 'FB-D2', 5, { idWoo: 402 });
    seedDecision(db, 'MLD2|v2', 'FB-D2');
    seedLog(db, { clave: 'MLD2|v2', estado: 'error', error: 'HTTP 400' });
    mockItem({ id: 'MLD2', title: 'Pub D2', status: 'active', sub_status: [], variations: [{ id: 'otra' }] });
    const res = await request(app).get('/api/sync/atencion/errores');
    const row = res.body.data.find(r => r.clave === 'MLD2|v2');
    expect(row.diagnostico).toBe('estructura_cambiada');
    expect(row.accion).toBe('desvincular');
  });

  it('descartar-error: la clave desaparece de errores y del contador del dashboard', async () => {
    seedLog(db, { clave: 'MLD3|v3', estado: 'error', error: 'HTTP 400' });
    // antes: cuenta como error
    let dash = await request(app).get('/api/sync/dashboard');
    expect(dash.body.atencion.errores_reales).toBe(1);
    // descartar
    const desc = await request(app).post('/api/sync/descartar-error').send({ claves: ['MLD3|v3'] });
    expect(desc.body.ok).toBe(true);
    // después: no está en la vista ni en el contador
    const list = await request(app).get('/api/sync/atencion/errores');
    expect(list.body.data.find(r => r.clave === 'MLD3|v3')).toBeUndefined();
    dash = await request(app).get('/api/sync/dashboard');
    expect(dash.body.atencion.errores_reales).toBe(0);
  });

  it('desvincular: borra el mapeo de la clave', async () => {
    seedDecision(db, 'MLD4|v4', 'FB-D4');
    const res = await request(app).post('/api/sync/desvincular').send({ clave: 'MLD4|v4' });
    expect(res.body.ok).toBe(true);
    expect(res.body.borradas).toBe(1);
    const dec = db.prepare('SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave=?').get('MLD4|v4');
    expect(dec.n).toBe(0);
  });

  it('GET /reactivables: si mlFetch/netoMl lanzan (throw) para UNA publicación del lote, esa queda en sin_precio y NO afecta a las demás', async () => {
    seedToken(db);
    // Publicación A: la que va a fallar (throw al pedir su comisión/listing_prices).
    seedCatalogo(db, 'FB-T1', 5, { idWoo: 501 });
    db.prepare("UPDATE catalogo_cache SET precio=1500, regular_price=1500 WHERE sku='FB-T1'").run();
    seedDecision(db, 'MLAT1|', 'FB-T1');
    seedPublicacion(db, { clave: 'MLAT1|', itemId: 'MLAT1', status: 'paused', subStatus: 'out_of_stock' });
    // Publicación B: debe evaluarse con normalidad pese al throw de la A.
    seedCatalogo(db, 'FB-T2', 5, { idWoo: 502 });
    db.prepare("UPDATE catalogo_cache SET precio=1500, regular_price=1500 WHERE sku='FB-T2'").run();
    seedDecision(db, 'MLAT2|', 'FB-T2');
    seedPublicacion(db, { clave: 'MLAT2|', itemId: 'MLAT2', status: 'paused', subStatus: 'out_of_stock' });

    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      if (url.includes('/items?ids=')) {
        return {
          status: 200,
          data: [
            { code: 200, body: { id: 'MLAT1', price: 1000, category_id: 'CAT-FALLA', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] } },
            { code: 200, body: { id: 'MLAT2', price: 1000, category_id: 'CAT-OK', listing_type_id: 'gold_special', shipping: { free_shipping: false }, variations: [] } },
          ],
          headers: {},
        };
      }
      if (url.includes('/listing_prices')) {
        // Simula un throw real (ej. timeout de axios), no un status de error, y SOLO para la
        // categoría de la publicación A. La B debe resolver normalmente.
        if (url.includes('category_id=CAT-FALLA')) throw new Error('timeout de red simulado');
        return { status: 200, data: { sale_fee_amount: 100 }, headers: {} };
      }
      return { status: 200, data: {}, headers: {} };
    });

    const res = await request(app).get('/api/sync/reactivables');
    expect(res.status).toBe(200);
    const byItem = Object.fromEntries(res.body.data.map(p => [p.item_id, p]));

    // Publicación A: quedó marcada sin_precio, con el resto de campos en null (no tumbó el lote).
    expect(byItem['MLAT1'].estado).toBe('sin_precio');
    expect(byItem['MLAT1'].precio_ml).toBeNull();
    expect(byItem['MLAT1'].sale_fee).toBeNull();
    expect(byItem['MLAT1'].envio).toBeNull();
    expect(byItem['MLAT1'].neto).toBeNull();
    expect(byItem['MLAT1'].precio_web).toBeNull();
    expect(byItem['MLAT1'].deficit_pct).toBeNull();

    // Publicación B: se evaluó con normalidad, sin verse afectada por el throw de la A.
    expect(byItem['MLAT2'].estado).not.toBe('sin_precio');
    expect(byItem['MLAT2'].precio_ml).toBe(1000);
    expect(byItem['MLAT2'].sale_fee).toBe(100);
    expect(byItem['MLAT2'].neto).toBe(900);
    expect(byItem['MLAT2'].precio_web).not.toBeNull();
  });

  it('GET /reactivables/conteo: devuelve el total de publicaciones/variaciones sin consultar ML', async () => {
    // Dos publicaciones reactivables (una con dos variaciones) → 2 publicaciones, 3 variaciones.
    seedCatalogo(db, 'FB-C1', 5, { idWoo: 701 });
    seedDecision(db, 'MLC1|v1', 'FB-C1');
    seedPublicacion(db, { clave: 'MLC1|v1', itemId: 'MLC1', varId: 'v1', status: 'paused', subStatus: 'out_of_stock' });
    seedCatalogo(db, 'FB-C2a', 5, { idWoo: 702 });
    seedDecision(db, 'MLC2|v2', 'FB-C2a');
    seedPublicacion(db, { clave: 'MLC2|v2', itemId: 'MLC2', varId: 'v2', status: 'paused', subStatus: 'out_of_stock' });
    seedCatalogo(db, 'FB-C2b', 4, { idWoo: 703 });
    seedDecision(db, 'MLC2|v3', 'FB-C2b');
    seedPublicacion(db, { clave: 'MLC2|v3', itemId: 'MLC2', varId: 'v3', status: 'paused', subStatus: 'out_of_stock' });

    const res = await request(app).get('/api/sync/reactivables/conteo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.totalPublicaciones).toBe(2);
    expect(res.body.totalVariaciones).toBe(3);
    // No debe haber consultado ML para el conteo (es solo caché local).
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('GET /reactivables/conteo: sin candidatas devuelve ceros', async () => {
    const res = await request(app).get('/api/sync/reactivables/conteo');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, totalPublicaciones: 0, totalVariaciones: 0 });
  });
});

// ─── buscar-sku: filtro por tipo (bug de config-ml que excluía simple/variable) ──

describe('GET /api/sync/buscar-sku', () => {
  let db, app;

  beforeEach(() => {
    db = openDb(TEST_DB);
    app = buildSyncApp(db, { ml: ML_CFG, woo: { url: 'https://x', ck: 'a', cs: 'b' } });
    seedCatalogo(db, 'BUSC-VAR-1', 5, { tipo: 'variation', idWoo: 901 });
    seedCatalogo(db, 'BUSC-SIMPLE-1', 3, { tipo: 'simple', idPadre: 0, idWoo: 902 });
    seedCatalogo(db, 'BUSC-VARIABLE-1', 0, { tipo: 'variable', idPadre: 0, idWoo: 903 });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('sin q: devuelve data vacía sin consultar la base', async () => {
    const res = await request(app).get('/api/sync/buscar-sku');
    expect(res.body).toEqual({ ok: true, data: [] });
  });

  it('por defecto (sin tipo=all): solo trae tipo=variation, excluye simple y variable', async () => {
    const res = await request(app).get('/api/sync/buscar-sku?q=BUSC');
    expect(res.body.ok).toBe(true);
    const skus = res.body.data.map(r => r.sku).sort();
    expect(skus).toEqual(['BUSC-VAR-1']);
  });

  it('con tipo=all: incluye simple y variable además de variation', async () => {
    const res = await request(app).get('/api/sync/buscar-sku?q=BUSC&tipo=all');
    expect(res.body.ok).toBe(true);
    const skus = res.body.data.map(r => r.sku).sort();
    expect(skus).toEqual(['BUSC-SIMPLE-1', 'BUSC-VAR-1', 'BUSC-VARIABLE-1']);
  });

  it('busca por nombre además de por SKU', async () => {
    const res = await request(app).get('/api/sync/buscar-sku?q=Prod%20BUSC-SIMPLE-1&tipo=all');
    expect(res.body.data.map(r => r.sku)).toEqual(['BUSC-SIMPLE-1']);
  });

  it('excluye filas con sku vacío', async () => {
    seedCatalogo(db, '', 1, { tipo: 'variation', idWoo: 999 });
    db.prepare("UPDATE catalogo_cache SET nombre='BUSC-vacio' WHERE id_woo=999").run();
    const res = await request(app).get('/api/sync/buscar-sku?q=BUSC-vacio&tipo=all');
    expect(res.body.data).toEqual([]);
  });

  it('"%" y "_" se buscan como texto literal, no como comodín que matchea todo', async () => {
    const porcentaje = await request(app).get('/api/sync/buscar-sku?q=%&tipo=all');
    expect(porcentaje.body.data).toEqual([]);
    const guionBajo = await request(app).get('/api/sync/buscar-sku?q=_&tipo=all');
    expect(guionBajo.body.data).toEqual([]);
  });
});

// ─── config-ml: guardar / listar / eliminar configuración de reservas locales ──

describe('POST/GET/DELETE /api/sync/config-ml', () => {
  let db, app;

  beforeEach(() => {
    db = openDb(TEST_DB);
    app = buildSyncApp(db, { ml: ML_CFG, woo: { url: 'https://x', ck: 'a', cs: 'b' } });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('GET config-ml: lista vacía si no hay nada configurado', async () => {
    const res = await request(app).get('/api/sync/config-ml');
    expect(res.body).toEqual({ ok: true, data: [] });
  });

  it('POST config-ml: rechaza si falta sku', async () => {
    const res = await request(app).post('/api/sync/config-ml').send({ modo: 'reserva', reserva: 2 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST config-ml: rechaza modo inválido', async () => {
    const res = await request(app).post('/api/sync/config-ml').send({ sku: 'FB-CFG-1', modo: 'otra_cosa' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST config-ml: crea config en modo reserva y aparece en GET con stock disponible calculado', async () => {
    seedCatalogo(db, 'FB-CFG-2', 10, { tipo: 'simple', idPadre: 0 });
    const post = await request(app).post('/api/sync/config-ml').send({ sku: 'FB-CFG-2', modo: 'reserva', reserva: 3 });
    expect(post.body.ok).toBe(true);

    const list = await request(app).get('/api/sync/config-ml');
    const row = list.body.data.find(r => r.sku === 'FB-CFG-2');
    expect(row).toBeTruthy();
    expect(row.modo).toBe('reserva');
    expect(row.reserva).toBe(3);
    expect(row.stock_wc).toBe(10);
    expect(row.stock_disponible_ml).toBe(7); // 10 - 3
  });

  it('POST config-ml: modo solo_local siempre da stock_disponible_ml = 0 e ignora reserva enviada', async () => {
    seedCatalogo(db, 'FB-CFG-3', 8, { tipo: 'simple', idPadre: 0 });
    await request(app).post('/api/sync/config-ml').send({ sku: 'FB-CFG-3', modo: 'solo_local', reserva: 99 });

    const list = await request(app).get('/api/sync/config-ml');
    const row = list.body.data.find(r => r.sku === 'FB-CFG-3');
    expect(row.modo).toBe('solo_local');
    expect(row.reserva).toBe(0);
    expect(row.stock_disponible_ml).toBe(0);
  });

  it('POST config-ml: toma el nombre del catálogo si no viene en el body', async () => {
    seedCatalogo(db, 'FB-CFG-4', 5, { tipo: 'simple', idPadre: 0 });
    await request(app).post('/api/sync/config-ml').send({ sku: 'FB-CFG-4', modo: 'reserva', reserva: 1 });
    const list = await request(app).get('/api/sync/config-ml');
    const row = list.body.data.find(r => r.sku === 'FB-CFG-4');
    expect(row.nombre).toBe('Prod FB-CFG-4');
  });

  it('POST config-ml: actualiza (upsert) si ya existe config para el sku', async () => {
    seedCatalogo(db, 'FB-CFG-5', 20, { tipo: 'simple', idPadre: 0 });
    await request(app).post('/api/sync/config-ml').send({ sku: 'FB-CFG-5', modo: 'reserva', reserva: 5 });
    await request(app).post('/api/sync/config-ml').send({ sku: 'FB-CFG-5', modo: 'reserva', reserva: 9 });

    const list = await request(app).get('/api/sync/config-ml');
    const rows = list.body.data.filter(r => r.sku === 'FB-CFG-5');
    expect(rows).toHaveLength(1);
    expect(rows[0].reserva).toBe(9);
  });

  it('DELETE config-ml/:sku: elimina la config y ya no aparece en GET', async () => {
    seedCatalogo(db, 'FB-CFG-6', 4, { tipo: 'simple', idPadre: 0 });
    await request(app).post('/api/sync/config-ml').send({ sku: 'FB-CFG-6', modo: 'reserva', reserva: 1 });

    const del = await request(app).delete('/api/sync/config-ml/FB-CFG-6');
    expect(del.body.ok).toBe(true);

    const list = await request(app).get('/api/sync/config-ml');
    expect(list.body.data.find(r => r.sku === 'FB-CFG-6')).toBeUndefined();
  });

  it('DELETE config-ml/:sku: no falla si el sku no existe', async () => {
    const del = await request(app).delete('/api/sync/config-ml/NO-EXISTE');
    expect(del.body.ok).toBe(true);
  });
});

// ─── catalogo-config / config-ml/lote: carga masiva de reservas ──────────────

// seedCatalogo no soporta marca/categorias_json; este helper cubre lo que necesita el
// filtro masivo (marca exacta, categorias_json como array JSON).
function seedCatalogoMasivo(db, sku, stock, { marca = '', categorias = null, idWoo, nombre } = {}) {
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, marca, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(idWoo, nombre || ('Prod ' + sku), sku, 'simple', 0, stock, marca, categorias ? JSON.stringify(categorias) : null, ahora());
}

describe('GET /api/sync/catalogo-config y POST /api/sync/config-ml/lote', () => {
  let db, app;

  beforeEach(() => {
    db = openDb(TEST_DB);
    app = buildSyncApp(db, { ml: ML_CFG, woo: { url: 'https://x', ck: 'a', cs: 'b' } });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('GET /catalogo-config', () => {
    it('lista el catálogo completo con modo null cuando no hay config', async () => {
      seedCatalogoMasivo(db, 'MASV-1', 10, { marca: 'Shimano', idWoo: 1 });
      const res = await request(app).get('/api/sync/catalogo-config');
      expect(res.status).toBe(200);
      const row = res.body.data.find(r => r.sku === 'MASV-1');
      expect(row.modo).toBeNull();
      expect(row.reserva).toBe(0);
      expect(row.stock_disponible_ml).toBe(10);
      expect(row.total ?? res.body.total).toBeDefined();
    });

    it('calcula stock_disponible_ml según el modo (reserva resta, solo_local en 0)', async () => {
      seedCatalogoMasivo(db, 'MASV-2', 10, { idWoo: 2 });
      db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('MASV-2','x','reserva',4,?)").run(ahora());
      seedCatalogoMasivo(db, 'MASV-3', 8, { idWoo: 3 });
      db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('MASV-3','x','solo_local',0,?)").run(ahora());

      const res = await request(app).get('/api/sync/catalogo-config');
      const r2 = res.body.data.find(r => r.sku === 'MASV-2');
      const r3 = res.body.data.find(r => r.sku === 'MASV-3');
      expect(r2.stock_disponible_ml).toBe(6);
      expect(r3.stock_disponible_ml).toBe(0);
    });

    it('filtra por estado sin_config/solo_local/reserva', async () => {
      seedCatalogoMasivo(db, 'MASV-EST-1', 5, { idWoo: 11 });
      seedCatalogoMasivo(db, 'MASV-EST-2', 5, { idWoo: 12 });
      db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('MASV-EST-2','x','reserva',1,?)").run(ahora());
      seedCatalogoMasivo(db, 'MASV-EST-3', 5, { idWoo: 13 });
      db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('MASV-EST-3','x','solo_local',0,?)").run(ahora());

      const sinConfig = await request(app).get('/api/sync/catalogo-config?estado=sin_config&q=MASV-EST');
      expect(sinConfig.body.data.map(r => r.sku)).toEqual(['MASV-EST-1']);

      const reserva = await request(app).get('/api/sync/catalogo-config?estado=reserva&q=MASV-EST');
      expect(reserva.body.data.map(r => r.sku)).toEqual(['MASV-EST-2']);

      const soloLocal = await request(app).get('/api/sync/catalogo-config?estado=solo_local&q=MASV-EST');
      expect(soloLocal.body.data.map(r => r.sku)).toEqual(['MASV-EST-3']);
    });

    it('filtra por marca exacta', async () => {
      seedCatalogoMasivo(db, 'MASV-M1', 5, { marca: 'Shimano', idWoo: 21 });
      seedCatalogoMasivo(db, 'MASV-M2', 5, { marca: 'Sram', idWoo: 22 });
      const res = await request(app).get('/api/sync/catalogo-config?marca=Shimano&q=MASV-M');
      expect(res.body.data.map(r => r.sku)).toEqual(['MASV-M1']);
    });

    it('filtra por categoria dentro del array categorias_json', async () => {
      seedCatalogoMasivo(db, 'MASV-C1', 5, { categorias: ['Cascos', 'Indumentaria'], idWoo: 31 });
      seedCatalogoMasivo(db, 'MASV-C2', 5, { categorias: ['Cubiertas'], idWoo: 32 });
      seedCatalogoMasivo(db, 'MASV-C3', 5, { categorias: null, idWoo: 33 });
      const res = await request(app).get('/api/sync/catalogo-config?categoria=Cascos&q=MASV-C');
      expect(res.body.data.map(r => r.sku)).toEqual(['MASV-C1']);
    });

    it('rechaza estado/orden/dir fuera de whitelist con 400', async () => {
      const r1 = await request(app).get('/api/sync/catalogo-config?estado=invalido');
      expect(r1.status).toBe(400);
      const r2 = await request(app).get('/api/sync/catalogo-config?orden=precio');
      expect(r2.status).toBe(400);
      const r3 = await request(app).get('/api/sync/catalogo-config?dir=vertical');
      expect(r3.status).toBe(400);
    });

    it('limite tope 500 aunque se pida más', async () => {
      seedCatalogoMasivo(db, 'MASV-LIM', 5, { idWoo: 41 });
      const res = await request(app).get('/api/sync/catalogo-config?limite=9999');
      expect(res.status).toBe(200);
      // no hace falta sembrar 500 filas: solo confirmamos que el request no rompe.
      expect(res.body.data.length).toBeLessThanOrEqual(500);
    });

    it('dedup por SKU repetido en catalogo_cache: cuenta una sola vez, con el stock más bajo (menor stock, menor id_woo)', async () => {
      // Mismo SKU en 3 filas: dato sucio conocido. Debe ganar la de menor stock (y a igualdad,
      // menor id_woo) tanto en el listado como en el total.
      seedCatalogoMasivo(db, 'MASV-DUP', 20, { idWoo: 50 });
      seedCatalogoMasivo(db, 'MASV-DUP', 5, { idWoo: 51 });
      seedCatalogoMasivo(db, 'MASV-DUP', 5, { idWoo: 49 }); // mismo stock que la anterior, menor id_woo → gana esta

      const res = await request(app).get('/api/sync/catalogo-config?q=MASV-DUP');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].stock_wc).toBe(5);
    });

    it('un filtro que no matchea nada devuelve total 0 y data vacía (no cae a "todo el catálogo")', async () => {
      seedCatalogoMasivo(db, 'MASV-OTRO', 5, { marca: 'Shimano', idWoo: 60 });
      const res = await request(app).get('/api/sync/catalogo-config?marca=NoExisteJamas');
      expect(res.body.total).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    it('escapa comodines de LIKE en q (% y _) para no traer de más', async () => {
      seedCatalogoMasivo(db, 'MASV-50PORCIENTO', 5, { idWoo: 70, nombre: 'Producto 50% descuento' });
      seedCatalogoMasivo(db, 'MASV-OTRO-2', 5, { idWoo: 71, nombre: 'Producto cualquiera' });
      // Buscar literalmente "50%" no debe matchear "Producto cualquiera" vía comodín suelto.
      const res = await request(app).get('/api/sync/catalogo-config?' + new URLSearchParams({ q: '50%' }).toString());
      expect(res.body.data.map(r => r.sku)).toEqual(['MASV-50PORCIENTO']);
    });

    it('con facetas=1 agrega marcas y categorias de todo el catálogo', async () => {
      seedCatalogoMasivo(db, 'MASV-F1', 5, { marca: 'Shimano', categorias: ['Cascos'], idWoo: 80 });
      seedCatalogoMasivo(db, 'MASV-F2', 5, { marca: 'Sram', categorias: ['Cubiertas'], idWoo: 81 });
      const res = await request(app).get('/api/sync/catalogo-config?facetas=1');
      expect(res.body.marcas).toEqual(expect.arrayContaining(['Shimano', 'Sram']));
      expect(res.body.categorias).toEqual(expect.arrayContaining(['Cascos', 'Cubiertas']));
    });

    it('sin facetas=1 no incluye marcas ni categorias', async () => {
      seedCatalogoMasivo(db, 'MASV-NF', 5, { marca: 'Shimano', idWoo: 90 });
      const res = await request(app).get('/api/sync/catalogo-config');
      expect(res.body.marcas).toBeUndefined();
      expect(res.body.categorias).toBeUndefined();
    });
  });

  describe('invariante: total del GET === resumen.solicitados del POST con el mismo filtro', () => {
    it('coincide con filtros combinados (q + marca + categoria + estado)', async () => {
      // Universo con ruido: solo dos SKUs matchean TODO el filtro combinado.
      seedCatalogoMasivo(db, 'INV-1', 5, { marca: 'Shimano', categorias: ['Cascos'], idWoo: 100 });
      seedCatalogoMasivo(db, 'INV-2', 5, { marca: 'Shimano', categorias: ['Cascos'], idWoo: 101 });
      // No matchea: otra marca.
      seedCatalogoMasivo(db, 'INV-3', 5, { marca: 'Sram', categorias: ['Cascos'], idWoo: 102 });
      // No matchea: otra categoria.
      seedCatalogoMasivo(db, 'INV-4', 5, { marca: 'Shimano', categorias: ['Cubiertas'], idWoo: 103 });
      // No matchea: ya tiene config previa (estado sin_config pedido).
      seedCatalogoMasivo(db, 'INV-5', 5, { marca: 'Shimano', categorias: ['Cascos'], idWoo: 104 });
      db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('INV-5','x','reserva',1,?)").run(ahora());

      const filtro = { q: 'INV', marca: 'Shimano', categoria: 'Cascos', estado: 'sin_config' };
      const qs = new URLSearchParams(filtro).toString();
      const get = await request(app).get(`/api/sync/catalogo-config?${qs}`);
      expect(get.body.data.map(r => r.sku).sort()).toEqual(['INV-1', 'INV-2']);
      expect(get.body.total).toBe(2);

      const post = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'solo_local', vista_previa: true, filtro,
      });
      expect(post.body.resumen.solicitados).toBe(get.body.total);
      expect(post.body.resumen.solicitados).toBe(2);
    });
  });

  describe('POST /config-ml/lote: validaciones (400)', () => {
    it('accion fuera del enum', async () => {
      const res = await request(app).post('/api/sync/config-ml/lote').send({ accion: 'volar', skus: ['A'] });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it.each([
      ['negativa', -1],
      ['no entera', 1.5],
      ['string vacío', ''],
      ['null', null],
      ['array', []],
    ])('reserva inválida: %s', async (_desc, valorInvalido) => {
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: valorInvalido, skus: ['A'],
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('acepta reserva 0 (entero >= 0 válido)', async () => {
      seedCatalogoMasivo(db, 'RES-0', 5, { idWoo: 110 });
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: 0, skus: ['RES-0'],
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('skus y filtro ambos presentes → 400', async () => {
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'quitar', skus: ['A'], filtro: { q: '' },
      });
      expect(res.status).toBe(400);
    });

    it('ni skus ni filtro → 400', async () => {
      const res = await request(app).post('/api/sync/config-ml/lote').send({ accion: 'quitar' });
      expect(res.status).toBe(400);
    });

    it('más de 5000 skus → 400', async () => {
      const skus = Array.from({ length: 5001 }, (_, i) => `SKU-${i}`);
      const res = await request(app).post('/api/sync/config-ml/lote').send({ accion: 'quitar', skus });
      expect(res.status).toBe(400);
    });

    it('exactamente 5000 skus no rebota por el límite (aunque no existan en catálogo)', async () => {
      const skus = Array.from({ length: 5000 }, (_, i) => `SKU-${i}`);
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'quitar', skus, vista_previa: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.resumen.solicitados).toBe(5000);
    });

    it('filtro.estado fuera de enum → 400', async () => {
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'quitar', filtro: { estado: 'inventado' },
      });
      expect(res.status).toBe(400);
    });

    it('orden/dir/estado fuera de whitelist en el GET (ya cubierto arriba) también aplica al filtro del lote vía estado', async () => {
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'quitar', filtro: { estado: 'no-valido' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/estado/);
    });
  });

  describe('POST /config-ml/lote: acciones reales sobre la base', () => {
    it('accion reserva: hace upsert con la cantidad y marca pisados si ya había config', async () => {
      seedCatalogoMasivo(db, 'ACC-R1', 10, { idWoo: 120 });
      seedCatalogoMasivo(db, 'ACC-R2', 10, { idWoo: 121 });
      db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('ACC-R2','viejo','solo_local',0,?)").run(ahora());

      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: 3, skus: ['ACC-R1', 'ACC-R2'],
      });
      expect(res.status).toBe(200);
      expect(res.body.resumen).toMatchObject({ solicitados: 2, aplicados: 2, pisados: 1, sin_cambio: 0, inexistentes: [] });

      const r1 = db.prepare("SELECT modo, reserva, nombre FROM skus_config_ml WHERE sku='ACC-R1'").get();
      expect(r1).toMatchObject({ modo: 'reserva', reserva: 3 });
      const r2 = db.prepare("SELECT modo, reserva FROM skus_config_ml WHERE sku='ACC-R2'").get();
      expect(r2).toMatchObject({ modo: 'reserva', reserva: 3 }); // pisó la config previa
    });

    it('accion solo_local: guarda reserva en 0 aunque no se mande reserva', async () => {
      seedCatalogoMasivo(db, 'ACC-SL1', 10, { idWoo: 130 });
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'solo_local', skus: ['ACC-SL1'],
      });
      expect(res.status).toBe(200);
      const row = db.prepare("SELECT modo, reserva FROM skus_config_ml WHERE sku='ACC-SL1'").get();
      expect(row).toMatchObject({ modo: 'solo_local', reserva: 0 });
    });

    it('accion quitar: borra la fila; los que no tenían config cuentan sin_cambio, no error', async () => {
      seedCatalogoMasivo(db, 'ACC-Q1', 10, { idWoo: 140 });
      seedCatalogoMasivo(db, 'ACC-Q2', 10, { idWoo: 141 });
      db.prepare("INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en) VALUES ('ACC-Q1','x','reserva',2,?)").run(ahora());
      // ACC-Q2 nunca tuvo config.

      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'quitar', skus: ['ACC-Q1', 'ACC-Q2'],
      });
      expect(res.status).toBe(200);
      expect(res.body.resumen).toMatchObject({ solicitados: 2, aplicados: 2, pisados: 0, sin_cambio: 1, inexistentes: [] });
      expect(db.prepare("SELECT * FROM skus_config_ml WHERE sku='ACC-Q1'").get()).toBeUndefined();
      expect(db.prepare("SELECT * FROM skus_config_ml WHERE sku='ACC-Q2'").get()).toBeUndefined();
    });

    it('nombre sale de catalogo_cache (dedup), no del body', async () => {
      seedCatalogoMasivo(db, 'ACC-N1', 10, { idWoo: 150, nombre: 'Nombre real del catálogo' });
      await request(app).post('/api/sync/config-ml/lote').send({ accion: 'reserva', reserva: 1, skus: ['ACC-N1'] });
      const row = db.prepare("SELECT nombre FROM skus_config_ml WHERE sku='ACC-N1'").get();
      expect(row.nombre).toBe('Nombre real del catálogo');
    });
  });

  describe('POST /config-ml/lote: vista_previa no escribe nada', () => {
    it('vista_previa:true devuelve resumen y esperados pero no toca la base', async () => {
      seedCatalogoMasivo(db, 'VP-1', 10, { idWoo: 160 });
      seedCatalogoMasivo(db, 'VP-2', 10, { idWoo: 161 });

      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: 5, skus: ['VP-1', 'VP-2', 'VP-NO-EXISTE'], vista_previa: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.vista_previa).toBe(true);
      expect(res.body.esperados).toBe(3);
      expect(res.body.resumen).toMatchObject({ solicitados: 3, aplicados: 2, inexistentes: ['VP-NO-EXISTE'] });

      // nada se escribió en skus_config_ml
      const count = db.prepare('SELECT COUNT(*) n FROM skus_config_ml').get().n;
      expect(count).toBe(0);
    });

    it('la vista previa devuelve el mismo resumen que la aplicación real inmediatamente después', async () => {
      seedCatalogoMasivo(db, 'VP-3', 10, { idWoo: 170 });
      const filtro = { q: 'VP-3' };

      const preview = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'solo_local', filtro, vista_previa: true,
      });
      const real = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'solo_local', filtro, esperados: preview.body.esperados,
      });
      expect(real.body.resumen).toEqual(preview.body.resumen);
    });
  });

  describe('POST /config-ml/lote: guard 409 por catálogo cambiado', () => {
    it('esperados no coincide con lo resuelto ahora → 409 y no escribe nada', async () => {
      seedCatalogoMasivo(db, 'G409-1', 10, { marca: 'Shimano', idWoo: 180 });
      const filtro = { marca: 'Shimano' };

      const preview = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: 1, filtro, vista_previa: true,
      });
      expect(preview.body.esperados).toBe(1);

      // El catálogo cambia entre la vista previa y la confirmación: aparece un segundo SKU
      // Shimano (ej. un refresco de Woo corrió en el medio).
      seedCatalogoMasivo(db, 'G409-2', 10, { marca: 'Shimano', idWoo: 181 });

      const real = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: 1, filtro, esperados: preview.body.esperados,
      });
      expect(real.status).toBe(409);
      expect(real.body.ok).toBe(false);

      // No se escribió nada: ni G409-1 ni G409-2 tienen config.
      const count = db.prepare('SELECT COUNT(*) n FROM skus_config_ml').get().n;
      expect(count).toBe(0);
    });

    it('esperados coincide → aplica normalmente (200)', async () => {
      seedCatalogoMasivo(db, 'G409-OK', 10, { marca: 'Sram', idWoo: 190 });
      const filtro = { marca: 'Sram' };
      const preview = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'solo_local', filtro, vista_previa: true,
      });
      const real = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'solo_local', filtro, esperados: preview.body.esperados,
      });
      expect(real.status).toBe(200);
      expect(real.body.ok).toBe(true);
    });
  });

  describe('POST /config-ml/lote: dedup de SKU duplicado en catalogo_cache', () => {
    it('un SKU en 3 filas cuenta una sola vez en el resumen y se aplica una sola config', async () => {
      seedCatalogoMasivo(db, 'LOTE-DUP', 20, { idWoo: 200 });
      seedCatalogoMasivo(db, 'LOTE-DUP', 5, { idWoo: 202 });
      seedCatalogoMasivo(db, 'LOTE-DUP', 5, { idWoo: 201 }); // empata en stock, gana por menor id_woo

      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: 2, skus: ['LOTE-DUP'],
      });
      expect(res.body.resumen.solicitados).toBe(1);
      expect(res.body.resumen.aplicados).toBe(1);

      const rows = db.prepare("SELECT * FROM skus_config_ml WHERE sku='LOTE-DUP'").all();
      expect(rows).toHaveLength(1);
      expect(rows[0].nombre).toBe('Prod LOTE-DUP'); // nombre de la fila ganadora del dedup
    });

    it('dedup también aplica al resolver por filtro (no una config por cada fila duplicada)', async () => {
      seedCatalogoMasivo(db, 'LOTE-DUP-F', 20, { marca: 'Shimano', idWoo: 210 });
      seedCatalogoMasivo(db, 'LOTE-DUP-F', 5, { marca: 'Shimano', idWoo: 211 });

      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'quitar', filtro: { marca: 'Shimano', q: 'LOTE-DUP-F' },
      });
      expect(res.body.resumen.solicitados).toBe(1);
    });
  });

  describe('POST /config-ml/lote: SKUs inexistentes en catalogo_cache', () => {
    it('no se insertan y se reportan en resumen.inexistentes con el sku tal cual se envió', async () => {
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'reserva', reserva: 1, skus: ['NO-EXISTE-1', 'NO-EXISTE-2'],
      });
      expect(res.status).toBe(200);
      expect(res.body.resumen).toMatchObject({ solicitados: 2, aplicados: 0, inexistentes: ['NO-EXISTE-1', 'NO-EXISTE-2'] });
      expect(db.prepare('SELECT COUNT(*) n FROM skus_config_ml').get().n).toBe(0);
    });

    it('mezcla existentes e inexistentes: solo se aplican los existentes', async () => {
      seedCatalogoMasivo(db, 'MIX-1', 5, { idWoo: 220 });
      const res = await request(app).post('/api/sync/config-ml/lote').send({
        accion: 'solo_local', skus: ['MIX-1', 'MIX-NO-EXISTE'],
      });
      expect(res.body.resumen.aplicados).toBe(1);
      expect(res.body.resumen.inexistentes).toEqual(['MIX-NO-EXISTE']);
      expect(db.prepare("SELECT * FROM skus_config_ml WHERE sku='MIX-1'").get()).toBeTruthy();
      expect(db.prepare("SELECT * FROM skus_config_ml WHERE sku='MIX-NO-EXISTE'").get()).toBeUndefined();
    });
  });

  describe('POST /config-ml/lote: atomicidad de la transacción', () => {
    it('un lote válido se aplica completo en una sola transacción (todas las filas quedan escritas)', async () => {
      // No hay forma limpia de forzar una excepción a mitad de camino sin tocar producción;
      // este test verifica el comportamiento observable (todo o nada) con un lote grande,
      // confirmando que no queda ninguna fila a medio escribir tras una corrida exitosa.
      const skus = [];
      for (let i = 0; i < 50; i++) {
        const sku = `ATOM-${i}`;
        seedCatalogoMasivo(db, sku, 10, { idWoo: 300 + i });
        skus.push(sku);
      }
      const res = await request(app).post('/api/sync/config-ml/lote').send({ accion: 'reserva', reserva: 1, skus });
      expect(res.status).toBe(200);
      expect(res.body.resumen.aplicados).toBe(50);
      const count = db.prepare('SELECT COUNT(*) n FROM skus_config_ml').get().n;
      expect(count).toBe(50);
    });
  });
});
