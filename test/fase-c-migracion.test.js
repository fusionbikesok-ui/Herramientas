import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/index.js';

const FILE = './test/tmp-fase-c-migracion.sqlite';
const SQL = fs.readFileSync(path.join(import.meta.dirname, '..', 'migrations', '120_fase_c_identidad.sql'), 'utf8');
const TS = '2026-10-07T12:00:00.000Z';

describe('migración 120: Fase C', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => { try { db.close(); } catch { /* ya cerrada */ } for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`); });

  const guardia = (clave, estado = 'abierto', bloquea = 1) => db.prepare(`INSERT INTO guardia_ml_casos
    (clave,estado,motivo,bloquea_sync,creado_en,actualizado_en) VALUES (?,?,'sin_cobertura',?,?,?)`).run(clave, estado, bloquea, TS, TS);
  const decision = (clave, sku, accion) => db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,?,?)").run(clave, sku, accion, TS);

  it('queda registrada en _schema_migrations al abrir la base', () => {
    expect(db.prepare("SELECT 1 FROM _schema_migrations WHERE key='fase_c_identidad_120'").get()).toBeTruthy();
  });

  it('crea el índice (ml_key, estado) de identidad_casos', () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='identidad_casos'").all().map((r) => r.name);
    expect(idx).toContain('idx_identidad_casos_clave_estado');
  });

  it('cierra los casos de Guardia de claves en omitir (links de pago) con evento omitida_link_pago, y solo esos', () => {
    guardia('LP1|'); guardia('LP2|'); guardia('VINC|'); guardia('SIN|'); guardia('LPOK|', 'resuelto', 0);
    decision('LP1|', null, 'omitir'); decision('LP2|', null, 'omitir'); decision('LPOK|', null, 'omitir'); decision('VINC|', 'FB-1', 'confirmar');
    db.exec(SQL);
    const est = Object.fromEntries(db.prepare('SELECT clave, estado, bloquea_sync b FROM guardia_ml_casos').all().map((r) => [r.clave, [r.estado, r.b]]));
    expect(est).toEqual({ 'LP1|': ['resuelto', 0], 'LP2|': ['resuelto', 0], 'VINC|': ['abierto', 1], 'SIN|': ['abierto', 1], 'LPOK|': ['resuelto', 0] });
    const ev = db.prepare("SELECT c.clave, e.evento, e.actor, e.detalle_json FROM guardia_ml_eventos e JOIN guardia_ml_casos c ON c.id=e.caso_id").all();
    expect(ev.map((e) => e.clave).sort()).toEqual(['LP1|', 'LP2|']);
    expect(ev.every((e) => e.evento === 'cerrado_omitida_link_pago' && JSON.parse(e.detalle_json).motivo === 'omitida_link_pago')).toBe(true);
    expect(db.prepare("SELECT resuelto_en FROM guardia_ml_casos WHERE clave='LP1|'").get().resuelto_en).toBeTruthy();
  });

  it('es idempotente: correrla de nuevo no duplica eventos ni falla', () => {
    guardia('LP1|'); decision('LP1|', null, 'omitir');
    db.exec(SQL); db.exec(SQL);
    expect(db.prepare('SELECT COUNT(*) n FROM guardia_ml_eventos').get().n).toBe(1);
  });

  it('se aplica sola al abrir una base que todavía no la tenía (el despliegue)', () => {
    guardia('LP1|'); decision('LP1|', null, 'omitir');
    db.prepare("DELETE FROM _schema_migrations WHERE key='fase_c_identidad_120'").run();
    db.close();
    db = openDb(FILE);
    expect(db.prepare("SELECT estado FROM guardia_ml_casos WHERE clave='LP1|'").get().estado).toBe('resuelto');
  });
});
