import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { evaluarBackupNube, revisarBackupNube, evaluarPostgres, revisarBackupPostgres } from '../lib/vigiaBackup.js';

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

  it('avisa por capacidad del bucket y resuelve el aviso al bajar, sin mezclarlo con el backup vencido', () => {
    const capacidad = () => activos(db).filter(i => i.tipo_error === 'capacidad_bucket');
    escribirEstado({ ultimo_ok: '2026-09-13T06:00:00Z', bucket_bytes: 8.5e9 });
    const r = revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA });
    expect(r).toMatchObject({ ok: true, bucketBytes: 8.5e9 });
    expect(capacidad()).toHaveLength(1);
    expect(capacidad()[0]).toMatchObject({ severidad: 'advertencia' });
    expect(capacidad()[0].mensaje_humano).toContain('8.5 GB');
    expect(activos(db).filter(i => i.tipo_error === 'backup_vencido')).toHaveLength(0);

    escribirEstado({ ultimo_ok: '2026-09-13T06:00:00Z', bucket_bytes: 2e9 });
    revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA });
    expect(capacidad()).toHaveLength(0);
  });

  it('sin dato de tamaño (bucket_bytes null o ausente) no abre ni resuelve el aviso de capacidad', () => {
    escribirEstado({ ultimo_ok: '2026-09-13T06:00:00Z', bucket_bytes: 9e9 });
    revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA });
    escribirEstado({ ultimo_ok: '2026-09-13T06:00:00Z', bucket_bytes: null });
    expect(revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA }).bucketBytes).toBeNull();
    expect(activos(db).filter(i => i.tipo_error === 'capacidad_bucket')).toHaveLength(1);
  });

  it('nunca lanza aunque la base falle', () => {
    escribirEstado({ ultimo_ok: '2026-09-01T00:00:00Z' });
    db.close();
    expect(() => revisarBackupNube(db, { estadoPath: ESTADO, ahora: AHORA })).not.toThrow();
    db = openDb(TEST_DB);
  });
});

describe('lib/vigiaBackup — PostgreSQL (E0 nivel 1)', () => {
  let db;
  const DIR = './test/tmp-vigia-pg';
  const opciones = (extra = {}) => ({ desplegadoPath: DIR, estadoPath: `${DIR}/estado-pg.json`, archivoPath: `${DIR}/archivo.json`, ahora: AHORA, ...extra });
  const escribir = (nombre, obj) => fs.writeFileSync(`${DIR}/${nombre}`, JSON.stringify(obj));
  const pg = () => db.prepare("SELECT tipo_error, severidad FROM incidentes_operativos WHERE integracion='backup' AND proceso='postgres' AND estado='activo' ORDER BY tipo_error").all();
  const archivoSano = { medido: '2026-09-13T11:58:00Z', ok: true, pendientes: 0, mas_viejo_s: 0, spool_bytes: 1000 };

  beforeEach(() => { db = openDb(TEST_DB); fs.mkdirSync(DIR, { recursive: true }); });
  afterEach(() => {
    db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('no hace nada mientras PostgreSQL no está desplegado', () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    expect(revisarBackupPostgres(db, opciones())).toMatchObject({ desplegado: false });
    expect(pg()).toHaveLength(0);
  });

  it('sano: backup de hace 6 h y archivado al día', () => {
    escribir('estado-pg.json', { ultimo_ok: '2026-09-13T06:00:00Z', ok: true });
    escribir('archivo.json', archivoSano);
    const r = revisarBackupPostgres(db, opciones());
    expect(r.problemas).toEqual([]);
    expect(pg()).toHaveLength(0);
  });

  it('WAL sin archivar hace más de 5 min es crítico; entre 3 y 5 min es aviso; se resuelve al volver', () => {
    escribir('estado-pg.json', { ultimo_ok: '2026-09-13T06:00:00Z', ok: true });
    escribir('archivo.json', { ...archivoSano, pendientes: 3, mas_viejo_s: 420 });
    revisarBackupPostgres(db, opciones());
    expect(pg()).toEqual([{ tipo_error: 'archivo_wal', severidad: 'critico' }]);
    escribir('archivo.json', archivoSano);
    revisarBackupPostgres(db, opciones());
    expect(pg()).toHaveLength(0);
    escribir('archivo.json', { ...archivoSano, pendientes: 1, mas_viejo_s: 200 });
    revisarBackupPostgres(db, opciones());
    expect(pg()).toEqual([{ tipo_error: 'archivo_wal', severidad: 'advertencia' }]);
  });

  it('medición vieja, ilegible o ausente es crítica: sin medición no hay RPO', () => {
    escribir('estado-pg.json', { ultimo_ok: '2026-09-13T06:00:00Z', ok: true });
    escribir('archivo.json', { ...archivoSano, medido: '2026-09-13T11:30:00Z' });
    expect(evaluarPostgres(opciones()).problemas).toEqual([expect.objectContaining({ tipo: 'archivo_wal', severidad: 'critico' })]);
    fs.rmSync(`${DIR}/archivo.json`);
    expect(evaluarPostgres(opciones()).problemas).toEqual([expect.objectContaining({ tipo: 'archivo_wal', severidad: 'critico' })]);
  });

  it('backup vencido o nunca hecho es crítico, y spool por encima del 70 % avisa', () => {
    escribir('archivo.json', { ...archivoSano, spool_bytes: 4 * 1024 ** 3 });
    escribir('estado-pg.json', { ultimo_ok: '', ok: false, detalle: 'backup diff falló' });
    const r = evaluarPostgres(opciones());
    expect(r.problemas.map(p => [p.tipo, p.severidad]).sort()).toEqual([['backup_vencido', 'critico'], ['spool_wal', 'advertencia']]);
    escribir('estado-pg.json', { ultimo_ok: '2026-09-12T08:00:00Z', ok: true });
    expect(evaluarPostgres(opciones()).problemas.find(p => p.tipo === 'backup_vencido').mensajeHumano).toContain('hace 28 h');
  });
});
