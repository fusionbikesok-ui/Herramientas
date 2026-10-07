import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  retenerPedidoMl, liberarRetenidasResueltas, pedidoMlRetenido,
  claveCubiertaParaVenta, claveFrenadaParaVenta, esOmitir,
} from '../lib/guardiaMl.js';

const FILE = './test/tmp-fase-c-retencion.sqlite';
const now = () => new Date().toISOString();

function cache(db, clave, sku = '') {
  const [item, variacion = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`).run(clave, item, variacion, 'Pub', 'active', sku, 1, now());
}
function catalogo(db, sku) {
  db.prepare('INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,?,?,?)')
    .run(Math.floor(Math.random() * 1e9), 'Producto ' + sku, sku, 'simple', 2, now());
}
function decision(db, clave, sku, accion = 'confirmar') {
  db.prepare('INSERT INTO sku_matcher_decisiones(clave,sku,accion,actualizado_en) VALUES (?,?,?,?)').run(clave, sku, accion, now());
}
function casoIdentidad(db, clave, estado, clasificacion) {
  db.prepare(`INSERT INTO identidad_casos (direccion, ml_key, clasificacion, estado, severidad, evidencia_fingerprint, primera_deteccion_en, ultima_deteccion_en)
    VALUES ('ml_fusion', ?, ?, ?, 'critica', 'fp', ?, ?)`).run(clave, clasificacion, estado, now(), now());
}
function retener(db, orderId, clave) {
  const [item, variacion] = clave.split('|');
  const items = [{ item: { id: item, variation_id: variacion || null, seller_sku: null, title: 'X' }, quantity: 1 }];
  db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en) VALUES (?, 0, NULL, ?)').run(orderId, now());
  db.prepare("INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?, ?, '[]', 'retenido', ?)").run(orderId, now(), now());
  retenerPedidoMl(db, { orderId, items, claves: [clave] });
}

describe('Fase C R5 — retención de ventas', () => {
  let db;
  const env = process.env.IDENTIDAD_PROTECCION;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    db.close();
    if (env === undefined) delete process.env.IDENTIDAD_PROTECCION; else process.env.IDENTIDAD_PROTECCION = env;
    for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) fs.rmSync(f, { force: true });
  });

  it('activo: decisión asignar/confirmar sin frenos cubre aunque el seller_sku remoto difiera', () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    catalogo(db, 'FB-1'); cache(db, 'MLA1|', 'OTRO'); decision(db, 'MLA1|', 'FB-1');
    expect(claveCubiertaParaVenta(db, 'MLA1|')).toBe(true);
    expect(claveFrenadaParaVenta(db, 'MLA1|')).toBe(false);
  });

  it('activo: sin decisión no cubre; con caso en intervención se frena y no cubre', () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    cache(db, 'MLA2|', ''); expect(claveCubiertaParaVenta(db, 'MLA2|')).toBe(false);
    catalogo(db, 'FB-3'); cache(db, 'MLA3|', 'FB-3'); decision(db, 'MLA3|', 'FB-3');
    casoIdentidad(db, 'MLA3|', 'intervencion', 'sku_exacto');
    expect(claveFrenadaParaVenta(db, 'MLA3|')).toBe(true);
    expect(claveCubiertaParaVenta(db, 'MLA3|')).toBe(false);
  });

  it('activo: omitir se detecta y no frena', () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    cache(db, 'MLA4|', ''); decision(db, 'MLA4|', 'X', 'omitir');
    expect(esOmitir(db, 'MLA4|')).toBe(true);
  });

  it('sombra: se conserva la regla de hoy (seller_sku divergente no cubre)', () => {
    process.env.IDENTIDAD_PROTECCION = 'sombra';
    catalogo(db, 'FB-1'); cache(db, 'MLA1|', 'OTRO'); decision(db, 'MLA1|', 'FB-1');
    expect(claveCubiertaParaVenta(db, 'MLA1|')).toBe(false);
  });

  it('liberarRetenidasResueltas: en activo libera una venta de clave omitir; en sombra no', () => {
    cache(db, 'MLA5|', ''); decision(db, 'MLA5|', 'X', 'omitir');
    retener(db, 'ORD-5', 'MLA5|');
    process.env.IDENTIDAD_PROTECCION = 'sombra';
    liberarRetenidasResueltas(db);
    expect(pedidoMlRetenido(db, 'ORD-5')).toBeTruthy();
    process.env.IDENTIDAD_PROTECCION = 'activo';
    expect(liberarRetenidasResueltas(db).liberadas).toBe(1);
    expect(pedidoMlRetenido(db, 'ORD-5')).toBeFalsy();
  });
});
