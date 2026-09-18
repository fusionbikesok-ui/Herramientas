import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApi } from '../../src/api/app.ts';
import { RUTA_ESTADO_INFORMES } from '../../src/api/informes.ts';
import { crearLogger } from '../../src/comun/logger.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearOrigenes, firmar } from '../../src/seguridad/interna.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { limpiar, sembrar } from '../soporte/fixtures.ts';

const clave = randomBytes(32);
const keyring = { activeKeyId: 'k1', keys: { k1: clave } };

describe('GET /internal/v1/informes/estado', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  let cuentaMl: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    cuentaMl = (await sembrar(pool)).cuentaMl;
  });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });
  beforeEach(async () => { await limpiar(admin, ['informes.entregas']); });

  const api = (conSenales = true) => crearApi({
    pool, logger: crearLogger('test'), estadoPgDir: '/nada',
    ...(conSenales ? { senales: { keyring, origenes: crearOrigenes('127.0.0.1/32'), cuentas: new Map([['mercadolibre', cuentaMl] as const]) } } : {}),
  });
  const firmado = (o: { clave?: Buffer } = {}) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('base64url');
    return {
      'x-fusion-key-id': 'k1', 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
      'x-fusion-signature': firmar(o.clave ?? clave, ts, nonce, 'GET', RUTA_ESTADO_INFORMES, Buffer.alloc(0)),
    };
  };

  it('sin la API interna configurada la ruta no existe', async () => {
    const app = api(false);
    expect((await app.inject({ method: 'GET', url: RUTA_ESTADO_INFORMES, remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    await app.close();
  });

  it('sin firma válida responde 401', async () => {
    const app = api();
    expect((await app.inject({ method: 'GET', url: RUTA_ESTADO_INFORMES, remoteAddress: '127.0.0.1' })).statusCode).toBe(401);
    const otra = firmado({ clave: randomBytes(32) });
    expect((await app.inject({ method: 'GET', url: RUTA_ESTADO_INFORMES, remoteAddress: '127.0.0.1', headers: otra })).statusCode).toBe(401);
    await app.close();
  });

  it('informa el último reporte avisado y las entregas atrasadas', async () => {
    await admin.query(`INSERT INTO informes.entregas
      (tipo, fecha, estado_deposito, estado_aviso, hash_contenido, semaforo, b2_object_key, b2_version_id, retention_until)
      VALUES ('reporte', '2026-09-15', 'subido', 'avisado', repeat('a', 64), 'verde', 'e1/reportes/2026-09-15.json', 'v1', '2027-09-20T00:00:00Z')`);
    // Una subida que quedó firmada hace dos días: atrasada.
    await admin.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido, generado_en)
      VALUES ('manifiesto', '2026-09-16', 'firmado', repeat('b', 64), now() - interval '48 hours')`);
    const app = api();
    const r = await app.inject({ method: 'GET', url: RUTA_ESTADO_INFORMES, remoteAddress: '127.0.0.1', headers: firmado() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ultimo: '2026-09-15', atrasadas: [{ tipo: 'manifiesto', fecha: '2026-09-16' }] });
    await app.close();
  });
});
