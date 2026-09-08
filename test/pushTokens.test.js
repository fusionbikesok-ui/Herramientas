import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { revocarPorRespuesta } from '../lib/pushTokens.js';

const DB = './test/tmp-push-tokens.sqlite';

describe('lib/pushTokens', () => {
  let db;

  const seedUser = (id = 1) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, 0, 1, ?, ?)
    `).run(id, `tester-${id}`, 'hash', now, now);
  };

  const sembrar = (token) => {
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
      VALUES (1, ?, 'ios', ?, ?)`).run(token, ts, ts);
  };
  const revocado = (token) =>
    db.prepare('SELECT revocado_en FROM device_tokens WHERE token = ?').get(token)?.revocado_en;

  beforeEach(() => {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);
    db = openDb(DB);
    seedUser(1);
  });
  afterEach(() => {
    db?.close();
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.unlinkSync(DB + s);
  });

  // Si no se revoca, la tabla se llena de muertos y cada envio desperdicia una request.
  it('revoca ante 410 Unregistered', () => {
    sembrar('tok-410');
    expect(revocarPorRespuesta(db, 'tok-410', { status: 410, reason: 'Unregistered' })).toBe(true);
    expect(revocado('tok-410')).toBeTruthy();
  });

  it('revoca ante 400 BadDeviceToken', () => {
    sembrar('tok-400');
    expect(revocarPorRespuesta(db, 'tok-400', { status: 400, reason: 'BadDeviceToken' })).toBe(true);
    expect(revocado('tok-400')).toBeTruthy();
  });

  // 429 y 5xx son problemas de Apple, no del token: revocarlos perderia dispositivos sanos.
  it('NO revoca ante 429 ni 503', () => {
    sembrar('tok-429');
    expect(revocarPorRespuesta(db, 'tok-429', { status: 429, reason: 'TooManyRequests' })).toBe(false);
    expect(revocado('tok-429')).toBeNull();
  });

  it('NO revoca ante un envio exitoso', () => {
    sembrar('tok-ok');
    expect(revocarPorRespuesta(db, 'tok-ok', { ok: true, status: 200 })).toBe(false);
    expect(revocado('tok-ok')).toBeNull();
  });

  it('no rompe si el token ya no esta en la base', () => {
    expect(revocarPorRespuesta(db, 'inexistente', { status: 410, reason: 'Unregistered' })).toBe(false);
  });
});
