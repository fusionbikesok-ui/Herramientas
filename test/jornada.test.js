import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { ensureTablesJornada } from '../routes/jornada.js';

const TEST_DB = 'test/jornada.test.sqlite';

describe('ensureTablesJornada', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('crea las 4 tablas y es idempotente al llamarse dos veces', () => {
    ensureTablesJornada(db);
    ensureTablesJornada(db); // no debe tirar error
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tablas).toEqual(expect.arrayContaining([
      'operational_days', 'pick_waves', 'pick_wave_items', 'pick_wave_claims',
    ]));
  });

  it('operational_days rechaza fecha duplicada (UNIQUE)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts);
    expect(() => db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts)).toThrow();
  });

  it('pick_waves rechaza una segunda mini-ola abierta en el mismo día (índice único parcial)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    const dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts);
    expect(() => db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts)).toThrow();
  });

  it('pick_wave_items rechaza que el mismo pedido esté en dos olas (índice único sobre pedido_clave)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    const dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    const waveId = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(waveId, 'ml:1', ts);
    expect(() => db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(waveId, 'ml:1', ts)).toThrow();
  });
});
