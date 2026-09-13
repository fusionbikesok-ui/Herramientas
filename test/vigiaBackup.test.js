import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { evaluarBackupNube, revisarBackupNube } from '../lib/vigiaBackup.js';

const TEST_DB = './test/tmp-vigia-backup.sqlite';
const ESTADO = './test/tmp-vigia-backup-estado.json';
const AHORA = Date.parse('2026-09-13T12:00:00Z');

function escribirEstado(obj) { fs.writeFileSync(ESTADO, typeof obj === 'string' ? obj : JSON.stringify(obj)); }
const activos = db => db.prepare("SELECT * FROM incidentes_operativos WHERE integracion='backup' AND estado='activo'").all();

describe('lib/vigiaBackup', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`, ESTADO]) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  it('un backup de hace 6 h está sano', () => {
    escribirEstado({ ultimo_ok: '2026-09-13T06:00:00Z', nube_ok: true });
    expect(evaluarBackupNube({ estadoPath: ESTADO, ahora: AHORA })).toMatchObject({ ok: true, horas: 6 });
  });

  it('un backup de más de 26 h está vencido aunque la última corrida diga ok', () => {
    escribirEstado({ ultimo_ok: '2026-09-12T09:00:00Z', nube_ok: true });
    expect(evaluarBackupNube({ estadoPath: ESTADO, ahora: AHORA })).toMatchObject({ ok: false, motivo: 'vencido', horas: 27 });
  });

  it('distingue archivo faltante, ilegible y sin ningún éxito', () => {
    expect(evaluarBackupNube({ estadoPath: ESTADO, ahora: AHORA }).motivo).toBe('sin_estado');
    escribirEstado('{roto');
    expect(evaluarBackupNube({ estadoPath: ESTADO, ahora: AHORA }).motivo).toBe('estado_ilegible');
    escribirEstado({ ultimo_ok: '', nube_ok: false, detalle: 'faltan B2_KEY_ID' });
    expect(evaluarBackupNube({ estadoPath: ESTADO, ahora: AHORA })).toMatchObject({ motivo: 'nunca_ok', detalle: 'faltan B2_KEY_ID' });
  });

  it('abre un incidente crítico deduplicado y lo resuelve cuando vuelve el backup', () => {
    escribirEstado({ ultimo_ok: '2026-09-11T06:00:00Z' });
    revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA });
    revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA });
    const abiertos = activos(db);
    expect(abiertos).toHaveLength(1);
    expect(abiertos[0]).toMatchObject({ severidad: 'critico', contador_repeticiones: 2 });
    expect(abiertos[0].mensaje_humano).toContain('hace 54 h');

    escribirEstado({ ultimo_ok: '2026-09-13T06:00:00Z' });
    expect(revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA }).ok).toBe(true);
    expect(activos(db)).toHaveLength(0);
  });

  it('nunca lanza aunque la base falle', () => {
    escribirEstado({ ultimo_ok: '2026-09-01T00:00:00Z' });
    db.close();
    expect(() => revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA })).not.toThrow();
    db = openDb(TEST_DB);
  });
});
