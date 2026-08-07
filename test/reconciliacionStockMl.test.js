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
import { reconciliarStockMl, syncWcToMl, syncRouter } from '../routes/sync.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
  estadoCooldownMl: vi.fn(() => ({ activo: false, hasta: null, nivel: 0 })),
}));

import { mlFetch, estadoCooldownMl } from '../lib/mlClient.js';

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

  // RECONCILIACION_LOTE es 150 y el lote siempre cubre min(LOTE, universo.length): con un
  // universo de 3-4 filas (como el test de arriba) el lote SIEMPRE da la vuelta entera y
  // nunca prueba avance real del cursor (su propio comentario lo admitía). Para probar
  // avance real hace falta un universo > 150, así el lote deja filas afuera.
  function seedUniversoGrande(db, n) {
    for (let i = 0; i < n; i++) {
      const clave = `MLA1${String(i).padStart(4, '0')}|`;
      seedPublicacion(db, { clave, itemId: `MLA1${String(i).padStart(4, '0')}`, sku: `SKU${i}`, cantidadMl: 1 });
    }
  }

  it('avance real del cursor con lote menor al universo (universo > RECONCILIACION_LOTE)', async () => {
    seedUniversoGrande(db, 155); // > 150: el lote de la primera corrida no cubre todo

    mlFetch.mockImplementation(async (dbArg, cfgArg, method, path) => {
      const ids = path.match(/ids=([^&]+)/)[1].split(',');
      return {
        status: 200,
        data: ids.map(id => ({ code: 200, body: { id, status: 'active', available_quantity: 1 } })),
      };
    });

    const r1 = await correr(db, CFG);
    expect(r1.revisadas).toBe(150); // tamanoLote = min(150, 155)

    // El cursor avanzó, no dio la vuelta: debe apuntar a la clave Nº150 (índice 150, base 0),
    // no a la primera del universo.
    const cursor1 = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
    expect(cursor1.valor).toBe('MLA10150|');
    expect(cursor1.valor).not.toBe('MLA10000|');

    // Segunda corrida: cubre las 5 restantes y da la vuelta, tomando 145 de las ya vistas
    // (lote circular) — lo importante es que retomó desde donde quedó, no desde 0.
    const r2 = await correr(db, CFG);
    expect(r2.revisadas).toBe(150);
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

    it('429 en el primer chunk con cooldown corto → espera y reintenta ese chunk; si el reintento da 200, la corrida completa el lote y el cursor avanza', async () => {
      seedPublicacion(db, { clave: 'MLA962|', itemId: 'MLA962', sku: 'A', cantidadMl: 1 });

      const hasta = new Date(Date.now() + 5000).toISOString();
      estadoCooldownMl.mockReturnValue({ activo: true, hasta, nivel: 0 });

      let llamada = 0;
      mlFetch.mockImplementation(async () => {
        llamada++;
        if (llamada === 1) return { status: 429, data: null };
        return { status: 200, data: [{ code: 200, body: { id: 'MLA962', status: 'active', available_quantity: 1 } }] };
      });

      const r = await correr(db, CFG);

      expect(mlFetch).toHaveBeenCalledTimes(2); // el 429 original + el reintento post-cooldown
      expect(r.esperasCooldown).toBe(1);
      expect(r.revisadas).toBe(1);
      expect(r.corregidas).toBe(0); // ML confirmó lo mismo que ya estaba registrado
      const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor.valor).toBe('MLA962|'); // avanzó: el reintento sí trajo dato real
    });

    it('429 en el primer chunk, reintento también 429 → corta como antes, cursor no avanza', async () => {
      seedPublicacion(db, { clave: 'MLA963|', itemId: 'MLA963', sku: 'A', cantidadMl: 1 });

      const hasta = new Date(Date.now() + 5000).toISOString();
      estadoCooldownMl.mockReturnValue({ activo: true, hasta, nivel: 0 });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mlFetch.mockResolvedValue({ status: 429, data: null });

      const r = await correr(db, CFG);

      expect(mlFetch).toHaveBeenCalledTimes(2); // 429 original + el único reintento permitido
      expect(r.esperasCooldown).toBe(1);
      expect(r.sinDato).toBe(1);
      const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cooldown 429 activo'));
      warnSpy.mockRestore();
    });

    it('cooldown a esperar más largo que el tope → NO espera, corta directo (sin sleep real)', async () => {
      seedPublicacion(db, { clave: 'MLA964|', itemId: 'MLA964', sku: 'A', cantidadMl: 1 });

      // Nivel de backoff alto: el cooldown vence en 5 minutos, muy por encima del tope de 90s.
      const hasta = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      estadoCooldownMl.mockReturnValue({ activo: true, hasta, nivel: 2 });

      mlFetch.mockResolvedValue({ status: 429, data: null });

      const antes = Date.now();
      const r = await correr(db, CFG);
      const despues = Date.now();

      expect(mlFetch).toHaveBeenCalledTimes(1); // no hubo reintento: cortó directo
      expect(r.esperasCooldown).toBe(0);
      expect(r.sinDato).toBe(1);
      // No debe haber quedado ningún timer pendiente de una espera larga (runAllTimersAsync ya
      // habría fallado/colgado si hubiera un sleep de 5 min sin resolver dentro de `correr`).
      expect(despues - antes).toBeLessThan(1000);
    });

    it('un solo reintento por corrida: dos chunks distintos con 429 no producen dos esperas', async () => {
      seedUniversoGrande(db, 25); // 25 itemIds -> 2 chunks (20 + 5)

      const hasta = new Date(Date.now() + 5000).toISOString();
      estadoCooldownMl.mockReturnValue({ activo: true, hasta, nivel: 0 });

      mlFetch.mockResolvedValue({ status: 429, data: null }); // ambos chunks, y el reintento, dan 429

      const r = await correr(db, CFG);

      // Chunk 1 (429) + reintento (429, corta acá) = 2 llamadas; el chunk 2 nunca se intenta.
      expect(mlFetch).toHaveBeenCalledTimes(2);
      expect(r.esperasCooldown).toBe(1);
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

  it('cadena completa (el bug real): reconciliación sube el estado a 1 (lo que ML tenía) y la corrida siguiente de syncWcToMl empuja el stock real de Woo (0) a ML', async () => {
    seedPublicacion(db, { clave: 'MLA1117110786|', itemId: 'MLA1117110786', sku: 'FB-4501', cantidadMl: 0 });
    const nowIso = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(500, 'Producto FB-4501', 'FB-4501', 'simple', null, 0, nowIso);

    mlFetch.mockImplementation(async (dbArg, cfgArg, method, path) => {
      if (method === 'get' && path.includes('/items?ids=')) {
        return { status: 200, data: [{ code: 200, body: { id: 'MLA1117110786', status: 'active', available_quantity: 1 } }] };
      }
      return { status: 200, data: {} }; // PUT de syncWcToMl
    });

    const r = await correr(db, CFG);
    expect(r.corregidas).toBe(1);
    let estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA1117110786|'").get();
    expect(estado.cantidad_ml).toBe(1); // reconciliación dejó el estado igual a lo que ML tenía

    // Corrida siguiente: syncWcToMl ve deseado(Woo=0) != recordado(1) -> diff real -> empuja 0 a ML.
    const p = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    expect(mlFetch).toHaveBeenCalledWith(db, CFG.ml, 'put', '/items/MLA1117110786', { available_quantity: 0 });
    estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA1117110786|'").get();
    expect(estado.cantidad_ml).toBe(0);
  });

  it('caso Starvos completo (integración): syncWcToMl saltea la publicación por status "paused" stale en caché; reconciliarStockMl refresca el status a "active"; la corrida siguiente de syncWcToMl deja de saltearla y empuja el stock real', async () => {
    // Publicación activa y vendiendo en ML, pero la caché local (solo se refresca con el
    // botón del matcher) todavía la cree "paused" desde hace tiempo. Sin fila en
    // ml_stock_estado (punto ciego). Woo tiene stock real 15 (2 unidades menos que las 17
    // que ML todavía figura vendiendo — sobreventa real del caso Starvos).
    seedPublicacion(db, { clave: 'MLA3101044322|', itemId: 'MLA3101044322', sku: 'FB-58761', cantidadMl: 17, status: 'paused' });
    db.prepare("UPDATE ml_publicaciones_cache SET sub_status = 'paused_by_seller' WHERE clave = 'MLA3101044322|'").run();
    const nowIso = new Date().toISOString();
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(700, 'Casco Bontrager Starvos', 'FB-58761', 'simple', null, 15, nowIso);

    // Paso 0 (control): ANTES de reconciliar, syncWcToMl la saltea — su caché de status por
    // item_id sigue leyendo 'paused' de ml_publicaciones_cache, así que ni siquiera intenta
    // el PUT. Esto es lo que reproducía el bug: la publicación quedaba invisible al sync.
    const p0 = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p0;
    expect(mlFetch).not.toHaveBeenCalledWith(db, CFG.ml, 'put', '/items/MLA3101044322', expect.anything());
    let estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA3101044322|'").get();
    expect(estado.cantidad_ml).toBe(17); // intacto: la publicación ni se tocó

    // Paso 1: reconciliarStockMl consulta ML directo (multiget), ignora el status stale de
    // la caché (universo ya no filtra por status), y descubre que ML la tiene 'active' con
    // 17 unidades — refresca status Y corrige ml_stock_estado.
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA3101044322', status: 'active', sub_status: [], available_quantity: 17 } }],
    });
    const r1 = await correr(db, CFG);
    expect(r1.statusRefrescados).toBe(1);
    const cache = db.prepare("SELECT status, sub_status FROM ml_publicaciones_cache WHERE clave = 'MLA3101044322|'").get();
    expect(cache.status).toBe('active');
    estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA3101044322|'").get();
    expect(estado.cantidad_ml).toBe(17); // reconciliación deja el estado en lo que ML tenía

    // Paso 2: con la caché ya al día, syncWcToMl deja de saltearla — ve deseado(Woo=15) !=
    // recordado(17) -> diff real -> empuja el stock real de Woo a ML, cerrando la sobreventa.
    mlFetch.mockClear();
    mlFetch.mockResolvedValue({ status: 200, data: {} }); // PUT de syncWcToMl
    const p2 = syncWcToMl(db, CFG);
    await vi.runAllTimersAsync();
    await p2;

    expect(mlFetch).toHaveBeenCalledWith(db, CFG.ml, 'put', '/items/MLA3101044322', { available_quantity: 15 });
    estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA3101044322|'").get();
    expect(estado.cantidad_ml).toBe(15);
  });

  it('la pausa entre chunks se aplica de verdad: no antes del primer chunk, sí antes del segundo, no después del último', async () => {
    seedUniversoGrande(db, 25); // 25 itemIds únicos -> 2 chunks (20 + 5)
    mlFetch.mockImplementation(async (dbArg, cfgArg, method, path) => {
      const ids = path.match(/ids=([^&]+)/)[1].split(',');
      return { status: 200, data: ids.map(id => ({ code: 200, body: { id, status: 'active', available_quantity: 1 } })) };
    });

    const p = reconciliarStockMl(db, CFG);

    await vi.advanceTimersByTimeAsync(0);
    expect(mlFetch).toHaveBeenCalledTimes(1); // primer chunk sale sin esperar pausa previa

    await vi.advanceTimersByTimeAsync(1400);
    expect(mlFetch).toHaveBeenCalledTimes(1); // todavía no se cumplió la pausa de 1500ms

    await vi.advanceTimersByTimeAsync(100);
    expect(mlFetch).toHaveBeenCalledTimes(2); // segundo chunk recién ahora

    await vi.runAllTimersAsync();
    const r = await p;
    expect(mlFetch).toHaveBeenCalledTimes(2); // sin pausa (ni tercer chunk) después del último
    expect(r.revisadas).toBe(25);
  });

  describe('universo: filas con status distinto de "active" en la caché local (caso Starvos)', () => {
    it('con cantidad_ml > 0 entra al universo (siempre entra, ya no depende del status en caché), y se saltea sin tocar el estado si ML confirma que sigue no-activa', async () => {
      seedPublicacion(db, { clave: 'MLA850|', itemId: 'MLA850', sku: 'CASCO-Z', cantidadMl: 2, status: 'paused' });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA850', status: 'paused', available_quantity: 2 } }],
      });

      const r = await correr(db, CFG);

      expect(mlFetch).toHaveBeenCalled(); // se consultó pese a que la caché local dice "paused"
      expect(r.revisadas).toBe(1);
      expect(r.corregidas).toBe(0); // ML confirma que sigue sin estar activa: se saltea sin corregir
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA850|'").get();
      expect(estado.cantidad_ml).toBe(2);
    });

    it('con cantidad_ml = 0 y status "closed" en caché IGUAL entra al universo (el universo ya no filtra por status): se consulta y no hay nada que corregir', async () => {
      seedPublicacion(db, { clave: 'MLA851|', itemId: 'MLA851', sku: 'CASCO-Y', cantidadMl: 0, status: 'closed' });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA851', status: 'closed', available_quantity: 0 } }],
      });

      const r = await correr(db, CFG);

      expect(mlFetch).toHaveBeenCalled();
      expect(r.revisadas).toBe(1);
      expect(r.corregidas).toBe(0);
    });

    it('caso Starvos: status="paused_by_seller" en caché pero ML la tiene "active" con stock → SÍ entra al universo, se corrige el stock Y se refresca el status en ml_publicaciones_cache', async () => {
      seedPublicacion(db, { clave: 'MLA3101044322|', itemId: 'MLA3101044322', sku: 'FB-58761', cantidadMl: 13, status: 'paused' });
      db.prepare("UPDATE ml_publicaciones_cache SET sub_status = 'paused_by_seller' WHERE clave = 'MLA3101044322|'").run();
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA3101044322', status: 'active', sub_status: [], available_quantity: 15 } }],
      });

      const r = await correr(db, CFG);

      expect(r.revisadas).toBe(1);
      expect(r.corregidas).toBe(1);
      expect(r.statusRefrescados).toBe(1);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA3101044322|'").get();
      expect(estado.cantidad_ml).toBe(15);
      const cache = db.prepare("SELECT status, sub_status FROM ml_publicaciones_cache WHERE clave = 'MLA3101044322|'").get();
      expect(cache.status).toBe('active');
      expect(cache.sub_status).toBe('');
    });
  });

  describe('universo: filas sin fila en ml_stock_estado (LEFT JOIN, punto ciego cerrado)', () => {
    function seedSinStockEstado(db, { clave, itemId, sku, status = 'active' }) {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run(clave, sku, 'Producto', 'confirmar', now);
      db.prepare(
        'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run(clave, itemId, '', status, now);
    }

    it('publicación mapeada sin fila en ml_stock_estado se da de alta con el valor REAL de ML (no se pierde el punto ciego)', async () => {
      seedSinStockEstado(db, { clave: 'MLA3100995880|', itemId: 'MLA3100995880', sku: 'FB-58759' });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA3100995880', status: 'active', available_quantity: 12 } }],
      });

      const r = await correr(db, CFG);

      expect(r.revisadas).toBe(1);
      expect(r.altas).toBe(1); // alta (m2, ronda 2 revisor), no corregidas — no había fila previa
      expect(r.corregidas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA3100995880|'").get();
      expect(estado.cantidad_ml).toBe(12);
      const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA3100995880|' AND estado = 'reconciliado'").get();
      expect(log).toBeTruthy();
      expect(log.cant_anterior).toBeNull();
      expect(log.cant_nueva).toBe(12);
      expect(log.error).toMatch(/sin ml_stock_estado registrado/);
      expect(log.error).toMatch(/ML tiene 12/);
    });

    it('el INSERT de alta usa ON CONFLICT(clave) DO NOTHING: si otro proceso ya insertó la fila entre la lectura del universo y este INSERT, no la pisa (m4, ronda 2 revisor)', async () => {
      seedSinStockEstado(db, { clave: 'MLA3100995881|', itemId: 'MLA3100995881', sku: 'FB-58762' });
      // Simula el proceso concurrente (syncWcToMl/procesarReintentos) insertando la fila DESPUÉS
      // de que el universo se leyó (LEFT JOIN, sin fila todavía) pero ANTES de que este INSERT se
      // ejecute — el ON CONFLICT tiene que ejercerse de verdad, no pasar por accidente porque no
      // había fila previa.
      mlFetch.mockImplementation(async () => {
        db.prepare(
          'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
        ).run('MLA3100995881|', 'FB-58762', 5, new Date().toISOString());
        return {
          status: 200,
          data: [{ code: 200, body: { id: 'MLA3100995881', status: 'active', available_quantity: 12 } }],
        };
      });

      const r = await correr(db, CFG);

      // El ON CONFLICT DO NOTHING no pisó la fila del otro proceso (5), y no cuenta como
      // corregida/alta: el dato del otro proceso es más fresco que la lectura de ML de esta
      // corrida.
      expect(r.corregidas).toBe(0);
      expect(r.altas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA3100995881|'").get();
      expect(estado.cantidad_ml).toBe(5); // conserva el valor del otro proceso, no el 12 de ML
    });
  });

  describe('write-back de status/sub_status: no toca actualizado_en, CAS contra snapshot previo, sub_status ausente no pisa', () => {
    it('escribe status/sub_status pero NO toca actualizado_en de ml_publicaciones_cache (B1, revisor)', async () => {
      seedPublicacion(db, { clave: 'MLA1000|', itemId: 'MLA1000', sku: 'A', cantidadMl: 1, status: 'paused' });
      const actualizadoAntes = db.prepare("SELECT actualizado_en FROM ml_publicaciones_cache WHERE clave = 'MLA1000|'").get().actualizado_en;

      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA1000', status: 'active', sub_status: [], available_quantity: 1 } }],
      });

      const r = await correr(db, CFG);

      expect(r.statusRefrescados).toBe(1);
      const cache = db.prepare("SELECT status, sub_status, actualizado_en FROM ml_publicaciones_cache WHERE clave = 'MLA1000|'").get();
      expect(cache.status).toBe('active');
      expect(cache.actualizado_en).toBe(actualizadoAntes); // intacto
    });

    it('sub_status ausente en la respuesta de ML no borra el sub_status guardado (M2, revisor)', async () => {
      seedPublicacion(db, { clave: 'MLA1001|', itemId: 'MLA1001', sku: 'A', cantidadMl: 1, status: 'paused' });
      db.prepare("UPDATE ml_publicaciones_cache SET sub_status = 'out_of_stock' WHERE clave = 'MLA1001|'").run();

      // ML responde 200 con status pero SIN el atributo sub_status.
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA1001', status: 'paused', available_quantity: 1 } }],
      });

      await correr(db, CFG);

      const cache = db.prepare("SELECT sub_status FROM ml_publicaciones_cache WHERE clave = 'MLA1001|'").get();
      expect(cache.sub_status).toBe('out_of_stock'); // no se pisó con ''
    });

    it('CAS de status: si otro flujo cambió el status entre el snapshot y el UPDATE, no se pisa (M1, revisor)', async () => {
      seedPublicacion(db, { clave: 'MLA1002|', itemId: 'MLA1002', sku: 'A', cantidadMl: 1, status: 'paused' });

      // El multiget devuelve 'paused' (dato "viejo" al momento en que se resuelve la promesa),
      // pero antes de que se resuelva, otro flujo (simulado acá) ya reactivó la publicación.
      mlFetch.mockImplementation(async () => {
        db.prepare("UPDATE ml_publicaciones_cache SET status = 'active', sub_status = '' WHERE clave = 'MLA1002|'").run();
        return { status: 200, data: [{ code: 200, body: { id: 'MLA1002', status: 'paused', available_quantity: 1 } }] };
      });

      const r = await correr(db, CFG);

      expect(r.statusRefrescados).toBe(0); // el CAS no matcheó: snapshot decía 'paused', cache ya no
      const cache = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave = 'MLA1002|'").get();
      expect(cache.status).toBe('active'); // ganó el dato más fresco del otro flujo, no se pisó
    });

    it('item con N variaciones en el lote: una sola escritura de status, statusRefrescados cuenta 1 no N', async () => {
      seedPublicacion(db, { clave: 'MLA1003|1', itemId: 'MLA1003', variationId: '1', sku: 'A', cantidadMl: 1, status: 'paused' });
      seedPublicacion(db, { clave: 'MLA1003|2', itemId: 'MLA1003', variationId: '2', sku: 'B', cantidadMl: 1, status: 'paused' });

      mlFetch.mockResolvedValue({
        status: 200,
        data: [{
          code: 200,
          body: {
            id: 'MLA1003', status: 'active', sub_status: [],
            variations: [{ id: 1, available_quantity: 1 }, { id: 2, available_quantity: 1 }],
          },
        }],
      });

      const r = await correr(db, CFG);

      expect(r.statusRefrescados).toBe(1);
    });

    it('m1 (ronda 2, revisor): dos filas del MISMO item_id con status divergente entre sí — el CAS es por clave, así que ambas se corrigen (no queda una absorbida para siempre)', async () => {
      // Caso que describe el hallazgo: refresh parcial dejó las dos variaciones del mismo
      // item_id con status distinto entre sí ANTES de esta corrida (dato inconsistente ya
      // existente). Con un único snapshot por item_id (LIMIT 1 sin ORDER BY) el UPDATE por
      // item_id con WHERE status IS <snapshot único> solo podía matchear una de las dos —
      // la otra quedaba clavada para siempre, porque la corrida siguiente volvía a snapshotear
      // la misma fila "ganadora". Con snapshot y CAS por clave, ambas se actualizan.
      seedPublicacion(db, { clave: 'MLA1006|1', itemId: 'MLA1006', variationId: '1', sku: 'A', cantidadMl: 1, status: 'paused' });
      seedPublicacion(db, { clave: 'MLA1006|2', itemId: 'MLA1006', variationId: '2', sku: 'B', cantidadMl: 1, status: 'active' });

      mlFetch.mockResolvedValue({
        status: 200,
        data: [{
          code: 200,
          body: {
            id: 'MLA1006', status: 'active', sub_status: [],
            variations: [{ id: 1, available_quantity: 1 }, { id: 2, available_quantity: 1 }],
          },
        }],
      });

      const r = await correr(db, CFG);

      // Ambas filas terminan con status='active' en la caché: la que ya decía 'active' no
      // cambió (no suma al UPDATE), la que decía 'paused' sí se corrigió.
      expect(r.statusRefrescados).toBe(1); // sigue contando por ítem, no por fila (ver test de arriba)
      const c1 = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave = 'MLA1006|1'").get();
      const c2 = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave = 'MLA1006|2'").get();
      expect(c1.status).toBe('active');
      expect(c2.status).toBe('active');
    });

    it('M3 (ronda 2, revisor): status ausente en la última fila del lote, PERMANENTE en corridas consecutivas — el cursor no avanza las primeras dos veces, pero SÍ a la tercera, con sync_log error accionable', async () => {
      // Universo de 1 sola clave: con lote de tamaño 1 esa fila es a la vez la primera Y la
      // última del lote — la reproducción más simple de "status ausente al final del lote",
      // que es justamente el caso que dejaba `ultimaIdxConDato` sin setear y el cursor sin
      // avanzar. ML responde 200 pero el body no trae el atributo `status` (ausente, no null
      // explícito — mismo caso que describe el comentario del código).
      seedPublicacion(db, { clave: 'MLA1007|', itemId: 'MLA1007', sku: 'A', cantidadMl: 1, status: 'paused' });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA1007', available_quantity: 1 } }], // sin `status`
      });

      // 1ra y 2da corrida: transitorio todavía (< 3 consecutivas) — el cursor NO avanza, sin
      // log de error, la fila se reintenta en la próxima corrida.
      let r = await correr(db, CFG);
      expect(r.sinDato).toBe(1);
      let cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor).toBeUndefined(); // nunca se seteó: ultimaIdxConDato quedó en -1

      r = await correr(db, CFG);
      expect(r.sinDato).toBe(1);
      cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor).toBeUndefined();

      let errorLog = db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA1007|' AND estado = 'error'").get();
      expect(errorLog).toBeUndefined(); // todavía no es "permanente"

      // 3ra corrida consecutiva: la condición ya no es transitoria — el cursor avanza igual
      // (universo de 1 sola clave: vuelve a la misma) y queda un sync_log 'error' accionable.
      r = await correr(db, CFG);
      expect(r.sinDato).toBe(1);
      cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor.valor).toBe('MLA1007|'); // avanzó (única clave del universo)

      errorLog = db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA1007|' AND estado = 'error'").get();
      expect(errorLog).toBeTruthy();
      expect(errorLog.error).toMatch(/status/i);
      expect(errorLog.error).toMatch(/3 corridas consecutivas|permanente/i);

      // 4ta corrida: el contador se reseteó tras el log de error — vuelve a comportarse como
      // transitorio (no dispara un error en cada corrida sucesiva).
      const cantLogsAntes = db.prepare("SELECT COUNT(*) n FROM sync_log WHERE clave = 'MLA1007|' AND estado = 'error'").get().n;
      r = await correr(db, CFG);
      expect(r.sinDato).toBe(1);
      const cantLogsDespues = db.prepare("SELECT COUNT(*) n FROM sync_log WHERE clave = 'MLA1007|' AND estado = 'error'").get().n;
      expect(cantLogsDespues).toBe(cantLogsAntes); // no logueó de nuevo, iba en 1/3
    });

    it('item ausente del multiget / 429 → no se escribe status (garantía fail-closed)', async () => {
      seedPublicacion(db, { clave: 'MLA1004|', itemId: 'MLA1004', sku: 'A', cantidadMl: 1, status: 'paused' });
      mlFetch.mockResolvedValue({ status: 429, data: null });

      const r = await correr(db, CFG);

      expect(r.statusRefrescados).toBe(0);
      const cache = db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave = 'MLA1004|'").get();
      expect(cache.status).toBe('paused'); // intacto
    });

    it('fila con cantidad_ml == null y sku vacío → no inserta, cuenta sinSku, cursor avanza', async () => {
      const nowIso = new Date().toISOString();
      db.prepare(
        'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run('MLA1005|', '', 'Producto', 'confirmar', nowIso);
      db.prepare(
        'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
      ).run('MLA1005|', 'MLA1005', '', 'active', nowIso);

      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA1005', status: 'active', available_quantity: 3 } }],
      });

      const r = await correr(db, CFG);

      expect(r.sinSku).toBe(1);
      expect(db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLA1005|'").get()).toBeUndefined();
      const cursor = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
      expect(cursor.valor).toBe('MLA1005|'); // cursor avanzó igual
    });
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
