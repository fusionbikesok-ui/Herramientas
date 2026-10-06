/**
 * test/incidentes-api.test.js — Tests para la API HTTP de incidentes operativos (Hito 5).
 * Prueba autenticación, filtros, paginación, y validación de entrada.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { incidentesRouter } from '../routes/incidentes.js';
import { abrirOActualizarIncidente } from '../lib/incidentes.js';

function tmpDb() {
  const f = path.join(os.tmpdir(), `incidentes-api_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(f);
  db._tmpFile = f;
  return db;
}

function seedIncidentesSchema(db) {
  // Crear tablas de incidentes
  db.prepare(`
    CREATE TABLE IF NOT EXISTS incidentes_operativos (
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
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS incidentes_operativos_historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incidente_id INTEGER NOT NULL REFERENCES incidentes_operativos(id),
      evento TEXT NOT NULL,
      detalle_json TEXT,
      creado_en TEXT NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incidentes_dedupe_activo
      ON incidentes_operativos(clave_dedupe) WHERE estado = 'activo'
  `).run();
}

function buildAppWithAdmin(db, isAdmin = true) {
  const app = express();
  app.use(express.json());
  // Inyectar usuario autenticado como admin o no-admin
  app.use((req, res, next) => {
    req.user = isAdmin ? { login: 'admin', is_admin: true } : { login: 'user', is_admin: false };
    next();
  });
  app.use('/api/incidentes', incidentesRouter(db));
  return app;
}

describe('GET /api/incidentes — Autenticación y permisos', () => {
  let db;
  beforeEach(() => {
    db = tmpDb();
    seedIncidentesSchema(db);
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('sin admin: devuelve 403', async () => {
    const app = buildAppWithAdmin(db, false);
    const res = await request(app).get('/api/incidentes');
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('Requiere administrador');
  });

  it('con admin: devuelve 200 con estructura correcta', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('pageSize');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/incidentes — Paginación y filtros', () => {
  let db;
  beforeEach(() => {
    db = tmpDb();
    seedIncidentesSchema(db);
    // Insertar 5 incidentes variados para pruebas
    const now = new Date().toISOString();
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO incidentes_operativos
          (integracion, proceso, tipo_error, clave_dedupe, severidad, estado,
           mensaje_humano, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        i % 2 === 0 ? 'ml' : 'woo',
        'sync_precios',
        i <= 2 ? 'auth_fail' : 'rate_limit',
        `clave_${i}`,
        i === 1 ? 'critico' : i === 2 ? 'info' : 'advertencia',
        i <= 3 ? 'activo' : 'resuelto',
        `Incidente ${i}`,
        now,
        now,
        now,
        now
      );
    }
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('devuelve 20 elementos por defecto', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.data.length).toBe(5); // Tenemos 5 en total
    expect(res.body.total).toBe(5);
  });

  it('filtro por estado: devuelve solo activos', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?estado=activo');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(3); // 3 activos (i=1,2,3)
    expect(res.body.data.every(inc => inc.estado === 'activo')).toBe(true);
  });

  it('filtro por integracion: devuelve solo de ml', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?integracion=ml');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2); // i=2,4 son ml
    expect(res.body.data.every(inc => inc.integracion === 'ml')).toBe(true);
  });

  it('filtro por severidad: devuelve solo critico', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?severidad=critico');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1); // i=1 es critico
    expect(res.body.data[0].severidad).toBe('critico');
  });

  it('múltiples filtros combinados', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?estado=activo&integracion=woo&severidad=advertencia');
    expect(res.status).toBe(200);
    // Buscamos: estado=activo, integracion=woo, severidad=advertencia
    // i=3: woo, activo, advertencia → match
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].integracion).toBe('woo');
    expect(res.body.data[0].estado).toBe('activo');
    expect(res.body.data[0].severidad).toBe('advertencia');
  });
});

describe('GET /api/incidentes — Paginación con valores inválidos', () => {
  let db;
  beforeEach(() => {
    db = tmpDb();
    seedIncidentesSchema(db);
    const now = new Date().toISOString();
    // Insertar 25 elementos para probar paginación
    for (let i = 1; i <= 25; i++) {
      db.prepare(`
        INSERT INTO incidentes_operativos
          (integracion, proceso, tipo_error, clave_dedupe, severidad, estado,
           mensaje_humano, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ml', 'sync', 'error', `clave_${i}`, 'advertencia', 'activo', `Inc ${i}`, now, now, now, now);
    }
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('pageSize=0 se trata como default (20)', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?pageSize=0');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(20);
  });

  it('pageSize=-5 se trata como default (20)', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?pageSize=-5');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(20);
  });

  it('pageSize=1000 se clampea a 100', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?pageSize=1000');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(100); // lib/incidentes.js tapa en PAGE_SIZE_MAX=100
    expect(res.body.data.length).toBe(25); // pero devuelve todos porque tenemos 25
  });

  it('pageSize=abc (no numérico) se trata como default', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?pageSize=abc');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(20);
  });

  it('page=0 se trata como 1', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?page=0');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
  });

  it('page=-1 se trata como 1', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?page=-1');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
  });

  it('page=xyz (no numérico) se trata como 1', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?page=xyz');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
  });

  it('paginación válida: page=2 con pageSize=10 devuelve elementos 11-20', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?page=2&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(10);
  });

  it('no rompe con pageSize gigante (1e21)', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes?pageSize=1e21');
    // Puede devolver default (20) o clampeado a MAX_SAFE_INTEGER, pero no debe fallar
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/incidentes/:id — Detalle y validación', () => {
  let db;
  beforeEach(() => {
    db = tmpDb();
    seedIncidentesSchema(db);
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('sin admin: devuelve 403', async () => {
    const app = buildAppWithAdmin(db, false);
    const res = await request(app).get('/api/incidentes/1');
    expect(res.status).toBe(403);
  });

  it('id inexistente: devuelve 404', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes/9999');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('no encontrado');
  });

  it('id inválido (no numérico): devuelve 400', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes/abc');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('id inválido (negativo): devuelve 400', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes/-1');
    expect(res.status).toBe(400);
  });

  it('id inválido (0): devuelve 400', async () => {
    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get('/api/incidentes/0');
    expect(res.status).toBe(400);
  });

  it('con id existente: devuelve 200 con estructura de incidente', async () => {
    const app = buildAppWithAdmin(db, true);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO incidentes_operativos
        (integracion, proceso, tipo_error, clave_dedupe, severidad, estado,
         mensaje_humano, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ml', 'sync', 'auth', 'clave_1', 'critico', 'activo', 'Fallo crítico', now, now, now, now);

    const res = await request(app).get('/api/incidentes/1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.integracion).toBe('ml');
    expect(res.body.data.severidad).toBe('critico');
    expect(res.body.data.estado).toBe('activo');
  });
});

describe('GET /api/incidentes/:id — Historial', () => {
  let db;
  beforeEach(() => {
    db = tmpDb();
    seedIncidentesSchema(db);
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('devuelve el incidente con historial vacío si no hay eventos', async () => {
    const app = buildAppWithAdmin(db, true);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO incidentes_operativos
        (integracion, proceso, tipo_error, clave_dedupe, severidad, estado,
         mensaje_humano, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('woo', 'pedidos', 'connection', 'clave_1', 'advertencia', 'activo', 'Conectividad', now, now, now, now);

    const res = await request(app).get('/api/incidentes/1');
    expect(res.status).toBe(200);
    expect(res.body.data.historial).toBeDefined();
    expect(Array.isArray(res.body.data.historial)).toBe(true);
  });

  it('devuelve historial ordenado cronológico (más antiguo primero)', async () => {
    const app = buildAppWithAdmin(db, true);
    const now = new Date().toISOString();
    const hace1h = new Date(Date.now() - 3600000).toISOString();

    db.prepare(`
      INSERT INTO incidentes_operativos
        (integracion, proceso, tipo_error, clave_dedupe, severidad, estado,
         mensaje_humano, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('woo', 'pedidos', 'connection', 'clave_1', 'advertencia', 'activo', 'Conectividad', hace1h, now, hace1h, now);

    db.prepare(`
      INSERT INTO incidentes_operativos_historial (incidente_id, evento, detalle_json, creado_en)
      VALUES (?, ?, ?, ?)
    `).run(1, 'abierto', '{"mensaje":"inicial"}', hace1h);

    db.prepare(`
      INSERT INTO incidentes_operativos_historial (incidente_id, evento, detalle_json, creado_en)
      VALUES (?, ?, ?, ?)
    `).run(1, 'repetido', '{"repeticiones":2}', now);

    const res = await request(app).get('/api/incidentes/1');
    expect(res.status).toBe(200);
    expect(res.body.data.historial.length).toBe(2);
    expect(res.body.data.historial[0].evento).toBe('abierto');
    expect(res.body.data.historial[1].evento).toBe('repetido');
  });
});

describe('Integración real: abrirOActualizarIncidente + GET /api/incidentes', () => {
  let db;
  beforeEach(() => {
    db = tmpDb();
    seedIncidentesSchema(db);
  });
  afterEach(() => { db.close(); fs.unlinkSync(db._tmpFile); });

  it('incidente abierto con abrirOActualizarIncidente aparece en listado y detalle', async () => {
    // Abrir un incidente usando la función de lib/incidentes.js
    const resultado = abrirOActualizarIncidente(db, {
      integracion: 'ml',
      proceso: 'sync_precios',
      tipoError: 'rate_limit',
      severidad: 'advertencia',
      mensajeHumano: 'Rate limit de ML alcanzado',
      mensajeTecnico: 'HTTP 429 en GET /products',
      contexto: { status: 429, message: 'Too many requests' },
    });

    expect(resultado.creado).toBe(true);
    expect(resultado.id).toBeDefined();
    const incidenteId = resultado.id;

    const app = buildAppWithAdmin(db, true);

    // Verificar en listado
    const resLista = await request(app).get('/api/incidentes?integracion=ml&estado=activo');
    expect(resLista.status).toBe(200);
    expect(resLista.body.data.length).toBeGreaterThan(0);
    const incenListado = resLista.body.data.find(inc => inc.id === incidenteId);
    expect(incenListado).toBeDefined();
    expect(incenListado.integracion).toBe('ml');
    expect(incenListado.proceso).toBe('sync_precios');
    expect(incenListado.tipo_error).toBe('rate_limit');

    // Verificar en detalle
    const resDetalle = await request(app).get(`/api/incidentes/${incidenteId}`);
    expect(resDetalle.status).toBe(200);
    expect(resDetalle.body.ok).toBe(true);
    expect(resDetalle.body.data.id).toBe(incidenteId);
    expect(resDetalle.body.data.severidad).toBe('advertencia');
    expect(resDetalle.body.data.mensaje_humano).toContain('Rate limit');
    // Historial debe tener el evento 'abierto'
    expect(resDetalle.body.data.historial.length).toBeGreaterThan(0);
    expect(resDetalle.body.data.historial[0].evento).toBe('abierto');
  });

  it('incidentes repetidos escalan en severidad y aparecen en listado', async () => {
    // Primer incidente: info
    const r1 = abrirOActualizarIncidente(db, {
      integracion: 'woo',
      proceso: 'pedidos',
      tipoError: 'connection_timeout',
      severidad: 'info',
      mensajeHumano: 'Timeout leve',
      contexto: null,
    });

    // Repetición con severidad mayor: advertencia (debe escalar)
    const r2 = abrirOActualizarIncidente(db, {
      integracion: 'woo',
      proceso: 'pedidos',
      tipoError: 'connection_timeout',
      severidad: 'advertencia',
      mensajeHumano: 'Timeout más frecuente',
      contexto: null,
    });

    expect(r1.id).toBe(r2.id); // Mismo incidente
    expect(r2.escalado).toBe(true); // Escaló en severidad

    const app = buildAppWithAdmin(db, true);
    const res = await request(app).get(`/api/incidentes/${r1.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.severidad).toBe('advertencia'); // Escaló
    expect(res.body.data.contador_repeticiones).toBe(2);
    // El historial debe mostrar tanto 'abierto' como 'escalado'
    expect(res.body.data.historial.length).toBe(2);
    expect(res.body.data.historial.map(h => h.evento)).toContain('escalado');
  });
});
