import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { crearPool } from '../src/db/pool.ts';
import { crearApi } from '../src/api/app.ts';
import { PREFIJO_PASSKEYS, RUTAS_PASSKEYS } from '../src/api/passkeys.ts';
import { crearLogger } from '../src/comun/logger.ts';
import {
  ErrorPasskey, iniciarAutenticacion, iniciarRegistro, passkeysHabilitadas, terminarAutenticacion, terminarRegistro,
} from '../src/auth/passkeys.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';
import { limpiar, sembrar, type Semilla } from './soporte/fixtures.ts';
import { crearAutenticador } from './soporte/webauthn.ts';
import { emitirCodigos } from '../src/auth/recuperacion.ts';
import { randomBytes } from 'node:crypto';

const CFG = { rpID: 'localhost', rpNombre: 'FusionBikes', origen: 'http://localhost' };
const AHORA = new Date('2026-09-17T10:00:00Z');
const despues = (ms: number) => new Date(AHORA.getTime() + ms);

describe('passkeys', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  let s: Semilla;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });
  beforeEach(async () => {
    await limpiar(admin, ['security.webauthn_challenges', 'security.webauthn_credentials']);
    s = await sembrar(pool);
  });

  /** Registra una passkey nueva del usuario de la semilla y devuelve su autenticador. */
  const registrar = async () => {
    const aut = crearAutenticador({ rpID: CFG.rpID, origin: CFG.origen });
    const opciones = await iniciarRegistro(pool, CFG, { id: s.userId, nombre: 'prueba' }, AHORA);
    await terminarRegistro(pool, CFG, { id: s.userId }, aut.responderRegistro(opciones) as RegistrationResponseJSON, despues(1000));
    return aut;
  };

  describe('interruptor de doble llave', () => {
    it('E1-WA-01 nace apagado: la migración deja passkeys.real en false', async () => {
      const r = await pool.query(`SELECT enabled FROM security.feature_flags WHERE code = 'passkeys.real'`);
      expect(r.rows[0]).toEqual({ enabled: false });
      expect(await passkeysHabilitadas(pool, { PASSKEYS_HABILITADAS: '1' })).toBe(false);
    });

    it('E1-WA-01 la fila sola no alcanza sin la variable de entorno, ni la variable sin la fila', async () => {
      await admin.query(`UPDATE security.feature_flags SET enabled = true WHERE code = 'passkeys.real'`);
      try {
        expect(await passkeysHabilitadas(pool, {})).toBe(false);
        expect(await passkeysHabilitadas(pool, { PASSKEYS_HABILITADAS: 'true' })).toBe(false);
        expect(await passkeysHabilitadas(pool, { PASSKEYS_HABILITADAS: '1' })).toBe(true);
      } finally {
        await admin.query(`UPDATE security.feature_flags SET enabled = false WHERE code = 'passkeys.real'`);
      }
    });
  });

  it('E1-WA-01 registro, login y reautenticación con el autenticador virtual', async () => {
    const aut = await registrar();
    const cred = await pool.query(`SELECT user_id, sign_count FROM security.webauthn_credentials`);
    expect(cred.rows).toEqual([{ user_id: s.userId, sign_count: '0' }]);

    const login = await iniciarAutenticacion(pool, CFG, 'login', null, despues(2000));
    aut.contador = 1;
    expect(await terminarAutenticacion(pool, CFG, 'login', null, aut.responderLogin(login) as AuthenticationResponseJSON, despues(3000)))
      .toEqual({ userId: s.userId });

    const reaut = await iniciarAutenticacion(pool, CFG, 'reautenticacion', s.userId, despues(4000));
    aut.contador = 2;
    expect(await terminarAutenticacion(pool, CFG, 'reautenticacion', s.userId, aut.responderLogin(reaut) as AuthenticationResponseJSON, despues(5000)))
      .toEqual({ userId: s.userId });
    const final = await pool.query(`SELECT sign_count::int AS n, last_used_at FROM security.webauthn_credentials`);
    expect(final.rows[0].n).toBe(2);
    expect(final.rows[0].last_used_at).toEqual(despues(5000));
  });

  it('E1-WA-01 un desafío se usa una sola vez', async () => {
    const aut = await registrar();
    const login = await iniciarAutenticacion(pool, CFG, 'login', null, AHORA);
    const respuesta = aut.responderLogin(login) as AuthenticationResponseJSON;
    await terminarAutenticacion(pool, CFG, 'login', null, respuesta, despues(1000));
    await expect(terminarAutenticacion(pool, CFG, 'login', null, respuesta, despues(2000))).rejects.toThrow(/ya usado/);
  });

  it('E1-WA-01 un desafío vencido se rechaza, y queda consumido', async () => {
    const aut = await registrar();
    const login = await iniciarAutenticacion(pool, CFG, 'login', null, AHORA);
    await expect(terminarAutenticacion(pool, CFG, 'login', null, aut.responderLogin(login) as AuthenticationResponseJSON, despues(6 * 60_000)))
      .rejects.toThrow(ErrorPasskey);
  });

  it('E1-WA-01 un desafío de registro no sirve para un login', async () => {
    const aut = await registrar();
    const deRegistro = await iniciarRegistro(pool, CFG, { id: s.userId, nombre: 'prueba' }, AHORA);
    await expect(terminarAutenticacion(pool, CFG, 'login', null, aut.responderLogin(deRegistro) as AuthenticationResponseJSON, despues(1000)))
      .rejects.toThrow(/otro propósito/);
  });

  it('E1-WA-01 un origen distinto del configurado se rechaza', async () => {
    const aut = await registrar();
    const login = await iniciarAutenticacion(pool, CFG, 'login', null, AHORA);
    await expect(terminarAutenticacion(pool, CFG, 'login', null,
      aut.responderLogin(login, { origen: 'https://phishing.example' }) as AuthenticationResponseJSON, despues(1000))).rejects.toThrow(ErrorPasskey);
  });

  it('E1-WA-01 exige verificación de usuario al registrar', async () => {
    const aut = crearAutenticador({ rpID: CFG.rpID, origin: CFG.origen });
    const opciones = await iniciarRegistro(pool, CFG, { id: s.userId, nombre: 'prueba' }, AHORA);
    await expect(terminarRegistro(pool, CFG, { id: s.userId },
      aut.responderRegistro(opciones, { sinVerificacion: true }) as RegistrationResponseJSON, despues(1000))).rejects.toThrow(ErrorPasskey);
  });

  it('E1-WA-01 reautenticar con la passkey de otro usuario se rechaza', async () => {
    const ajeno = await registrar();
    const otro = await sembrar(pool);
    const reaut = await iniciarAutenticacion(pool, CFG, 'reautenticacion', otro.userId, AHORA);
    await expect(terminarAutenticacion(pool, CFG, 'reautenticacion', otro.userId,
      ajeno.responderLogin(reaut) as AuthenticationResponseJSON, despues(1000))).rejects.toThrow(/otro usuario/);
  });

  it('E1-WA-01 un contador que retrocede se rechaza; uno siempre en cero se acepta', async () => {
    const aut = await registrar();
    aut.contador = 5;
    const a = await iniciarAutenticacion(pool, CFG, 'login', null, AHORA);
    await terminarAutenticacion(pool, CFG, 'login', null, aut.responderLogin(a) as AuthenticationResponseJSON, despues(1000));
    aut.contador = 3; // retrocede: posible clon
    const b = await iniciarAutenticacion(pool, CFG, 'login', null, despues(2000));
    await expect(terminarAutenticacion(pool, CFG, 'login', null, aut.responderLogin(b) as AuthenticationResponseJSON, despues(3000)))
      .rejects.toThrow(ErrorPasskey);

    // Una passkey sincronizada que informa siempre 0 no es un clon: la regla de la librería la acepta.
    const sincronizada = await registrar();
    const c = await iniciarAutenticacion(pool, CFG, 'login', null, despues(4000));
    await terminarAutenticacion(pool, CFG, 'login', null, sincronizada.responderLogin(c) as AuthenticationResponseJSON, despues(5000));
    const d = await iniciarAutenticacion(pool, CFG, 'login', null, despues(6000));
    expect(await terminarAutenticacion(pool, CFG, 'login', null, sincronizada.responderLogin(d) as AuthenticationResponseJSON, despues(7000)))
      .toEqual({ userId: s.userId });
  });
});

describe('rutas de passkeys', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });

  const api = (entorno: Record<string, string>) => crearApi({
    pool, logger: crearLogger('test'), estadoPgDir: '/nada', passkeys: { cfg: CFG, entorno },
  });
  /** Las rutas del grupo según Fastify, no según una lista que mantiene la misma implementación. */
  const registradas = (app: ReturnType<typeof crearApi>) =>
    [...new Set([...app.printRoutes({ commonPrefix: false }).matchAll(/(\/api\/v2\/auth\/passkeys\/[^\s(]+)/g)].map((m) => m[1]!))].sort();

  it('E1-WA-01 con el interruptor apagado responden 503 TODAS las rutas que Fastify registró', async () => {
    const app = api({ PASSKEYS_HABILITADAS: '1' });
    await app.ready();
    const rutas = registradas(app);
    expect(rutas.length).toBeGreaterThanOrEqual(6);
    // Si alguien agrega una ruta al grupo sin sumarla a la lista, este test lo ve.
    expect(rutas).toEqual([...RUTAS_PASSKEYS].sort());
    for (const url of rutas) {
      const r = await app.inject({ method: 'POST', url, payload: {} });
      expect(r.statusCode, url).toBe(503);
      expect(r.json(), url).toMatchObject({ error: 'passkeys_deshabilitadas' });
    }
    await app.close();
  });

  it('E1-WA-01 con la fila encendida pero sin la variable, siguen en 503', async () => {
    await admin.query(`UPDATE security.feature_flags SET enabled = true WHERE code = 'passkeys.real'`);
    try {
      const app = api({});
      expect((await app.inject({ method: 'POST', url: `${PREFIJO_PASSKEYS}/login/inicio`, payload: {} })).statusCode).toBe(503);
      await app.close();
      // Con las dos llaves, la ruta responde de verdad.
      const encendida = api({ PASSKEYS_HABILITADAS: '1' });
      const r = await encendida.inject({ method: 'POST', url: `${PREFIJO_PASSKEYS}/login/inicio`, payload: {} });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toHaveProperty('challenge');
      await encendida.close();
    } finally {
      await admin.query(`UPDATE security.feature_flags SET enabled = false WHERE code = 'passkeys.real'`);
    }
  });

  it('E1-WA-01 la recuperación funciona por la ruta con las dos llaves, y no dice si el usuario existe', async () => {
    const clave = randomBytes(32);
    const usuario = (await sembrar(pool)).userId;
    const [codigo] = await emitirCodigos(pool, clave, usuario, new Date(), 1);
    await admin.query(`UPDATE security.feature_flags SET enabled = true WHERE code = 'passkeys.real'`);
    try {
      const app = crearApi({ pool, logger: crearLogger('test'), estadoPgDir: '/nada',
        passkeys: { cfg: CFG, entorno: { PASSKEYS_HABILITADAS: '1' }, claveRecuperacion: clave } });
      const pedir = (payload: object) => app.inject({ method: 'POST', url: `${PREFIJO_PASSKEYS}/recuperacion`, payload });
      const mal = await pedir({ usuario, codigo: 'nosirve' });
      const inexistente = await pedir({ usuario: '00000000-0000-7000-8000-0000000000ff', codigo: 'nosirve' });
      expect(mal.statusCode).toBe(400);
      expect(inexistente.json()).toEqual(mal.json());
      expect((await pedir({ usuario, codigo })).json()).toEqual({ ok: true });
      await app.close();
    } finally {
      await admin.query(`UPDATE security.feature_flags SET enabled = false WHERE code = 'passkeys.real'`);
    }
  });
});
