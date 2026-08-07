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

function seedTokenVencido(db) {
  // Vencido hace 1 minuto: fuerza refresh en la próxima llamada.
  const exp = new Date(Date.now() - 60_000).toISOString();
  db.prepare(`INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1,'tok-viejo','ref-viejo',?,?)`).run(exp, ahora());
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

describe('mlClient — 429 en el refresh de token OAuth', () => {
  let db;

  // Helper: reemplaza la DB de test por una con un token vencido, forzando
  // el refresh en la próxima llamada. Antes estaba duplicado en cada test.
  function reseedConTokenVencido() {
    db.close();
    fs.unlinkSync(TEST_DB);
    db = makeDb();
    db.prepare('DELETE FROM ml_oauth_token').run();
    seedTokenVencido(db);
  }

  beforeEach(async () => {
    vi.resetModules();
    axios.request.mockReset();
    axios.post.mockReset();
    db = makeDb();
    reseedConTokenVencido();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('un 429 en /oauth/token arma el cooldown global (mismo mecanismo que un 429 de API)', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.post.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '30' }, data: null });

    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow(/rate limit ML \(429\)/);

    expect(estadoCooldownMl().activo).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('tras el 429 del refresh, la siguiente llamada no vuelve a pegarle a /oauth/token (cooldown corta antes de getAccessToken)', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.post.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow();
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Segunda llamada no-manual: el cooldown ya está activo, mlFetch corta
    // antes de llamar a getAccessToken/_doRefresh — no debe salir a red de nuevo.
    const r2 = await mlFetch(db, ML_CFG, 'get', '/items/MLA2');
    expect(r2.status).toBe(429);
    expect(r2.__cooldownSintetico).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1); // sin llamada nueva a /oauth/token
    expect(axios.request).not.toHaveBeenCalled(); // ni siquiera llegó a pedir el recurso
  });

  it('un 400 en el refresh NO arma cooldown (es fatal, no transitorio) y nombra client_secret/OAuth', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.post.mockResolvedValueOnce({ status: 400, headers: {}, data: null });
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow(/client_secret|autorización OAuth/);

    expect(estadoCooldownMl().activo).toBe(false);
  });

  it('un 401 en el refresh también es fatal, no arma cooldown, y el mensaje nombra las dos causas posibles (client_secret o refresh_token)', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.post.mockResolvedValueOnce({ status: 401, headers: {}, data: null });
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow(/client_secret|autorización OAuth/);

    expect(estadoCooldownMl().activo).toBe(false);
  });

  it('un status inesperado no-5xx (ej. 403) en el refresh da mensaje con el status real y NO arma cooldown', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.post.mockResolvedValueOnce({ status: 403, headers: {}, data: null });
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow(/\(403\)/);

    expect(estadoCooldownMl().activo).toBe(false);
  });

  it('un 5xx sostenido en el refresh arma cooldown igual que un 429 (ML caído, no solo rate-limitado)', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.post.mockResolvedValueOnce({ status: 503, headers: {}, data: null });
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow(/\(503\)/);

    expect(estadoCooldownMl().activo).toBe(true);
  });

  it('un fallo de conectividad (excepción de axios) en el refresh también arma cooldown', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    axios.post.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow(/conectividad/);

    expect(estadoCooldownMl().activo).toBe(true);
  });

  it('el lock de refresh no queda colgado tras un 429 — un refresh posterior (cooldown vencido) funciona normal', async () => {
    vi.useFakeTimers();

    const { mlFetch, getAccessToken } = await import('../lib/mlClient.js');

    axios.post.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow();

    // Avanza más allá del cooldown (nivel 0 = 60s) para que getAccessToken
    // vuelva a intentar el refresh en vez de cortar por el cooldown sintético.
    await vi.advanceTimersByTimeAsync(61_000);

    axios.post.mockResolvedValueOnce({
      status: 200, headers: {}, data: { access_token: 'nuevo', refresh_token: 'nuevo-ref', expires_in: 21600 },
    });
    const token = await getAccessToken(db, ML_CFG);
    expect(token).toBe('nuevo');
    expect(axios.post).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('BLOQUEANTE 1: una llamada manual con cooldown activo y token vencido NO le pega al OAuth', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    // Primero se arma el cooldown con un 429 real del refresh.
    axios.post.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow();
    expect(estadoCooldownMl().activo).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Segunda llamada, esta vez MANUAL (p.ej. "Refrescar ML" del matcher).
    // El token en DB sigue vencido (el 429 no lo actualizó). Con cooldown
    // activo, getAccessToken debe cortar sin volver a golpear /oauth/token,
    // aunque opts.manual salte el chequeo de cooldown de mlFetch.
    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA2', null, { manual: true }))
      .rejects.toThrow(/cooldown/i);
    expect(axios.post).toHaveBeenCalledTimes(1); // sin POST nuevo a /oauth/token
    expect(axios.request).not.toHaveBeenCalled(); // ni siquiera llegó a pedir el recurso
  });

  it('BLOQUEANTE 2: dos mlFetch no-manuales concurrentes con token vencido y 429 en el refresh generan un solo POST a /oauth/token', async () => {
    const { mlFetch, estadoCooldownMl } = await import('../lib/mlClient.js');

    // Ambas llamadas salen "casi juntas", antes de que el cooldown exista —
    // simula la ráfaga de 9 crons arrancando en el mismo ciclo.
    axios.post.mockResolvedValueOnce({ status: 429, headers: {}, data: null });

    const [r1, r2] = await Promise.allSettled([
      mlFetch(db, ML_CFG, 'get', '/items/MLA1'),
      mlFetch(db, ML_CFG, 'get', '/items/MLA2'),
    ]);

    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect(axios.post).toHaveBeenCalledTimes(1); // un solo POST pese a la concurrencia
    expect(estadoCooldownMl().activo).toBe(true);
  });
});

describe('mlClient — trazabilidad de errores', () => {
  let db;
  let errorSpy;

  beforeEach(async () => {
    vi.resetModules();
    axios.request.mockReset();
    axios.post.mockReset();
    db = makeDb();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('el 429 real loguea método y path normalizado', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA123');

    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('429') && m.includes('GET') && m.includes('/items/MLA123'))).toBe(true);
  });

  it('el path largo del multiget se colapsa y no se vuelca entero', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    const ids = Array.from({ length: 20 }, (_, i) => `MLA${i}`).join(',');
    const path = `/items?ids=${ids}&attributes=id,price`;

    axios.request.mockResolvedValueOnce({ status: 500, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', path);

    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    const conError = mensajes.find(m => m.includes('[ML][error]'));
    expect(conError).toBeDefined();
    expect(conError).toContain('<20 ids>');
    expect(conError).not.toContain('MLA19'); // el listado crudo no se vuelca
  });

  it('un no-2xx deja rastro en el log central', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 404, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA999');

    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('[ML][error]') && m.includes('404'))).toBe(true);
  });

  it('la deduplicación no emite N líneas para N repeticiones: emite resumen al vencer la ventana', async () => {
    vi.useFakeTimers();
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValue({ status: 500, headers: {}, data: null });

    for (let i = 0; i < 5; i++) {
      await mlFetch(db, ML_CFG, 'post', '/items/MLA913043039', { foo: 'bar' });
    }

    let mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    const lineasError = mensajes.filter(m => m.includes('[ML][error]') && m.includes('MLA913043039'));
    expect(lineasError.length).toBe(1); // una sola línea, no 5

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

    mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    const resumen = mensajes.find(m => m.includes('MLA913043039') && m.includes('veces más'));
    expect(resumen).toBeDefined();
    expect(resumen).toContain('4 veces más');
  });

  it('la clave de dedup agrupa por ENDPOINT: N ids distintos sobre el mismo recurso producen una sola línea', async () => {
    // Este es el test que le da valor a la normalización de #1: si se revierte
    // (clave = método+path crudo+status), cada id distinto arma una clave nueva
    // y este test falla porque aparecen 6 líneas en vez de 1.
    vi.useFakeTimers();
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValue({ status: 500, headers: {}, data: null });

    for (let i = 0; i < 6; i++) {
      await mlFetch(db, ML_CFG, 'put', `/items/MLA${i}`, { available_quantity: 1 });
    }

    let mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    const lineasError = mensajes.filter(m => m.includes('[ML][error]') && m.includes('PUT'));
    expect(lineasError.length).toBe(1); // una sola línea para las 6 publicaciones distintas

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

    mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    const resumen = mensajes.find(m => m.includes('veces más'));
    expect(resumen).toBeDefined();
    expect(resumen).toContain('5 veces más');
  });

  it('un offset/fecha distinto en /orders/search no rompe el agrupamiento del dedup', async () => {
    vi.useFakeTimers();
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValue({ status: 500, headers: {}, data: null });

    for (let i = 0; i < 3; i++) {
      const path = `/orders/search?seller=123&order.status=paid&sort=date_asc&order.date_created.from=${encodeURIComponent(new Date(Date.now() + i * 1000).toISOString())}&offset=${i * 50}&limit=50`;
      await mlFetch(db, ML_CFG, 'get', path);
    }

    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    const lineasError = mensajes.filter(m => m.includes('[ML][error]') && m.includes('/orders/search'));
    expect(lineasError.length).toBe(1);
  });

  it('el 429 real no duplica línea: solo la de _activarCooldown, no la de _registrarErrorMl', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');

    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    const lineas429 = mensajes.filter(m => m.includes('429') && m.includes('MLA1'));
    expect(lineas429.length).toBe(1);
    expect(lineas429[0]).toContain('cooldown activado');
  });

  it('el techo de 200 entradas no crece sin límite y no filtra timers al purgar', async () => {
    vi.useFakeTimers();
    const { mlFetch, _estadoDedupParaTests } = await import('../lib/mlClient.js');

    for (let i = 0; i < 205; i++) {
      // 500+i evita pisar el 429 (que dispara cooldown y cambiaría el escenario).
      axios.request.mockResolvedValueOnce({ status: 500 + i, headers: {}, data: null });
      await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    }

    const estado = _estadoDedupParaTests();
    expect(estado.entradas).toBeLessThanOrEqual(200);
    expect(estado.timers).toBe(estado.entradas); // ninguna entrada quedó con timer huérfano

    vi.useRealTimers();
  });

  it('los sintéticos NO loguean por llamada pero incrementan sus contadores', async () => {
    const { mlFetch, estadoErroresMl, _resetCooldownParaTests } = await import('../lib/mlClient.js');
    _resetCooldownParaTests();

    // Fuerza cooldown_sintetico: primero un 429 real arma el cooldown.
    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    errorSpy.mockClear();

    // Esta y la próxima caen en el corte sintético — no deben pegarle a axios.
    await mlFetch(db, ML_CFG, 'get', '/items/MLA2');
    await mlFetch(db, ML_CFG, 'get', '/items/MLA3');

    expect(axios.request).toHaveBeenCalledTimes(1); // solo la primera real
    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('MLA2') || m.includes('MLA3'))).toBe(false);

    const estado = estadoErroresMl();
    expect(estado.sinteticos.cooldown_sintetico).toBe(2);
  });

  it('los contadores salen por GET /api/sync/estado', async () => {
    const { mlFetch, _resetCooldownParaTests } = await import('../lib/mlClient.js');
    _resetCooldownParaTests();
    const { syncRouter } = await import('../routes/sync.js');

    axios.request.mockResolvedValueOnce({ status: 429, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'get', '/items/MLA1');
    await mlFetch(db, ML_CFG, 'get', '/items/MLA2'); // sintético

    // Sembrar tablas mínimas que consulta el endpoint.
    db.exec(`
      CREATE TABLE sync_estado (clave TEXT, valor TEXT, actualizado_en TEXT);
      CREATE TABLE sync_log (id INTEGER PRIMARY KEY, direccion TEXT, estado TEXT, creado_en TEXT);
    `);

    const router = syncRouter(db, { ml: ML_CFG });
    const capa = router.stack.find(l => l.route?.path === '/estado');
    let statusCode = 200;
    let body = null;
    const res = {
      json: (b) => { body = b; },
      status: (c) => { statusCode = c; return res; },
    };
    await capa.route.stack[0].handle({}, res);

    expect(statusCode).toBe(200);
    expect(body.erroresMl.sinteticos.cooldown_sintetico).toBeGreaterThanOrEqual(1);
  });

  it('nunca se loguea el body de la request', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    axios.request.mockResolvedValueOnce({ status: 400, headers: {}, data: null });
    await mlFetch(db, ML_CFG, 'post', '/orders/123/notes', { customer_note: false, secreto: 'no-debe-salir' });

    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('no-debe-salir'))).toBe(false);
  });

  it('un error de red deja rastro con método y path, sin el body', async () => {
    const { mlFetch } = await import('../lib/mlClient.js');

    const errRed = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    axios.request.mockRejectedValueOnce(errRed);

    await expect(mlFetch(db, ML_CFG, 'get', '/items/MLA1')).rejects.toThrow('timeout');

    const mensajes = errorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('[ML][error]') && m.includes('/items/MLA1'))).toBe(true);
  });
});
