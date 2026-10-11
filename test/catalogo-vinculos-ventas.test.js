import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { importarGestionPedidos } from '../lib/gestionPedidos.js';
import { plataEnJuego } from '../lib/catalogoVinculos.js';

const FILE = './test/tmp-catalogo-vinculos-ventas.sqlite';
const AHORA = new Date('2026-10-09T12:00:00.000Z');
const dias = (n) => new Date(AHORA.getTime() - n * 86400000).toISOString();

function pub(db, clave, sku) {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,'Pub','active',?,1,1,'[]',?)`).run(clave, item, variation, sku, AHORA.toISOString());
}
function woo(db, id, sku, stock) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`).run(id, `P${id}`, sku, stock, AHORA.toISOString());
}
function caso(db, { clave, productoId = null, deteccion }) {
  db.prepare(`INSERT INTO identidad_casos (direccion,ml_key,producto_id,clasificacion,estado,severidad,evidencia_fingerprint,expected_version,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,?,'sku_ausente','urgente','urgente','fp',1,?,?)`).run(clave, productoId, deteccion, deteccion);
}
function venta(db, { id, clave, sku, cantidad, fecha, estado = 'paid' }) {
  const [item, variation = ''] = clave.split('|');
  importarGestionPedidos(db, [{ canal: 'ml', ml_order_id: id, numero: id, fecha, estado, comprador: { nickname: 'x' },
    items: [{ item_id_ml: item, variation_id_ml: variation, clave, seller_sku: sku, nombre: 'N', cantidad }] }]);
}

describe('plataEnJuego: ventas ML 30 días × stock Woo, por publicación', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => { try { db.close(); } catch { /* ya cerrada */ } for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  it('persiste ml_key en cada ítem de una venta ML', () => {
    venta(db, { id: 'V1', clave: 'MLA1|', sku: 'FB-1', cantidad: 2, fecha: dias(1) });
    expect(db.prepare('SELECT ml_key FROM gestion_pedido_items').get().ml_key).toBe('MLA1|');
  });

  it('dos publicaciones con el mismo SKU suman solo sus propias ventas', () => {
    woo(db, 1, 'FB-1', 10);
    pub(db, 'MLA1|', 'FB-1'); pub(db, 'MLA2|', 'FB-1');
    const p = db.prepare("SELECT id FROM productos_fusion LIMIT 1").get();
    caso(db, { clave: 'MLA1|', deteccion: dias(5) }); caso(db, { clave: 'MLA2|', deteccion: dias(4) });
    db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('MLA1|','FB-1','confirmar',?),('MLA2|','FB-1','confirmar',?)").run(dias(9), dias(9));
    venta(db, { id: 'V1', clave: 'MLA1|', sku: 'FB-1', cantidad: 3, fecha: dias(2) });
    venta(db, { id: 'V2', clave: 'MLA2|', sku: 'FB-1', cantidad: 1, fecha: dias(2) });
    const r = plataEnJuego(db, { ahora: AHORA });
    expect(r.get('MLA1|')).toMatchObject({ unidades_30d: 3, stock_woo: 10, plata: 30 });
    expect(r.get('MLA2|')).toMatchObject({ unidades_30d: 1, stock_woo: 10, plata: 10 });
    expect(p).toBeUndefined();
  });

  it('ignora ventas de más de 30 días, canceladas y de otras fuentes', () => {
    woo(db, 1, 'FB-1', 5); pub(db, 'MLA1|', 'FB-1'); caso(db, { clave: 'MLA1|', deteccion: dias(5) });
    db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('MLA1|','FB-1','confirmar',?)").run(dias(9));
    venta(db, { id: 'VIEJA', clave: 'MLA1|', sku: 'FB-1', cantidad: 9, fecha: dias(40) });
    venta(db, { id: 'CANC', clave: 'MLA1|', sku: 'FB-1', cantidad: 9, fecha: dias(1), estado: 'cancelled' });
    venta(db, { id: 'OK', clave: 'MLA1|', sku: 'FB-1', cantidad: 2, fecha: dias(1) });
    expect(plataEnJuego(db, { ahora: AHORA }).get('MLA1|')).toMatchObject({ unidades_30d: 2, plata: 10 });
  });

  it('sin producto Woo o sin stock conocido la plata es 0', () => {
    pub(db, 'MLA1|', 'FB-X'); caso(db, { clave: 'MLA1|', deteccion: dias(5) });
    venta(db, { id: 'V1', clave: 'MLA1|', sku: 'FB-X', cantidad: 4, fecha: dias(1) });
    expect(plataEnJuego(db, { ahora: AHORA }).get('MLA1|')).toMatchObject({ unidades_30d: 4, stock_woo: null, plata: 0 });
  });

  it('ordena por plata descendente y, con empate, el caso más antiguo primero', () => {
    woo(db, 1, 'FB-1', 10); woo(db, 2, 'FB-2', 10); woo(db, 3, 'FB-3', 10);
    for (const [c, s] of [['MLA1|', 'FB-1'], ['MLA2|', 'FB-2'], ['MLA3|', 'FB-3']]) {
      pub(db, c, s);
      db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,'confirmar',?)").run(c, s, dias(9));
    }
    caso(db, { clave: 'MLA1|', deteccion: dias(2) }); caso(db, { clave: 'MLA2|', deteccion: dias(8) }); caso(db, { clave: 'MLA3|', deteccion: dias(5) });
    venta(db, { id: 'A', clave: 'MLA1|', sku: 'FB-1', cantidad: 1, fecha: dias(1) });
    venta(db, { id: 'B', clave: 'MLA2|', sku: 'FB-2', cantidad: 1, fecha: dias(1) });
    venta(db, { id: 'C', clave: 'MLA3|', sku: 'FB-3', cantidad: 5, fecha: dias(1) });
    const orden = [...plataEnJuego(db, { ahora: AHORA }).values()].map((x) => x.ml_key);
    expect(orden).toEqual(['MLA3|', 'MLA2|', 'MLA1|']);
  });
});
