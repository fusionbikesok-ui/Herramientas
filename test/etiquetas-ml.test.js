// Etiquetas en Preparación, parte B: POST /etiquetas-ml (PDF binario, rechazo parcial, dedupe por envío, packs, fail-closed).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { preparacionRouter, crearPreparacion } from '../routes/preparacion.js';
import { fotosListasFaltantes, fotosFaltantes } from '../lib/preparacion.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), mlFetchBinario: vi.fn() };
});
import { mlFetch, mlFetchBinario } from '../lib/mlClient.js';

const TEST_DB = `./test/tmp-etiquetas-ml.${process.pid}.sqlite`;
const limpiar = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
const CFG = { woo: { url: 'https://x.test' }, ml: { clientId: 'x' }, colaFotos: { disparoInmediato: false } };
let db; let app; let n = 1000;
const PDF = (txt) => Buffer.from(`%PDF-1.4 ${txt}`);

function appComo(usuario = 'operario') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0, permisos: [{ herramienta: 'preparacion', nivel: 'write' }] }; next(); });
  a.use('/api/preparacion', preparacionRouter(db, CFG));
  return a;
}

/** Orden ML lista para imprimir: preparación con las dos fotos del paquete `listo`, pedido confirmado y envío ready_to_print. */
function orden({ shipment = null, logistica = 'cross_docking', status = 'ready_to_ship', sub = 'ready_to_print', comercial = 'confirmado', foto = 'listo', conFotos = true } = {}) {
  n += 1;
  const sid = shipment || `S${n}`;
  const id = crearPreparacion(db, { canal: 'ml', mlOrderId: String(n), numeroPedido: String(n), comprador: `C${n}`, items: [] });
  db.prepare(`INSERT OR IGNORE INTO gestion_pedidos (fuente, external_id, estado_comercial, estado_operativo, ml_shipment_id, importado_en, actualizado_en) VALUES ('mercadolibre',?,?,'importado',?,?,?)`)
    .run(String(n), comercial, sid, new Date().toISOString(), new Date().toISOString());
  db.prepare('UPDATE gestion_pedidos SET estado_comercial=? WHERE external_id=?').run(comercial, String(n));
  db.prepare('INSERT OR REPLACE INTO ml_shipment_estado (shipment_id, status, substatus, logistic_type, actualizado_en) VALUES (?,?,?,?,?)').run(sid, status, sub, logistica, new Date().toISOString());
  if (conFotos) {
    for (const tipo of ['paquete_abierto', 'paquete_cerrado']) {
      db.prepare(`INSERT INTO preparacion_fotos (preparacion_id, tipo, url, nombre_archivo, creado_en, estado_proceso) VALUES (?,?,?,?,?,?)`)
        .run(id, tipo, `u/${tipo}.jpg`, `${tipo}.jpg`, new Date().toISOString(), foto);
    }
  }
  return { id, clave: `ml:${n}`, orderId: String(n), sid };
}

const itemsDe = (...ids) => ({ status: 200, data: ids.map((order_id) => ({ order_id })) });
const ok = (txt = 'lote') => ({ status: 200, buffer: PDF(txt), contentType: 'application/pdf', error: null });
const rechazo = (msg = 'not_printable_status') => ({ status: 400, buffer: null, contentType: 'application/json', error: JSON.stringify({ error: msg }) });
const post = (claves) => request(app).post('/api/preparacion/etiquetas-ml').send({ claves });

beforeEach(() => {
  limpiar(); db = openDb(TEST_DB); preparacionRouter(db, CFG); app = appComo(); n = 1000;
  mlFetch.mockReset(); mlFetchBinario.mockReset();
  // Por defecto el envío contiene solo la orden pedida (se redefine en los tests de pack).
  mlFetch.mockImplementation(async (_d, _c, _m, path) => {
    const sid = decodeURIComponent(path.match(/shipments\/([^/]+)\/items/)[1]);
    const ids = db.prepare("SELECT external_id FROM gestion_pedidos WHERE ml_shipment_id=?").all(sid).map((r) => r.external_id);
    return itemsDe(...ids);
  });
});
afterEach(() => { db.close(); limpiar(); });

describe('fotosListasFaltantes', () => {
  const req = [{ tipos: ['paquete_abierto'], min: 1 }];
  it('solo cuenta fotos en listo; fotosFaltantes conserva su semántica', () => {
    const fotos = [{ tipo: 'paquete_abierto', estado_proceso: 'error' }];
    expect(fotosListasFaltantes(req, fotos)).toHaveLength(1);
    expect(fotosFaltantes(req, fotos)).toHaveLength(0);
    expect(fotosListasFaltantes(req, [{ tipo: 'paquete_abierto', estado_proceso: 'listo' }])).toHaveLength(0);
  });
});

describe('POST /etiquetas-ml', () => {
  it('valida el cuerpo: 1..50 claves ml:<orden>', async () => {
    expect((await post([])).status).toBe(400);
    expect((await post(['web:1'])).status).toBe(400);
    expect((await post(Array.from({ length: 51 }, (_, i) => `ml:${i + 1}`))).status).toBe(400);
    expect((await request(app).post('/api/preparacion/etiquetas-ml').send({})).status).toBe(400);
    expect(mlFetchBinario).not.toHaveBeenCalled();
  });

  it('un pedido elegible devuelve el PDF binario en base64 y registra la descarga (no «impresa»)', async () => {
    const a = orden();
    mlFetchBinario.mockResolvedValueOnce(ok('uno'));
    const r = await post([a.clave]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, aceptados: [a.clave], rechazados: [] });
    expect(Buffer.from(r.body.pdf_base64, 'base64').toString()).toBe(PDF('uno').toString());
    expect(mlFetchBinario.mock.calls[0][2]).toBe(`/shipment_labels?shipment_ids=${a.sid}&response_type=pdf`);
    expect(mlFetchBinario.mock.calls[0][3]).toMatchObject({ manual: true });
    const reg = db.prepare('SELECT * FROM etiquetas_ml_descargas').all();
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ clave: a.clave, shipment_id: a.sid, usuario: 'operario' });
  });

  it('dedupe por envío: un pack de dos órdenes pide UN shipment_id y acepta ambas claves', async () => {
    const a = orden({ shipment: 'PACK1' });
    const b = orden({ shipment: 'PACK1' });
    mlFetchBinario.mockResolvedValueOnce(ok());
    const r = await post([a.clave, b.clave]);
    expect(r.body.aceptados.sort()).toEqual([a.clave, b.clave].sort());
    expect(mlFetchBinario).toHaveBeenCalledTimes(1);
    expect(mlFetchBinario.mock.calls[0][2]).toBe('/shipment_labels?shipment_ids=PACK1&response_type=pdf');
    expect(db.prepare('SELECT COUNT(*) c FROM etiquetas_ml_descargas').get().c).toBe(2);
  });

  it('claves repetidas se deduplican', async () => {
    const a = orden();
    mlFetchBinario.mockResolvedValueOnce(ok());
    const r = await post([a.clave, a.clave]);
    expect(r.body.aceptados).toEqual([a.clave]);
  });

  it('motivos de rechazo local: Full, envío no listo, orden no paga, sin fotos, foto en proceso, sin preparación', async () => {
    const full = orden({ logistica: 'fulfillment' });
    const noListo = orden({ status: 'pending' });
    const sub = orden({ sub: 'dropped_off' });
    const noPaga = orden({ comercial: 'cancelado' });
    const sinFotos = orden({ conFotos: false });
    const enProceso = orden({ foto: 'pendiente' });
    const fallida = orden({ foto: 'error' });
    const r = await post([full.clave, noListo.clave, sub.clave, noPaga.clave, sinFotos.clave, enProceso.clave, fallida.clave, 'ml:999999']);
    const m = Object.fromEntries(r.body.rechazados.map((x) => [x.clave, x.motivo]));
    expect(m[full.clave]).toBe('Full');
    expect(m[noListo.clave]).toBe('envío no listo');
    expect(m[sub.clave]).toBe('envío ya salió');
    expect(m[noPaga.clave]).toBe('orden no paga o cancelada');
    expect(m[sinFotos.clave]).toBe('faltan fotos');
    expect(m[enProceso.clave]).toBe('foto en proceso o fallida');
    expect(m[fallida.clave]).toBe('foto en proceso o fallida');
    expect(m['ml:999999']).toBe('sin preparación');
    expect(r.body.aceptados).toEqual([]);
    expect(r.body.pdf_base64).toBeNull();
    expect(mlFetchBinario).not.toHaveBeenCalled();
  });

  it('acepta substatus printed (reimpresión) y las cuatro logísticas locales', async () => {
    const claves = ['cross_docking', 'self_service', 'drop_off', 'xd_drop_off'].map((l, i) => orden({ logistica: l, sub: i === 0 ? 'printed' : 'ready_to_print' }).clave);
    mlFetchBinario.mockResolvedValueOnce(ok());
    const r = await post(claves);
    expect(r.body.aceptados).toHaveLength(4);
  });

  it('pack con una orden incompleta: rechaza TODAS las claves del envío con el motivo', async () => {
    const a = orden({ shipment: 'PACK2' });
    const b = orden({ shipment: 'PACK2', conFotos: false });
    const r = await post([a.clave]);
    expect(r.body.aceptados).toEqual([]);
    expect(r.body.rechazados).toEqual([{ clave: a.clave, motivo: `pack con fotos pendientes en #${b.orderId}` }]);
    expect(mlFetchBinario).not.toHaveBeenCalled();
  });

  it('pack con orden sin preparación local: «pack con orden sin preparar #id»', async () => {
    const a = orden({ shipment: 'PACK3' });
    db.prepare(`INSERT INTO gestion_pedidos (fuente, external_id, estado_comercial, estado_operativo, ml_shipment_id, importado_en, actualizado_en) VALUES ('mercadolibre','777','confirmado','importado','PACK3',?,?)`).run('x', 'x');
    mlFetch.mockResolvedValueOnce(itemsDe(a.orderId, '777'));
    const r = await post([a.clave]);
    expect(r.body.rechazados[0].motivo).toBe('pack con orden sin preparar #777');
  });

  it('hermana sin fila comercial en gestion_pedidos: «pack con orden sin confirmar #id» (fail-closed)', async () => {
    const a = orden({ shipment: 'PACK4' });
    const h = orden({ shipment: 'PACK4b' });   // tiene preparación con fotos, pero le quitamos la fila comercial
    db.prepare('DELETE FROM gestion_pedidos WHERE external_id=?').run(h.orderId);
    mlFetch.mockResolvedValueOnce(itemsDe(a.orderId, h.orderId));
    const r = await post([a.clave]);
    expect(r.body.rechazados[0].motivo).toBe(`pack con orden sin confirmar #${h.orderId}`);
    expect(mlFetchBinario).not.toHaveBeenCalled();
  });

  it('membresía vacía, o que no incluye la orden propia, no verifica el pack', async () => {
    const a = orden();
    mlFetch.mockResolvedValueOnce({ status: 200, data: [] });
    expect((await post([a.clave])).body.rechazados[0].motivo).toBe('no se pudo verificar el pack');
    mlFetch.mockResolvedValueOnce(itemsDe('424242'));
    expect((await post([a.clave])).body.rechazados[0].motivo).toBe('no se pudo verificar el pack');
    expect(mlFetchBinario).not.toHaveBeenCalled();
  });

  it('hermana con preparación cancelada sin retiro no frena el envío (igual que una orden cancelada)', async () => {
    const a = orden({ shipment: 'PACK5' });
    const h = orden({ shipment: 'PACK5', conFotos: false });
    db.prepare("UPDATE preparaciones SET estado='cancelada_sin_retiro' WHERE id=?").run(h.id);
    mlFetchBinario.mockResolvedValueOnce(ok());
    const r = await post([a.clave]);
    expect(r.body.aceptados).toEqual([a.clave]);
  });

  it('fail-closed: si ML no responde la membresía del pack, rechaza («no se pudo verificar el pack»)', async () => {
    const a = orden();
    mlFetch.mockResolvedValueOnce({ status: 500, data: null });
    const r1 = await post([a.clave]);
    expect(r1.body.rechazados[0].motivo).toBe('no se pudo verificar el pack');
    mlFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const r2 = await post([a.clave]);
    expect(r2.body.rechazados[0].motivo).toBe('no se pudo verificar el pack');
    expect(mlFetchBinario).not.toHaveBeenCalled();
  });

  it('lote rechazado por ML: clasifica envío por envío y hace UNA llamada final con los aceptados', async () => {
    const a = orden(); const b = orden(); const c = orden();
    mlFetchBinario
      .mockResolvedValueOnce(rechazo())                 // lote completo
      .mockResolvedValueOnce(ok('a'))                   // a ok (descartado)
      .mockResolvedValueOnce(rechazo('not_printable_status')) // b rechazado
      .mockResolvedValueOnce(ok('c'))                   // c ok (descartado)
      .mockResolvedValueOnce(ok('final'));              // llamada final con a y c
    const r = await post([a.clave, b.clave, c.clave]);
    expect(r.status).toBe(200);
    expect(r.body.aceptados.sort()).toEqual([a.clave, c.clave].sort());
    expect(r.body.rechazados).toEqual([{ clave: b.clave, motivo: 'not_printable_status' }]);
    expect(Buffer.from(r.body.pdf_base64, 'base64').toString()).toBe(PDF('final').toString());
    expect(mlFetchBinario).toHaveBeenCalledTimes(5);
    expect(mlFetchBinario.mock.calls[4][2]).toBe(`/shipment_labels?shipment_ids=${a.sid},${c.sid}&response_type=pdf`);
    // Solo se registran los aceptados
    expect(db.prepare('SELECT clave FROM etiquetas_ml_descargas').all().map((x) => x.clave).sort()).toEqual([a.clave, c.clave].sort());
  });

  it('si ML rechaza todos los envíos: pdf_base64 null y solo rechazados', async () => {
    const a = orden(); const b = orden();
    mlFetchBinario.mockResolvedValue(rechazo());
    const r = await post([a.clave, b.clave]);
    expect(r.body.pdf_base64).toBeNull();
    expect(r.body.aceptados).toEqual([]);
    expect(r.body.rechazados).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) c FROM etiquetas_ml_descargas').get().c).toBe(0);
  });

  it('ML caído (429/5xx/red): 502 sin clasificar ni registrar nada', async () => {
    const a = orden(); const b = orden();
    mlFetchBinario.mockResolvedValueOnce({ status: 429, buffer: null, error: null });
    const r = await post([a.clave, b.clave]);
    expect(r.status).toBe(502);
    expect(mlFetchBinario).toHaveBeenCalledTimes(1);
    mlFetchBinario.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    expect((await post([a.clave])).status).toBe(502);
    expect(db.prepare('SELECT COUNT(*) c FROM etiquetas_ml_descargas').get().c).toBe(0);
  });

  it('una respuesta 200 que no es PDF jamás se entrega como PDF', async () => {
    const a = orden();
    mlFetchBinario.mockResolvedValueOnce({ status: 200, buffer: null, contentType: 'text/html', error: 'respuesta_no_pdf' });
    const r = await post([a.clave]);
    expect(r.status).toBe(502);
    expect(r.body.pdf_base64).toBeUndefined();
  });

  it('exige usuario autenticado', async () => {
    const a = express(); a.use(express.json());
    a.use('/api/preparacion', preparacionRouter(db, CFG));
    const r = await request(a).post('/api/preparacion/etiquetas-ml').send({ claves: ['ml:1'] });
    expect([401, 403]).toContain(r.status);
  });
});

describe('GET /pendientes: campos de etiqueta', () => {
  it('ML: etiqueta_ml (elegible/motivo/última descarga) y chips; «etiqueta ✓» solo con foto vigente', async () => {
    const a = orden(); const b = orden({ conFotos: false });
    for (const o of [a, b]) {
      db.prepare(`INSERT INTO pedidos_cache (clave, canal, ml_order_id, numero_pedido, comprador, fecha, estado_envio, items_json, actualizado_en)
        VALUES (?, 'ml', ?, ?, 'C', ?, 'pendiente', '[]', ?)`).run(o.clave, o.orderId, o.orderId, new Date().toISOString(), new Date().toISOString());
    }
    db.prepare('INSERT INTO etiquetas_ml_descargas (clave, shipment_id, usuario, descargado_en) VALUES (?,?,?,?)').run(a.clave, a.sid, 'ana', '2026-10-15T10:00:00.000Z');
    db.prepare("UPDATE preparaciones SET etiqueta_cargada_en=?, etiqueta_origen='foto' WHERE id=?").run(new Date().toISOString(), a.id);
    const r = await request(app).get('/api/preparacion/pendientes');
    const pa = r.body.data.find((x) => x.ml_order_id === a.orderId);
    const pb = r.body.data.find((x) => x.ml_order_id === b.orderId);
    expect(pa.etiqueta_ml).toMatchObject({ elegible: true, descargada_por: 'ana' });
    expect(pa.etiqueta_foto).toBe(true);
    expect(pa.falta_etiqueta).toBe(false);
    expect(pb.etiqueta_ml).toMatchObject({ elegible: false, motivo: 'faltan fotos' });
    expect(pb.etiqueta_foto).toBe(false);
    expect(pb.falta_etiqueta).toBe(true);
  });
});

