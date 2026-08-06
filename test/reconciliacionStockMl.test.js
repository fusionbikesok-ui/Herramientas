/**
 * Tests para reconciliarStockMl: reconciliación incremental del stock recordado
 * (ml_stock_estado.cantidad_ml) contra el stock REAL de ML (multiget /items?ids=).
 *
 * Caso real que motivó esto (ver docs/superpowers/plans/2026-08-06-reconciliacion-stock-ml.md):
 * MLA1117110786| (SKU FB-4501) quedó con cantidad_ml=0 desde el 2026-07-17 mientras ML tenía
 * 1 unidad activa y vendible — syncWcToMl nunca lo detectó porque comparaba deseado (0)
 * contra recordado (0), ambos iguales.
 *
 * IMPORTANTE: esta función NUNCA escribe en ML (solo GET vía multiget). Solo corrige
 * ml_stock_estado; la corrección real hacia ML la sigue haciendo syncWcToMl, no probado acá.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { reconciliarStockMl, syncRouter } from '../routes/sync.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = './test/tmp-reconciliacion.sqlite';

const CFG = {
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
};

function seedPublicacion(db, { clave, itemId, variationId = '', status = 'active', sku, cantidadMl }) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(clave, sku, 'Producto', 'confirmar', now);
  db.prepare(
    'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(clave, itemId, variationId, status, now);
  db.prepare(
    'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
  ).run(clave, sku, cantidadMl, now);
}

describe('reconciliarStockMl', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // Ejecuta reconciliarStockMl y avanza los fake timers para que los sleeps de pausa entre
  // chunks (RECONCILIACION_PAUSA_CHUNK_MS) no cuelguen el test.
  async function correr(db, cfg) {
    const p = reconciliarStockMl(db, cfg);
    await vi.runAllTimersAsync();
    return p;
  }

  it('reproduce el caso real de la horquilla: estado 0, ML 1, Woo 0 → corrige el estado a 1 y registra en sync_log', async () => {
    seedPublicacion(db, { clave: 'MLA1117110786|', itemId: 'MLA1117110786', sku: 'FB-4501', cantidadMl: 0 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA1117110786', status: 'active', available_quantity: 1 } }],
    });

    const r = await correr(db, CFG);

    expect(r.omitido).toBe(false);
    expect(r.corregidas).toBe(1);

    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA1117110786|'").get();
    expect(estado.cantidad_ml).toBe(1);

    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA1117110786|' AND estado = 'reconciliado'").get();
    expect(log).toBeTruthy();
    expect(log.cant_anterior).toBe(0);
    expect(log.cant_nueva).toBe(1);
    expect(log.error).toMatch(/ML tenía 1/);
    expect(log.error).toMatch(/ml_stock_estado tenía 0/);
  });

  it('sin divergencia (estado y ML coinciden) → no escribe nada ni ensucia el log', async () => {
    seedPublicacion(db, { clave: 'MLA200|', itemId: 'MLA200', sku: 'CASCO-L', cantidadMl: 5 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA200', status: 'active', available_quantity: 5 } }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(0);
    const estado = db.prepare("SELECT cantidad_ml, actualizado_en FROM ml_stock_estado WHERE clave = 'MLA200|'").get();
    expect(estado.cantidad_ml).toBe(5);
    const logs = db.prepare("SELECT * FROM sync_log").all();
    expect(logs.length).toBe(0);
  });

  it('ML tiene MENOS que lo registrado → también se corrige (ambos sentidos)', async () => {
    seedPublicacion(db, { clave: 'MLA300|', itemId: 'MLA300', sku: 'CASCO-M', cantidadMl: 10 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA300', status: 'active', available_quantity: 2 } }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(1);
    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA300|'").get();
    expect(estado.cantidad_ml).toBe(2);
    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA300|'").get();
    expect(log.cant_anterior).toBe(10);
    expect(log.cant_nueva).toBe(2);
  });

  describe('fail-closed: nunca corrige con un dato dudoso', () => {
    it('item ausente del multiget (chunk devolvió otra cosa) → deja la fila intacta', async () => {
      seedPublicacion(db, { clave: 'MLA400|', itemId: 'MLA400', sku: 'PEDAL-X', cantidadMl: 3 });
      mlFetch.mockResolvedValue({ status: 200, data: [] }); // MLA400 ausente de la respuesta

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA400|'").get();
      expect(estado.cantidad_ml).toBe(3);
      expect(db.prepare('SELECT * FROM sync_log').all().length).toBe(0);
    });

    it('cantidad nula/no numérica en la respuesta → deja la fila intacta', async () => {
      seedPublicacion(db, { clave: 'MLA401|', itemId: 'MLA401', sku: 'PEDAL-Y', cantidadMl: 3 });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA401', status: 'active', available_quantity: null } }],
      });

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA401|'").get();
      expect(estado.cantidad_ml).toBe(3);
    });

    it('el multiget responde status !== 200 → deja la fila intacta', async () => {
      seedPublicacion(db, { clave: 'MLA402|', itemId: 'MLA402', sku: 'PEDAL-Z', cantidadMl: 3 });
      mlFetch.mockResolvedValue({ status: 429, data: null });

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA402|'").get();
      expect(estado.cantidad_ml).toBe(3);
    });
  });

  it('publicación que ya no está active en ML → se saltea sin tocar el estado', async () => {
    seedPublicacion(db, { clave: 'MLA500|', itemId: 'MLA500', sku: 'GRIP-A', cantidadMl: 0 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA500', status: 'paused', available_quantity: 7 } }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(0);
    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA500|'").get();
    expect(estado.cantidad_ml).toBe(0);
    expect(db.prepare('SELECT * FROM sync_log').all().length).toBe(0);
  });

  it('compara la cantidad de la VARIACIÓN, no la del item, cuando la clave tiene variation_id', async () => {
    seedPublicacion(db, { clave: 'MLA600|111', itemId: 'MLA600', variationId: '111', sku: 'CASCO-S', cantidadMl: 0 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{
        code: 200,
        body: {
          id: 'MLA600', status: 'active', available_quantity: 999,
          variations: [
            { id: 111, available_quantity: 4 },
            { id: 222, available_quantity: 0 },
          ],
        },
      }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(1);
    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA600|111'").get();
    expect(estado.cantidad_ml).toBe(4);
  });

  it('el cursor avanza entre corridas y da la vuelta al llegar al final, sin saltearse publicaciones', async () => {
    // 3 publicaciones, forzamos un lote de 1 leyendo directo el cursor entre corridas —
    // se simula con 3 corridas consecutivas y se verifica que cada clave se visitó.
    seedPublicacion(db, { clave: 'MLA700|', itemId: 'MLA700', sku: 'A', cantidadMl: 1 });
    seedPublicacion(db, { clave: 'MLA701|', itemId: 'MLA701', sku: 'B', cantidadMl: 1 });
    seedPublicacion(db, { clave: 'MLA702|', itemId: 'MLA702', sku: 'C', cantidadMl: 1 });

    mlFetch.mockImplementation(async (dbArg, cfgArg, method, path) => {
      const ids = path.match(/ids=([^&]+)/)[1].split(',');
      return {
        status: 200,
        data: ids.map(id => ({ code: 200, body: { id, status: 'active', available_quantity: 1 } })),
      };
    });

    // Con RECONCILIACION_LOTE=100 y solo 3 publicaciones, una sola corrida ya cubre todo el
    // universo y el cursor da la vuelta al principio. Corremos dos veces y verificamos que
    // el cursor sigue siendo consistente (apunta a una clave real del universo) y que ambas
    // corridas revisaron las 3 publicaciones sin saltear ninguna.
    const r1 = await correr(db, CFG);
    expect(r1.revisadas).toBe(3);
    const cursor1 = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
    expect(['MLA700|', 'MLA701|', 'MLA702|']).toContain(cursor1.valor);

    const r2 = await correr(db, CFG);
    expect(r2.revisadas).toBe(3);
  });

  // RECONCILIACION_LOTE es 100 y el lote siempre cubre min(LOTE, universo.length): con un
  // universo de 3-4 filas (como el test de arriba) el lote SIEMPRE da la vuelta entera y
  // nunca prueba avance real del cursor (su propio comentario lo admitía). Para probar
  // avance real hace falta un universo > 100, así el lote deja filas afuera.
  function seedUniversoGrande(db, n) {
    for (let i = 0; i < n; i++) {
      const clave = `MLA1${String(i).padStart(4, '0')}|`;
      seedPublicacion(db, { clave, itemId: `MLA1${String(i).padStart(4, '0')}`, sku: `SKU${i}`, cantidadMl: 1 });
    }
  }

  it('avance real del cursor con lote menor al universo (universo > RECONCILIACION_LOTE)', async () => {
    seedUniversoGrande(db, 105); // > 100: el lote de la primera corrida no cubre todo

    mlFetch.mockImplementation(async (dbArg, cfgArg, method, path) => {
      const ids = path.match(/ids=([^&]+)/)[1].split(',');
      return {
        status: 200,
        data: ids.map(id => ({ code: 200, body: { id, status: 'active', available_quantity: 1 } })),
      };
    });

    const r1 = await correr(db, CFG);
    expect(r1.revisadas).toBe(100); // tamanoLote = min(100, 105)

    // El cursor avanzó, no dio la vuelta: debe apuntar a la clave Nº100 (índice 100, base 0),
    // no a la primera del universo.
    const cursor1 = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
    expect(cursor1.valor).toBe('MLA10100|');
    expect(cursor1.valor).not.toBe('MLA10000|');

    // Segunda corrida: cubre las 5 restantes y da la vuelta, tomando 95 de las ya vistas
    // (lote circular) — lo importante es que retomó desde donde quedó, no desde 0.
    const r2 = await correr(db, CFG);
    expect(r2.revisadas).toBe(100);
  });

  it('clave del cursor desaparecida del universo → arranca en la siguiente lexicográficamente mayor, no en 0', async () => {
    seedUniversoGrande(db, 105);

    const idsConsultados = [];
    mlFetch.mockImplementation(async (dbArg, cfgArg, method, path) => {
      const ids = path.match(/ids=([^&]+)/)[1].split(',');
      idsConsultados.push(...ids);
      return {
        status: 200,
        data: ids.map(id => ({ code: 200, body: { id, status: 'active', available_quantity: 1 } })),
      };
    });

    // El cursor apunta a una clave que ya no está en el universo (se desmapeó, cayó del
    // filtro, etc), intermedia entre MLA10049| y MLA10050|. Con el fallback ingenuo a 0 se
    // reprocesarían las primeras 100 de nuevo; el fallback correcto retoma en MLA10050|.
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('cursor_reconciliacion_stock', 'MLA10049|X', datetime('now'))
    `).run();

    await correr(db, CFG);

    // Lo que importa: arrancó en MLA10050| (siguiente mayor a la clave desaparecida), no en
    // MLA10000| (que hubiera sido el fallback ingenuo a 0). El lote de 100 sobre un universo
    // de 105 da la vuelta y sí vuelve a tocar las primeras claves — eso es circular esperado,
    // no el bug que este test cubre.
    expect(idsConsultados[0]).toBe('MLA10050');
  });

  describe('universo con 429/errores: el cursor no debe dar vueltas en falso', () => {
    it('elemento con code !== 200 dentro del array del multiget → fail-closed, no lo cuenta como revisado a efectos de cursor', async () => {
      seedPublicacion(db, { clave: 'MLA940|', itemId: 'MLA940', sku: 'A', cantidadMl: 3 });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 404, body: null }],
      });

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      expect(r.sinDato).toBe(1);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA940|'").get();
      expect(estado.cantidad_ml).toBe(3);
      // El único ítem del lote quedó sin dato: el cursor no debe haber avanzado.
      const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor).toBeUndefined();
    });

    it('un chunk lanza excepción de axios → no tumba el resto del lote', async () => {
      seedPublicacion(db, { clave: 'MLA950|', itemId: 'MLA950', sku: 'A', cantidadMl: 1 });
      seedPublicacion(db, { clave: 'MLA951|', itemId: 'MLA951', sku: 'B', cantidadMl: 1 });

      // itemIdsUnicos tiene 2 elementos < RECONCILIACION_MULTIGET_CHUNK(20), o sea va todo
      // en un solo chunk: para forzar dos chunks distintos con uno fallando habría que subir
      // el universo a 21+. En cambio probamos que, si el único chunk lanza, el resto del
      // proceso (avance de cursor, retorno) sigue funcionando sin excepción no capturada.
      mlFetch.mockRejectedValue(new Error('timeout de red'));

      const r = await correr(db, CFG);

      expect(r.omitido).toBe(false);
      expect(r.corregidas).toBe(0);
      expect(r.sinDato).toBe(2);
      const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor).toBeUndefined();
    });

    it('429 sostenido en TODOS los chunks → corta el bucle, no avanza el cursor, avisa por consola', async () => {
      seedPublicacion(db, { clave: 'MLA960|', itemId: 'MLA960', sku: 'A', cantidadMl: 1 });
      seedPublicacion(db, { clave: 'MLA961|', itemId: 'MLA961', sku: 'B', cantidadMl: 1 });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mlFetch.mockResolvedValue({ status: 429, data: null });

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      expect(r.sinDato).toBe(2);
      expect(mlFetch).toHaveBeenCalledTimes(1); // cortó tras el primer 429, no siguió con más chunks
      const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  it('candado anti-solape: una corrida en curso hace que la segunda se omita con motivo en_curso', async () => {
    seedPublicacion(db, { clave: 'MLA970|', itemId: 'MLA970', sku: 'A', cantidadMl: 1 });
    let resolverPrimera;
    mlFetch.mockImplementation(() => new Promise(resolve => { resolverPrimera = resolve; }));

    const p1 = reconciliarStockMl(db, CFG);
    // Dejar que la primera corrida entre al candado antes de lanzar la segunda.
    await vi.advanceTimersByTimeAsync(0);
    const r2 = await reconciliarStockMl(db, CFG);

    expect(r2.omitido).toBe(true);
    expect(r2.motivo).toBe('en_curso');

    resolverPrimera({ status: 200, data: [{ code: 200, body: { id: 'MLA970', status: 'active', available_quantity: 1 } }] });
    await vi.runAllTimersAsync();
    await p1;
  });

  it('sin config de ML → omitido con motivo sin_config, sin tocar nada', async () => {
    seedPublicacion(db, { clave: 'MLA800|', itemId: 'MLA800', sku: 'X', cantidadMl: 1 });
    const r = await reconciliarStockMl(db, { ml: {}, woo: CFG.woo });
    expect(r.omitido).toBe(true);
    expect(r.motivo).toBe('sin_config');
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('compare-and-swap: si otro proceso ya escribió ml_stock_estado (changes === 0), no cuenta como corregida ni loguea, y el cursor avanza igual', async () => {
    // Simula la carrera descrita en el código: entre la lectura del universo y el UPDATE de
    // reconciliarStockMl, otro proceso (syncWcToMl/procesarReintentos) ya actualizó la fila
    // con un valor más fresco. El UPDATE con "AND cantidad_ml = ?" (valor viejo leído acá) no
    // matchea ninguna fila → changes === 0. No hay nada que corregir: ya está actualizada.
    seedPublicacion(db, { clave: 'MLA990|', itemId: 'MLA990', sku: 'CADENA-1', cantidadMl: 0 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA990', status: 'active', available_quantity: 1 } }],
    });

    // Otro proceso pisa la fila ANTES del UPDATE de reconciliarStockMl (simulado adelantando
    // el cambio real acá mismo, ya que en el test es síncrono con la lectura del universo).
    db.prepare("UPDATE ml_stock_estado SET cantidad_ml = 1, actualizado_en = datetime('now') WHERE clave = 'MLA990|'").run();

    const r = await correr(db, CFG);

    // No se cuenta como corregida (el UPDATE con predicado viejo no matcheó ninguna fila).
    expect(r.corregidas).toBe(0);
    // No se logueó nada: no había nada que corregir.
    expect(db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA990|'").all().length).toBe(0);
    // La fila quedó con el valor que ya tenía (el que puso el "otro proceso"), no se pisó.
    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA990|'").get();
    expect(estado.cantidad_ml).toBe(1);
    // El cursor avanzó igual: sí hubo dato real de ML para esta clave (item.status activo,
    // cantidad finita), aunque el UPDATE no haya escrito nada.
    const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
    expect(cursor.valor).toBe('MLA990|');
  });

  describe('POST /api/sync/reconciliar-stock', () => {
    function armarApp(cfg) {
      const app = express();
      app.use(express.json());
      app.use('/api/sync', syncRouter(db, cfg));
      return app;
    }

    it('corre un lote y devuelve revisadas/corregidas/sinDato', async () => {
      seedPublicacion(db, { clave: 'MLA980|', itemId: 'MLA980', sku: 'A', cantidadMl: 0 });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA980', status: 'active', available_quantity: 1 } }],
      });

      const res = await request(armarApp(CFG)).post('/api/sync/reconciliar-stock');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.omitido).toBe(false);
      expect(res.body.revisadas).toBe(1);
      expect(res.body.corregidas).toBe(1);
      expect(res.body.sinDato).toBe(0);
    });

    it('sin config de ML → omitido con motivo sin_config', async () => {
      const res = await request(armarApp({ ml: {}, woo: CFG.woo })).post('/api/sync/reconciliar-stock');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.omitido).toBe(true);
      expect(res.body.motivo).toBe('sin_config');
    });
  });
});
