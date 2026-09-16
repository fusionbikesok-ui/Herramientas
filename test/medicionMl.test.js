import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { medirLlamadaMl, resumenMedicionMl, volcarMedicionMl } from '../lib/medicionMl.js';

const TEST_DB = './test/tmp-medicion-ml.sqlite';
let db;
const t0 = Date.parse('2026-09-16T12:00:10.000Z');

describe('medición durable de llamadas a ML (techo shadow E1 T3)', () => {
  beforeEach(() => {
    if (db) db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
  });
  afterAll(() => { db?.close(); for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true }); });

  it('acumula por minuto y recurso y escribe el minuto cerrado al cambiar de minuto', () => {
    medirLlamadaMl(db, 'lectura', { status: 200 }, t0);
    medirLlamadaMl(db, 'lectura', { status: 429 }, t0 + 1000);
    medirLlamadaMl(db, 'lectura', { sintetica: true }, t0 + 2000);
    medirLlamadaMl(db, 'escritura', { status: 200 }, t0 + 3000);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_llamadas_minuto').get().n).toBe(0);
    medirLlamadaMl(db, 'lectura', { status: 200 }, t0 + 60_000);
    expect(db.prepare('SELECT minuto, recurso, reales, status_429, sinteticas FROM ml_llamadas_minuto ORDER BY recurso').all()).toEqual([
      { minuto: '2026-09-16T12:00Z', recurso: 'escritura', reales: 1, status_429: 0, sinteticas: 0 },
      { minuto: '2026-09-16T12:00Z', recurso: 'lectura', reales: 2, status_429: 1, sinteticas: 1 },
    ]);
    volcarMedicionMl(db, t0 + 60_000);
    expect(db.prepare("SELECT reales FROM ml_llamadas_minuto WHERE minuto='2026-09-16T12:01Z'").get().reales).toBe(1);
  });

  it('resume percentiles contando los minutos sin llamadas como cero', () => {
    for (let m = 0; m < 10; m++) for (let i = 0; i < (m === 9 ? 50 : 2); i++) medirLlamadaMl(db, 'lectura', { status: 200 }, t0 + m * 60_000);
    volcarMedicionMl(db, t0 + 10 * 60_000);
    const r = resumenMedicionMl(db, { dias: 1, ahoraMs: t0 + 10 * 60_000 });
    expect(r.minutos_con_datos).toBe(10);
    expect(r.recursos.lectura).toMatchObject({ p50: 0, max: 50 });
  });

  it('nunca rompe la llamada: base cerrada o inválida es fail-open', () => {
    db.close();
    expect(() => medirLlamadaMl(db, 'lectura', { status: 200 }, t0 + 120_000)).not.toThrow();
    expect(() => medirLlamadaMl({ prepare() { throw new Error('x'); }, open: true, transaction: (f) => f }, 'lectura', {}, t0 + 240_000)).not.toThrow();
    db = openDb(TEST_DB);
  });
});
