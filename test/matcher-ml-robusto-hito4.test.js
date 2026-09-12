import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, request: vi.fn() } };
});

import axios from 'axios';
import { categorizarErrorMl, _resetCooldownParaTests } from '../lib/mlClient.js';
import { refrescarPublicacionesMlConMetricas, refrescarPublicacionesMl } from '../routes/matcher.js';
import { _resetPresupuestoParaTests } from '../lib/mlRateLimiter.js';

const TEST_DB = './test/tmp-matcher-hito4.sqlite';
const ML_CFG = { clientId: 'c', clientSecret: 's', userId: '999' };

function makeDb() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const db = new Database(TEST_DB);
  // Minimálista: solo las tablas necesarias
  db.exec(`
    CREATE TABLE ml_oauth_token (
      id INTEGER PRIMARY KEY,
      access_token TEXT, refresh_token TEXT, expires_at TEXT, actualizado_en TEXT
    );
    CREATE TABLE ml_publicaciones_cache (
      clave TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      variation_id TEXT,
      titulo TEXT,
      status TEXT,
      sub_status TEXT,
      es_variante INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      talle TEXT,
      seller_sku TEXT,
      -- Este archivo escribe su propio mini-esquema a mano, así que hay que mantenerlo al día
      -- con lo que prepararUpsertCache (routes/matcher.js) realmente inserta. Estas seis
      -- columnas llegaron con la migración 082 y faltaban acá: el test venía pasando sólo
      -- porque reusaba una base .sqlite vieja que sí las tenía, y falló apenas se limpiaron
      -- los temporales huérfanos de test/.
      seller_sku_presente INTEGER NOT NULL DEFAULT 0,
      seller_custom_field TEXT,
      atributos_json TEXT,
      gtin TEXT,
      user_product_id TEXT,
      canales_json TEXT,
      variations_texto TEXT,
      thumbnail TEXT,
      permalink TEXT,
      catalogo INTEGER,
      -- Llegó con la migración 103 (vigía de formato). Mismo caso que las seis de arriba: el
      -- snapshot previo al DELETE la lee, así que sin ella el refresco muere con
      -- "no such column" antes de llegar a lo que este archivo mide.
      catalog_product_id TEXT,
      precio REAL,
      available_quantity INTEGER,
      precio_actualizado_en TEXT,
      actualizado_en TEXT NOT NULL
    );
    CREATE TABLE incidentes_operativos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integracion TEXT NOT NULL,
      proceso TEXT NOT NULL,
      tipo_error TEXT NOT NULL,
      clave_dedupe TEXT NOT NULL,
      severidad TEXT NOT NULL,
      estado TEXT NOT NULL,
      mensaje_tecnico TEXT,
      mensaje_humano TEXT NOT NULL,
      contexto_json TEXT,
      contador_repeticiones INTEGER NOT NULL DEFAULT 1,
      primera_deteccion_en TEXT NOT NULL,
      ultima_deteccion_en TEXT NOT NULL,
      ultima_recuperacion_en TEXT,
      resuelto_en TEXT,
      creado_en TEXT NOT NULL,
      actualizado_en TEXT NOT NULL
    );
    CREATE TABLE incidentes_operativos_historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incidente_id INTEGER NOT NULL REFERENCES incidentes_operativos(id),
      evento TEXT NOT NULL,
      detalle_json TEXT,
      creado_en TEXT NOT NULL
    );
    CREATE TABLE metricas_ciclo_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integracion TEXT NOT NULL,
      proceso TEXT NOT NULL,
      iniciado_en TEXT NOT NULL,
      finalizado_en TEXT,
      duracion_ms INTEGER,
      procesados INTEGER NOT NULL DEFAULT 0,
      fallidos INTEGER NOT NULL DEFAULT 0,
      reintentados INTEGER NOT NULL DEFAULT 0,
      circuito_abierto INTEGER NOT NULL DEFAULT 0,
      creado_en TEXT NOT NULL
    );
    CREATE INDEX idx_metricas_ciclo_integracion ON metricas_ciclo_sync(integracion, proceso, iniciado_en);
  `);
  const exp = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1,'tok','ref',?,?)`).run(exp, new Date().toISOString());
  return db;
}

describe('Hito 4: ML robusto — categorizarErrorMl', () => {
  it('clasifica 429 como rate_limit', () => {
    const err = new Error('429 de ML');
    err.status = 429;
    expect(categorizarErrorMl(err)).toBe('rate_limit');
  });

  it('clasifica 401/403 como auth', () => {
    const err401 = new Error('401');
    err401.status = 401;
    expect(categorizarErrorMl(err401)).toBe('auth');

    const err403 = new Error('403');
    err403.status = 403;
    expect(categorizarErrorMl(err403)).toBe('auth');
  });

  it('clasifica 5xx como transitorio', () => {
    const err = new Error('500 de ML');
    err.status = 500;
    expect(categorizarErrorMl(err)).toBe('transitorio');

    const err503 = new Error('503 de ML');
    err503.status = 503;
    expect(categorizarErrorMl(err503)).toBe('transitorio');
  });

  it('clasifica otros 4xx como datos', () => {
    const err404 = new Error('404');
    err404.status = 404;
    expect(categorizarErrorMl(err404)).toBe('datos');

    const err422 = new Error('422');
    err422.status = 422;
    expect(categorizarErrorMl(err422)).toBe('datos');
  });

  it('clasifica sin status HTTP como transitorio (timeout/conexión)', () => {
    const timeout = new Error('Timeout');
    expect(categorizarErrorMl(timeout)).toBe('transitorio');
  });

  it('clasifica TypeError, RangeError, SqliteError como interno', () => {
    const typeErr = new TypeError('bad type');
    expect(categorizarErrorMl(typeErr)).toBe('interno');

    const rangeErr = new RangeError('out of range');
    expect(categorizarErrorMl(rangeErr)).toBe('interno');

    const sqlErr = new Error('SQL');
    sqlErr.name = 'SqliteError';
    expect(categorizarErrorMl(sqlErr)).toBe('interno');
  });

  it('respeta e.categoria si ya está seteada', () => {
    const err = new Error('test');
    err.status = 500; // sería transitorio por status
    err.categoria = 'custom'; // pero seteamos una custom
    expect(categorizarErrorMl(err)).toBe('custom');
  });
});

describe('Hito 4: ML robusto — refrescarPublicacionesMlConMetricas', () => {
  let db;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    axios.request.mockReset();
    // IMPORTANTE: También resetear axios.post para evitar que mocks de tests anteriores
    // contaminen los tests posteriores. El mock de axios.post se configura con
    // mockResolvedValue en algunos tests. Si existehow un mock previo, lo reseteamos;
    // si no, la creamos como un vi.fn() vacío.
    const axiosMocked = vi.mocked(axios);
    if (typeof axiosMocked?.post?.mockReset === 'function') {
      axiosMocked.post.mockReset();
    } else {
      // Si no existe o no tiene mockReset, crear un nuevo mock vacío
      axiosMocked.post = vi.fn();
    }
    db = makeDb();
    _resetCooldownParaTests();
    _resetPresupuestoParaTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetCooldownParaTests();
    _resetPresupuestoParaTests();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('registra métrica exitosa cuando refresco devuelve publicaciones', async () => {
    // Mock del refresco exitoso: devuelve 1 publicación
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { results: [{ id: 'MLA1' }], scroll_id: null },
    });
    // Paused status (segunda llamada de scan)
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { results: [], scroll_id: null }, // sin items pausados
    });
    // Multiget: 1 item
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: [
        { code: 200, body: { id: 'MLA1', title: 'Item 1', seller_custom_field: 'SKU1' } },
      ],
    });

    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG);
    await vi.runAllTimersAsync();

    const resultado = await promise;
    expect(resultado).toBeDefined();
    expect(resultado.total).toBeGreaterThan(0); // debe traer publicaciones

    // Verificar métrica registrada
    const metricas = db.prepare('SELECT * FROM metricas_ciclo_sync WHERE integracion = ? AND proceso = ?')
      .all('mercadolibre', 'refrescar_publicaciones');
    expect(metricas.length).toBe(1);
    expect(metricas[0].procesados).toBeGreaterThan(0); // debe haber procesado las publicaciones
    expect(metricas[0].fallidos).toBe(0);
    expect(metricas[0].finalizado_en).toBeTruthy();
  });

  it('ALTO 4: abre incidente de advertencia cuando resultado es 0 publicaciones (antes era info)', async () => {
    // Refresco que devuelve 0 items en ambos status
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { results: [], scroll_id: null }, // vacío (active)
    });
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { results: [], scroll_id: null }, // vacío (paused)
    });

    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG);
    await vi.runAllTimersAsync();

    const resultado = await promise;
    expect(resultado.total).toBe(0);

    // ALTO 4: severidad sube a 'advertencia' ahora que evitamos pisar el cache
    const incidentes = db.prepare('SELECT * FROM incidentes_operativos WHERE integracion = ? AND tipo_error = ?')
      .all('mercadolibre', 'publicaciones_vacias');
    expect(incidentes.length).toBe(1);
    expect(incidentes[0].severidad).toBe('advertencia');
    expect(incidentes[0].estado).toBe('activo');
  });

  // 3ra pasada del revisor (MEDIO 4): el test de arriba solo verificaba el incidente, no que
  // las publicaciones YA cacheadas sobrevivan — un futuro refactor del guard `filas.length > 0`
  // podía volver a borrar el cache completo ante 0 resultados y seguir pasando en verde.
  it('ALTO 4: con 0 publicaciones, el cache existente NO se borra (fail-closed real, no solo el incidente)', async () => {
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, actualizado_en) VALUES (?, ?, ?)`)
      .run('MLA1|', 'MLA1', ts);
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, actualizado_en) VALUES (?, ?, ?)`)
      .run('MLA2|', 'MLA2', ts);

    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: { results: [], scroll_id: null } });
    axios.request.mockResolvedValueOnce({ status: 200, headers: {}, data: { results: [], scroll_id: null } });

    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG);
    await vi.runAllTimersAsync();
    const resultado = await promise;
    expect(resultado.total).toBe(0);

    const filasSobrevivientes = db.prepare('SELECT COUNT(*) n FROM ml_publicaciones_cache').get().n;
    expect(filasSobrevivientes).toBe(2); // el cache viejo sigue intacto, no se pisó con 0 filas
  });

  it('registra duración en métrica (performance.now monotónico)', async () => {
    // Refresco mínimo (vacío)
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { results: [], scroll_id: null }, // active vacío
    });
    axios.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { results: [], scroll_id: null }, // paused vacío
    });

    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG);
    await vi.runAllTimersAsync();

    await promise;

    const metricas = db.prepare('SELECT * FROM metricas_ciclo_sync').all();
    expect(metricas.length).toBe(1);
    const duracionRegistrada = metricas[0].duracion_ms;

    // La duración debe registrarse (aunque sea con fake timers)
    expect(duracionRegistrada).toBeGreaterThanOrEqual(0);
    expect(metricas[0].finalizado_en).toBeTruthy();
  });

  it('MEDIO 5: integración end-to-end — un 401 real genera incidente tipo_error=auth, severidad=critico', async () => {
    // Mock: scan devuelve 401 (credenciales revocadas)
    // Nota: usamos mockResolvedValue (no ValueOnce) para que TODAS las llamadas a axios.request
    // devuelvan 401, evitando TypeErrors cuando hay múltiples iteraciones del retry logic.
    axios.request.mockResolvedValue({
      status: 401,
      headers: {},
      data: null,
    });

    // El .catch(e=>e) se adjunta EN EL MISMO TICK que se crea la promesa — no después de
    // vi.runAllTimersAsync() — para que Node no la vea "sin manejador" en el instante en que
    // se rechaza (patrón ya usado en test/woo.test.js/fallaRefresco).
    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(Error);

    // Verificar que se creó un incidente con tipo_error='auth' y severidad='critico'
    const incidentes = db.prepare('SELECT * FROM incidentes_operativos WHERE integracion = ? AND proceso = ?')
      .all('mercadolibre', 'refrescar_publicaciones');
    expect(incidentes.length).toBeGreaterThan(0);
    const incidente = incidentes[0];
    expect(incidente.tipo_error).toBe('auth');
    expect(incidente.severidad).toBe('critico');
    expect(incidente.estado).toBe('activo');
  });

  it('MEDIO 5: el incidente de un fallo real sigue activo — NO se confirma ciclo sano con 0 publicaciones', async () => {
    // Primer ciclo: simular un 401, genera incidente
    // Nota: usamos mockResolvedValue (no ValueOnce) para que TODAS las llamadas devuelvan 401.
    axios.request.mockResolvedValue({
      status: 401,
      headers: {},
      data: null,
    });

    const promise1 = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();
    expect(await promise1).toBeInstanceOf(Error);

    // Verificar que el incidente está activo
    let incidentes = db.prepare('SELECT * FROM incidentes_operativos WHERE estado = ? AND tipo_error = ?')
      .all('activo', 'auth');
    expect(incidentes.length).toBe(1);
    const incidenteId = incidentes[0].id;

    // Resetear mocks para el segundo ciclo
    axios.request.mockReset();

    // Segundo ciclo: mismo 401, el incidente debe SEGUIR activo (no resolverse)
    // Nota: usamos mockResolvedValue (no ValueOnce) para que TODAS las llamadas devuelvan 401.
    axios.request.mockResolvedValue({
      status: 401,
      headers: {},
      data: null,
    });

    const promise2 = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();
    expect(await promise2).toBeInstanceOf(Error);

    // El incidente debe estar ACTIVO todavía (no confirmado)
    incidentes = db.prepare('SELECT * FROM incidentes_operativos WHERE id = ? AND estado = ?')
      .all(incidenteId, 'activo');
    expect(incidentes.length).toBe(1);
  });

  it('ALTO 1: refresh de token con 401 se categoriza como auth y tiene .status seteado', async () => {
    // Preparar: crear un token que está VENCIDO (para forzar refresh)
    const ahora = Date.now();
    const vencidoHace1Min = new Date(ahora - 60 * 1000).toISOString();
    db.prepare('UPDATE ml_oauth_token SET expires_at = ?, refresh_token = ? WHERE id = 1')
      .run(vencidoHace1Min, 'refresh_token_quemado');

    // Mockear axios.post (el endpoint de OAuth) para devolver 401
    // (axios.request es para las llamadas API, axios.post es para OAuth)
    // Nota: usamos mockResolvedValue (no ValueOnce) para que TODAS las llamadas a axios.post
    // devuelvan 401. Si hay múltiples intentos de refresh (e.g., debido a que getAccessToken
    // se llama desde múltiples lugares en paralelo antes del lock), todas recibirán 401
    // en lugar de undefined, evitando TypeErrors no atrapados.
    vi.mocked(axios).post = vi.fn().mockResolvedValue({
      status: 401,
      headers: {},
      data: null,
    });

    // Intentar refrescar publicaciones, lo cual dispara getAccessToken,
    // que intenta refresh y falla con 401
    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();

    // Debería rechazar con un error que tenga .status = 401
    const thrownErr = await promise;
    expect(thrownErr).toBeInstanceOf(Error);
    expect(thrownErr.status).toBe(401); // ALTO 1: verificar que .status está seteado
    expect(categorizarErrorMl(thrownErr)).toBe('auth');

    // Verificar que se registró un incidente con categoría 'auth' y severidad 'critico'
    const incidentes = db.prepare('SELECT * FROM incidentes_operativos WHERE integracion = ? AND proceso = ?')
      .all('mercadolibre', 'refrescar_publicaciones');
    expect(incidentes.length).toBeGreaterThan(0);
    const incidente = incidentes[incidentes.length - 1];
    expect(incidente.tipo_error).toBe('auth');
    expect(incidente.severidad).toBe('critico');
  });

  // 3ra pasada del revisor (ALTO 1): el 401 de arriba ya pasaba, pero el escenario real que
  // motivó el hito (refresh_token quemado / invalid_grant) es un 400 según OAuth 2.0 (RFC
  // 6749), no un 401 — y ese caso caía en categorizarErrorMl como 'datos' (severidad 'info')
  // en vez de 'auth' (severidad 'critico'), porque el throw original solo seteaba .status,
  // no .categoria.
  it('ALTO 1: refresh de token con 400 (invalid_grant) también se categoriza como auth, no datos', async () => {
    const ahora = Date.now();
    const vencidoHace1Min = new Date(ahora - 60 * 1000).toISOString();
    db.prepare('UPDATE ml_oauth_token SET expires_at = ?, refresh_token = ? WHERE id = 1')
      .run(vencidoHace1Min, 'refresh_token_quemado');

    vi.mocked(axios).post = vi.fn().mockResolvedValue({
      status: 400,
      headers: {},
      data: null,
    });

    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();

    const thrownErr = await promise;
    expect(thrownErr).toBeInstanceOf(Error);
    expect(thrownErr.status).toBe(400);
    expect(categorizarErrorMl(thrownErr)).toBe('auth'); // no 'datos'

    const incidentes = db.prepare('SELECT * FROM incidentes_operativos WHERE integracion = ? AND proceso = ?')
      .all('mercadolibre', 'refrescar_publicaciones');
    expect(incidentes.length).toBeGreaterThan(0);
    const incidente = incidentes[incidentes.length - 1];
    expect(incidente.tipo_error).toBe('auth');
    expect(incidente.severidad).toBe('critico'); // no 'info'
  });

  // 3ra pasada del revisor (ALTO 2): el cooldown propio del refresh de OAuth (_cooldownActivo()
  // en getAccessToken) seteaba status=429 pero no el flag sintético — indistinguible de un
  // 429 real de ML, y pisando la clave de dedupe del 429 real que originó el cooldown.
  it('ALTO 2: el cooldown propio de OAuth se distingue de un 429 real (tipoError rate_limit_propio)', async () => {
    // Forzar refresh y activar el cooldown de OAuth con un 429 real primero.
    const ahora = Date.now();
    const vencidoHace1Min = new Date(ahora - 60 * 1000).toISOString();
    db.prepare('UPDATE ml_oauth_token SET expires_at = ?, refresh_token = ? WHERE id = 1')
      .run(vencidoHace1Min, 'refresh_token_quemado');
    vi.mocked(axios).post = vi.fn().mockResolvedValue({ status: 429, headers: {}, data: null });

    const promise1 = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();
    const err1 = await promise1;
    expect(err1).toBeInstanceOf(Error);

    // Segundo ciclo: el cooldown que el 429 real activó sigue vigente — getAccessToken corta
    // ANTES de llamar a axios.post de nuevo. Ese segundo error debe venir marcado como
    // sintético (rate_limit_propio), no pisar el incidente 'rate_limit' del 429 real.
    db.prepare('UPDATE ml_oauth_token SET expires_at = ? WHERE id = 1').run(vencidoHace1Min);
    const promise2 = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();
    const err2 = await promise2;
    expect(err2).toBeInstanceOf(Error);
    expect(err2.__cooldownSintetico).toBe(true);

    const incidentesReales = db.prepare("SELECT * FROM incidentes_operativos WHERE tipo_error = 'rate_limit'").all();
    expect(incidentesReales.length).toBeGreaterThan(0); // el 429 real conservó su propia clave
  });

  // 4ta pasada del revisor (ALTO 1): si falla la escritura en sqlite tras rotar el
  // refresh_token, el error CRÍTICO original no debía matchear ningún patrón de
  // ML_ERRORES_NO_TRANSITORIOS — se reintentaba con el refresh_token YA QUEMADO, generando
  // un 400 invalid_grant que enmascaraba el problema real (DB, no credenciales).
  it('ALTO 1: fallo al persistir el refresh_token rotado NO se reintenta con el token quemado', async () => {
    const ahora = Date.now();
    const vencidoHace1Min = new Date(ahora - 60 * 1000).toISOString();
    db.prepare('UPDATE ml_oauth_token SET expires_at = ?, refresh_token = ? WHERE id = 1')
      .run(vencidoHace1Min, 'refresh_token_vigente');

    // OAuth responde bien (200, token nuevo) — la falla es nuestra, al persistir.
    vi.mocked(axios).post = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      data: { access_token: 'nuevo_token', refresh_token: 'nuevo_refresh', expires_in: 21600 },
    });
    const prepareOriginal = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('ON CONFLICT(id) DO UPDATE')) {
        throw new Error('SQLITE_READONLY: attempt to write a readonly database');
      }
      return prepareOriginal(sql);
    });

    const promise = refrescarPublicacionesMlConMetricas(db, ML_CFG).catch(e => e);
    await vi.runAllTimersAsync();
    const err = await promise;

    prepareSpy.mockRestore();

    expect(err).toBeInstanceOf(Error);
    // Si esto dice "Autenticación ML rechazada", el error se perdió en un reintento con el
    // token quemado y el mensaje CRÍTICO original nunca llegó al caller.
    expect(err.message).toMatch(/no se pudo persistir en sqlite/);
    expect(err.message).toMatch(/CRÍTICO/);

    // El axios.post de OAuth se llamó UNA sola vez — no se reintentó con el token quemado.
    expect(vi.mocked(axios).post).toHaveBeenCalledTimes(1);
  });
});
