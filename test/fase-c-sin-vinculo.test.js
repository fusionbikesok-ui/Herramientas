import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { syncWcToMl } from '../routes/sync.js';

const TEST_DB = './test/fase-c-sin-vinculo.sqlite';
const CFG = { ml: { clientId: 'c', clientSecret: 's', userId: '9' }, woo: { url: 'https://x', ck: 'a', cs: 'b' } };
const TS = '2026-10-07T12:00:00.000Z';

describe('Fase C: R4 en el sync (publicación nueva sin vínculo → stock 0)', () => {
  let db;
  const env0 = process.env.IDENTIDAD_PROTECCION;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); vi.useFakeTimers(); mlFetch.mockResolvedValue({ status: 200, data: {} }); });
  afterEach(() => {
    vi.useRealTimers(); db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (env0 === undefined) delete process.env.IDENTIDAD_PROTECCION; else process.env.IDENTIDAD_PROTECCION = env0;
  });

  const pub = (n, { vid = '', sku = null, qty = 5, status = 'active' } = {}) => {
    const clave = `MLA${n}|${vid}`;
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
      VALUES (?,?,?,'x',?,?,?,datetime('now'))`).run(clave, `MLA${n}`, vid, status, sku, qty);
    return clave;
  };
  const caso = (clave, clasificacion = 'sku_ausente', estado = 'urgente') => db.prepare(`INSERT INTO identidad_casos
    (direccion,ml_key,clasificacion,estado,severidad,evidencia_fingerprint,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,?,?,'urgente','fp',?,?)`).run(clave, clasificacion, estado, TS, TS);
  const correr = async () => { const p = syncWcToMl(db, CFG); await vi.runAllTimersAsync(); await p; };
  const puts = () => mlFetch.mock.calls.filter((c) => c[2] === 'put');

  it('activo: la publicación nueva sin SKU, con caso abierto, recibe 0 una sola vez', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const c = pub(1); caso(c);
    await correr();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].slice(3)).toEqual(['/items/MLA1', { available_quantity: 0 }]);
    expect(db.prepare('SELECT cantidad_ml FROM ml_stock_estado WHERE clave=?').get(c).cantidad_ml).toBe(0);
    expect(db.prepare("SELECT estado FROM sync_log WHERE clave=? AND direccion='wc_ml'").get(c).estado).toBe('ok');
    await correr(); // ya está en 0 en nuestro estado: no repite el PUT aunque el cache de ML tarde en refrescarse
    expect(puts()).toHaveLength(1);
  });

  it('activo: una variación usa el endpoint puntual de la variación', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const c = pub(2, { vid: '77' }); caso(c, 'sku_inexistente', 'tomado');
    await correr();
    expect(puts()[0].slice(3)).toEqual(['/items/MLA2/variations/77', { available_quantity: 0 }]);
  });

  it('sombra (default): no manda nada', async () => {
    delete process.env.IDENTIDAD_PROTECCION;
    pub(1); caso('MLA1|');
    await correr();
    expect(puts()).toHaveLength(0);
  });

  it('activo: omitir, ya vinculada, caso resuelto y pausada no se tocan', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const dec = (c, sku, accion) => db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,?,datetime('now'))").run(c, sku, accion);
    const a = pub(1); caso(a); dec(a, null, 'omitir');
    const b = pub(2, { sku: 'FB-2' }); caso(b); dec(b, 'FB-2', 'confirmar');   // vinculada sin stock en Woo: la CTE no la ve (no hay catalogo)
    const c = pub(3); caso(c, 'sku_ausente', 'resuelto');
    const d = pub(4, { status: 'paused' }); caso(d);
    await correr();
    expect(puts()).toHaveLength(0);
  });

  it('activo: una clasificación que no es de «sin vínculo» no frena', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const c = pub(1, { sku: 'FB-1' }); caso(c, 'gtin_contradictorio');
    await correr();
    expect(puts()).toHaveLength(0);
  });
});
