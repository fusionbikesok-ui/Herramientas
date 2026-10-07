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
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); vi.useFakeTimers(); mlFetch.mockResolvedValue({ status: 200, data: {} }); auditConfiable(); catalogoNoVacio(); });
  afterEach(() => {
    vi.useRealTimers(); db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (env0 === undefined) delete process.env.IDENTIDAD_PROTECCION; else process.env.IDENTIDAD_PROTECCION = env0;
  });

  const auditConfiable = (en = new Date().toISOString()) => db.prepare('UPDATE identidad_config SET ultimo_scan_confiable_en=? WHERE id=1').run(en);
  const catalogoNoVacio = () => db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (999,'P','FB-X','simple',1,?)").run(TS);
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

  it('MEDIO 1: con backlog > tope, la clave R4 se envía en la primera corrida', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    for (let i = 1; i <= 5; i++) {
      const sku = `FB-${i}`;
      db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',3,?)").run(100 + i, sku, sku, TS);
      const c = pub(100 + i, { sku, qty: 9 });
      db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,'confirmar',?)").run(c, sku, TS);
    }
    const r4 = pub(1); caso(r4);
    const p = syncWcToMl(db, CFG, { maxLlamadas: 2 }); await vi.runAllTimersAsync(); await p;
    expect(puts().some((c) => c[3] === '/items/MLA1')).toBe(true);
  });

  it('MEDIO 2a: catálogo vacío o audit no confiable → R4 no aplica', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const c = pub(1); caso(c);
    db.prepare('DELETE FROM catalogo_cache').run();
    await correr(); expect(puts()).toHaveLength(0);
    catalogoNoVacio(); auditConfiable(null);
    await correr(); expect(puts()).toHaveLength(0);
    auditConfiable(new Date(Date.now() - 7 * 3600e3).toISOString());
    await correr(); expect(puts()).toHaveLength(0);
    auditConfiable();
    await correr(); expect(puts()).toHaveLength(1);
  });

  it('MEDIO 2b: más de 20 claves R4 en una corrida → no se aplica ninguna y se abre incidente crítico', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    for (let i = 1; i <= 21; i++) caso(pub(i));
    await correr();
    expect(puts()).toHaveLength(0);
    const inc = db.prepare("SELECT severidad, estado, mensaje_humano FROM incidentes_operativos WHERE integracion='mercadolibre' AND proceso='fase_c_r4'").get();
    expect(inc).toMatchObject({ severidad: 'critico', estado: 'activo' });
    expect(inc.mensaje_humano).toContain('21');
  });

  it('BAJO 3: si alguien subió stock a mano (cache más nuevo que nuestro 0) se reenvía el 0', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const c = pub(1); caso(c);
    db.prepare("INSERT INTO ml_stock_estado (clave,sku,cantidad_ml,actualizado_en) VALUES (?,?,0,'2020-01-01T00:00:00.000Z')").run(c, 'x');
    await correr();
    expect(puts()).toHaveLength(1);
  });

  it('BAJO 4: no guarda sku vacío en ml_stock_estado', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const c = pub(1, { sku: 'ABC' }); caso(c, 'sku_inexistente');
    await correr();
    expect(db.prepare('SELECT sku FROM ml_stock_estado WHERE clave=?').get(c).sku).toBe('ABC');
    const d = pub(2); caso(d);
    await correr();
    expect(db.prepare('SELECT sku FROM ml_stock_estado WHERE clave=?').get(d).sku).not.toBe('');
  });
});
