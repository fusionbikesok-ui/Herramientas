import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';

const TEST_DB = './test/tmp-mlclient.sqlite';
const ML_CFG = { clientId: 'c', clientSecret: 's', userId: '999' };
const ahora = () => new Date().toISOString();

function seedToken(db) {
  const exp = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1,'tok','ref',?,?)`).run(exp, ahora());
}

function makeDb() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const db = new Database(TEST_DB);
  db.exec(`
    CREATE TABLE ml_oauth_token (
      id INTEGER PRIMARY KEY,
      access_token TEXT, refresh_token TEXT, expires_at TEXT, actualizado_en TEXT
    );
  `);
  seedToken(db);
  return db;
}

describe('mlClient — cooldown global de rate-limit', () => {
  let db;

  beforeEach(async () => {
    vi.resetModules();
    axios.request.mockReset();
    axios.post.mockReset();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('activa cooldown ante 429 y bloquea llamadas no-manuales sin salir a red', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });

    const r1 = await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    expect(r1.status).toBe(429);
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(estadoCooldownMl().activo).toBe(true);

    // Segunda llamada, aún en cooldown: no debe salir a red.
    const r2 = await mlFetch(db, ML_CFG, 'get', '/items/MLA2');
    expect(r2.status).toBe(429);
    expect(axios.request).toHaveBeenCalledTimes(1); // sin llamada nueva
  });

  it('las llamadas manuales ignoran el cooldown', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');

    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: { id: 'MLA2' } });
    const r = await mlFetch(db, ML_CFG, 'get', '/items/MLA2', null, { manual: true });
    expect(r.status).toBe(200);
    expect(axios.request).toHaveBeenCalledTimes(2);
  });

  it('respeta Retry-After si es mayor al escalón calculado, pero nunca supera el tope de 10 min', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '900' }, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');

    const estado = estadoCooldownMl();
    expect(estado.activo).toBe(true);
    const restanteMs = new Date(estado.hasta).getTime() - Date.now();
    // Retry-After pidió 900s (15min) pero el tope duro es 10min: nunca puede superarlo.
    expect(restanteMs).toBeGreaterThan(590_000);
    expect(restanteMs).toBeLessThanOrEqual(600_000);
  });

  it('Retry-After en formato HTTP-date (NaN en parseInt) cae al escalón calculado', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({
      status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, data: null,
    });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');

    const estado = estadoCooldownMl();
    expect(estado.activo).toBe(true);
    const restanteMs = new Date(estado.hasta).getTime() - Date.now();
    // Nivel 0 del escalón: 60s (con margen por el paso del tiempo del test).
    expect(restanteMs).toBeGreaterThan(55_000);
    expect(restanteMs).toBeLessThan(65_000);
  });

  it('resetea el backoff tras una respuesta exitosa NO manual', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: {} });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    expect(estadoCooldownMl()).toEqual({ activo: false, hasta: null, nivel: -1 });
  });

  it('un 200 de una llamada manual NO resetea el cooldown activo', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    expect(estadoCooldownMl().activo).toBe(true);

    // Llamada manual exitosa mientras el cooldown sigue activo: no debe cancelarlo.
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: { id: 'MLA2' } });
    const r = await mlFetch(db, ML_CFG, 'get', '/items/MLA2', null, { manual: true });
    expect(r.status).toBe(200);
    expect(estadoCooldownMl().activo).toBe(true);
  });

  it('429s concurrentes con cooldown ya activo no escalan el nivel ni extienden la ventana', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    const estado1 = estadoCooldownMl();
    expect(estado1.nivel).toBe(0);

    // Otra request "en vuelo" que también recibe 429 mientras el cooldown ya está activo
    // (simula concurrencia real: varias llamadas salieron a red casi juntas). Es manual,
    // así que reintenta una vez tras la espera acotada — mockear también esa segunda
    // llamada, que sigue devolviendo 429.
    vi.useFakeTimers();
    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    const p = mlFetch(db, ML_CFG, 'get', '/items/MLA2', null, { manual: true }); // manual para forzar salida a red
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    vi.useRealTimers();
    const estado2 = estadoCooldownMl();

    expect(estado2.nivel).toBe(0); // no escaló a nivel 1
    expect(new Date(estado2.hasta).getTime()).toBe(new Date(estado1.hasta).getTime()); // no extendió la ventana
  });

  it('llamadas manuales reintentan una vez ante 429 antes de devolverlo', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    vi.useFakeTimers();
    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: { id: 'MLA1' } });

    const p = mlFetch(db, ML_CFG, 'get', '/items/MLA1', null, { manual: true });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    vi.useRealTimers();

    expect(r.status).toBe(200);
    expect(axios.request).toHaveBeenCalledTimes(2); // 429 + reintento exitoso
  });

  it('escala al nivel 1 (120s) cuando llega un nuevo 429 tras vencer el cooldown anterior', async () => {
    vi.useFakeTimers();
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    expect(estadoCooldownMl().nivel).toBe(0); // 60s

    // Vence el cooldown del nivel 0.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(estadoCooldownMl().activo).toBe(false);

    // Nuevo 429 real (cooldown ya vencido): debe escalar a nivel 1 (120s).
    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA2');
    const estado = estadoCooldownMl();
    expect(estado.nivel).toBe(1);
    const restanteMs = new Date(estado.hasta).getTime() - Date.now();
    expect(restanteMs).toBeGreaterThan(115_000);
    expect(restanteMs).toBeLessThanOrEqual(120_000);

    vi.useRealTimers();
  });

  it('decae el nivel de backoff tras la gracia si no hubo más llamadas (ni éxito ni 429)', async () => {
    vi.useFakeTimers();
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    expect(estadoCooldownMl().nivel).toBe(0);

    // Cooldown vence (60s) y pasa además la ventana de gracia (15min) sin ninguna
    // llamada nueva: el nivel debe decaer solo a -1 (sin backoff acumulado).
    await vi.advanceTimersByTimeAsync(60_000 + 15 * 60 * 1000 + 1000);
    const estado = estadoCooldownMl();
    expect(estado.activo).toBe(false);
    expect(estado.nivel).toBe(-1);

    vi.useRealTimers();
  });

  it('no reintenta inmediatamente ante 429 (sin sleep de 2s como antes)', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');
    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });

    const inicio = Date.now();
    const r = await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    const duracion = Date.now() - inicio;

    expect(r.status).toBe(429);
    expect(duracion).toBeLessThan(500); // no hay espera de 2s
    expect(axios.request).toHaveBeenCalledTimes(1); // sin segundo intento
  });
});
