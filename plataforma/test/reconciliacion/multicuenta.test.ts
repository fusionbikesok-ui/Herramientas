import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { materializarCorridas } from '../../src/reconciliacion/corridas.ts';
import { crearProcesadorMotor } from '../../src/reconciliacion/motor.ts';
import { ErrorRegistro, parsearRegistro, validarRegistroContraBase } from '../../src/reconciliacion/registro.ts';
import { claveCorrienteCuenta, type AdaptadorBarrido } from '../../src/reconciliacion/tipos.ts';
import type { KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearWorkerBarridos, type ProcesadorBarrido } from '../../src/worker/barridos.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const keyring: KeyringSobre = { activeKeyId: 'mc', keys: { mc: Buffer.alloc(32, 3) } };
const ML = '01a0aa38-c27b-73b9-ac6d-2ce5f0feea17';
const WOO = '01a0aa38-c27b-73b9-ac6d-2ce5f0feea18';

/** Adaptador falso que devuelve el MISMO id de recurso en las dos cuentas: el cruce sería visible. */
function adaptador(topic: string, marca: string): AdaptadorBarrido {
  return {
    topic, cursorKind: 'state_sweep', fullScan: false, versionKind: 'temporal',
    async listar() {
      const version = '2026-09-16T10:00:00Z';
      return {
        resources: [{ id: '1', version, updatedAt: version, lifecycle: 'open', payload: { marca }, projection: { marca } }],
        nextPosition: null, cursorAfter: { v: 1, updated_at: version, tie_breaker: '1' },
      };
    },
  };
}

describe('E1-ACC-01 multi-cuenta', () => {
  it('el registro es cerrado: rechaza credenciales, repetidos y metadatos del canal equivocado', () => {
    const ml = { id: ML, channel: 'mercadolibre', external_account: '777', base_url: 'http://simulator:8080', seller_id: '777' };
    const woo = { id: WOO, channel: 'woocommerce', external_account: 'https://tienda', base_url: 'http://simulator:8080' };
    const leidas = parsearRegistro({ version: 1, cuentas: [ml, woo] });
    // Sin decirlo, una cuenta lee por el gateway del legado: la plataforma no tiene credenciales de canal.
    expect(leidas.map((c) => c.transporte)).toEqual(['gateway', 'gateway']);
    const casos: Array<[string, unknown]> = [
      ['token en una cuenta', { version: 1, cuentas: [{ ...ml, access_token: 'APP_USR-secreto' }] }],
      ['consumer key en Woo', { version: 1, cuentas: [{ ...woo, consumer_key: 'ck_secreto' }] }],
      ['ML sin seller', { version: 1, cuentas: [{ ...ml, seller_id: undefined }] }],
      ['Woo con seller', { version: 1, cuentas: [{ ...woo, seller_id: '1' }] }],
      ['id repetido', { version: 1, cuentas: [ml, { ...woo, id: ML }] }],
      ['externa repetida', { version: 1, cuentas: [ml, { ...ml, id: WOO }] }],
      ['canal desconocido', { version: 1, cuentas: [{ ...woo, channel: 'amazon' }] }],
      ['vacío', { version: 1, cuentas: [] }],
      ['transporte inventado', { version: 1, cuentas: [{ ...ml, transporte: 'https' }] }],
    ];
    for (const [nombre, crudo] of casos) {
      expect(() => parsearRegistro(crudo), nombre).toThrow(ErrorRegistro);
    }
    // El mensaje de error nombra campos, nunca valores: un secreto mal puesto no llega al log.
    try { parsearRegistro(casos[0]![1]); } catch (e) { expect((e as Error).message).not.toContain('APP_USR'); }
  });

  describe('con base', () => {
    let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let cuentaMl: string; let cuentaWoo: string;
    beforeAll(async () => {
      base = await crearBaseDePrueba(); db = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
      const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Multi') returning id")).rows[0]!.id;
      cuentaMl = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','777') returning id", [empresa])).rows[0]!.id;
      cuentaWoo = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'woocommerce','https://tienda') returning id", [empresa])).rows[0]!.id;
    });
    afterAll(async () => { await db.end(); await admin.end(); await base.borrar(); });

    it('el registro tiene que coincidir con la base en canal e identificador externo', async () => {
      const ml = { id: cuentaMl, channel: 'mercadolibre' as const, external_account: '777', base_url: 'http://s', seller_id: '777', transporte: 'gateway' as const };
      const woo = { id: cuentaWoo, channel: 'woocommerce' as const, external_account: 'https://tienda', base_url: 'http://s', transporte: 'gateway' as const };
      await expect(validarRegistroContraBase(db, [ml, woo])).resolves.toBeUndefined();
      await expect(validarRegistroContraBase(db, [{ ...woo, id: cuentaMl }])).rejects.toThrow(/no coincide/);
      await expect(validarRegistroContraBase(db, [{ ...ml, external_account: '999' }])).rejects.toThrow(/no coincide/);
      await expect(validarRegistroContraBase(db, [{ ...ml, id: '11111111-1111-1111-1111-111111111111' }])).rejects.toThrow(/no existe/);
    });

    it('dos cuentas simultáneas: ni corrida, cursor, observación, inbox ni señal cruzan de cuenta', async () => {
      expect((await db.query<{ n: number }>('select integrations.sembrar_corrientes($1) n', [cuentaMl])).rows[0]!.n).toBe(6);
      expect((await db.query<{ n: number }>('select integrations.sembrar_corrientes($1) n', [cuentaWoo])).rows[0]!.n).toBe(4);
      await admin.query("update integrations.reconciliation_cursors set next_run_at = now() + interval '1 hour'");
      await admin.query(`update integrations.reconciliation_cursors set next_run_at = now() - interval '1 second'
        where (channel_account_id=$1 and topic='ml.orders' and cursor_kind='state_sweep')
           or (channel_account_id=$2 and topic='woo.orders' and cursor_kind='state_sweep')`, [cuentaMl, cuentaWoo]);
      expect(await materializarCorridas(db)).toBe(2);

      const recibidas: Array<[string, string]> = [];
      const procesador = (cuenta: string, a: AdaptadorBarrido): ProcesadorBarrido => {
        const motor = crearProcesadorMotor({ db, adaptador: a, keyring });
        return async (corrida) => { recibidas.push([cuenta, corrida.channelAccountId]); return motor(corrida); };
      };

      // Un worker que sólo registró la cuenta ML no puede tomar la corrida de Woo, aunque esté lista.
      const soloMl = crearWorkerBarridos({ db, workerId: 'solo-ml', procesadores: {
        [claveCorrienteCuenta(cuentaMl, 'ml.orders', 'state_sweep')]: procesador(cuentaMl, adaptador('ml.orders', 'ml')),
      } });
      expect(await soloMl.unaVuelta(10)).toBe(1);
      expect(await soloMl.unaVuelta(10)).toBe(0);
      const pendienteWoo = await db.query<{ status: string }>("select status from integrations.sweep_runs where channel_account_id=$1 and topic='woo.orders'", [cuentaWoo]);
      expect(pendienteWoo.rows[0]?.status).toBe('pending');

      // Un worker con las dos cuentas procesa la otra, y cada procesador recibe sólo su cuenta.
      const ambos = crearWorkerBarridos({ db, workerId: 'ambos', procesadores: {
        [claveCorrienteCuenta(cuentaMl, 'ml.orders', 'state_sweep')]: procesador(cuentaMl, adaptador('ml.orders', 'ml')),
        [claveCorrienteCuenta(cuentaWoo, 'woo.orders', 'state_sweep')]: procesador(cuentaWoo, adaptador('woo.orders', 'woo')),
      } });
      expect(await ambos.unaVuelta(10)).toBe(1);
      expect(recibidas.every(([registrada, recibida]) => registrada === recibida)).toBe(true);

      const porCuenta = async (tabla: string) => (await db.query<{ cuenta: string; topic: string }>(
        `select channel_account_id::text cuenta, topic from integrations.${tabla} order by 1,2`)).rows;
      for (const tabla of ['resource_observations', 'inbox_messages']) {
        const filas = await porCuenta(tabla);
        expect(filas, tabla).toHaveLength(2);
        expect(filas.every((f) => (f.cuenta === cuentaMl) === f.topic.startsWith('ml.')), tabla).toBe(true);
      }
      const avanzados = await db.query<{ cuenta: string; topic: string }>(
        "select channel_account_id::text cuenta, topic from integrations.reconciliation_cursors where last_success_at is not null order by 1,2");
      expect(avanzados.rows).toHaveLength(2);
      expect(avanzados.rows.every((f) => (f.cuenta === cuentaMl) === f.topic.startsWith('ml.'))).toBe(true);

      // Señales del mismo recurso en las dos cuentas son dos señales activas, no una coalescida.
      for (const [cuenta, topic] of [[cuentaMl, 'ml.orders'], [cuentaWoo, 'woo.orders']] as const) {
        await db.query("insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source) values ($1,$2,'1','fp','webhook_copy')", [cuenta, topic]);
      }
      expect((await porCuenta('reconciliation_signals')).map((f) => f.topic)).toEqual(
        [cuentaMl, cuentaWoo].sort()[0] === cuentaMl ? ['ml.orders', 'woo.orders'] : ['woo.orders', 'ml.orders']);
    });
  });
});
