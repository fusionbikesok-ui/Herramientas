import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  retenerPedidoMl, pedidoMlRetenido, liberarRetenidasResueltas, liberarPedidoRetenido, clavesDePedidoRetenido,
} from '../lib/guardiaMl.js';
import { guardiaMlRouter } from '../routes/guardiaMl.js';

const FILE = './test/tmp-guardia-retenidas-auto.sqlite';
const now = () => new Date().toISOString();

function cache(db, clave, sku = '') {
  const [item, variacion = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`).run(clave, item, variacion, 'Pub ' + clave, 'active', sku, 1, now());
}
function catalogo(db, sku) {
  db.prepare('INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,?,?,?)')
    .run(Math.floor(Math.random() * 1e9), 'Producto ' + sku, sku, 'simple', 2, now());
}
function decision(db, clave, sku) {
  db.prepare("INSERT INTO sku_matcher_decisiones(clave,sku,accion,actualizado_en) VALUES (?,?,'confirmar',?)").run(clave, sku, now());
}
function itemOrden(itemId, variationId = null, { sellerSku = null, title = 'Caramañola Camelbak' } = {}) {
  return { item: { id: itemId, variation_id: variationId, seller_sku: sellerSku, title }, quantity: 1 };
}
// Deja la venta como la deja syncMlToWc al retener: reserva wc_order_id=0 y orden procesada.
function retener(db, orderId, items, claves) {
  db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en) VALUES (?, 0, NULL, ?)').run(orderId, now());
  db.prepare("INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?, ?, '[]', 'retenido', ?)").run(orderId, now(), now());
  retenerPedidoMl(db, { orderId, items, claves });
}
const aviso = (db, orderId) => db.prepare("SELECT estado, severidad FROM incidentes_operativos WHERE integracion='guardia_ml' AND proceso='venta_retenida' AND tipo_error=?").get(orderId);
const caso = (db, clave) => db.prepare('SELECT * FROM guardia_ml_casos WHERE clave=?').get(clave);

describe('Guardia ML — ventas retenidas: liberación automática y aviso', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => { db.close(); for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) fs.rmSync(f, { force: true }); });

  it('arma las claves con el formato de normalizarOrdenMl y no inventa claves si falta un id', () => {
    expect(clavesDePedidoRetenido({ items_json: JSON.stringify([itemOrden('MLA1', 123, { sellerSku: 'FB-1' }), itemOrden('MLA2')]) }))
      .toEqual([{ clave: 'MLA1|123', sellerSku: 'FB-1' }, { clave: 'MLA2|', sellerSku: '' }]);
    expect(clavesDePedidoRetenido({ items_json: JSON.stringify([{ item_id: 'X' }]) })).toEqual([]);
    expect(clavesDePedidoRetenido({ items_json: 'no-json' })).toEqual([]);
  });

  it('retener abre una alerta advertencia por venta y no duplica al retener dos veces', () => {
    retener(db, 'ORD-A', [itemOrden('MLA10')], ['MLA10|']);
    retenerPedidoMl(db, { orderId: 'ORD-A', items: [itemOrden('MLA10')], claves: ['MLA10|'] });
    expect(aviso(db, 'ORD-A')).toEqual({ estado: 'activo', severidad: 'advertencia' });
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='venta_retenida'").get().n).toBe(1);
    expect(db.prepare('SELECT mensaje_humano FROM incidentes_operativos WHERE tipo_error=?').get('ORD-A').mensaje_humano).toContain('Caramañola Camelbak');
  });

  it('libera sola cuando todas las claves quedan cubiertas: mismos efectos que el manual y alerta resuelta', () => {
    catalogo(db, 'FB-10'); cache(db, 'MLA10|', 'FB-10');
    retener(db, 'ORD-B', [itemOrden('MLA10')], ['MLA10|']);
    expect(liberarRetenidasResueltas(db)).toEqual({ revisadas: 1, liberadas: 0 }); // caso abierto bloquea

    decision(db, 'MLA10|', 'FB-10');
    db.prepare("UPDATE guardia_ml_casos SET estado='resuelto', bloquea_sync=0 WHERE clave='MLA10|'").run();
    expect(liberarRetenidasResueltas(db)).toEqual({ revisadas: 1, liberadas: 1 });

    expect(pedidoMlRetenido(db, 'ORD-B')).toBeUndefined();
    expect(db.prepare("SELECT estado, liberado_por FROM guardia_ml_pedidos_retenidos WHERE ml_order_id='ORD-B'").get()).toEqual({ estado: 'liberado', liberado_por: 'sistema' });
    expect(db.prepare("SELECT COUNT(*) n FROM ordenes_ml_wc_pedidos WHERE ml_order_id='ORD-B'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM ordenes_ml_procesadas WHERE order_id='ORD-B'").get().n).toBe(0);
    expect(aviso(db, 'ORD-B').estado).toBe('resuelto');
    expect(liberarRetenidasResueltas(db)).toEqual({ revisadas: 0, liberadas: 0 }); // idempotente
  });

  it('no libera si UNA de las claves sigue sin cubrir', () => {
    catalogo(db, 'FB-20'); cache(db, 'MLA20|', 'FB-20'); decision(db, 'MLA20|', 'FB-20');
    cache(db, 'MLA21|', '');
    retener(db, 'ORD-C', [itemOrden('MLA20'), itemOrden('MLA21')], ['MLA21|']);
    db.prepare("UPDATE guardia_ml_casos SET estado='resuelto', bloquea_sync=0").run();
    expect(liberarRetenidasResueltas(db).liberadas).toBe(0);
    expect(pedidoMlRetenido(db, 'ORD-C')).toBeTruthy();
    expect(aviso(db, 'ORD-C').estado).toBe('activo');
  });

  it('una excepción no libera: el caso sigue bloqueando', () => {
    catalogo(db, 'FB-30'); cache(db, 'MLA30|', 'FB-30'); decision(db, 'MLA30|', 'FB-30');
    retener(db, 'ORD-D', [itemOrden('MLA30')], ['MLA30|']);
    db.prepare("UPDATE guardia_ml_casos SET estado='excepcion' WHERE clave='MLA30|'").run();
    expect(caso(db, 'MLA30|').bloquea_sync).toBe(1);
    expect(liberarRetenidasResueltas(db).liberadas).toBe(0);
    expect(pedidoMlRetenido(db, 'ORD-D')).toBeTruthy();
  });

  it('cubre por seller_sku único de la venta, igual que syncMlToWc, pero no por un SKU duplicado', () => {
    catalogo(db, 'FB-40');
    retener(db, 'ORD-E', [itemOrden('MLA40', null, { sellerSku: 'FB-40' })], ['MLA40|']);
    db.prepare("UPDATE guardia_ml_casos SET estado='resuelto', bloquea_sync=0").run();
    catalogo(db, 'FB-41'); catalogo(db, 'FB-41');
    retener(db, 'ORD-F', [itemOrden('MLA41', null, { sellerSku: 'FB-41' })], ['MLA41|']);
    db.prepare("UPDATE guardia_ml_casos SET estado='resuelto', bloquea_sync=0 WHERE clave='MLA41|'").run();
    expect(liberarRetenidasResueltas(db)).toEqual({ revisadas: 2, liberadas: 1 });
    expect(pedidoMlRetenido(db, 'ORD-E')).toBeUndefined();
    expect(pedidoMlRetenido(db, 'ORD-F')).toBeTruthy();
  });

  it('liberar dos veces la misma venta devuelve false la segunda y no toca nada', () => {
    retener(db, 'ORD-G', [itemOrden('MLA50')], ['MLA50|']);
    expect(liberarPedidoRetenido(db, 'ORD-G', { actor: 'jose', motivo: 'ok' })).toBe(true);
    expect(liberarPedidoRetenido(db, 'ORD-G', { actor: 'otro', motivo: 'otra vez' })).toBe(false);
    expect(db.prepare("SELECT liberado_por FROM guardia_ml_pedidos_retenidos WHERE ml_order_id='ORD-G'").get().liberado_por).toBe('jose');
  });

  describe('endpoints manuales', () => {
    function app(user = { username: 'jose', is_admin: 1 }) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => { req.user = user; next(); });
      a.use('/api/guardia-ml', guardiaMlRouter(db, {}));
      return a;
    }

    it('liberar a mano deja los mismos efectos, registra el evento y resuelve la alerta', async () => {
      retener(db, 'ORD-H', [itemOrden('MLA60')], ['MLA60|']);
      const res = await request(app()).post('/api/guardia-ml/pedidos-retenidos/ORD-H/liberar').send({ motivo: 'vinculado a mano' });
      expect(res.body).toEqual({ ok: true, estado: 'liberado' });
      expect(db.prepare("SELECT COUNT(*) n FROM ordenes_ml_wc_pedidos WHERE ml_order_id='ORD-H'").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM guardia_ml_eventos WHERE evento='pedido_liberado'").get().n).toBe(1);
      expect(aviso(db, 'ORD-H').estado).toBe('resuelto');
      const otra = await request(app()).post('/api/guardia-ml/pedidos-retenidos/ORD-H/liberar').send({ motivo: 'x' });
      expect(otra.status).toBe(404);
    });

    it('cancelar resuelve la alerta; sin permiso de escritura en Matcher responde 403', async () => {
      retener(db, 'ORD-I', [itemOrden('MLA70')], ['MLA70|']);
      const sinPermiso = await request(app({ username: 'lector', is_admin: 0, permisos: [{ herramienta: 'matcher', nivel: 'read' }] }))
        .post('/api/guardia-ml/pedidos-retenidos/ORD-I/cancelar').send({ motivo: 'x' });
      expect(sinPermiso.status).toBe(403);
      const res = await request(app()).post('/api/guardia-ml/pedidos-retenidos/ORD-I/cancelar').send({ motivo: 'comprador canceló' });
      expect(res.body.estado).toBe('cancelado');
      expect(aviso(db, 'ORD-I').estado).toBe('resuelto');
    });
  });
});
