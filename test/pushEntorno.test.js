// test/pushEntorno.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';

const DB = './test/tmp-push-entorno.sqlite';

describe('device_tokens.entorno', () => {
  let db;
  beforeEach(() => {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);
    db = openDb(DB);
  });
  afterEach(() => {
    db?.close();
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);
  });

  it('existe la columna entorno', () => {
    const columnas = db.prepare('PRAGMA table_info(device_tokens)').all().map((c) => c.name);
    expect(columnas).toContain('entorno');
  });

  // Los tokens que ya están guardados vienen de builds de TestFlight: producción es el
  // default correcto, y adivinar sandbox los dejaría sin entrega.
  it('el default es production', () => {
    const ts = new Date().toISOString();
    // device_tokens.user_id referencia users(id) con FK activa; sin esta fila la insercion
    // de abajo falla con FOREIGN KEY constraint failed antes de llegar a comprobar el default.
    db.prepare(`INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (1, 'tester', 'hash', 0, 1, ?, ?)`).run(ts, ts);
    db.prepare(`INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
      VALUES (1, 'tok-abc', 'ios', ?, ?)`).run(ts, ts);
    const fila = db.prepare("SELECT entorno FROM device_tokens WHERE token = 'tok-abc'").get();
    expect(fila.entorno).toBe('production');
  });

  it('la migración es idempotente: abrir dos veces no rompe', () => {
    db.close();
    db = openDb(DB);
    const columnas = db.prepare('PRAGMA table_info(device_tokens)').all().map((c) => c.name);
    expect(columnas).toContain('entorno');
  });
});
