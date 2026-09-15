import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApi } from '../src/api/app.ts';
import { crearLogger } from '../src/comun/logger.ts';
import { registrarLatido } from '../src/comun/latido.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('API E1', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>; let dir: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); dir = await mkdtemp(join(tmpdir(), 'plataforma-api-'));
    await writeFile(join(dir, 'estado-pg-archivo.json'), JSON.stringify({ medido: new Date().toISOString(), ok: true, mas_viejo_s: 0 }));
    await registrarLatido(pool, 'worker', 'w1', 'test'); await registrarLatido(pool, 'scheduler', 's1', 'test');
  });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); await rm(dir, { recursive: true, force: true }); });
  const api = (capabilities: readonly string[] = []) => crearApi({ pool, logger: crearLogger('test'), estadoPgDir: dir, sesion: async () => capabilities.length ? { userId: 'u', capabilities } : null });

  it('E1-API-01 health refleja los cuatro componentes y correlación', async () => {
    const app = api(); const id = randomUUID();
    const r = await app.inject({ method: 'GET', url: '/api/v2/health', headers: { 'x-correlation-id': id } });
    expect(r.statusCode).toBe(200); expect(r.headers['x-correlation-id']).toBe(id);
    expect(r.json()).toMatchObject({ status: 'ok', components: { database: { status: 'ok' }, worker: { status: 'ok' }, scheduler: { status: 'ok' }, wal_archive: { status: 'ok' } } });
    await app.close();
  });

  it('E1-CAP-01 incidents exige sesión y capacidad; valida parámetros', async () => {
    let app = api(); expect((await app.inject('/api/v2/incidents')).statusCode).toBe(401); await app.close();
    app = api(['catalog.read']); expect((await app.inject('/api/v2/incidents')).statusCode).toBe(403); await app.close();
    app = api(['operations.read']);
    expect((await app.inject('/api/v2/incidents?limit=101')).statusCode).toBe(422);
    const r = await app.inject('/api/v2/incidents?limit=10');
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ items: [], next_cursor: null }); await app.close();
  });

  it('health queda 503 si falta un servicio', async () => {
    await admin.query("delete from core.service_heartbeats where servicio='worker'");
    const app = api(); const r = await app.inject('/api/v2/health');
    expect(r.statusCode).toBe(503); expect(r.json().components.worker.status).toBe('down'); await app.close();
    await registrarLatido(pool, 'worker', 'w1', 'test');
  });
});
