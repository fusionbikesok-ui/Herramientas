import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cargarConfig, ErrorConfig } from '../src/comun/config.ts';
import { correlacionDe } from '../src/comun/correlacion.ts';
import { registrarLatido } from '../src/comun/latido.ts';
import { crearLogger } from '../src/comun/logger.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('configuración', () => {
  const env = { SERVICIO: 'api', INSTANCIA: 'api-1', VERSION: '0.1.0', PG_HOST: 'pg', PG_PORT: '5432', PG_DATABASE: 'plataforma', PG_USER: 'plataforma_app', PG_PASSWORD_FILE: '/run/secretos/pg', API_PUERTO: '3201', ESTADO_PG_DIR: '/estado-pg' };

  it('arma la URL con la contraseña leída del archivo', () => {
    const c = cargarConfig(env, () => 'cla ve/1\n');
    expect(c).toMatchObject({ servicio: 'api', apiPuerto: 3201, estadoPgDir: '/estado-pg', heartbeatMaxS: 120, heartbeatIntervalMs: 30000 });
    expect(c.pgUrl).toBe('postgres://plataforma_app:cla%20ve%2F1@pg:5432/plataforma');
  });

  it('falla claro si falta una variable', () => {
    const { PG_USER: _omitido, ...incompleto } = env;
    expect(() => cargarConfig(incompleto, () => 'x')).toThrow(ErrorConfig);
    expect(() => cargarConfig(incompleto, () => 'x')).toThrow(/PG_USER/);
  });

  it('E1-SIG-02 la configuración de señales es todo o nada y valida canal=uuid', () => {
    const leer = () => 'x';
    expect(cargarConfig(env, leer).senales).toBeUndefined();
    const ml = '01a0aa38-c27b-73b9-ac6d-2ce5f0feea17';
    const ok = cargarConfig({ ...env, SENALES_KEYRING_FILE: '/run/secretos/senales', SENALES_CUENTAS: `mercadolibre=${ml}`, SENALES_ORIGENES: '172.16.0.0/12' }, leer);
    expect(ok.senales?.cuentas.get('mercadolibre')).toBe(ml);
    expect(() => cargarConfig({ ...env, SENALES_CUENTAS: `mercadolibre=${ml}` }, leer)).toThrow(/incompleta/);
    for (const cuentas of ['mercadolibre=no-uuid', `amazon=${ml}`, `mercadolibre=${ml},mercadolibre=${ml}`]) {
      expect(() => cargarConfig({ ...env, SENALES_KEYRING_FILE: '/k', SENALES_CUENTAS: cuentas, SENALES_ORIGENES: '127.0.0.1/32' }, leer), cuentas).toThrow(ErrorConfig);
    }
  });

  it('E1-ACC-01 barridos: registro+keyring todo o nada y sin variables de cuenta única', () => {
    const leer = () => 'x';
    expect(cargarConfig({ ...env, BARRIDOS_REGISTRO_FILE: '/r.json', BARRIDOS_KEYRING_FILE: '/k.json' }, leer).barridos)
      .toEqual({ registroFile: '/r.json', keyringFile: '/k.json' });
    expect(() => cargarConfig({ ...env, BARRIDOS_REGISTRO_FILE: '/r.json' }, leer)).toThrow(/incompleta/);
    expect(() => cargarConfig({ ...env, BARRIDOS_REGISTRO_FILE: '/r.json', BARRIDOS_KEYRING_FILE: '/k.json', BARRIDOS_CUENTA: 'x' }, leer)).toThrow(/cuenta única/);
  });

  it('rechaza un servicio desconocido', () => {
    expect(() => cargarConfig({ ...env, SERVICIO: 'otro' }, () => 'x')).toThrow(ErrorConfig);
  });

  it('acepta la contraseña efímera inyectada sólo por el entrypoint', () => {
    const { PG_PASSWORD_FILE: _archivo, ...sinArchivo } = env;
    expect(cargarConfig({ ...sinArchivo, PG_PASSWORD: 'temporal' }, () => { throw new Error('no debe leer archivo'); }).pgUrl).toContain(':temporal@');
  });
});

describe('logs y correlación', () => {
  it('oculta contraseñas, tokens, cookies y emails', () => {
    let salida = '';
    const destino = new Writable({ write(chunk, _enc, cb) { salida += String(chunk); cb(); } });
    crearLogger('api', destino).info({ password: 'secreto', token: 't', req: { headers: { cookie: 'c', authorization: 'a' } }, email: 'a@b.c' }, 'hola');
    expect(salida).not.toMatch(/secreto|"t"|a@b\.c/);
    expect(JSON.parse(salida)).toMatchObject({ servicio: 'api', msg: 'hola', password: '[oculto]' });
  });

  it('respeta un X-Correlation-Id UUID válido y genera otro si no', () => {
    const uuid = '0191f2c4-7b1e-7d3a-9c1f-2b6a1e4d5f60';
    expect(correlacionDe(uuid)).toBe(uuid);
    expect(correlacionDe('no-es-uuid')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlacionDe(undefined)).not.toBe(correlacionDe(undefined));
  });
});

describe('latidos', () => {
  let base: BaseDePrueba; let app: pg.Pool;
  beforeAll(async () => { base = await crearBaseDePrueba(); app = crearPool(base.urlApp); });
  afterAll(async () => { await app.end(); await base.borrar(); });

  it('registrarLatido inserta y actualiza una fila por servicio', async () => {
    await registrarLatido(app, 'worker', 'w1', '0.1.0');
    await registrarLatido(app, 'worker', 'w2', '0.1.0');
    const r = await app.query<{ instancia: string }>("select instancia from core.service_heartbeats where servicio='worker'");
    expect(r.rows).toEqual([{ instancia: 'w2' }]);
  });
});
