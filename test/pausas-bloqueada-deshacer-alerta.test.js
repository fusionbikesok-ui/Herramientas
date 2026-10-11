import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { catalogoVinculosRouter } from '../routes/catalogoVinculos.js';
import { solicitarNoSincronizarPausa, procesarPausasIdentidad } from '../lib/pausasIdentidad.js';
import { marcarNoSincronizar, deshacerNoSincronizar } from '../lib/noSincronizar.js';

const FILE = './test/tmp-pausas-bloqueada-deshacer-alerta.sqlite';
const BASE = '/api/catalogo-vinculos';
const now = () => new Date().toISOString();
const ALERTA = { integracion: 'mercadolibre', proceso: 'identidad_pausa', tipoError: 'pausa_bloqueada_impacto' };

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
  return {
    async pausarItem() { return { ok: true }; },
    async estadoItem(item) { return { item_id: item, status: 'paused', observed_at: now() }; } };
}
const admin = { username: 'jose', is_admin: true, permisos: [] };
const alertasAbiertas = (db) => db.prepare("SELECT estado FROM incidentes_operativos WHERE clave_dedupe=?")
  .all(`${ALERTA.integracion}|${ALERTA.proceso}|${ALERTA.tipoError}`).map((r) => r.estado);

describe('pausa bloqueada_impacto: deshacer, re-marca, confirmación vigente y alerta', () => {
  let db;
  let app;
  beforeEach(() => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    db = openDb(FILE);
    app = () => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => { req.user = admin; next(); });
      a.use(BASE, catalogoVinculosRouter(db));
      return a;
    };
  });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  // Pausa real llevada a bloqueada_impacto por el worker: se pide sin hermanas, aparece una hermana, el worker la frena.
  async function pausaBloqueada(clave = 'MLA5|10') {
    config(db, 'enforced', 1);
    cache(db, clave);
    expect(solicitarNoSincronizarPausa(db, { clave, ...base, operation_id: `p-${clave}`, esAdmin: true }).ok).toBe(true);
    cache(db, `${clave.split('|')[0]}|11`); // hermana del mismo ítem, aparecida después de pedir la pausa
    await procesarPausasIdentidad(db, adaptador());
    const vieja = db.prepare('SELECT * FROM identidad_pausas WHERE ml_key=? ORDER BY id DESC').get(clave);
    expect(vieja.estado).toBe('bloqueada_impacto');
    return vieja;
  }

  describe('Ítem 1: deshacer la marca cancela la pausa bloqueada', () => {
    it('deshacer con pausa bloqueada_impacto la deja cancelada (no queda esperando confirmación)', async () => {
      const vieja = await pausaBloqueada();
      const r = deshacerNoSincronizar(db, { clave: 'MLA5|10', motivo: 'error', actor: 'jose', esAdmin: true });
      expect(r).toMatchObject({ ok: true });
      const p = porId(db, vieja.id);
      expect(p.estado).toBe('cancelada');
      expect(p.ultimo_error).toBe('deshecha por una persona');
    });

    it('re-marcar (b) y confirmar la pausa vieja: 409 INVALID_STATE, no crea pausa nueva', async () => {
      const vieja = await pausaBloqueada();
      deshacerNoSincronizar(db, { clave: 'MLA5|10', motivo: 'error', actor: 'jose', esAdmin: true });
      // Se vuelve a marcar: pausa nueva con su propia operación. La vieja no debe revivir con esa confirmación.
      expect(solicitarNoSincronizarPausa(db, { clave: 'MLA5|10', ...base, operation_id: 'p-nueva', esAdmin: true, confirm_sibling_impact: true }).ok).toBe(true);
      const antes = cuantas(db);
      const r = await request(app()).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-vieja' });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, code: 'INVALID_STATE' });
      expect(cuantas(db)).toBe(antes);
      expect(porId(db, vieja.id).estado).toBe('cancelada');
    });

    it('marca reemplazada por otra variante (a) sin deshacer: la pausa bloqueada no se confirma (409 INVALID_STATE)', async () => {
      const vieja = await pausaBloqueada();
      expect(marcarNoSincronizar(db, { clave: 'MLA5|10', variante: 'a', motivo: 'otra cosa', actor: 'jose', expectedSku: null, expectedSkuProvided: true, esAdmin: true }).ok).toBe(true);
      const antes = cuantas(db);
      const r = await request(app()).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-a' });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ ok: false, code: 'INVALID_STATE' });
      expect(cuantas(db)).toBe(antes);
      expect(porId(db, vieja.id).estado).toBe('bloqueada_impacto');
    });

    it('con la marca (b) vigente, confirmar sigue 201 y crea la pausa nueva', async () => {
      const vieja = await pausaBloqueada();
      const r = await request(app()).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-ok' });
      expect(r.status).toBe(201);
      expect(r.body.pausa).toMatchObject({ ml_key: 'MLA5|10', estado: 'pendiente' });
    });
  });

  describe('Ítem 2: alerta al bloquear por impacto, cierre al confirmar o cancelar', () => {
    it('el worker abre la alerta pausa_bloqueada_impacto al bloquear', async () => {
      await pausaBloqueada();
      expect(alertasAbiertas(db)).toEqual(['activo']);
      const inc = db.prepare('SELECT severidad,mensaje_humano FROM incidentes_operativos WHERE clave_dedupe=?')
        .get(`${ALERTA.integracion}|${ALERTA.proceso}|${ALERTA.tipoError}`);
      expect(inc.severidad).toBe('advertencia');
      expect(inc.mensaje_humano).toMatch(/MLA5\|10/);
    });

    it('deshacer la marca cierra la alerta', async () => {
      await pausaBloqueada();
      deshacerNoSincronizar(db, { clave: 'MLA5|10', motivo: 'error', actor: 'jose', esAdmin: true });
      expect(alertasAbiertas(db)).toEqual(['resuelto']);
    });

    it('confirmar el impacto cierra la alerta', async () => {
      const vieja = await pausaBloqueada();
      const r = await request(app()).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-ok' });
      expect(r.status).toBe(201);
      expect(alertasAbiertas(db)).toEqual(['resuelto']);
    });

    it('con dos pausas bloqueadas, cerrar una no cierra la alerta mientras quede la otra', async () => {
      const vieja = await pausaBloqueada('MLA5|10');
      await pausaBloqueada('MLA7|20');
      deshacerNoSincronizar(db, { clave: 'MLA5|10', motivo: 'error', actor: 'jose', esAdmin: true });
      expect(porId(db, vieja.id).estado).toBe('cancelada');
      expect(alertasAbiertas(db)).toEqual(['activo']);
    });
  });
});
