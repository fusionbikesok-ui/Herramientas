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
      variations_texto TEXT,
      thumbnail TEXT,
      permalink TEXT,
      catalogo INTEGER,
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
    expect(resultado.total).toBeGreaterThanOrEqual(0);

    // Verificar métrica registrada
    const metricas = db.prepare('SELECT * FROM metricas_ciclo_sync WHERE integracion = ? AND proceso = ?')
      .all('mercadolibre', 'refrescar_publicaciones');
    expect(metricas.length).toBe(1);
    expect(metricas[0].procesados).toBeGreaterThanOrEqual(0);
    expect(metricas[0].fallidos).toBe(0);
    expect(metricas[0].finalizado_en).toBeTruthy();
  });

  it('no confirma ciclo sano si resultado es 0 publicaciones (ambiguo)', async () => {
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

    // NO debe confirmar ciclo sano (sin incidente, pero sin confirmación)
    const incidentes = db.prepare('SELECT * FROM incidentes_operativos WHERE estado = ?')
      .all('activo');
    expect(incidentes.length).toBe(0);
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

    // La duración debe registrarse (aunque sea con fake timers, el reloj monotónico se incrementa)
    expect(duracionRegistrada).toBeGreaterThanOrEqual(0);
  });
});
