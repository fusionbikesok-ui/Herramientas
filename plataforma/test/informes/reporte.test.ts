import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { armarReporte, MOTIVOS_EXPLICADOS } from '../../src/informes/reporte.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { limpiar, sembrar, type Semilla } from '../soporte/fixtures.ts';

describe('armarReporte', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>; let s: Semilla;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); s = await sembrar(pool); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });
  beforeEach(async () => { await limpiar(admin, ['integrations.reconciliation_signals', 'informes.entregas']); });
  const senal = (x: Record<string, unknown>) => pool.query(`INSERT INTO integrations.reconciliation_signals (channel_account_id, topic, resource_id, fingerprint, source, status, error_detail, received_at) VALUES ($1,$2,$3,$4,'webhook_copy',$5,$6,$7)`, [x.cuenta ?? s.cuentaWoo, x.topic, x.resource, x.fingerprint, x.status, x.motivo ?? null, x.recibida]);

  it('da verde y cero faltantes en un día sin actividad', async () => { const r = await armarReporte(pool, '2026-09-16'); expect(r.semaforo).toBe('verde'); expect(r.faltantes_sin_explicar).toBe(0); expect(r.ventana).toEqual({ desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' }); });
  it('sólo cuenta señales dentro de la ventana', async () => { await senal({ topic:'woo.orders',resource:'1',fingerprint:'a',status:'succeeded',recibida:'2026-09-16T12:00:00Z' }); await senal({ topic:'woo.orders',resource:'2',fingerprint:'b',status:'succeeded',recibida:'2026-09-17T12:00:00Z' }); expect((await armarReporte(pool,'2026-09-16')).topicos['woo.orders']!.senales_nucleo).toBe(1); });
  it('acepta sólo motivos explicados y marca rojo los demás', async () => { expect(MOTIVOS_EXPLICADOS).toContain('recurso_borrado'); await senal({topic:'woo.products',resource:'3',fingerprint:'c',status:'excluded',motivo:'recurso_borrado',recibida:'2026-09-16T12:00:00Z'}); expect((await armarReporte(pool,'2026-09-16')).semaforo).toBe('verde'); await senal({topic:'woo.products',resource:'4',fingerprint:'d',status:'dead_lettered',motivo:'porque_si',recibida:'2026-09-16T12:00:00Z'}); expect((await armarReporte(pool,'2026-09-16')).faltantes_sin_explicar).toBe(1); });
  it('marca rojo una cadena rota', async () => { const r = await armarReporte(pool,'2026-09-15',{manifiesto:{tipo:'manifiesto',fecha:'2026-09-15',ventana:{desde:'2026-09-15T03:00:00.000Z',hasta:'2026-09-16T03:00:00.000Z'},primer_chain_seq:null,ultimo_chain_seq:null,ultimo_hash:'0'.repeat(64),eventos:0,cadena:{integra:false,roto_en:'7'}}}); expect(r.semaforo).toBe('rojo'); });
});
