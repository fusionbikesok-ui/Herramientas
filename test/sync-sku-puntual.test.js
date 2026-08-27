import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { syncSkuPuntual, syncWcToMl } from '../routes/sync.js';

// Mock mlFetch para evitar llamadas reales a ML
vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return {
    ...actual,
    mlFetch: vi.fn(),
  };
});
import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = './test/tmp-sync-sku-puntual.sqlite';

const CFG = {
  ml: { clientId: 'test', clientSecret: 'test', userId: 'test' },
};

/**
 * Seeds para tests de syncSkuPuntual
 */
function seedMatcher(db, sku, clave, itemId, variationId = '') {
  const now = new Date().toISOString();
  const fullClave = variationId ? `${clave}|${variationId}` : `${clave}|`;
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(fullClave, sku, `Producto ${sku}`, 'confirmar', now);
}

function seedCatalogo(db, sku, stock = 10) {
  const now = new Date().toISOString();
  const idWoo = Math.floor(100 + Math.random() * 10000);
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(idWoo, `Producto ${sku}`, sku, 'simple', null, stock, now);
}

describe('syncSkuPuntual', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('sin cambios', () => {
    it('devuelve sin_cambios cuando el SKU no tiene diff pendiente', async () => {
      seedMatcher(db, 'SKU-001', 'MLA100', 'MLA100');
      seedCatalogo(db, 'SKU-001', 10);

      // Insertar un ml_stock_estado con cantidad igual al stock disponible (sin diff)
      db.prepare(
        'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
      ).run('MLA100|', 'SKU-001', 10, new Date().toISOString());

      const result = await syncSkuPuntual(db, CFG, 'SKU-001');

      expect(result.sku).toBe('SKU-001');
      expect(result.estado).toBe('sin_cambios');
      expect(result.detalle).toContain('Sin cambios pendientes');
      // No debe hacer ninguna llamada a ML
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('devuelve sin_cambios cuando la publicación está pausada', async () => {
      seedMatcher(db, 'SKU-002', 'MLA200', 'MLA200');
      seedCatalogo(db, 'SKU-002', 15);

      // Hay diff pendiente (stock en WC es 15, cantidad_ml es 5)
      db.prepare(
        'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
      ).run('MLA200|', 'SKU-002', 5, new Date().toISOString());

      // mlFetch devuelve status 'paused' (no activa)
      mlFetch.mockResolvedValue({
        status: 200,
        data: { status: 'paused' },
      });

      const result = await syncSkuPuntual(db, CFG, 'SKU-002');

      expect(result.sku).toBe('SKU-002');
      expect(result.estado).toBe('sin_cambios');
      expect(result.detalle).toContain('paused');
      // Debe consultar status pero NO hacer PUT
      expect(mlFetch).toHaveBeenCalledWith(
        db, CFG.ml, 'get', '/items/MLA200?attributes=status'
      );
      expect(mlFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('sincronizado', () => {
    it('devuelve sincronizado cuando el PUT a ML tiene éxito', async () => {
      seedMatcher(db, 'SKU-003', 'MLA300', 'MLA300');
      seedCatalogo(db, 'SKU-003', 20);

      // Hay diff: 20 en WC vs 10 en ML
      db.prepare(
        'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
      ).run('MLA300|', 'SKU-003', 10, new Date().toISOString());

      // Mock: status active → PUT exitoso
      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'active' } }) // GET status
        .mockResolvedValueOnce({ status: 200, data: {} }); // PUT stock

      const result = await syncSkuPuntual(db, CFG, 'SKU-003');

      expect(result.sku).toBe('SKU-003');
      expect(result.estado).toBe('sincronizado');
      expect(result.detalle).toBe('1/1 publicaciones actualizadas');

      // Verificar que se actualizó ml_stock_estado
      const estado = db.prepare("SELECT * FROM ml_stock_estado WHERE clave = 'MLA300|'").get();
      expect(estado.cantidad_ml).toBe(20);

      // Debe hacer dos llamadas: GET status + PUT stock
      expect(mlFetch).toHaveBeenCalledTimes(2);
      const putCall = mlFetch.mock.calls.find(c => c[2] === 'put');
      expect(putCall).toBeTruthy();
      expect(putCall[3]).toBe('/items/MLA300');
      expect(putCall[4]).toEqual({ available_quantity: 20 });
    });

    it('devuelve sincronizado con variación', async () => {
      seedMatcher(db, 'SKU-004', 'MLA400', 'MLA400', '999');
      seedCatalogo(db, 'SKU-004', 8);

      db.prepare(
        'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
      ).run('MLA400|999', 'SKU-004', 3, new Date().toISOString());

      mlFetch
        .mockResolvedValueOnce({ status: 200, data: { status: 'active' } })
        .mockResolvedValueOnce({ status: 200, data: {} });

      const result = await syncSkuPuntual(db, CFG, 'SKU-004');

      expect(result.estado).toBe('sincronizado');

      // El PUT debe ir al endpoint de variación
      const putCall = mlFetch.mock.calls.find(c => c[2] === 'put');
      expect(putCall[3]).toBe('/items/MLA400/variations/999');
      expect(putCall[4]).toEqual({ available_quantity: 8 });
    });
  });

  describe('error', () => {
    it('devuelve error cuando el GET de status falla y agota el reintento (1 solo reintento, no 3)', async () => {
      vi.useFakeTimers();
      try {
        seedMatcher(db, 'SKU-005', 'MLA500', 'MLA500');
        seedCatalogo(db, 'SKU-005', 12);

        db.prepare(
          'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
        ).run('MLA500|', 'SKU-005', 5, new Date().toISOString());

        // Siempre falla
        mlFetch.mockRejectedValue(new Error('Timeout de ML'));

        const resultPromise = syncSkuPuntual(db, CFG, 'SKU-005');
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.sku).toBe('SKU-005');
        expect(result.estado).toBe('error');
        expect(result.detalle).toContain('Fallo tras reintento');
        // Backoff acotado a 1 reintento (no 3): exactamente 2 llamadas al GET de status.
        expect(mlFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('devuelve error cuando el PUT falla y agota el reintento', async () => {
      vi.useFakeTimers();
      try {
        seedMatcher(db, 'SKU-006', 'MLA600', 'MLA600');
        seedCatalogo(db, 'SKU-006', 14);

        db.prepare(
          'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
        ).run('MLA600|', 'SKU-006', 2, new Date().toISOString());

        // GET status exitoso las 2 veces (una por intento), PUT siempre falla.
        mlFetch.mockImplementation(async (db_, mlCfg, method) => {
          if (method === 'get') return { status: 200, data: { status: 'active' } };
          throw new Error('PUT failed');
        });

        const resultPromise = syncSkuPuntual(db, CFG, 'SKU-006');
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.sku).toBe('SKU-006');
        expect(result.estado).toBe('error');
        expect(result.detalle).toContain('Fallo tras reintento');
        // 2 GET + 2 PUT (1 intento + 1 reintento)
        expect(mlFetch).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it('NO reintenta cuando el PUT responde un HTTP de error real (4xx/5xx que ML contestó, no es transitorio)', async () => {
      seedMatcher(db, 'SKU-006b', 'MLA650', 'MLA650');
      seedCatalogo(db, 'SKU-006b', 14);
      db.prepare(
        'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
      ).run('MLA650|', 'SKU-006b', 2, new Date().toISOString());

      mlFetch.mockImplementation(async (db_, mlCfg, method) => {
        if (method === 'get') return { status: 200, data: { status: 'active' } };
        return { status: 400, data: { error: 'bad_request' } };
      });

      const result = await syncSkuPuntual(db, CFG, 'SKU-006b');

      expect(result.estado).toBe('error');
      // 1 GET + 1 PUT, sin reintento: un HTTP de respuesta no es un fallo de red.
      expect(mlFetch).toHaveBeenCalledTimes(2);
    });

    it('devuelve omitido (no error) SIN reintentar cuando ML devuelve 429 (cooldown global, igual criterio que syncWcToMl)', async () => {
      seedMatcher(db, 'SKU-007', 'MLA700', 'MLA700');
      seedCatalogo(db, 'SKU-007', 16);

      db.prepare(
        'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
      ).run('MLA700|', 'SKU-007', 1, new Date().toISOString());

      mlFetch.mockResolvedValue({ status: 429, data: {} });

      const result = await syncSkuPuntual(db, CFG, 'SKU-007');

      expect(result.sku).toBe('SKU-007');
      // 429 no es un fallo de este SKU, es cooldown global: no se pinta de error, el
      // cron lo retoma. Mismo criterio que "ML no configurado".
      expect(result.estado).toBe('omitido');
      expect(result.detalle.toLowerCase()).toContain('cooldown');
      // Sin backoff: el 429 corta de una, una sola llamada (el GET de status).
      expect(mlFetch).toHaveBeenCalledTimes(1);
    });

    it('devuelve error con SKU inválido', async () => {
      const result = await syncSkuPuntual(db, CFG, '');

      expect(result.estado).toBe('error');
      expect(result.detalle).toContain('SKU inválido');
    });
  });

  describe('omitido', () => {
    it('devuelve omitido (no error) sin config ML', async () => {
      seedMatcher(db, 'SKU-008', 'MLA800', 'MLA800');
      seedCatalogo(db, 'SKU-008', 18);

      const noCfg = { ml: null };
      const result = await syncSkuPuntual(db, noCfg, 'SKU-008');

      expect(result.estado).toBe('omitido');
      expect(result.detalle).toContain('ML no configurado');
      expect(mlFetch).not.toHaveBeenCalled();
    });

    it('devuelve omitido si el sync general (syncWcToMl) está en curso', async () => {
      // Sembrar un diff AJENO (otro SKU) para que syncWcToMl tenga trabajo async real y
      // el candado _wcToMlEnCurso quede en true mientras está "colgado" esperando ML.
      seedMatcher(db, 'SKU-OTRO', 'MLA999', 'MLA999');
      seedCatalogo(db, 'SKU-OTRO', 5);
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA999|', 'SKU-OTRO', 1, new Date().toISOString());

      seedMatcher(db, 'SKU-009b', 'MLA1099', 'MLA1099');
      seedCatalogo(db, 'SKU-009b', 7);
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA1099|', 'SKU-009b', 1, new Date().toISOString());

      let liberarMl;
      const colgado = new Promise(resolve => { liberarMl = resolve; });
      mlFetch.mockImplementation(() => colgado);

      // No se awaitea: syncWcToMl corre síncrono hasta su primer await (adentro de
      // _syncWcToMl, en el mlFetch que quedó colgado), dejando _wcToMlEnCurso=true.
      const corridaCron = syncWcToMl(db, CFG);

      const result = await syncSkuPuntual(db, CFG, 'SKU-009b');
      expect(result.estado).toBe('omitido');
      expect(result.detalle).toContain('en curso');

      liberarMl({ status: 200, data: { status: 'active' } });
      await corridaCron;
    });
  });

  describe('SKU con más de una publicación mapeada', () => {
    it('sincronizado agrega el conteo de publicaciones actualizadas cuando todas tienen éxito', async () => {
      seedMatcher(db, 'SKU-009', 'MLA900', 'MLA900');
      seedMatcher(db, 'SKU-009', 'MLA901', 'MLA901');
      seedCatalogo(db, 'SKU-009', 7);
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA900|', 'SKU-009', 1, new Date().toISOString());
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA901|', 'SKU-009', 2, new Date().toISOString());

      mlFetch.mockImplementation(async (db_, mlCfg, method) => {
        if (method === 'get') return { status: 200, data: { status: 'active' } };
        return { status: 200, data: {} };
      });

      const result = await syncSkuPuntual(db, CFG, 'SKU-009');

      expect(result.estado).toBe('sincronizado');
      expect(result.detalle).toBe('2/2 publicaciones actualizadas');
    });

    it('NO reporta sincronizado si una de dos publicaciones falla (no miente sobre la que quedó sin actualizar)', async () => {
      seedMatcher(db, 'SKU-010', 'MLA1000', 'MLA1000');
      seedMatcher(db, 'SKU-010', 'MLA1001', 'MLA1001');
      seedCatalogo(db, 'SKU-010', 9);
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA1000|', 'SKU-010', 1, new Date().toISOString());
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA1001|', 'SKU-010', 2, new Date().toISOString());

      mlFetch.mockImplementation(async (db_, mlCfg, method, path) => {
        if (method === 'get') return { status: 200, data: { status: 'active' } };
        // El PUT de MLA1001 falla con un error real de ML (no 429/cooldown, que ahora es
        // 'omitido' y no debe contarse como fallo de este SKU).
        if (path.includes('MLA1001')) return { status: 500, data: { error: 'internal' } };
        return { status: 200, data: {} };
      });

      const result = await syncSkuPuntual(db, CFG, 'SKU-010');

      // Con LIMIT 1 (versión anterior) esto habría dado 'sincronizado' sin más — acá debe
      // reflejar que MLA1001 quedó sin actualizar.
      expect(result.estado).toBe('error');
    });

    it('agregado es omitido (no sin_cambios) si una clave da 429 y la otra SÍ está sin diff real — no mezcla los dos significados', async () => {
      seedMatcher(db, 'SKU-011', 'MLA1100', 'MLA1100');
      seedMatcher(db, 'SKU-011', 'MLA1101', 'MLA1101');
      seedCatalogo(db, 'SKU-011', 9);
      // MLA1100: sin diff real (ya está sincronizada, ni siquiera va a entrar al SELECT
      // del CTE) — para forzar el caso, ambas claves SÍ tienen diff, pero MLA1100 la
      // resuelve como 'sin_cambios' porque su publicación está pausada.
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA1100|', 'SKU-011', 1, new Date().toISOString());
      db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run('MLA1101|', 'SKU-011', 2, new Date().toISOString());

      mlFetch.mockImplementation(async (db_, mlCfg, method, path) => {
        if (method === 'get') {
          if (path.includes('MLA1100')) return { status: 200, data: { status: 'paused' } };
          return { status: 429, data: {} }; // MLA1101: cooldown
        }
        return { status: 200, data: {} };
      });

      const result = await syncSkuPuntual(db, CFG, 'SKU-011');

      // Sigue habiendo un diff sin resolver (MLA1101, cooldown) — no es "confirmado sin
      // cambios pendientes", aunque MLA1100 sí lo esté genuinamente.
      expect(result.estado).toBe('omitido');
    });
  });
});
