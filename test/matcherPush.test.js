import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import {
  seleccionarPendientes, contarPendientes, pushSkusPendientes,
  getEstadoPush, _resetEstadoPushParaTests,
} from '../lib/matcherPush.js';
import { mlFetch, estadoCooldownMl, _resetCooldownParaTests } from '../lib/mlClient.js';

// Mock axios para evitar llamadas reales a ML
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';

// Mock del rate limiter propio para simular __sinCupo de forma determinística:
// el token bucket real se rellena continuo y en 15s de espera (ESPERA_MAX_MS)
// recupera cupo solo, así que no se puede provocar un __sinCupo confiable sin
// mockear reservarCupo directamente.
vi.mock('../lib/mlRateLimiter.js', async () => {
  const actual = await vi.importActual('../lib/mlRateLimiter.js');
  return { ...actual, reservarCupo: vi.fn(actual.reservarCupo) };
});
import { reservarCupo } from '../lib/mlRateLimiter.js';

// Mock parcial de mlClient: por default reenvía a la implementación real
// (mlFetch = vi.fn(actual.mlFetch)), así que el camino real (429 real → cooldown propio →
// sintético en el intento siguiente, ver BLOQUEANTE 1 del revisor 2026-08-06) queda cubierto
// end-to-end vía axios.request en los tests que no tocan este mock. Algunos tests igual
// sobreescriben mlFetch directo con mockResolvedValue/mockImplementation puntual como caso
// EXTRA para aislar el loop de reintentos de la mecánica de cooldown de mlClient.
vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(actual.mlFetch) };
});

const TEST_DB = './test/tmp-matcher-push.sqlite';
const ML_CFG = { clientId: 'client123', clientSecret: 'secret456', userId: '99999' };

function now() { return new Date().toISOString(); }

function seedToken(db) {
  const expiresAt = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
     VALUES (1, 'tok', 'ref', ?, ?)`
  ).run(expiresAt, now());
}

function seedDecision(db, { clave, sku, accion = 'asignar' }) {
  db.prepare(
    'INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(clave, sku, sku, accion, now());
}

function seedCache(db, { clave, itemId, variationId = '', titulo = 'Pub', status = 'active', sellerSku = '' }) {
  db.prepare(
    `INSERT INTO ml_publicaciones_cache
       (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, actualizado_en)
     VALUES (?, ?, ?, ?, ?, '', 0, '', '', ?, '', ?)`
  ).run(clave, itemId, variationId, titulo, status, sellerSku, now());
}

function respOk() {
  return { status: 200, headers: {}, data: {} };
}
function resp429() {
  return { status: 429, headers: { 'retry-after': '0' }, data: {} };
}
function resp400(msg = 'no se pudo') {
  return { status: 400, headers: {}, data: { message: msg } };
}

describe('lib/matcherPush', () => {
  let db;
  beforeEach(async () => {
    db = openDb(TEST_DB);
    seedToken(db);
    vi.clearAllMocks();
    // mlFetch es un mock que por default reenvía a la implementación real (vi.fn(actual));
    // clearAllMocks() no borra un mockResolvedValue puntual de un test anterior, así que se
    // restaura acá explícitamente para no dejar un 429 "puro" pisando el resto de la suite.
    const actualMlClient = await vi.importActual('../lib/mlClient.js');
    mlFetch.mockImplementation(actualMlClient.mlFetch);
    // Mismo motivo: clearAllMocks() no deshace un mockResolvedValue persistente de un test
    // anterior (ej. __sinCupo sostenido), así que sin esto ese mock "pisaba" a los siguientes.
    const actualRateLimiter = await vi.importActual('../lib/mlRateLimiter.js');
    reservarCupo.mockImplementation(actualRateLimiter.reservarCupo);
    _resetEstadoPushParaTests();
    // El cooldown de 429 vive en el módulo mlClient: sin esto, el test de "429
    // persistente" se lo deja activo a los siguientes y los corta de entrada.
    _resetCooldownParaTests();
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('seleccionarPendientes prioriza activas sobre pausadas', () => {
    seedCache(db, { clave: 'P1|', itemId: 'P1', status: 'paused' });
    seedDecision(db, { clave: 'P1|', sku: 'FB-1' });
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-2' });

    const lote = seleccionarPendientes(db, 10);
    expect(lote.map(p => p.clave)).toEqual(['A1|', 'P1|']);
  });

  it('contarPendientes separa activas/pausadas/en_espera (backoff futuro)', () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });
    seedCache(db, { clave: 'P1|', itemId: 'P1', status: 'paused' });
    seedDecision(db, { clave: 'P1|', sku: 'FB-2' });
    seedCache(db, { clave: 'W1|', itemId: 'W1', status: 'active' });
    seedDecision(db, { clave: 'W1|', sku: 'FB-3' });
    const futuro = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare(`INSERT INTO ml_sku_push_fallos (clave, sku, intentos, proximo_intento_en, actualizado_en) VALUES (?, ?, 1, ?, ?)`)
      .run('W1|', 'FB-3', futuro, now());

    const r = contarPendientes(db);
    expect(r).toEqual({ total: 2, activas: 1, pausadas: 1, enEspera: 1 });
  });

  it('éxito borra un fallo previo registrado para esa clave', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });
    db.prepare(`INSERT INTO ml_sku_push_fallos (clave, sku, intentos, proximo_intento_en, actualizado_en) VALUES ('A1|', 'FB-1', 1, ?, ?)`)
      .run(new Date(Date.now() - 3600 * 1000).toISOString(), now());

    axios.request.mockResolvedValue(respOk());
    const r = await pushSkusPendientes(db, ML_CFG);

    expect(r.escritos).toBe(1);
    expect(r.errores).toBe(0);
    const fallo = db.prepare('SELECT * FROM ml_sku_push_fallos WHERE clave = ?').get('A1|');
    expect(fallo).toBeUndefined();
  });

  it('error 400 registra fallo con backoff creciente entre corridas', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

    axios.request.mockResolvedValue(resp400('publicación con restricciones'));
    const r1 = await pushSkusPendientes(db, ML_CFG);
    expect(r1.errores).toBe(1);
    const fallo1 = db.prepare('SELECT * FROM ml_sku_push_fallos WHERE clave = ?').get('A1|');
    expect(fallo1.intentos).toBe(1);
    const proximo1 = new Date(fallo1.proximo_intento_en).getTime();
    // Backoff 2^1 = 2h
    expect(proximo1 - Date.now()).toBeGreaterThan(1.9 * 3600 * 1000);

    // Fuerza el próximo intento venciendo el backoff, para poder correr una 2da corrida
    db.prepare('UPDATE ml_sku_push_fallos SET proximo_intento_en = ? WHERE clave = ?')
      .run(new Date(Date.now() - 1000).toISOString(), 'A1|');
    _resetEstadoPushParaTests();
    const r2 = await pushSkusPendientes(db, ML_CFG);
    expect(r2.errores).toBe(1);
    const fallo2 = db.prepare('SELECT * FROM ml_sku_push_fallos WHERE clave = ?').get('A1|');
    expect(fallo2.intentos).toBe(2);
    const proximo2 = new Date(fallo2.proximo_intento_en).getTime();
    // Backoff 2^2 = 4h > el de la corrida anterior
    expect(proximo2).toBeGreaterThan(proximo1);
  });

  it('429 REAL de ML (end-to-end, sin mockear mlFetch) corta por rate_limit y NO por cooldown propio', async () => {
    // BLOQUEANTE 2 (revisor): este es el camino que de verdad ocurre en producción. Con el
    // mlClient real, mlFetch activa SU PROPIO cooldown apenas ve un 429 (ver _activarCooldown
    // en lib/mlClient.js) ANTES de devolvernos la respuesta — así que el intento siguiente de
    // la misma publicación ya ve `_cooldownActivo()` en true y recibe __cooldownSintetico,
    // aunque el 429 que lo originó fue real. Si pushSkusPendientes no distingue "sintético
    // heredado de otro cron" de "sintético continuación de un 429 real de ESTA corrida", un
    // 429 real de ML termina clasificado como cortado_por_cooldown_propio ("no es rechazo de
    // ML") y la corrida se queda reintentando la misma publicación hasta 5 minutos en vez de
    // cortar en ~1,4s — la inversión exacta del diagnóstico que este módulo vino a resolver.
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });
    seedCache(db, { clave: 'A2|', itemId: 'A2', status: 'active' });
    seedDecision(db, { clave: 'A2|', sku: 'FB-2' });

    axios.request.mockResolvedValue(resp429());
    const r = await pushSkusPendientes(db, ML_CFG);

    expect(r.cortado_por_rate_limit).toBe(true);
    expect(r.cortado_por_cooldown_propio).toBe(false); // distinción: esto es 429 REAL de ML
    expect(r.errores).toBe(0);
    expect(r.escritos).toBe(0);
    const fallos = db.prepare('SELECT COUNT(*) n FROM ml_sku_push_fallos').get().n;
    expect(fallos).toBe(0);
    // Nada se escribió: las dos claves siguen pendientes para el próximo ciclo
    expect(contarPendientes(db).total).toBe(2);
  }, 15000);

  it('429 persistente corta la corrida entera sin marcar fallo (mock directo sobre mlFetch, caso extra)', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });
    seedCache(db, { clave: 'A2|', itemId: 'A2', status: 'active' });
    seedDecision(db, { clave: 'A2|', sku: 'FB-2' });

    // Mock directo sobre mlFetch: caso extra que aísla el loop de reintentos de la mecánica
    // de cooldown de mlClient. El test end-to-end de arriba es el que cubre el camino real.
    mlFetch.mockResolvedValue({ status: 429, headers: {}, data: null });
    const r = await pushSkusPendientes(db, ML_CFG);

    expect(r.cortado_por_rate_limit).toBe(true);
    expect(r.cortado_por_cooldown_propio).toBe(false);
    expect(r.errores).toBe(0);
    expect(r.escritos).toBe(0);
    const fallos = db.prepare('SELECT COUNT(*) n FROM ml_sku_push_fallos').get().n;
    expect(fallos).toBe(0);
    expect(contarPendientes(db).total).toBe(2);
  }, 15000);

  // --- Distinción 429 propio (cooldown/cupo) vs 429 REAL de ML (2026-08-06) ---
  describe('429 propio (cooldown/cupo) vs 429 real de ML', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('429 sintético (__cooldownSintetico) al principio de la corrida NO aborta: espera el cooldown y termina escribiendo el lote', async () => {
      seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
      seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

      // Prime el cooldown propio con un 429 REAL de ML (simula que otro cron de los
      // 9 lo disparó segundos antes, tal como en el incidente diagnosticado): nivel 0,
      // 60s de cooldown — bien por debajo de TIEMPO_MAX_CORRIDA_MS (5min).
      axios.request.mockResolvedValueOnce(resp429());
      await mlFetch(db, ML_CFG, 'get', '/users/me');
      expect(estadoCooldownMl().activo).toBe(true);

      axios.request.mockResolvedValue(respOk());
      vi.useFakeTimers();
      const p = pushSkusPendientes(db, ML_CFG);
      await vi.advanceTimersByTimeAsync(65_000); // supera el escalón de 60s
      const r = await p;

      expect(r.escritos).toBe(1);
      expect(r.cortado_por_rate_limit).toBe(false);
      expect(r.cortado_por_cooldown_propio).toBe(false);
      expect(contarPendientes(db).total).toBe(0);
    });

    it('429 sintético cuyo `hasta` cae más allá de TIEMPO_MAX_CORRIDA_MS corta sin marcar fallo, y las publicaciones quedan pendientes', async () => {
      seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
      seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

      vi.useFakeTimers();
      const t0 = new Date('2026-02-01T00:00:00.000Z');
      vi.setSystemTime(t0);

      // Escala el cooldown a nivel 3 (600s = 10min > TIEMPO_MAX_CORRIDA_MS de 5min):
      // cada escalón solo sube si el 429 llega con el cooldown anterior YA vencido.
      const escalones = [
        { esperaMs: 60_000, avanzar: 61_000 },   // nivel 0 → 60s
        { esperaMs: 120_000, avanzar: 121_000 }, // nivel 1 → 120s
        { esperaMs: 300_000, avanzar: 301_000 }, // nivel 2 → 300s
      ];
      for (const e of escalones) {
        axios.request.mockResolvedValueOnce(resp429());
        await mlFetch(db, ML_CFG, 'get', '/users/me');
        vi.setSystemTime(new Date(Date.now() + e.avanzar));
      }
      // Último 429: escala a nivel 3, cooldown de 600s desde "ahora"
      axios.request.mockResolvedValueOnce(resp429());
      await mlFetch(db, ML_CFG, 'get', '/users/me');
      const cooldown = estadoCooldownMl();
      expect(cooldown.nivel).toBe(3);
      expect(new Date(cooldown.hasta).getTime() - Date.now()).toBeGreaterThan(5 * 60 * 1000);

      const r = await pushSkusPendientes(db, ML_CFG);

      expect(r.cortado_por_cooldown_propio).toBe(true);
      expect(r.cortado_por_rate_limit).toBe(false);
      expect(r.escritos).toBe(0);
      expect(r.errores).toBe(0);
      const fallos = db.prepare('SELECT COUNT(*) n FROM ml_sku_push_fallos').get().n;
      expect(fallos).toBe(0); // fail-open: no se penaliza la publicación
      expect(contarPendientes(db).total).toBe(1); // sigue pendiente para el próximo ciclo
    });

    it('__sinCupo (presupuesto propio agotado) espera y reintenta, no aborta la corrida', async () => {
      seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
      seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

      reservarCupo.mockResolvedValueOnce(false); // simula presupuesto propio agotado
      axios.request.mockResolvedValue(respOk());

      vi.useFakeTimers();
      const p = pushSkusPendientes(db, ML_CFG);
      await vi.advanceTimersByTimeAsync(2_000); // ESPERA_SIN_CUPO_MS + margen
      const r = await p;

      expect(r.escritos).toBe(1);
      expect(r.cortado_por_rate_limit).toBe(false);
      expect(r.cortado_por_cooldown_propio).toBe(false);
      expect(contarPendientes(db).total).toBe(0);
    });

    it('__sinCupo sostenido (presupuesto propio nunca se libera) corta tras MAX_REINTENTOS_SIN_CUPO, sin marcar fallo', async () => {
      // IMPORTANTE 4 (revisor): sin un tope de reintentos, __sinCupo sostenido (9 crons
      // compitiendo por el mismo presupuesto) podía girar sobre la MISMA publicación durante
      // toda la corrida (hasta 5 minutos) reteniendo el mutex. Acá reservarCupo devuelve false
      // siempre — nunca hay cupo — y la corrida debe cortar sola, rápido, sin agotar el tope
      // de 5 minutos ni penalizar la publicación con backoff.
      seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
      seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

      reservarCupo.mockResolvedValue(false); // presupuesto propio agotado, siempre
      axios.request.mockResolvedValue(respOk());

      vi.useFakeTimers();
      const p = pushSkusPendientes(db, ML_CFG);
      await vi.advanceTimersByTimeAsync(10_000); // sobra margen para agotar MAX_REINTENTOS_SIN_CUPO
      const r = await p;

      expect(r.escritos).toBe(0);
      expect(r.cortado_por_rate_limit).toBe(false);
      expect(r.cortado_por_cooldown_propio).toBe(true); // presupuesto NUESTRO, no rechazo de ML
      expect(r.errores).toBe(0);
      const fallos = db.prepare('SELECT COUNT(*) n FROM ml_sku_push_fallos').get().n;
      expect(fallos).toBe(0); // fail-open: no se penaliza la publicación
      expect(contarPendientes(db).total).toBe(1); // sigue pendiente para el próximo ciclo
    });
  });

  describe('corte por tope de tiempo puro (hallazgo A del revisor, 2026-08-06)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    // Con muchas publicaciones sanas (ML responde 200 a todo) el CALL_DELAY_MS entre cada una
    // termina agotando TIEMPO_MAX_CORRIDA_MS sin que haya habido ningún cooldown/cupo propio
    // esperando. Antes esto se reportaba (falsamente) como cortado_por_cooldown_propio.
    it('corta por TIEMPO_MAX_CORRIDA_MS en el chequeo de ANTES de la llamada, sin marcar cooldown propio', async () => {
      // 900 pendientes * 350ms (CALL_DELAY_MS) = 315s > TIEMPO_MAX_CORRIDA_MS (300s):
      // sanas de punta a punta, el corte tiene que venir por tiempo, no por cooldown/cupo.
      for (let i = 0; i < 900; i++) {
        seedCache(db, { clave: `A${i}|`, itemId: `A${i}`, status: 'active' });
        seedDecision(db, { clave: `A${i}|`, sku: `FB-${i}` });
      }
      axios.request.mockResolvedValue(respOk());

      vi.useFakeTimers();
      const p = pushSkusPendientes(db, ML_CFG);
      await vi.advanceTimersByTimeAsync(320_000); // > 900*350ms, sobra margen
      const r = await p;

      expect(r.cortado_por_tiempo).toBe(true);
      expect(r.cortado_por_cooldown_propio).toBe(false);
      expect(r.cortado_por_rate_limit).toBe(false);
      expect(r.cortado_por_error).toBe(false);
      expect(r.errores).toBe(0);
      expect(contarPendientes(db).total).toBeGreaterThan(0); // quedó trabajo para el próximo ciclo
    }, 20_000); // 900 seeds + iteraciones reales bajo fake timers superan el timeout default de 5s

    it('agota MAX_REINTENTOS_SIN_CUPO (no el tope de tiempo) cuando el presupuesto propio nunca se libera', async () => {
      // NOTA (tester, corrección post-revisor): con reservarCupo devolviendo false SIEMPRE,
      // MAX_REINTENTOS_SIN_CUPO (3 reintentos * ESPERA_SIN_CUPO_MS=1000ms) se agota a los ~3s
      // de reloj simulado, mucho antes de los 300s de TIEMPO_MAX_CORRIDA_MS: el corte viene
      // por el tope de REINTENTOS (lib/matcherPush.js:407), no por el chequeo de tiempo. El
      // resultado (cortado_por_cooldown_propio=true, cortado_por_tiempo=false) es el mismo que
      // en "__sinCupo sostenido" de arriba (:299+) — este test es, en la práctica, un
      // duplicado de aquel. Se deja documentado el motivo real en vez de eliminarlo porque
      // fija en el tiempo el orden de magnitud de MAX_REINTENTOS_SIN_CUPO vs. el tope de la
      // corrida; la cobertura del chequeo de tiempo POST-llamada (lib/matcherPush.js:399) está
      // en el test siguiente.
      seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
      seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

      vi.useFakeTimers();
      const t0 = new Date('2026-02-01T00:00:00.000Z');
      vi.setSystemTime(t0);
      reservarCupo.mockResolvedValue(false);
      const p = pushSkusPendientes(db, ML_CFG);
      await vi.advanceTimersByTimeAsync(310_000);
      const r = await p;

      expect(r.cortado_por_cooldown_propio).toBe(true);
      expect(r.cortado_por_tiempo).toBe(false);
    });

    it('corta por TIEMPO_MAX_CORRIDA_MS en el chequeo de DESPUÉS de la llamada (rama 429), antes de evaluar __sinCupo', async () => {
      // Cobertura real de lib/matcherPush.js:399 (el chequeo de tiempo que va DESPUÉS de la
      // llamada a escribirSkuEnMl, adentro del `for`, distinto del chequeo "de guardia" ANTES
      // de la llamada que ya cubre el test de arriba "en el chequeo de ANTES de la llamada").
      // Para llegar ahí sin pasar por la rama __sinCupo (que tiene su propio corte por
      // reintentos, ver el test anterior) reservarCupo hace avanzar el reloj simulado más allá
      // de TIEMPO_MAX_CORRIDA_MS DENTRO de su propia resolución, en el primer intento: el
      // reloj ya está vencido cuando el código llega a la línea 399, antes de siquiera mirar
      // resultado.__sinCupo — por eso corta con cortadoPorTiempo, no con
      // cortado_por_cooldown_propio (a diferencia del test anterior).
      seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
      seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

      vi.useFakeTimers();
      const t0 = new Date('2026-02-01T00:00:00.000Z');
      vi.setSystemTime(t0);
      reservarCupo.mockImplementation(async () => {
        // Simula el ~15s real que puede tardar reservarCupo puertas adentro (9 crons
        // compitiendo) pero llevado más allá del tope de la corrida para forzar el chequeo
        // de la línea 399 antes de que se evalúe __sinCupo.
        vi.setSystemTime(new Date(Date.now() + 310_000));
        return false;
      });
      const p = pushSkusPendientes(db, ML_CFG);
      await vi.advanceTimersByTimeAsync(310_000);
      const r = await p;

      expect(r.cortado_por_tiempo).toBe(true);
      expect(r.cortado_por_cooldown_propio).toBe(false);
      expect(r.cortado_por_rate_limit).toBe(false);
    });
  });

  it('acepta la config de sync completa {woo, ml} (forma real que usa el cron) y normaliza internamente', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

    axios.request.mockResolvedValue(respOk());
    const syncCfg = { woo: { url: 'https://x', ck: 'a', cs: 'b' }, ml: ML_CFG };
    const r = await pushSkusPendientes(db, syncCfg);

    expect(r.escritos).toBe(1);
    expect(r.errores).toBe(0);
  });

  it('status 0 (config/red, sin respuesta de ML) NO registra backoff y corta la corrida (fail-open)', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });
    seedCache(db, { clave: 'A2|', itemId: 'A2', status: 'active' });
    seedDecision(db, { clave: 'A2|', sku: 'FB-2' });

    // cfg sin clientId → getAccessToken revienta con "ML_CLIENT_ID no configurado" antes de
    // llegar a ML: status 0, igual que un error de red.
    const r = await pushSkusPendientes(db, { userId: '99999' });

    expect(r.cortado_por_error).toBe(true);
    expect(r.escritos).toBe(0);
    const fallos = db.prepare('SELECT COUNT(*) n FROM ml_sku_push_fallos').get().n;
    expect(fallos).toBe(0); // nunca se penaliza con backoff una publicación que ML no evaluó
    expect(contarPendientes(db).total).toBe(2); // ambas siguen pendientes para el próximo ciclo
  });

  it('el fallo registrado en /estado incluye proximo_intento_en e intentos', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

    axios.request.mockResolvedValue(resp400('publicación con restricciones'));
    const r = await pushSkusPendientes(db, ML_CFG);

    expect(r.fallos).toHaveLength(1);
    expect(r.fallos[0].intentos).toBe(1);
    expect(typeof r.fallos[0].proximo_intento_en).toBe('string');
    expect(new Date(r.fallos[0].proximo_intento_en).getTime()).toBeGreaterThan(Date.now());
  });

  it('no corre dos corridas en paralelo (anti-solape)', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

    let resolverPrimera;
    axios.request.mockImplementation(() => new Promise(res => { resolverPrimera = res; }));

    const p1 = pushSkusPendientes(db, ML_CFG);
    // Da tiempo a que la primera corrida marque running=true antes de lanzar la segunda
    await new Promise(r => setTimeout(r, 10));
    expect(getEstadoPush().running).toBe(true);

    const r2 = await pushSkusPendientes(db, ML_CFG);
    expect(r2.yaEnCurso).toBe(true);

    resolverPrimera(respOk());
    await p1;
  });

  // --- Cuota de pausadas por corrida ---
  describe('cuota de pausadas por corrida', () => {
    it('con 5 activas y 100 pausadas, seleccionarPendientes(cuota=10) trae las 5 activas y exactamente 10 publicaciones pausadas', () => {
      for (let i = 0; i < 5; i++) {
        seedCache(db, { clave: `A${i}|`, itemId: `A${i}`, status: 'active' });
        seedDecision(db, { clave: `A${i}|`, sku: `FB-A${i}` });
      }
      for (let i = 0; i < 100; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      const lote = seleccionarPendientes(db, { limite: 1000, cuotaPausadas: 10 });
      const activasSel = lote.filter(p => p.status === 'active');
      const pausadasSel = lote.filter(p => p.status !== 'active');
      expect(activasSel).toHaveLength(5);
      expect(pausadasSel).toHaveLength(10);
    });

    it('sin starvation: la cola de pausadas se vacía a lo largo de varias corridas de cuota', () => {
      for (let i = 0; i < 25; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      // Simula 3 corridas: cada una "escribe" (borra la decisión) su cuota de 10 pausadas.
      for (let corrida = 0; corrida < 3; corrida++) {
        const lote = seleccionarPendientes(db, { limite: 1000, cuotaPausadas: 10 });
        for (const p of lote) {
          db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(p.clave);
        }
      }
      expect(contarPendientes(db).total).toBe(0); // 25 = 10 + 10 + 5, se vació en 3 corridas
    });

    it('bloqueante 2 (revisor): la cuota se aplica por CORRIDA completa, no por tanda — 5 activas + 100 pausadas con cuota 10 procesan exactamente 5 activas y 10 publicaciones pausadas en una sola corrida', async () => {
      for (let i = 0; i < 5; i++) {
        seedCache(db, { clave: `A${i}|`, itemId: `A${i}`, status: 'active' });
        seedDecision(db, { clave: `A${i}|`, sku: `FB-A${i}` });
      }
      for (let i = 0; i < 100; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      axios.request.mockResolvedValue(respOk());
      // limite alto para que, si el bloqueante reapareciera (cuota reevaluada por tanda sin
      // descontar lo ya procesado), el while siguiera trayendo tandas de pausadas hasta
      // agotar las 100 en vez de cortar en 10.
      const r = await pushSkusPendientes(db, ML_CFG, { limite: 1000, cuotaPausadas: 10 });

      expect(r.escritos).toBe(15); // 5 activas + 10 pausadas, nunca más
      expect(r.errores).toBe(0);
      expect(contarPendientes(db).total).toBe(90); // 100 - 10 pausadas escritas; las 5 activas ya no quedan pendientes
    }, 15000);

    it('una pausada que falla con backoff (fail-closed) consume su cupo de cuota igual que una exitosa', async () => {
      for (let i = 0; i < 100; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      axios.request.mockResolvedValue(resp400('publicación con restricciones'));
      const r = await pushSkusPendientes(db, ML_CFG, { limite: 1000, cuotaPausadas: 10 });

      // Las 10 pausadas de la cuota fallaron con backoff: consumieron su cupo igual, y
      // pasan a "en espera" (backoff futuro), por lo que salen de `pausadas` en contarPendientes.
      expect(r.errores).toBe(10);
      expect(r.escritos).toBe(0);
      const conteo = contarPendientes(db);
      expect(conteo.pausadas).toBe(90);
      expect(conteo.enEspera).toBe(10);
      expect(conteo.total).toBe(90);
    }, 15000);

    it('una corrida cortada por 429 (fail-open) consume el cupo de la tanda seleccionada sin dejar la cuota en un estado raro', async () => {
      for (let i = 0; i < 100; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      // Mock directo sobre mlFetch (caso extra, aísla el loop de reintentos de la cuota de
      // pausadas; el test end-to-end con axios está en la suite de arriba).
      mlFetch.mockResolvedValue({ status: 429, headers: {}, data: null });
      const r = await pushSkusPendientes(db, ML_CFG, { limite: 1000, cuotaPausadas: 10 });

      expect(r.cortado_por_rate_limit).toBe(true);
      expect(r.escritos).toBe(0);
      expect(r.errores).toBe(0);
      const fallos = db.prepare('SELECT COUNT(*) n FROM ml_sku_push_fallos').get().n;
      expect(fallos).toBe(0); // fail-open: nada de backoff
      // Nada se escribió (ML nunca respondió sano): las 100 siguen pendientes para el
      // próximo ciclo, y la cuota gastada en esta corrida (que cortó) no deja rastros que
      // afecten la próxima corrida (cuotaRestante es local a cada llamada).
      expect(contarPendientes(db).total).toBe(100);
    }, 15000);

    it('una corrida cortada por status 0 (fail-open, config/red) tampoco deja la cuota en un estado raro', async () => {
      for (let i = 0; i < 100; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      // cfg sin clientId → status 0 antes de hablar con ML
      const r = await pushSkusPendientes(db, { userId: '99999' }, { limite: 1000, cuotaPausadas: 10 });

      expect(r.cortado_por_error).toBe(true);
      expect(r.escritos).toBe(0);
      const fallos = db.prepare('SELECT COUNT(*) n FROM ml_sku_push_fallos').get().n;
      expect(fallos).toBe(0);
      expect(contarPendientes(db).total).toBe(100);
    });

    it('cortado_por_cuota es true cuando la cuota se agota y quedan pausadas sin procesar', async () => {
      for (let i = 0; i < 100; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      axios.request.mockResolvedValue(respOk());
      const r = await pushSkusPendientes(db, ML_CFG, { limite: 1000, cuotaPausadas: 10 });

      expect(r.escritos).toBe(10);
      expect(r.cortado_por_cuota).toBe(true);
    }, 15000);

    it('cortado_por_cuota es false cuando la corrida vacía toda la cola de pausadas disponible', async () => {
      for (let i = 0; i < 10; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      axios.request.mockResolvedValue(respOk());
      const r = await pushSkusPendientes(db, ML_CFG, { limite: 1000, cuotaPausadas: 10 });

      expect(r.escritos).toBe(10);
      expect(contarPendientes(db).total).toBe(0);
      expect(r.cortado_por_cuota).toBe(false);
    }, 15000);

    it('una clave saltada por idempotencia (caché refrescada por otro proceso) cuenta en "saltados", no en "escritos"', async () => {
      // A2 se seedea primero (queda con timestamp más viejo) y A1 después (más nuevo), para
      // que el ORDER BY ... DESC procese A1 primero dentro del grupo de activas.
      seedCache(db, { clave: 'A2|', itemId: 'A2', status: 'active' });
      seedDecision(db, { clave: 'A2|', sku: 'FB-2' });
      seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active' });
      seedDecision(db, { clave: 'A1|', sku: 'FB-1' });

      let llamados = 0;
      axios.request.mockImplementation(async () => {
        llamados++;
        if (llamados === 1) {
          // Simula un refresco de caché concurrente (POST /refrescar-ml) que deja la
          // caché de A2 al día con el SKU que le íbamos a escribir, antes de que le
          // llegue su turno en esta misma corrida.
          db.prepare('UPDATE ml_publicaciones_cache SET seller_sku = ? WHERE clave = ?').run('FB-2', 'A2|');
        }
        return respOk();
      });

      const r = await pushSkusPendientes(db, ML_CFG);

      expect(r.escritos).toBe(1); // solo A1 generó un PUT real
      expect(r.saltados).toBe(1); // A2 se saltó por idempotencia
      expect(r.errores).toBe(0);
    });
  });

  // --- Coherencia: manual ignora la cuota, contarPendientes refleja la cola real ---
  describe('coherencia con el resto del sistema', () => {
    it('el camino manual (cuotaPausadas: null) procesa todas las pausadas sin cuota', async () => {
      for (let i = 0; i < 5; i++) {
        seedCache(db, { clave: `A${i}|`, itemId: `A${i}`, status: 'active' });
        seedDecision(db, { clave: `A${i}|`, sku: `FB-A${i}` });
      }
      for (let i = 0; i < 30; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      axios.request.mockResolvedValue(respOk());

      const r = await pushSkusPendientes(db, ML_CFG, { limite: 1000, cuotaPausadas: null });

      expect(r.escritos).toBe(35);
      expect(contarPendientes(db).total).toBe(0);
    }, 20000);

    it('GET /push-skus-pendientes/estado (contarPendientes) sigue devolviendo el total real, no acotado por la cuota', async () => {
      for (let i = 0; i < 5; i++) {
        seedCache(db, { clave: `A${i}|`, itemId: `A${i}`, status: 'active' });
        seedDecision(db, { clave: `A${i}|`, sku: `FB-A${i}` });
      }
      for (let i = 0; i < 100; i++) {
        seedCache(db, { clave: `P${i}|`, itemId: `P${i}`, status: 'paused' });
        seedDecision(db, { clave: `P${i}|`, sku: `FB-P${i}` });
      }

      // contarPendientes no acota nada por cuota: siempre la cola real
      expect(contarPendientes(db).total).toBe(105);
    });
  });
});
