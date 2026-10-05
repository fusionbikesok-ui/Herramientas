import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { listarPausadasConStock, resumenSoloLocal } from '../lib/pausadasConStock.js';
import { registrarPausaMl } from '../lib/pausasMl.js';

const FILE = './test/tmp-pausadas-con-stock.sqlite';
const ISO = '2026-10-03T12:00:00.000Z';

describe('lista "Pausadas con stock en Woo"', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  function woo(sku, stock) {
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)").run(Math.floor(Math.random() * 1e9), `Prod ${sku}`, sku, stock, ISO);
  }
  function pub(n, { status = 'paused', sub = '', sellerSku = null, sku = null } = {}) {
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,sub_status,seller_sku,actualizado_en)
      VALUES (?,?,'',?,?,?,?,?)`).run(`MLA${n}|`, `MLA${n}`, `Pub ${n}`, status, sub, sellerSku, ISO);
    if (sku) db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en,origen) VALUES (?,?,'confirmar',?,'test')").run(`MLA${n}|`, sku, ISO);
  }
  const causas = (r) => Object.fromEntries(r.data.map((x) => [x.item_id, x.causa]));

  it('asigna la causa de cada pausada con stock y excluye activas y las sin stock en Woo', () => {
    woo('FB-1', 3); woo('FB-2', 3); woo('FB-3', 3); woo('FB-4', 3); woo('FB-5', 3); woo('FB-6', 0); woo('FB-7', 3); woo('FB-8', 3);
    pub(1, { sub: 'paused_by_seller', sku: 'FB-1' });
    pub(2, { sub: 'out_of_stock,paused_by_seller', sku: 'FB-2' });
    pub(3, { sub: '', sku: 'FB-3' });
    pub(4, { sub: 'out_of_stock', sku: 'FB-4' });
    pub(5, { sub: 'paused_by_seller', sellerSku: 'FB-5' }); // sin vínculo, su SKU tiene stock
    pub(6, { sub: 'paused_by_seller', sku: 'FB-6' }); // sin stock en Woo: no entra
    pub(7, { status: 'active', sku: 'FB-7' }); // activa: no entra
    pub(8, { sub: 'paused_by_seller', sku: 'FB-8' });
    db.prepare("INSERT INTO skus_config_ml (sku,nombre,modo,reserva,actualizado_en) VALUES ('FB-8','x','solo_local',0,?)").run(ISO);
    const r = listarPausadasConStock(db);
    expect(causas(r)).toEqual({ MLA1: 'paused_by_seller', MLA2: 'paused_by_seller', MLA3: 'pausa_vieja', MLA4: 'out_of_stock', MLA5: 'sin_vinculo', MLA8: 'solo_local' });
    expect(r.total).toBe(6);
    expect(r.resumen).toMatchObject({ paused_by_seller: 2, pausa_vieja: 1, out_of_stock: 1, sin_vinculo: 1, solo_local: 1, vigia: 0 });
  });

  it('pausa del vigía (aviso sin revisar con pausada=1) se rotula vigia y NO es reactivable hasta revisar', () => {
    woo('FB-1', 3);
    pub(1, { sub: 'paused_by_seller', sku: 'FB-1' });
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,sku,campo,valor_anterior,valor_nuevo,pausada,detectado_en)
      VALUES ('MLA1|','MLA1','FB-1','UNITS_PER_PACK','1','6',1,?)`).run(ISO);
    const [it] = listarPausadasConStock(db).data;
    expect(it).toMatchObject({ causa: 'vigia', reactivable: false, motivo_no_reactivable: 'aviso_abierto' });
    db.prepare("UPDATE ml_publicacion_cambios SET revisado_en=?, revisado_por='ana'").run(ISO);
    registrarPausaMl(db, { itemId: 'MLA1', actor: 'vigia', origen: 'vigia_formato' });
    expect(listarPausadasConStock(db).data[0]).toMatchObject({ causa: 'vigia', reactivable: true });
  });

  it('una pausa hecha desde esta app queda como pausa_app con quién y desde dónde', () => {
    woo('FB-1', 3);
    pub(1, { sub: 'paused_by_seller', sku: 'FB-1' });
    registrarPausaMl(db, { itemId: 'MLA1', actor: 'ana', origen: 'cobertura' });
    const [it] = listarPausadasConStock(db).data;
    expect(it.causa).toBe('pausa_app');
    expect(it.detalle).toMatchObject({ actor: 'ana', origen: 'cobertura' });
    expect(it.reactivable).toBe(true);
  });

  it('solo_local y sin vínculo no son reactivables; una paused_by_seller vinculada sí (siempre manual)', () => {
    woo('FB-1', 3); woo('FB-2', 3); woo('FB-3', 3);
    pub(1, { sub: 'paused_by_seller', sku: 'FB-1' });
    pub(2, { sub: 'paused_by_seller', sellerSku: 'FB-2' });
    pub(3, { sub: 'paused_by_seller', sku: 'FB-3' });
    db.prepare("INSERT INTO skus_config_ml (sku,nombre,modo,reserva,actualizado_en) VALUES ('FB-3','x','solo_local',0,?)").run(ISO);
    const por = Object.fromEntries(listarPausadasConStock(db).data.map((x) => [x.item_id, x]));
    expect(por.MLA1).toMatchObject({ reactivable: true, motivo_no_reactivable: null });
    expect(por.MLA2).toMatchObject({ reactivable: false, motivo_no_reactivable: 'sin_vinculo' });
    expect(por.MLA3).toMatchObject({ reactivable: false, motivo_no_reactivable: 'solo_local' });
  });

  it('filtra por causa', () => {
    woo('FB-1', 3); woo('FB-2', 3);
    pub(1, { sub: 'paused_by_seller', sku: 'FB-1' });
    pub(2, { sub: 'out_of_stock', sku: 'FB-2' });
    const r = listarPausadasConStock(db, { causa: 'out_of_stock' });
    expect(r.data.map((x) => x.item_id)).toEqual(['MLA2']);
    expect(r.total).toBe(2);
  });

  it('resumenSoloLocal cuenta SKUs configurados y publicaciones afectadas', () => {
    woo('FB-1', 3); woo('FB-2', 3);
    pub(1, { status: 'active', sku: 'FB-1' }); pub(2, { sku: 'FB-1' }); pub(3, { sku: 'FB-2' });
    db.prepare("INSERT INTO skus_config_ml (sku,nombre,modo,reserva,actualizado_en) VALUES ('FB-1','x','solo_local',0,?),('FB-2','y','reserva',1,?),('FB-9','z','solo_local',0,?)").run(ISO, ISO, ISO);
    expect(resumenSoloLocal(db)).toEqual({ skus: 2, publicaciones: 2 });
  });

  it('trae foto, stock de ML, precio de contado por variación y plata en juego, ordenado por plata', () => {
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,regular_price,actualizado_en) VALUES (1,'A','FB-A','simple',4,1000,1000,?)").run(ISO);
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,regular_price,actualizado_en) VALUES (2,'B','FB-B','simple',2,5000,5000,?)").run(ISO);
    pub(1, { sub: 'paused_by_seller', sku: 'FB-A' });
    pub(2, { sub: 'paused_by_seller', sku: 'FB-B' });
    db.prepare("UPDATE ml_publicaciones_cache SET thumbnail='http://x/t.jpg', available_quantity=0 WHERE item_id='MLA2'").run();
    const r = listarPausadasConStock(db);
    expect(r.data.map((x) => x.item_id)).toEqual(['MLA2', 'MLA1']); // 2 × 5000 > 4 × 1000 (con el descuento de contado)
    const b = r.data[0];
    expect(b).toMatchObject({ thumbnail: 'https://x/t.jpg', stock_ml: 0, stock_woo: 2, sin_precio: false });
    expect(b.variaciones[0].precio_contado).toBeGreaterThan(0);
    expect(b.en_juego).toBe(Math.round(2 * b.variaciones[0].precio_contado));
  });

  it('stock_ml es null si ML no informó (no 0) y thumbnail/permalink solo aceptan http(s)', () => {
    db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,regular_price,actualizado_en) VALUES (1,'A','FB-A','simple',4,1000,1000,?)").run(ISO);
    pub(1, { sub: 'paused_by_seller', sku: 'FB-A' });
    db.prepare("UPDATE ml_publicaciones_cache SET available_quantity=NULL, thumbnail='javascript:alert(1)', permalink='//evil' WHERE item_id='MLA1'").run();
    const a = listarPausadasConStock(db).data[0];
    expect(a.stock_ml).toBeNull();
    expect(a.variaciones[0].stock_ml).toBeNull();
    expect(a.thumbnail).toBeNull();
    expect(a.permalink).toBeNull();
  });
});
