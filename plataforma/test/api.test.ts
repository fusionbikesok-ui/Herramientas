import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { ValidateFunction } from 'ajv';
import { crearApi } from '../src/api/app.ts';
import { crearLogger } from '../src/comun/logger.ts';
import { registrarLatido } from '../src/comun/latido.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

const require = createRequire(import.meta.url);
interface CompiladorJsonSchema { compile(schema: object): ValidateFunction }
const Ajv = require('ajv') as new (opciones: object) => CompiladorJsonSchema;
const addFormats = require('ajv-formats') as (ajv: CompiladorJsonSchema) => void;

describe('API E1', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>; let dir: string;
  let validarHealth: ValidateFunction; let validarIncidentes: ValidateFunction; let validarError: ValidateFunction;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); dir = await mkdtemp(join(tmpdir(), 'plataforma-api-'));
    await writeFile(join(dir, 'estado-pg-archivo.json'), JSON.stringify({ medido: new Date().toISOString(), ok: true, mas_viejo_s: 0 }));
    await registrarLatido(pool, 'worker', 'w1', 'test'); await registrarLatido(pool, 'scheduler', 's1', 'test');
    const contrato = await SwaggerParser.dereference(fileURLToPath(new URL('../../openapi/platform-v2.yaml', import.meta.url))) as { components: { schemas: Record<string, object> } };
    const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
    const schemas = contrato.components.schemas;
    if (!schemas.Health || !schemas.IncidentPage || !schemas.Error) throw new Error('faltan esquemas obligatorios en OpenAPI');
    validarHealth = ajv.compile(schemas.Health);
    validarIncidentes = ajv.compile(schemas.IncidentPage);
    validarError = ajv.compile(schemas.Error);
  });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); await rm(dir, { recursive: true, force: true }); });
  const api = (capabilities: readonly string[] = []) => crearApi({ pool, logger: crearLogger('test'), estadoPgDir: dir, sesion: async () => capabilities.length ? { userId: 'u', capabilities } : null });

  it('E1-API-01 health refleja los cuatro componentes y correlación', async () => {
    const app = api(); const id = randomUUID();
    const r = await app.inject({ method: 'GET', url: '/api/v2/health', headers: { 'x-correlation-id': id } });
    expect(r.statusCode).toBe(200); expect(r.headers['x-correlation-id']).toBe(id);
    expect(r.json()).toMatchObject({ status: 'ok', components: { database: { status: 'ok' }, worker: { status: 'ok' }, scheduler: { status: 'ok' }, wal_archive: { status: 'ok' } } });
    expect(validarHealth(r.json()), JSON.stringify(validarHealth.errors)).toBe(true);
    await app.close();
  });

  it('E1-CAP-01 incidents exige sesión y capacidad; valida parámetros', async () => {
    let app = api(); let r = await app.inject('/api/v2/incidents'); expect(r.statusCode).toBe(401); expect(validarError(r.json()), JSON.stringify(validarError.errors)).toBe(true); await app.close();
    app = api(['catalog.read']); r = await app.inject('/api/v2/incidents'); expect(r.statusCode).toBe(403); expect(validarError(r.json()), JSON.stringify(validarError.errors)).toBe(true); await app.close();
    app = api(['operations.read']);
    r = await app.inject('/api/v2/incidents?limit=101'); expect(r.statusCode).toBe(422); expect(validarError(r.json()), JSON.stringify(validarError.errors)).toBe(true);
    r = await app.inject('/api/v2/incidents?limit=10');
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ items: [], next_cursor: null }); await app.close();
    expect(validarIncidentes(r.json()), JSON.stringify(validarIncidentes.errors)).toBe(true);
  });

  it('health queda 503 si falta un servicio', async () => {
    await admin.query("delete from core.service_heartbeats where servicio='worker'");
    const app = api(); const r = await app.inject('/api/v2/health');
    expect(r.statusCode).toBe(503); expect(r.json().components.worker.status).toBe('down'); await app.close();
    expect(validarHealth(r.json()), JSON.stringify(validarHealth.errors)).toBe(true);
    await registrarLatido(pool, 'worker', 'w1', 'test');
  });
});
