import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import {
  bootstrapProductosFusion, clavesAfectadasPorBajaWoo, clavesEsperandoProteccion, protegerPorBajaWoo,
} from '../lib/identidadProductos.js';

const FILE = './test/tmp-proteccion-woo.sqlite';
const ISO = '2026-09-06T12:00:00.000Z';

function woo(db, { id, sku, stock = 3 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
    VALUES (?,?,?,'simple',?,?)`).run(id, `Producto ${id}`, sku, stock, ISO);
}

function ml(db, { clave, sku, stock = 2, status = 'active', canales = '["marketplace"]' }) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,canales_json,actualizado_en)
    VALUES (?,?,'','Publicación',?,?,1,?,?,?)`)
    .run(clave, clave.split('|')[0], status, sku, stock, canales, ISO);
}

// `pedidos_cache` la crea el router de preparación, no el esquema base: se replica acá para
// poder probar la retención de verdad en vez de saltearla.
function crearPedidosCache(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
    clave TEXT PRIMARY KEY, canal TEXT, ml_order_id TEXT, wc_order_id INTEGER,
    items_json TEXT, actualizado_en TEXT)`).run();
}

function pedidoMl(db, { orderId, sku, wcOrderId = 0 }) {
  crearPedidosCache(db);
  db.prepare(`INSERT INTO pedidos_cache (clave,canal,ml_order_id,wc_order_id,items_json,actualizado_en)
    VALUES (?, 'ml', ?, ?, ?, ?)`)
    .run('ml-' + orderId, String(orderId), wcOrderId, JSON.stringify([{ sku, cantidad: 1 }]), ISO);
  db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id,wc_order_id,creado_en) VALUES (?,?,?)')
    .run(String(orderId), wcOrderId, ISO);
}

describe('protección Woo→ML: la mitad que no escribe en ML', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('exige que la baja esté confirmada antes de tocar nada', () => {
    // Un webhook espurio o una lectura a medias retendría pedidos de productos vivos.
    woo(db, { id: 10, sku: 'FB-10' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA1|', sku: 'FB-10' });

    expect(protegerPorBajaWoo(db, { idWoo: 10, sku: 'FB-10' })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(clavesEsperandoProteccion(db)).toEqual([]);
  });

  it('abre un caso woo_ml crítico por cada clave ML afectada', () => {
    woo(db, { id: 11, sku: 'FB-11' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA2|', sku: 'FB-11', stock: 5 });

    const r = protegerPorBajaWoo(db, { idWoo: 11, sku: 'FB-11', confirmado: true }, 'ana');
    expect(r).toMatchObject({ ok: true, claves: 1, casos: 1 });

    const caso = db.prepare("SELECT * FROM identidad_casos WHERE direccion='woo_ml'").get();
    expect(caso).toMatchObject({ ml_key: 'MLA2|', estado: 'urgente', severidad: 'critica', clasificacion: 'baja_woo' });
    expect(clavesEsperandoProteccion(db)).toHaveLength(1);
  });

  it('encuentra la publicación por SKU aunque nunca se haya verificado su identidad', () => {
    // La identidad activa cubre lo que Fusion verificó; una publicación puede llevar el SKU sin
    // haber llegado nunca a verificarse, y es justo la que nadie miró.
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA3|', sku: 'HUERFANO-1' });

    expect(clavesAfectadasPorBajaWoo(db, { sku: 'HUERFANO-1' })).toHaveLength(1);
    expect(protegerPorBajaWoo(db, { sku: 'HUERFANO-1', confirmado: true })).toMatchObject({ claves: 1, casos: 1 });
  });

  it('ignora los links de pago de Mercado Pago', () => {
    // No se venden por el marketplace: no hay stock que proteger ni preparación que frenar.
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA4|', sku: 'MP-1', canales: '["mp-merchants","mp-link"]' });

    expect(clavesAfectadasPorBajaWoo(db, { sku: 'MP-1' })).toEqual([]);
  });

  it('retiene los pedidos que todavía no bajaron a Woo', () => {
    woo(db, { id: 12, sku: 'FB-12' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA5|', sku: 'FB-12' });
    pedidoMl(db, { orderId: 5001, sku: 'FB-12' });

    const r = protegerPorBajaWoo(db, { idWoo: 12, sku: 'FB-12', confirmado: true });
    expect(r.pedidos_retenidos).toBe(1);
    const ret = db.prepare("SELECT * FROM guardia_ml_pedidos_retenidos WHERE estado='retenido'").get();
    expect(ret).toMatchObject({ ml_order_id: '5001', motivo: 'baja_woo' });
  });

  it('no retiene un pedido ya sincronizado a Woo', () => {
    // El cliente compró y la unidad salió: retenerlo no devuelve nada y frena una preparación.
    woo(db, { id: 13, sku: 'FB-13' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA6|', sku: 'FB-13' });
    pedidoMl(db, { orderId: 5002, sku: 'FB-13', wcOrderId: 777 });

    expect(protegerPorBajaWoo(db, { idWoo: 13, sku: 'FB-13', confirmado: true }).pedidos_retenidos).toBe(0);
  });

  it('es idempotente: el mismo webhook repetido no duplica casos ni retenciones', () => {
    // Los webhooks de Woo llegan repetidos con normalidad.
    woo(db, { id: 14, sku: 'FB-14' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA7|', sku: 'FB-14' });
    pedidoMl(db, { orderId: 5003, sku: 'FB-14' });

    const primera = protegerPorBajaWoo(db, { idWoo: 14, sku: 'FB-14', confirmado: true });
    const segunda = protegerPorBajaWoo(db, { idWoo: 14, sku: 'FB-14', confirmado: true });

    expect(primera).toMatchObject({ casos: 1, pedidos_retenidos: 1 });
    expect(segunda).toMatchObject({ casos: 0, pedidos_retenidos: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE direccion='woo_ml'").get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM guardia_ml_pedidos_retenidos').get().n).toBe(1);
  });

  it('no inventa trabajo cuando no hay ninguna publicación viva', () => {
    woo(db, { id: 15, sku: 'FB-15' });
    bootstrapProductosFusion(db);
    expect(protegerPorBajaWoo(db, { idWoo: 15, sku: 'FB-15', confirmado: true }))
      .toEqual({ ok: true, claves: 0, casos: 0, pedidos_retenidos: 0 });
  });

  it('ordena por stock expuesto: primero lo que más se puede vender sin tener', () => {
    woo(db, { id: 16, sku: 'FB-16' });
    woo(db, { id: 17, sku: 'FB-17' });
    bootstrapProductosFusion(db);
    ml(db, { clave: 'MLA8|', sku: 'FB-16', stock: 1 });
    ml(db, { clave: 'MLA9|', sku: 'FB-17', stock: 9 });
    protegerPorBajaWoo(db, { idWoo: 16, sku: 'FB-16', confirmado: true });
    protegerPorBajaWoo(db, { idWoo: 17, sku: 'FB-17', confirmado: true });

    expect(clavesEsperandoProteccion(db).map((x) => x.ml_key)).toEqual(['MLA9|', 'MLA8|']);
  });
});
