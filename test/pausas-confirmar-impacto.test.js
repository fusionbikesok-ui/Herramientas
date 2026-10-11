import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { catalogoVinculosRouter } from '../routes/catalogoVinculos.js';
import { solicitarNoSincronizarPausa, procesarPausasIdentidad } from '../lib/pausasIdentidad.js';

const FILE = './test/tmp-pausas-confirmar-impacto.sqlite';
const BASE = '/api/catalogo-vinculos';
const now = () => new Date().toISOString();

function cache(db, clave, status = 'active') {
  const [item, variacion = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`).run(clave, item, variacion, `Pub ${clave}`, status, null, 1, now());
}
const config = (db, modo, hab) => db.prepare('UPDATE identidad_config SET modo=?,escrituras_remotas_habilitadas=?,canario_ml_key=NULL WHERE id=1').run(modo, hab);
const porId = (db, id) => db.prepare('SELECT * FROM identidad_pausas WHERE id=?').get(id);
const cuantas = (db) => db.prepare('SELECT COUNT(*) n FROM identidad_pausas').get().n;
const base = { variante: 'b', motivo: 'Publicación duplicada', actor: 'ana', expectedSku: null };
function adaptador() {
  const llamadas = [];
  return { llamadas,
    async pausarItem(item) { llamadas.push(['pausar', item]); return { ok: true }; },
    async estadoItem(item) { return { item_id: item, status: 'paused', observed_at: now() }; } };
}

const admin = { username: 'jose', is_admin: true, permisos: [] };
const operador = { username: 'ana', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };

describe('confirmar impacto de una pausa bloqueada_impacto (Catálogo y vínculos)', () => {
  let db;
  let app;
  beforeEach(() => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    db = openDb(FILE);
    app = (user) => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => { req.user = user; next(); });
      a.use(BASE, catalogoVinculosRouter(db));
      return a;
    };
  });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  // Pausa real llevada a bloqueada_impacto por la saga: se pide sin hermanas, aparece una hermana, el worker la frena.
  async function pausaBloqueada(clave = 'MLA5|10') {
    config(db, 'enforced', 1);
    cache(db, clave);
    const r = solicitarNoSincronizarPausa(db, { clave, ...base, operation_id: `p-${clave}`, esAdmin: true });
    expect(r.ok).toBe(true);
    cache(db, 'MLA5|11');
    await procesarPausasIdentidad(db, adaptador());
    const vieja = db.prepare('SELECT * FROM identidad_pausas WHERE ml_key=? ORDER BY id DESC').get(clave);
    expect(vieja.estado).toBe('bloqueada_impacto');
    return vieja;
  }

  describe('POST /pausas/:id/confirmar-impacto', () => {
    it('solo admin: operador recibe 403 y no se crea nada', async () => {
      const vieja = await pausaBloqueada();
      const r = await request(app(operador)).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-1' });
      expect(r.status).toBe(403);
      expect(cuantas(db)).toBe(1);
      expect(porId(db, vieja.id).estado).toBe('bloqueada_impacto');
    });

    it('sin operation_id: 422 INVALID_INPUT', async () => {
      const vieja = await pausaBloqueada();
      const r = await request(app(admin)).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({});
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    });

    it('pausa inexistente: 404', async () => {
      const r = await request(app(admin)).post(`${BASE}/pausas/999/confirmar-impacto`).send({ operation_id: 'c-x' });
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('pausa que no está en bloqueada_impacto (shadow): 409 INVALID_STATE', async () => {
      cache(db, 'MLA6|');
      solicitarNoSincronizarPausa(db, { clave: 'MLA6|', ...base, operation_id: 'p-6' });
      const shadow = db.prepare("SELECT * FROM identidad_pausas WHERE ml_key='MLA6|'").get();
      expect(shadow.estado).toBe('shadow');
      const r = await request(app(admin)).post(`${BASE}/pausas/${shadow.id}/confirmar-impacto`).send({ operation_id: 'c-6' });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, code: 'INVALID_STATE' });
      expect(porId(db, shadow.id).estado).toBe('shadow');
    });

    it('nueva pausa con operation_id nuevo: la vieja queda reemplazada (no reactivada), hermanas actuales en la respuesta', async () => {
      const vieja = await pausaBloqueada();
      cache(db, 'MLA5|12'); // una hermana más, aparecida después del bloqueo
      const r = await request(app(admin)).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-1' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ ok: true, reemplaza: vieja.id, hermanas: 2 });
      expect(r.body.hermanas_activas.map((h) => h.clave)).toEqual(['MLA5|11', 'MLA5|12']);
      expect(r.body.pausa).toMatchObject({ ml_key: 'MLA5|10', operation_id: 'c-1', estado: 'pendiente', impacto_hermanas: 2, impacto_confirmado: 1 });
      const cerrada = porId(db, vieja.id);
      expect(cerrada.estado).toBe('cancelada');
      expect(cerrada.ultimo_error).toMatch(/reemplazada/);
      // La vieja no vuelve a la cola: un nuevo intento sobre ella es un estado inválido.
      const otra = await request(app(admin)).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-2' });
      expect(otra.status).toBe(409);
      expect(otra.body.code).toBe('INVALID_STATE');
      expect(porId(db, vieja.id).estado).toBe('cancelada');
      // La nueva se pausa en ML (las hermanas coinciden con lo confirmado).
      const a = adaptador();
      await procesarPausasIdentidad(db, a);
      expect(a.llamadas).toEqual([['pausar', 'MLA5']]);
      expect(porId(db, r.body.pausa.id).estado).toBe('completada');
      expect(porId(db, vieja.id).estado).toBe('cancelada');
    });

    it('idempotente por operation_id: el replay devuelve la misma pausa sin crear otra', async () => {
      const vieja = await pausaBloqueada();
      const primera = await request(app(admin)).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-1' });
      const replay = await request(app(admin)).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-1' });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ ok: true, repetido: true, reemplaza: vieja.id, pausa: { id: primera.body.pausa.id } });
      expect(cuantas(db)).toBe(2);
    });

    it('operation_id ya usado por otra pausa (p. ej. el de la original): 409 OPERATION_ID_REUSED', async () => {
      const vieja = await pausaBloqueada();
      const r = await request(app(admin)).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: vieja.operation_id });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, code: 'OPERATION_ID_REUSED' });
      expect(cuantas(db)).toBe(1);
      expect(porId(db, vieja.id).estado).toBe('bloqueada_impacto');
    });
  });

  describe('Ejecución expone las hermanas activas de una pausa', () => {
    it('GET /ejecucion: pausa bloqueada trae n_hermanas_activas y hermanas_activas actuales', async () => {
      const vieja = await pausaBloqueada();
      cache(db, 'MLA5|12', 'paused'); // pausada: no cuenta como hermana activa
      const r = await request(app(operador)).get(`${BASE}/ejecucion`);
      expect(r.status).toBe(200);
      const p = r.body.data.pausas.find((x) => x.id === vieja.id);
      expect(p).toMatchObject({ estado: 'bloqueada_impacto', n_hermanas_activas: 1 });
      expect(p.hermanas_activas).toEqual([{ clave: 'MLA5|11', titulo: 'Pub MLA5|11', status: 'active' }]);
    });
  });
});
