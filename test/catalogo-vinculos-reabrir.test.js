import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos } from '../lib/identidadProductos.js';
import { catalogoVinculosRouter } from '../routes/catalogoVinculos.js';

// Fase D (H2): filtro "Cerrados" de la cola y "Reabrir" (excepción o "ninguno sirve" vigentes).
const FILE = './test/tmp-catalogo-vinculos-reabrir.sqlite';
const ISO = '2026-10-09T12:00:00.000Z';
const BASE = '/api/catalogo-vinculos';
const FUTURO = '2099-01-01T00:00:00.000Z';

describe('Catálogo y vínculos: filtro Cerrados y reabrir (H2)', () => {
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
  const operador = { username: 'ana', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
  const lector = { username: 'leo', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] };

  function caso(id) {
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`)
      .run(id, 'Bicicleta Rodado 29 Talle M', `FB-${id}`, 2, ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,canales_json,actualizado_en)
      VALUES (?,?,'','Bicicleta Rodado 29 Talle M','active',NULL,0,2,'[]','["marketplace"]',?)`).run(`MLA${id}|`, `MLA${id}`, ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    return db.prepare('SELECT id FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`).id;
  }
  const estadoCaso = (id) => db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(id);
  const cuerpoCaso = (id, extra = {}) => {
    const c = estadoCaso(id);
    return { operation_id: `cmd-${id}-${Math.random().toString(36).slice(2, 8)}`, expected_version: c.expected_version,
      evidence_fingerprint: c.evidencia_fingerprint, ...extra };
  };
  const cola = async (filtro, user = lector, extra = '') => (await request(app(user)).get(`${BASE}/cola?filtro=${filtro}${extra}`));
  const idsCola = async (filtro) => (await cola(filtro)).body.data.map((f) => f.caso_id);
  const historial = (id, evento) => db.prepare("SELECT actor,detalle_json FROM identidad_historial WHERE entidad_tipo='caso' AND entidad_id=? AND evento=? ORDER BY id")
    .all(id, evento);

  // Dos casos cerrados de formas distintas, por la API real.
  async function cerrarPorExcepcion(id) {
    const r = await request(app(operador)).post(`${BASE}/casos/${id}/excepcion`)
      .send(cuerpoCaso(id, { motivo: 'Esperamos reposición', expires_at: FUTURO }));
    expect(r.status).toBe(201);
    return r.body.decision;
  }
  async function cerrarPorNingunoSirve(id) {
    const r = await request(app(operador)).post(`${BASE}/casos/${id}/ninguno-sirve`)
      .send(cuerpoCaso(id, { motivo: 'no_existe_en_woo', nota: 'revisado' }));
    expect(r.status).toBe(201);
    return r;
  }

  describe('filtro cerrados en la cola', () => {
    it('lista excepción y ninguno sirve con tipo, motivo, vence_en, quién y cuándo; no aparecen en abiertos', async () => {
      const exc = caso(4001);
      const nin = caso(4002);
      const abierto = caso(4003);
      await cerrarPorExcepcion(exc);
      await cerrarPorNingunoSirve(nin);

      const r = await cola('cerrados');
      expect(r.status).toBe(200);
      expect(r.body.filtro).toBe('cerrados');
      expect(r.body.total).toBe(2);
      const porCaso = Object.fromEntries(r.body.data.map((f) => [f.caso_id, f]));
      expect(Object.keys(porCaso).map(Number).sort()).toEqual([exc, nin].sort());
      expect(porCaso[exc].cierre).toMatchObject({ tipo: 'excepcion', motivo: 'Esperamos reposición', vence_en: FUTURO, por: 'ana' });
      expect(typeof porCaso[exc].cierre.desde).toBe('string');
      expect(porCaso[nin].cierre).toMatchObject({ tipo: 'ninguno_sirve', motivo: 'no_existe_en_woo', nota: 'revisado', vence_en: null, por: 'ana' });

      const abiertos = await idsCola('abiertos');
      expect(abiertos).toContain(abierto);
      expect(abiertos).not.toContain(exc);
      expect(abiertos).not.toContain(nin);
      expect((await cola('abiertos')).body.data.every((f) => f.cierre === null)).toBe(true);
    });

    it('pagina con limit/offset y total antes de paginar', async () => {
      const a = caso(4010); const b = caso(4011); const c = caso(4012);
      await cerrarPorNingunoSirve(a); await cerrarPorNingunoSirve(b); await cerrarPorNingunoSirve(c);
      const p1 = await cola('cerrados', lector, '&limit=2&offset=0');
      const p2 = await cola('cerrados', lector, '&limit=2&offset=2');
      expect(p1.body.total).toBe(3);
      expect(p1.body.data).toHaveLength(2);
      expect(p2.body.data).toHaveLength(1);
    });

    it('un filtro inválido sigue respondiendo 422 y la lista de filtros incluye cerrados', async () => {
      const r = await cola('nada');
      expect(r.status).toBe(422);
      expect(r.body.error).toMatch(/cerrados/);
    });
  });

  describe('POST /casos/:id/reabrir', () => {
    it('lector recibe 403 y no cambia nada', async () => {
      const id = caso(4020);
      await cerrarPorExcepcion(id);
      const r = await request(app(lector)).post(`${BASE}/casos/${id}/reabrir`).send(cuerpoCaso(id, { motivo: 'x' }));
      expect(r.status).toBe(403);
      expect(estadoCaso(id).estado).toBe('exceptuado');
    });

    it('sin motivo (vacío o solo espacios) → 422 y no revierte', async () => {
      const id = caso(4021);
      await cerrarPorExcepcion(id);
      const a = request(app(operador));
      expect((await a.post(`${BASE}/casos/${id}/reabrir`).send(cuerpoCaso(id))).status).toBe(422);
      const r = await a.post(`${BASE}/casos/${id}/reabrir`).send(cuerpoCaso(id, { motivo: '   ' }));
      expect(r.status).toBe(422);
      expect(r.body.error).toMatch(/motivo/);
      expect(estadoCaso(id).estado).toBe('exceptuado');
    });

    it('falta operation_id, expected_version o evidence_fingerprint → 422', async () => {
      const id = caso(4022);
      await cerrarPorExcepcion(id);
      const c = cuerpoCaso(id, { motivo: 'x' });
      const a = request(app(operador));
      expect((await a.post(`${BASE}/casos/${id}/reabrir`).send({ ...c, operation_id: '' })).status).toBe(422);
      expect((await a.post(`${BASE}/casos/${id}/reabrir`).send({ ...c, expected_version: undefined })).status).toBe(422);
      expect((await a.post(`${BASE}/casos/${id}/reabrir`).send({ ...c, evidence_fingerprint: undefined })).status).toBe(422);
    });

    it('caso no cerrado → 409 INVALID_STATE', async () => {
      const id = caso(4023);
      const r = await request(app(operador)).post(`${BASE}/casos/${id}/reabrir`).send(cuerpoCaso(id, { motivo: 'x' }));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('INVALID_STATE');
    });

    it('versión vieja → 409 VERSION_CONFLICT', async () => {
      const id = caso(4024);
      await cerrarPorExcepcion(id);
      const c = cuerpoCaso(id, { motivo: 'x' });
      const r = await request(app(operador)).post(`${BASE}/casos/${id}/reabrir`).send({ ...c, expected_version: c.expected_version - 1 });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('VERSION_CONFLICT');
    });

    it('excepción: el caso vuelve a abiertos, sale de cerrados, excepción invalidada e historial con motivo y actor', async () => {
      const id = caso(4030);
      await cerrarPorExcepcion(id);
      const r = await request(app(operador)).post(`${BASE}/casos/${id}/reabrir`)
        .send(cuerpoCaso(id, { motivo: 'El proveedor confirmó stock' }));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, caso_id: id, estado: 'urgente', revertidos: ['excepcion'], motivo: 'El proveedor confirmó stock' });
      expect(r.body.repetido).toBeUndefined();
      expect(r.body.expected_version).toBe(estadoCaso(id).expected_version);

      expect(estadoCaso(id).estado).toBe('urgente');
      expect(await idsCola('abiertos')).toContain(id);
      expect(await idsCola('cerrados')).not.toContain(id);
      const exc = db.prepare('SELECT activa,invalidada_en FROM identidad_excepciones WHERE caso_id=? ORDER BY id DESC LIMIT 1').get(id);
      expect(exc.activa).toBe(0);
      expect(exc.invalidada_en).toBeTruthy();
      const h = historial(id, 'caso_reabierto');
      expect(h).toHaveLength(1);
      expect(h[0].actor).toBe('ana');
      expect(JSON.parse(h[0].detalle_json)).toMatchObject({ motivo: 'El proveedor confirmó stock', revertidos: ['excepcion'] });
    });

    it('"ninguno sirve": el caso vuelve a abiertos y sale de cerrados; el motor no lo vuelve a cerrar', async () => {
      const id = caso(4031);
      await cerrarPorNingunoSirve(id);
      expect(await idsCola('cerrados')).toContain(id);
      const r = await request(app(operador)).post(`${BASE}/casos/${id}/reabrir`).send(cuerpoCaso(id, { motivo: 'Sí existe' }));
      expect(r.status).toBe(200);
      expect(r.body.revertidos).toEqual(['ninguno_sirve']);
      expect(await idsCola('abiertos')).toContain(id);
      expect(await idsCola('cerrados')).not.toContain(id);
      expect(historial(id, 'ninguno_sirve_deshecho')).toHaveLength(1);
    });

    it('doble envío con el mismo operation_id es idempotente: 200 repetido y un solo evento', async () => {
      const id = caso(4032);
      await cerrarPorExcepcion(id);
      const body = cuerpoCaso(id, { motivo: 'x' });
      const a = request(app(operador));
      const primera = await a.post(`${BASE}/casos/${id}/reabrir`).send(body);
      const segunda = await a.post(`${BASE}/casos/${id}/reabrir`).send(body);
      expect(primera.status).toBe(200);
      expect(segunda.status).toBe(200);
      expect(segunda.body.repetido).toBe(true);
      expect(segunda.body.caso_id).toBe(id);
      expect(historial(id, 'caso_reabierto')).toHaveLength(1);
    });
  });
});
