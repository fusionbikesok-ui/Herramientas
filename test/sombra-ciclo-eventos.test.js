import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';

// E1 T3 C1: el ciclo de vida de la copia de sombra vive en integration_events, no en una tabla nueva.
const TEST_DB = './test/tmp-sombra-ciclo.sqlite';
const COLUMNAS = ['shadow_status', 'shadow_reason', 'ack_at', 'enqueue_at', 'completed_at', 'boot_id', 'attempt_id', 'shadow_imported_at'];

describe('migración 104 — ciclo de sombra sobre integration_events', () => {
  let db;
  beforeAll(() => {
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
  });
  afterAll(() => {
    db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });

  it('agrega las ocho columnas del ciclo, nulables y sin default', () => {
    const cols = db.prepare('PRAGMA table_info(integration_events)').all();
    for (const nombre of COLUMNAS) {
      const col = cols.find((c) => c.name === nombre);
      expect(col, nombre).toBeTruthy();
      // Nulables a propósito: un evento anterior a T3 o un aviso que nunca se copia las deja en NULL.
      expect(col.notnull, nombre).toBe(0);
      expect(col.dflt_value, nombre).toBeNull();
    }
  });

  it('crea los tres índices parciales de la sombra', () => {
    const indices = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='integration_events'").all();
    const porNombre = new Map(indices.map((i) => [i.name, i.sql || '']));
    expect(porNombre.has('idx_integration_events_sombra_activa')).toBe(true);
    expect(porNombre.get('idx_integration_events_sombra_activa')).toMatch(/WHERE shadow_status IN \('pending', 'queued', 'attempting'\)/);
    expect(porNombre.get('idx_integration_events_sombra_purga')).toMatch(/WHERE shadow_status IN \('copied', 'discarded', 'excluded', 'abandoned'\)/);
    expect(porNombre.get('idx_integration_events_sombra_import')).toMatch(/shadow_imported_at IS NULL/);
  });

  it('el recibo existente sigue funcionando y admite el ciclo de sombra', () => {
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,external_event_id,resource_id,received_at,correlation_id,dedupe_key)
      VALUES ('ev-1','webhook.received','ml','mercadolibre','fp-1','/orders/1','2026-09-16T00:00:00.000Z','corr-1','dk-1')`).run();
    db.prepare("UPDATE integration_events SET shadow_status='queued',ack_at='2026-09-16T00:00:00.100Z',boot_id='boot-1' WHERE event_id='ev-1'").run();
    const fila = db.prepare("SELECT shadow_status, ack_at, boot_id, shadow_reason FROM integration_events WHERE event_id='ev-1'").get();
    expect(fila).toEqual({ shadow_status: 'queued', ack_at: '2026-09-16T00:00:00.100Z', boot_id: 'boot-1', shadow_reason: null });
  });

  it('reabrir la base no reaplica la migración ni duplica columnas', () => {
    const antes = db.prepare("SELECT COUNT(*) n FROM _schema_migrations WHERE key='sombra_ciclo_104'").get().n;
    expect(antes).toBe(1);
    db.close();
    db = openDb(TEST_DB);
    expect(db.prepare("SELECT COUNT(*) n FROM _schema_migrations WHERE key='sombra_ciclo_104'").get().n).toBe(1);
    const cols = db.prepare('PRAGMA table_info(integration_events)').all().map((c) => c.name);
    for (const nombre of COLUMNAS) expect(cols.filter((c) => c === nombre)).toHaveLength(1);
  });
});
