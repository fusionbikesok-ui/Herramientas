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

  it('respeta Retry-After si es mayor al escalón calculado', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '900' }, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');

    const estado = estadoCooldownMl();
    expect(estado.activo).toBe(true);
    const restanteMs = new Date(estado.hasta).getTime() - Date.now();
    expect(restanteMs).toBeGreaterThan(600_000); // más que el tope de 10 min normal
  });

  it('resetea el backoff tras una respuesta exitosa', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: {} });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    expect(estadoCooldownMl()).toEqual({ activo: false, hasta: null, nivel: -1 });
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
