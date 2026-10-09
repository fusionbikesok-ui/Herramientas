import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { liberarRetenidasResueltas, pedidoMlRetenido, ignoraVentas, retenerPedidoMl } from '../lib/guardiaMl.js';
import { marcarNoSincronizar, marcarLinkDePago, deshacerNoSincronizar } from '../lib/noSincronizar.js';

const FILE = './test/tmp-no-sincronizar.sqlite';
const now = () => new Date().toISOString();

function cache(db, clave, sku = null) {
  const [item, variacion = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`).run(clave, item, variacion, 'Pub', 'active', sku, 1, now());
}
function retener(db, orderId, clave) {
  const [item, variacion] = clave.split('|');
  const items = [{ item: { id: item, variation_id: variacion || null, seller_sku: null, title: 'X' }, quantity: 1 }];
  db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en) VALUES (?, 0, NULL, ?)').run(orderId, now());
  db.prepare("INSERT INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en) VALUES (?, ?, '[]', 'retenido', ?)").run(orderId, now(), now());
  retenerPedidoMl(db, { orderId, items, claves: [clave] });
}
const decision = (db, clave) => db.prepare('SELECT * FROM sku_matcher_decisiones WHERE clave=?').get(clave);

describe('no sincronizar vs link de pago', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('exige motivo y una variante válida', () => {
    cache(db, 'MLA1|');
    expect(marcarNoSincronizar(db, { clave: 'MLA1|', variante: 'a', actor: 'ana', expectedSku: null }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(marcarNoSincronizar(db, { clave: 'MLA1|', variante: 'z', motivo: 'm', actor: 'ana', expectedSku: null }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('(a) marca omitir con origen propio y deja motivo en el historial', () => {
    cache(db, 'MLA2|');
    const r = marcarNoSincronizar(db, { clave: 'MLA2|', variante: 'a', motivo: 'Publicación vieja', actor: 'ana', expectedSku: null });
    expect(r.ok).toBe(true);
    expect(decision(db, 'MLA2|')).toMatchObject({ accion: 'omitir', origen: 'no_sincronizar_a' });
    const h = db.prepare("SELECT actor,detalle_json FROM identidad_historial WHERE evento='no_sincronizar'").get();
    expect(h.actor).toBe('ana');
    expect(JSON.parse(h.detalle_json)).toMatchObject({ clave: 'MLA2|', variante: 'a', motivo: 'Publicación vieja' });
  });

  it('las ventas de "no sincronizar" se retienen y no las libera el sistema; las de link de pago se ignoran', () => {
    cache(db, 'MLA3|'); cache(db, 'MLA4|');
    marcarNoSincronizar(db, { clave: 'MLA3|', variante: 'a', motivo: 'm', actor: 'ana', expectedSku: null });
    expect(marcarLinkDePago(db, { clave: 'MLA4|', motivo: 'm', actor: 'jose', esAdmin: true, expectedSku: null }).ok).toBe(true);
    expect(ignoraVentas(db, 'MLA3|')).toBe(false);
    expect(ignoraVentas(db, 'MLA4|')).toBe(true);
    retener(db, 'ORD-3', 'MLA3|'); retener(db, 'ORD-4', 'MLA4|');
    expect(liberarRetenidasResueltas(db).liberadas).toBe(1);
    expect(pedidoMlRetenido(db, 'ORD-3')).toBeTruthy();
    expect(pedidoMlRetenido(db, 'ORD-4')).toBeFalsy();
  });

  it('un omitir anterior sin origen nuevo sigue ignorando ventas (no cambia lo existente)', () => {
    cache(db, 'MLA5|');
    db.prepare("INSERT INTO sku_matcher_decisiones(clave,sku,accion,origen,actualizado_en) VALUES ('MLA5|',NULL,'omitir','matcher_no_sincronizar',?)").run(now());
    expect(ignoraVentas(db, 'MLA5|')).toBe(true);
  });

  it('link de pago es solo de administración', () => {
    cache(db, 'MLA6|');
    expect(marcarLinkDePago(db, { clave: 'MLA6|', motivo: 'm', actor: 'ana', esAdmin: false, expectedSku: null }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(decision(db, 'MLA6|')).toBeUndefined();
  });

  it('deshacer (a): cualquiera; borra la marca y deja un evento compensatorio', () => {
    cache(db, 'MLA7|');
    marcarNoSincronizar(db, { clave: 'MLA7|', variante: 'a', motivo: 'm', actor: 'ana', expectedSku: null });
    const r = deshacerNoSincronizar(db, { clave: 'MLA7|', motivo: 'error', actor: 'beto', esAdmin: false });
    expect(r.ok).toBe(true);
    expect(decision(db, 'MLA7|')).toBeUndefined();
    expect(db.prepare("SELECT actor FROM identidad_historial WHERE evento='no_sincronizar_deshecho'").get().actor).toBe('beto');
  });

  it('deshacer (c): solo administración, validado en el servidor', () => {
    cache(db, 'MLA8|');
    marcarNoSincronizar(db, { clave: 'MLA8|', variante: 'c', motivo: 'm', actor: 'ana', expectedSku: null });
    expect(deshacerNoSincronizar(db, { clave: 'MLA8|', motivo: 'x', actor: 'beto', esAdmin: false }))
      .toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(decision(db, 'MLA8|')).toBeTruthy();
    expect(deshacerNoSincronizar(db, { clave: 'MLA8|', motivo: 'x', actor: 'jose', esAdmin: true }).ok).toBe(true);
  });

  it('deshacer no toca un link de pago ni un omitir ajeno', () => {
    cache(db, 'MLA9|');
    marcarLinkDePago(db, { clave: 'MLA9|', motivo: 'm', actor: 'jose', esAdmin: true, expectedSku: null });
    expect(deshacerNoSincronizar(db, { clave: 'MLA9|', motivo: 'x', actor: 'jose', esAdmin: true }))
      .toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });
});
