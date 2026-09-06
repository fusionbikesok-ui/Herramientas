import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import {
  bootstrapProductosFusion, identificadorPrincipal, reordenarIdentificadores, sembrarIdentificadoresMl,
} from '../lib/identidadProductos.js';

const FILE = './test/tmp-identificadores-ml.sqlite';
const ISO = '2026-09-06T12:00:00.000Z';

function woo(db, { id, sku, gtin = null, padre = null, stock = 2 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,gtin,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, `Producto ${id}`, sku, padre ? 'variation' : 'simple', padre, stock, gtin, ISO);
}

function ml(db, { clave, sku, gtin, stock = 2, status = 'active' }) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,actualizado_en)
    VALUES (?,?,'','Publicación',?,?,1,?,?,?)`).run(clave, clave.split('|')[0], status, sku, gtin, stock, ISO);
}

const gtinDe = (db, productoId) => db.prepare(
  `SELECT valor_normalizado, valor_crudo, subtipo, fuente, estado, orden
   FROM identificadores_producto WHERE tipo='gtin' AND producto_id=? ORDER BY orden, id`,
).all(productoId);

const idDe = (db, idWoo) => db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(idWoo).id;

describe('siembra de identificadores GTIN desde ML', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('siembra en forma canónica el GTIN que sólo conocía ML', () => {
    woo(db, { id: 10, sku: 'FB-10' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA1|', sku: 'FB-10', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 1, conflictos: 0, absorbidos: 0 });
    expect(gtinDe(db, idDe(db, 10))).toMatchObject([{
      valor_normalizado: '00602883701731', valor_crudo: '602883701731',
      subtipo: 'upc_a', fuente: 'ml', estado: 'activo',
    }]);
  });

  it('reconoce como el mismo código el que Woo y ML escriben con distinto relleno', () => {
    // El caso que motivó todo: 13 pares de producción diferían sólo en los ceros.
    woo(db, { id: 11, sku: 'FB-11', gtin: '602883701731' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA2|', sku: 'FB-11', gtin: '0602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 0, conflictos: 0 });
    // Una sola fila: no se duplica el identificador ni se abre un conflicto falso.
    expect(gtinDe(db, idDe(db, 11))).toHaveLength(1);
  });

  it('absorbe las variaciones que heredaron el GTIN del padre', () => {
    // 28 casos de producción: talles de un mismo producto compartiendo código.
    // Es deuda de catálogo, no ambigüedad de identidad: no genera trabajo humano.
    woo(db, { id: 20, sku: 'FB-20', gtin: '602883701731' });
    woo(db, { id: 21, sku: 'FB-21', padre: 20 });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA3|', sku: 'FB-21', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ conflictos: 0, absorbidos: 1 });
    expect(gtinDe(db, idDe(db, 21))).toHaveLength(0);
  });

  it('registra el conflicto entre productos distintos en vez de descartarlo', () => {
    // Antes, el INSERT OR IGNORE hacía desaparecer este caso sin dejar rastro.
    woo(db, { id: 30, sku: 'FB-30', gtin: '602883701731' });
    woo(db, { id: 31, sku: 'FB-31' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA4|', sku: 'FB-31', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ conflictos: 1, absorbidos: 0 });
    expect(gtinDe(db, idDe(db, 31))).toMatchObject([{ estado: 'conflicto', fuente: 'ml' }]);
    // El identificador original no se toca: el conflicto no le saca la identidad a nadie.
    expect(gtinDe(db, idDe(db, 30))).toMatchObject([{ estado: 'activo' }]);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='gtin_en_conflicto'").get().n).toBe(1);
  });

  it('deja pasar el conflicto por el índice parcial pero no dos activos', () => {
    woo(db, { id: 40, sku: 'FB-40', gtin: '602883701731' });
    woo(db, { id: 41, sku: 'FB-41' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA5|', sku: 'FB-41', gtin: '602883701731' });
    sembrarIdentificadoresMl(db);

    expect(() => db.prepare(
      "UPDATE identificadores_producto SET estado='activo' WHERE estado='conflicto'",
    ).run()).toThrow();
  });

  it('deriva las publicaciones sin respaldo en Woo marcando stock y estado', () => {
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA6|', sku: 'NO-EXISTE', gtin: '602883701731', stock: 4 });
    ml(db, { clave: 'MLA7|', sku: 'TAMPOCO', gtin: '4006381333931', stock: 0, status: 'paused' });

    const r = sembrarIdentificadoresMl(db);
    expect(r.sembrados).toBe(0);
    expect(r.sinRespaldoWoo).toEqual([
      { clave: 'MLA6|', seller_sku: 'NO-EXISTE', gtin: '602883701731', stock: 4, activa: true },
      { clave: 'MLA7|', seller_sku: 'TAMPOCO', gtin: '4006381333931', stock: 0, activa: false },
    ]);
  });

  it('no siembra cuando el SKU vive en más de un producto Woo', () => {
    // Ese caso ya lo reporta `sku_no_unico`; elegir acá sería elegir al azar.
    woo(db, { id: 50, sku: 'DUP' });
    woo(db, { id: 51, sku: 'DUP' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA8|', sku: 'DUP', gtin: '602883701731' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 0, conflictos: 0 });
  });

  it('ignora los códigos que no son GTIN válidos', () => {
    woo(db, { id: 60, sku: 'FB-60' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA9|', sku: 'FB-60', gtin: 'N/A' });
    ml(db, { clave: 'MLA10|', sku: 'FB-60', gtin: '4006381333932' });

    expect(sembrarIdentificadoresMl(db)).toMatchObject({ sembrados: 0, sinRespaldoWoo: [] });
  });

  it('es idempotente: correrla de nuevo no duplica ni reabre nada', () => {
    woo(db, { id: 70, sku: 'FB-70' });
    woo(db, { id: 71, sku: 'FB-71' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA11|', sku: 'FB-70', gtin: '602883701731' });
    ml(db, { clave: 'MLA12|', sku: 'FB-71', gtin: '602883701731' });

    const primera = sembrarIdentificadoresMl(db);
    const total = db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE tipo='gtin'").get().n;
    const segunda = sembrarIdentificadoresMl(db);

    expect(segunda.sembrados).toBe(0);
    expect(segunda.conflictos).toBe(0);
    expect(primera.sembrados + primera.conflictos).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) n FROM identificadores_producto WHERE tipo='gtin'").get().n).toBe(total);
  });
});

describe('orden de prioridad de identificadores', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  function productoConDos() {
    // Dos códigos legítimos del mismo artículo, como Shimano-JP y Shimano-US.
    woo(db, { id: 80, sku: 'FB-80', gtin: '4524667220343' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA20|', sku: 'FB-80', gtin: '689228220348' });
    sembrarIdentificadoresMl(db);
    return idDe(db, 80);
  }

  it('elige como principal el primero del orden configurado', () => {
    const id = productoConDos();
    expect(gtinDe(db, id)).toHaveLength(2);
    // Con la prioridad por defecto (woo,ml) gana el que Woo ya publica, así el
    // orden inicial no cambia en silencio lo que hoy ve un cliente.
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('04524667220343');
  });

  it('deja reordenar cuál gana, sin perder los otros', () => {
    const id = productoConDos();
    const r = reordenarIdentificadores(db, id, ['00689228220348', '04524667220343']);

    expect(r).toMatchObject({ ok: true, principal: '00689228220348' });
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('00689228220348');
    expect(gtinDe(db, id)).toHaveLength(2);
  });

  it('rechaza una lista que no cubre todos los activos', () => {
    // Completarla sola dejaría al faltante en una posición que nadie eligió,
    // y podría terminar primero.
    const id = productoConDos();
    expect(reordenarIdentificadores(db, id, ['00689228220348'])).toMatchObject({ ok: false });
    expect(reordenarIdentificadores(db, id, ['00689228220348', '00000000000000'])).toMatchObject({ ok: false });
    expect(identificadorPrincipal(db, id).valor_normalizado).toBe('04524667220343');
  });

  it('resuelve el principal de forma estable cuando comparten orden', () => {
    // Situación normal tras un backfill: sin desempate por id, la proyección a
    // Woo podría cambiar sola entre dos corridas.
    const id = productoConDos();
    db.prepare("UPDATE identificadores_producto SET orden=10 WHERE tipo='gtin' AND producto_id=?").run(id);
    const primera = identificadorPrincipal(db, id).id;
    expect(identificadorPrincipal(db, id).id).toBe(primera);
  });

  it('respeta la prioridad configurada al sembrar', () => {
    db.prepare("UPDATE identidad_config SET identificadores_prioridad='ml,woo,manual' WHERE id=1").run();
    const id = productoConDos();
    expect(identificadorPrincipal(db, id).fuente).toBe('ml');
  });
});
