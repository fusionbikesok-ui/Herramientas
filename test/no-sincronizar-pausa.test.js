import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { marcarNoSincronizar, deshacerNoSincronizar } from '../lib/noSincronizar.js';
import { solicitarNoSincronizarPausa, procesarPausasIdentidad, listarPausasIdentidad } from '../lib/pausasIdentidad.js';

const FILE = './test/tmp-no-sincronizar-pausa.sqlite';
const now = () => new Date().toISOString();

function cache(db, clave, status = 'active') {
  const [item, variacion = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`).run(clave, item, variacion, 'Pub', status, null, 1, now());
}
const config = (db, modo, hab, canario = null) =>
  db.prepare('UPDATE identidad_config SET modo=?,escrituras_remotas_habilitadas=?,canario_ml_key=? WHERE id=1').run(modo, hab, canario);
const pausa = (db, clave) => db.prepare('SELECT * FROM identidad_pausas WHERE ml_key=? ORDER BY id DESC').get(clave);
const base = { variante: 'b', motivo: 'Publicación duplicada', actor: 'ana', expectedSku: null };
function adaptador({ estadoTras = 'paused', falla = false } = {}) {
  const llamadas = [];
  return { llamadas,
    async pausarItem(item) { llamadas.push(['pausar', item]); if (falla) throw new Error('ML 500'); return { ok: true }; },
    async estadoItem(item) { llamadas.push(['estado', item]); return { item_id: item, status: estadoTras, observed_at: now() }; } };
}

describe('no sincronizar (b): pausa durable', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('marcarNoSincronizar no acepta la variante b sin la operación de pausa', () => {
    cache(db, 'MLA1|');
    expect(marcarNoSincronizar(db, { clave: 'MLA1|', ...base })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('con hermanas activas exige confirmar el impacto y no persiste nada', () => {
    cache(db, 'MLA2|10'); cache(db, 'MLA2|11'); cache(db, 'MLA2|12', 'paused');
    const r = solicitarNoSincronizarPausa(db, { clave: 'MLA2|10', ...base, operation_id: 'p-2' });
    expect(r).toMatchObject({ ok: false, code: 'SIBLING_IMPACT_CONFIRMATION_REQUIRED', sibling_count: 1 });
    expect(pausa(db, 'MLA2|10')).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM sku_matcher_decisiones').get()).toBeUndefined();
  });

  it('marca (omitir b) y encola la pausa en la misma transacción; en sombra queda shadow', () => {
    cache(db, 'MLA3|');
    const r = solicitarNoSincronizarPausa(db, { clave: 'MLA3|', ...base, operation_id: 'p-3' });
    expect(r.ok).toBe(true);
    expect(db.prepare("SELECT origen FROM sku_matcher_decisiones WHERE clave='MLA3|'").get().origen).toBe('no_sincronizar_b');
    expect(pausa(db, 'MLA3|')).toMatchObject({ estado: 'shadow', item_id: 'MLA3', impacto_hermanas: 0 });
  });

  it('es idempotente por operation_id', () => {
    cache(db, 'MLA4|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA4|', ...base, operation_id: 'p-4' });
    expect(solicitarNoSincronizarPausa(db, { clave: 'MLA4|', ...base, operation_id: 'p-4' })).toMatchObject({ ok: true, repetido: true });
    expect(db.prepare('SELECT COUNT(*) n FROM identidad_pausas').get().n).toBe(1);
  });

  it('el worker no escribe en sombra ni con escrituras deshabilitadas', async () => {
    cache(db, 'MLA5|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA5|', ...base, operation_id: 'p-5' });
    const a = adaptador();
    expect(await procesarPausasIdentidad(db, a)).toMatchObject({ omitido: 'escrituras_remotas_deshabilitadas' });
    expect(a.llamadas).toHaveLength(0);
  });

  it('enforced: pausa, verifica releyendo y completa; actualiza el cache', async () => {
    config(db, 'enforced', 1);
    cache(db, 'MLA6|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA6|', ...base, operation_id: 'p-6' });
    expect(pausa(db, 'MLA6|').estado).toBe('pendiente');
    const a = adaptador();
    await procesarPausasIdentidad(db, a);
    expect(pausa(db, 'MLA6|')).toMatchObject({ estado: 'completada' });
    expect(a.llamadas.map((l) => l[0])).toEqual(['pausar', 'estado']);
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA6|'").get().status).toBe('paused');
    expect(db.prepare("SELECT origen FROM ml_pausas_log WHERE item_id='MLA6'").get().origen).toBe('identidad_no_sincronizar');
  });

  it('si la relectura no muestra la pausa, no la da por hecha: reintenta y al agotar queda fallida', async () => {
    config(db, 'enforced', 1);
    cache(db, 'MLA7|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA7|', ...base, operation_id: 'p-7' });
    const a = adaptador({ estadoTras: 'active' });
    await procesarPausasIdentidad(db, a);
    expect(pausa(db, 'MLA7|')).toMatchObject({ estado: 'pendiente', intentos: 1 });
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA7|'").get().status).toBe('active');
    for (let i = 0; i < 5; i += 1) {
      db.prepare('UPDATE identidad_pausas SET proximo_intento_en=NULL WHERE ml_key=?').run('MLA7|');
      await procesarPausasIdentidad(db, a);
    }
    expect(pausa(db, 'MLA7|').estado).toBe('fallida');
    expect(listarPausasIdentidad(db)[0]).toMatchObject({ riesgo: 'puede_estar_pausada_en_ml' });
    const inc = db.prepare("SELECT severidad,estado FROM incidentes_operativos WHERE proceso='identidad_pausa'").get();
    expect(inc).toMatchObject({ estado: 'activo' });
  });

  it('respeta el canario', async () => {
    config(db, 'enforced', 1, 'MLA9|');
    cache(db, 'MLA8|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA8|', ...base, operation_id: 'p-8' });
    const a = adaptador();
    await procesarPausasIdentidad(db, a);
    expect(a.llamadas).toHaveLength(0);
    expect(pausa(db, 'MLA8|').estado).toBe('pendiente');
  });

  it('deshacer (b): vale con la pausa pendiente o en shadow y la cancela', () => {
    cache(db, 'MLA10|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA10|', ...base, operation_id: 'p-10' });
    expect(deshacerNoSincronizar(db, { clave: 'MLA10|', motivo: 'x', actor: 'beto', esAdmin: false }).ok).toBe(true);
    expect(pausa(db, 'MLA10|').estado).toBe('cancelada');
    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA10|'").get()).toBeUndefined();
  });

  it('deshacer (b) con la pausa ya empezada o hecha da INVALID_STATE', async () => {
    config(db, 'enforced', 1);
    cache(db, 'MLA11|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA11|', ...base, operation_id: 'p-11' });
    await procesarPausasIdentidad(db, adaptador());
    expect(deshacerNoSincronizar(db, { clave: 'MLA11|', motivo: 'x', actor: 'beto', esAdmin: true }))
      .toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA11|'").get()).toBeTruthy();
  });

  it('un operation_id ya usado para otra clave no se repite: 409 OPERATION_ID_REUSED y no crea nada', () => {
    cache(db, 'MLA12|'); cache(db, 'MLA13|');
    expect(solicitarNoSincronizarPausa(db, { clave: 'MLA12|', ...base, operation_id: 'p-12' }).ok).toBe(true);
    expect(solicitarNoSincronizarPausa(db, { clave: 'MLA13|', ...base, operation_id: 'p-12' }))
      .toMatchObject({ ok: false, code: 'OPERATION_ID_REUSED', status: 409 });
    expect(db.prepare('SELECT COUNT(*) n FROM identidad_pausas').get().n).toBe(1);
    expect(db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave='MLA13|'").get()).toBeUndefined();
  });

  it('si aparecen hermanas activas entre la solicitud y la pausa, no pausa: pasa a bloqueada_impacto', async () => {
    config(db, 'enforced', 1);
    cache(db, 'MLA14|');
    solicitarNoSincronizarPausa(db, { clave: 'MLA14|', ...base, operation_id: 'p-14' });
    expect(pausa(db, 'MLA14|').impacto_hermanas).toBe(0);
    cache(db, 'MLA14|2');
    const a = adaptador();
    await procesarPausasIdentidad(db, a);
    expect(a.llamadas.filter(([op]) => op === 'pausar')).toHaveLength(0);
    expect(pausa(db, 'MLA14|')).toMatchObject({ estado: 'bloqueada_impacto', intentos: 0 });
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA14|'").get().status).toBe('active');
  });
});
