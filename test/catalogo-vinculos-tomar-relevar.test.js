import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos } from '../lib/identidadProductos.js';
import { catalogoVinculosRouter } from '../routes/catalogoVinculos.js';

// Fase D: rutas nuevas de Tomar y Relevar (POST /casos/:id/tomar y /relevar) del router de Catálogo y vínculos.
const FILE = './test/tmp-catalogo-vinculos-tomar-relevar.sqlite';
const ISO = '2026-10-09T12:00:00.000Z';
const BASE = '/api/catalogo-vinculos';

describe('Catálogo y vínculos: Tomar y Relevar', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  const app = (user) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use(BASE, catalogoVinculosRouter(db));
    return a;
  };
  const ana = { username: 'ana', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
  const bea = { username: 'bea', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
  const leo = { username: 'leo', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] };

  function caso(id) {
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`)
      .run(id, 'Bicicleta Rodado 29 Talle M', `FB-${id}`, 2, ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,canales_json,actualizado_en)
      VALUES (?,?,'','Bicicleta Rodado 29 Talle M','active',NULL,0,2,'[]','["marketplace"]',?)`).run(`MLA${id}|`, `MLA${id}`, ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    return db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`).id;
  }
  const estadoCaso = (id) => db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(id);
  const nOperaciones = () => db.prepare('SELECT COUNT(*) n FROM identidad_operaciones').get().n;
  const historial = (id, evento) => db.prepare(`SELECT * FROM identidad_historial
    WHERE entidad_tipo='caso' AND entidad_id=? AND evento=? ORDER BY id`).all(id, evento);
  const cuerpo = (id, extra = {}) => {
    const c = estadoCaso(id);
    return { operation_id: `cmd-${id}-${Math.random().toString(36).slice(2, 8)}`, expected_version: c.expected_version,
      evidence_fingerprint: c.evidencia_fingerprint, ...extra };
  };

  describe('Tomar', () => {
    it('operador: 200, el caso queda tomado por el actor, historial "tomado", sin operaciones remotas', async () => {
      const id = caso(4001);
      const r = await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, caso: { responsable: 'ana', estado: 'tomado' } });
      expect(estadoCaso(id)).toMatchObject({ responsable: 'ana', estado: 'tomado' });
      expect(historial(id, 'tomado')).toHaveLength(1);
      expect(nOperaciones()).toBe(0);
    });

    it('lector: 403 FORBIDDEN y no cambia el caso', async () => {
      const id = caso(4002);
      const antes = estadoCaso(id);
      const r = await request(app(leo)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('FORBIDDEN');
      expect(estadoCaso(id)).toMatchObject({ responsable: null, expected_version: antes.expected_version });
    });

    it('caso inexistente: 404 NOT_FOUND', async () => {
      const r = await request(app(ana)).post(`${BASE}/casos/99999/tomar`).send({ operation_id: 'x', expected_version: 1, evidence_fingerprint: 'x' });
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('caso ya tomado por otro: 409 CLAIM_CONFLICT, sin cambios (hoy no hay relevo implícito)', async () => {
      const id = caso(4003);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id)).expect(200);
      const r = await request(app(bea)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, code: 'CLAIM_CONFLICT' });
      expect(estadoCaso(id).responsable).toBe('ana');
    });

    it('sin datos de versión o evidencia: 422 INVALID_INPUT', async () => {
      const id = caso(4004);
      const r = await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send({ operation_id: 'sin-version' });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('INVALID_INPUT');
      expect(estadoCaso(id).responsable).toBeNull();
    });

    it('expected_version vieja: 409 VERSION_CONFLICT', async () => {
      const id = caso(4005);
      const body = cuerpo(id);
      db.prepare('UPDATE identidad_casos SET expected_version=expected_version+1 WHERE id=?').run(id);
      const r = await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(body);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('VERSION_CONFLICT');
      expect(estadoCaso(id).responsable).toBeNull();
    });

    it('repetir el mismo operation_id devuelve la respuesta guardada, sin segundo historial', async () => {
      const id = caso(4006);
      const body = cuerpo(id);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(body).expect(200);
      const r = await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(body);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, repetido: true });
      expect(historial(id, 'tomado')).toHaveLength(1);
    });
  });

  describe('Relevar', () => {
    it('sobre caso propio no exige motivo: 200, historial "relevado", sin operaciones', async () => {
      const id = caso(4010);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id)).expect(200);
      const r = await request(app(ana)).post(`${BASE}/casos/${id}/relevar`).send(cuerpo(id));
      expect(r.status).toBe(200);
      expect(r.body.caso.responsable).toBe('ana');
      expect(historial(id, 'relevado')).toHaveLength(1);
      expect(nOperaciones()).toBe(0);
    });

    it('caso de otro sin motivo: 422 INVALID_INPUT, no cambia el responsable', async () => {
      const id = caso(4011);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id)).expect(200);
      const r = await request(app(bea)).post(`${BASE}/casos/${id}/relevar`).send(cuerpo(id));
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ ok: false, code: 'INVALID_INPUT', error: 'motivo de relevo requerido' });
      expect(estadoCaso(id).responsable).toBe('ana');
      expect(historial(id, 'relevado')).toHaveLength(0);
    });

    it('caso de otro con motivo: 200, el actor pasa a ser responsable y el motivo queda en el historial', async () => {
      const id = caso(4012);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id)).expect(200);
      const r = await request(app(bea)).post(`${BASE}/casos/${id}/relevar`).send(cuerpo(id, { motivo: 'Ana está de licencia' }));
      expect(r.status).toBe(200);
      expect(estadoCaso(id)).toMatchObject({ responsable: 'bea', estado: 'tomado' });
      const h = historial(id, 'relevado');
      expect(h).toHaveLength(1);
      expect(h[0].actor).toBe('bea');
      expect(JSON.parse(h[0].detalle_json)).toMatchObject({ responsable: 'bea', motivo: 'Ana está de licencia' });
      expect(nOperaciones()).toBe(0);
    });

    it('el body no puede asignar el caso a otro: el responsable es siempre el usuario autenticado', async () => {
      const id = caso(4013);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id)).expect(200);
      const r = await request(app(bea)).post(`${BASE}/casos/${id}/relevar`).send(cuerpo(id, { motivo: 'x', responsable: 'leo' }));
      expect(r.status).toBe(200);
      expect(estadoCaso(id).responsable).toBe('bea');
    });

    it('lector: 403 FORBIDDEN y no cambia el caso', async () => {
      const id = caso(4014);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id)).expect(200);
      const r = await request(app(leo)).post(`${BASE}/casos/${id}/relevar`).send(cuerpo(id, { motivo: 'x' }));
      expect(r.status).toBe(403);
      expect(estadoCaso(id).responsable).toBe('ana');
    });

    it('caso inexistente: 404 NOT_FOUND', async () => {
      const r = await request(app(bea)).post(`${BASE}/casos/99998/relevar`).send({ operation_id: 'x', expected_version: 1, evidence_fingerprint: 'x', motivo: 'x' });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
    });

    it('expected_version vieja: 409 VERSION_CONFLICT y no escribe historial', async () => {
      const id = caso(4015);
      await request(app(ana)).post(`${BASE}/casos/${id}/tomar`).send(cuerpo(id)).expect(200);
      const body = cuerpo(id, { motivo: 'x' });
      db.prepare('UPDATE identidad_casos SET expected_version=expected_version+1 WHERE id=?').run(id);
      const r = await request(app(bea)).post(`${BASE}/casos/${id}/relevar`).send(body);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('VERSION_CONFLICT');
      expect(historial(id, 'relevado')).toHaveLength(0);
    });
  });
});
