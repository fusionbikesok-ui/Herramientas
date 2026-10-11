import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { catalogoVinculosRouter } from '../routes/catalogoVinculos.js';
import { solicitarNoSincronizarPausa, procesarPausasIdentidad } from '../lib/pausasIdentidad.js';
import { marcarNoSincronizar, marcarLinkDePago } from '../lib/noSincronizar.js';

const FILE = './test/tmp-no-sincronizar-reemplaza-pausa.sqlite';
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
const base = { motivo: 'Publicación duplicada', actor: 'ana', expectedSku: null };
function adaptador() {
  return {
    async pausarItem() { return { ok: true }; },
    async estadoItem(item) { return { item_id: item, status: 'paused', observed_at: now() }; } };
}
const admin = { username: 'jose', is_admin: true, permisos: [] };
const alertasAbiertas = (db) => db.prepare("SELECT estado FROM incidentes_operativos WHERE clave_dedupe=?")
  .all(`${ALERTA.integracion}|${ALERTA.proceso}|${ALERTA.tipoError}`).map((r) => r.estado);
const historialPausa = (db, id) => db.prepare("SELECT evento,detalle_json FROM identidad_historial WHERE entidad_tipo='pausa' AND entidad_id=? ORDER BY id").all(id);

describe('marcar otra variante cancela la pausa bloqueada_impacto de la clave', () => {
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

  // Pausa (b) llevada a bloqueada_impacto por el worker: se pide sin hermanas, aparece una hermana, el worker la frena.
  async function pausaBloqueada(clave = 'MLA5|10') {
    config(db, 'enforced', 1);
    cache(db, clave);
    expect(solicitarNoSincronizarPausa(db, { clave, ...base, variante: 'b', operation_id: `p-${clave}`, esAdmin: true }).ok).toBe(true);
    cache(db, `${clave.split('|')[0]}|11`); // hermana del mismo ítem, aparecida después de pedir la pausa
    await procesarPausasIdentidad(db, adaptador());
    const vieja = db.prepare('SELECT * FROM identidad_pausas WHERE ml_key=? ORDER BY id DESC').get(clave);
    expect(vieja.estado).toBe('bloqueada_impacto');
    return vieja;
  }

  it('marcar (a) cancela la pausa bloqueada con el texto de reemplazo, cierra la alerta y deja historial', async () => {
    const vieja = await pausaBloqueada();
    expect(alertasAbiertas(db)).toEqual(['activo']);
    const r = marcarNoSincronizar(db, { clave: 'MLA5|10', variante: 'a', motivo: 'otra cosa', actor: 'jose', expectedSku: null, expectedSkuProvided: true, esAdmin: true });
    expect(r.ok).toBe(true);
    const p = porId(db, vieja.id);
    expect(p.estado).toBe('cancelada');
    expect(p.ultimo_error).toBe('reemplazada por otra marca');
    expect(p.claim_hasta).toBeNull();
    const h = historialPausa(db, vieja.id);
    expect(h.map((x) => x.evento)).toContain('cancelada');
    expect(JSON.parse(h.find((x) => x.evento === 'cancelada').detalle_json)).toMatchObject({ clave: 'MLA5|10', variante_nueva: 'no_sincronizar_a' });
    expect(alertasAbiertas(db)).toEqual(['resuelto']);
  });

  it('confirmar-impacto después de reemplazar la marca da 409 INVALID_STATE y no crea pausa', async () => {
    const vieja = await pausaBloqueada();
    marcarNoSincronizar(db, { clave: 'MLA5|10', variante: 'c', motivo: 'duplicada', actor: 'jose', expectedSku: null, expectedSkuProvided: true, esAdmin: true });
    const antes = cuantas(db);
    const r = await request(app()).post(`${BASE}/pausas/${vieja.id}/confirmar-impacto`).send({ operation_id: 'c-tras-c' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(cuantas(db)).toBe(antes);
    expect(porId(db, vieja.id).estado).toBe('cancelada');
  });

  it('marcar link de pago (admin) también reemplaza la marca y cancela la pausa', async () => {
    const vieja = await pausaBloqueada();
    expect(marcarLinkDePago(db, { clave: 'MLA5|10', motivo: 'cobro', actor: 'jose', esAdmin: true, expectedSku: null, expectedSkuProvided: true }).ok).toBe(true);
    expect(porId(db, vieja.id)).toMatchObject({ estado: 'cancelada', ultimo_error: 'reemplazada por otra marca' });
  });

  it('con dos pausas bloqueadas, reemplazar la marca de una no cierra la alerta mientras quede la otra', async () => {
    const vieja = await pausaBloqueada('MLA5|10');
    await pausaBloqueada('MLA7|20');
    marcarNoSincronizar(db, { clave: 'MLA5|10', variante: 'a', motivo: 'otra', actor: 'jose', expectedSku: null, expectedSkuProvided: true, esAdmin: true });
    expect(porId(db, vieja.id).estado).toBe('cancelada');
    expect(alertasAbiertas(db)).toEqual(['activo']);
  });

  it('marcar la MISMA variante (b) de nuevo no cancela la pausa bloqueada', async () => {
    const vieja = await pausaBloqueada();
    const r = solicitarNoSincronizarPausa(db, { clave: 'MLA5|10', ...base, variante: 'b', operation_id: 'p-otra-vez', esAdmin: true, confirm_sibling_impact: true });
    expect(r.ok).toBe(true);
    expect(porId(db, vieja.id)).toMatchObject({ estado: 'bloqueada_impacto', ultimo_error: expect.stringMatching(/el impacto cambió/) });
    expect(alertasAbiertas(db)).toEqual(['activo']);
  });

  it('una pausa de otra clave bloqueada no se toca al marcar esta clave', async () => {
    const otra = await pausaBloqueada('MLA7|20');
    await pausaBloqueada('MLA5|10');
    marcarNoSincronizar(db, { clave: 'MLA5|10', variante: 'a', motivo: 'otra', actor: 'jose', expectedSku: null, expectedSkuProvided: true, esAdmin: true });
    expect(porId(db, otra.id).estado).toBe('bloqueada_impacto');
  });
});
