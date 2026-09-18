import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { armarReporte, MOTIVOS_EXPLICADOS } from '../../src/informes/reporte.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { limpiar, sembrar, type Semilla } from '../soporte/fixtures.ts';

describe('armarReporte', () => {
  let base: BaseDePrueba;
  let pool: ReturnType<typeof crearPool>;
  let admin: ReturnType<typeof crearPool>;
  let s: Semilla;

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    pool = crearPool(base.urlApp);
    admin = crearPool(base.urlAdmin);
    s = await sembrar(pool);
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
    await base.borrar();
  });

  // Sin esto, las señales de un caso cuentan en el siguiente y el resultado depende del orden.
  beforeEach(async () => {
    await limpiar(admin, ['integrations.reconciliation_signals', 'integrations.sweep_runs', 'informes.entregas']);
  });

  const senal = (extra: Record<string, unknown>) => pool.query(
    `INSERT INTO integrations.reconciliation_signals
       (channel_account_id, topic, resource_id, fingerprint, source, status, error_detail, received_at)
     VALUES ($1, $2, $3, $4, 'webhook_copy', $5, $6, $7)`,
    [extra.cuenta ?? s.cuentaWoo, extra.topic, extra.resource, extra.fingerprint, extra.status, extra.motivo ?? null, extra.recibida],
  );

  it('E1-REC-01 un día sin actividad da verde y cero faltantes', async () => {
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.semaforo).toBe('verde');
    expect(r.faltantes_sin_explicar).toBe(0);
    expect(r.ventana).toEqual({ desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' });
  });

  it('E1-REC-01 sólo cuenta señales dentro de la ventana del día', async () => {
    await senal({ topic: 'woo.orders', resource: '1', fingerprint: 'ev:a', status: 'succeeded', recibida: '2026-09-16T12:00:00Z' });
    await senal({ topic: 'woo.orders', resource: '2', fingerprint: 'ev:b', status: 'succeeded', recibida: '2026-09-17T12:00:00Z' });
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.topicos['woo.orders']!.senales_nucleo).toBe(1);
  });

  it('E1-REC-01 un faltante con motivo registrado no rompe', async () => {
    expect(MOTIVOS_EXPLICADOS).toContain('recurso_borrado');
    await senal({ topic: 'woo.products', resource: '3', fingerprint: 'ev:c', status: 'excluded', motivo: 'recurso_borrado', recibida: '2026-09-16T12:00:00Z' });
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.faltantes_sin_explicar).toBe(0);
    expect(r.semaforo).toBe('verde');
  });

  it('E1-REC-01 un faltante con motivo fuera de la lista pinta rojo', async () => {
    await senal({ topic: 'woo.products', resource: '4', fingerprint: 'ev:d', status: 'dead_lettered', motivo: 'porque_si', recibida: '2026-09-16T12:00:00Z' });
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.faltantes_sin_explicar).toBe(1);
    expect(r.semaforo).toBe('rojo');
  });

  it('E1-REC-01 un faltante sin motivo también pinta rojo', async () => {
    await senal({ topic: 'ml.orders', resource: '5', fingerprint: 'ev:e', status: 'dead_lettered', recibida: '2026-09-16T12:00:00Z', cuenta: s.cuentaMl });
    expect((await armarReporte(pool, '2026-09-16')).semaforo).toBe('rojo');
  });

  it('E1-REC-01 una cadena de auditoría rota pinta rojo aunque no haya faltantes', async () => {
    const r = await armarReporte(pool, '2026-09-15', {
      manifiesto: { tipo: 'manifiesto', fecha: '2026-09-15',
        ventana: { desde: '2026-09-15T03:00:00.000Z', hasta: '2026-09-16T03:00:00.000Z' },
        primer_chain_seq: null, ultimo_chain_seq: null, ultimo_hash: '0'.repeat(64), eventos: 0,
        cadena: { integra: false, roto_en: '7' } },
    });
    expect(r.semaforo).toBe('rojo');
  });

  // Un barrido de convergencia de envíos. `sweep_runs` referencia al cursor de su corriente, así que la
  // cuenta tiene que tener sus corrientes sembradas (lo hace la migración para las cuentas existentes).
  const barrido = async (inicio: string, conocidos: number, barridos: number, convergidos: number) => {
    await pool.query('SELECT integrations.sembrar_corrientes($1)', [s.cuentaMl]);
    await pool.query(`INSERT INTO integrations.sweep_runs
      (channel_account_id, topic, cursor_kind, strategy, started_at, status, known_resources, swept, converged)
      VALUES ($1, 'ml.shipments', 'state_sweep', 'convergence', $2, 'succeeded', $3, $4, $5)`,
      [s.cuentaMl, inicio, conocidos, barridos, convergidos]);
  };

  // Un reporte ya enviado en `fecha` con el semáforo dado; `null` simula uno viejo sin semáforo guardado.
  const reportePrevio = (fecha: string, semaforo: 'verde' | 'amarillo' | 'rojo' | null) => pool.query(
    `INSERT INTO informes.entregas
       (tipo, fecha, estado_deposito, estado_aviso, hash_contenido, semaforo, b2_object_key, b2_version_id, retention_until)
     VALUES ('reporte', $1, 'subido', 'avisado', repeat('a', 64), $2, $3, 'v1', '2027-09-20T00:00:00Z')`,
    [fecha, semaforo, `e1/reportes/${fecha}.json`],
  );

  it('E1-REC-01 numera el día de campaña y recuerda el reporte anterior', async () => {
    await reportePrevio('2026-09-13', 'verde');
    await reportePrevio('2026-09-14', 'amarillo');
    const r = await armarReporte(pool, '2026-09-15');
    expect(r.reporte_anterior).toBe('2026-09-14');
    // Dos días previos seguidos sin rojo más éste: tercer día. Amarillo no reinicia (diseño §9).
    expect(r.dia_campana).toBe(3);
  });

  it('E1-REC-01 un día rojo anterior reinicia la campaña', async () => {
    await reportePrevio('2026-09-12', 'verde');
    await reportePrevio('2026-09-13', 'rojo');
    await reportePrevio('2026-09-14', 'verde');
    // Sin esto, la racha contaba días avisados y no días limpios: aprobaba 7 días con un rojo adentro.
    expect((await armarReporte(pool, '2026-09-15')).dia_campana).toBe(2);
  });

  it('E1-REC-01 un día sin reporte también corta la campaña', async () => {
    await reportePrevio('2026-09-12', 'verde');
    await reportePrevio('2026-09-14', 'verde');
    expect((await armarReporte(pool, '2026-09-15')).dia_campana).toBe(2);
  });

  it('E1-REC-01 si este día es rojo, la campaña queda en cero', async () => {
    await reportePrevio('2026-09-14', 'verde');
    await senal({ topic: 'woo.orders', resource: '9', fingerprint: 'ev:z', status: 'dead_lettered', recibida: '2026-09-15T12:00:00Z' });
    const r = await armarReporte(pool, '2026-09-15');
    expect(r.semaforo).toBe('rojo');
    expect(r.dia_campana).toBe(0);
  });

  it('E1-REC-01 la convergencia incompleta de un barrido pinta amarillo', async () => {
    await barrido('2026-09-16T12:00:00Z', 10, 10, 9);
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.topicos['ml.shipments']).toMatchObject({ cobertura: 1, convergencia: 0.9 });
    expect(r.semaforo).toBe('amarillo');
  });

  it('E1-REC-01 un barrido de otro día no cuenta', async () => {
    await barrido('2026-09-17T12:00:00Z', 10, 5, 1);
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.topicos['ml.shipments']).toBeUndefined();
    expect(r.semaforo).toBe('verde');
  });
});
