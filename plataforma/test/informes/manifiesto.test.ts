import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { randomUUID } from 'node:crypto';
import { armarManifiesto } from '../../src/informes/manifiesto.ts';
import { registrarEvento } from '../../src/audit/auditoria.ts';
import { sembrar } from '../soporte/fixtures.ts';

// `audit_events` exige una empresa que exista y un correlation_id uuid: los dos salen de la semilla.
// `action` tiene además su propio CHECK (^[a-z_]+\.[a-z_.]+$ en 0001_esquema_base.sql): no admite dígitos,
// así que el índice `n` se traduce a letra en vez de viajar tal cual en el nombre de la acción.
const evento = (companyId: string, n: number) => ({
  companyId, actorType: 'system' as const, actorId: 'test',
  action: `prueba.${String.fromCharCode(96 + n)}`, aggregateType: 'prueba', aggregateId: String(n), correlationId: randomUUID(),
});

// `occurred_at` es parte del contenido canónico que entra al hash (audit.canonical en
// 0001_esquema_base.sql): cambiarlo con un UPDATE después de insertar, aunque sea con el pool
// administrador, deja el hash calculado para la fecha vieja y la cadena queda "rota" para
// verify_chain. Para fechar un evento dentro de un día fijo sin romper la cadena, el valor va en
// el INSERT mismo (columna común, sin trigger que la toque) en vez de corregirse después.
const registrarEventoFechado = async (
  pool: pg.Pool, companyId: string, n: number, occurredAt: string,
): Promise<{ chainSeq: string }> => {
  const e = evento(companyId, n);
  const r = await pool.query<{ chain_seq: string }>(
    `INSERT INTO audit.audit_events
       (company_id, actor_type, actor_id, action, aggregate_type, aggregate_id, correlation_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING chain_seq`,
    [e.companyId, e.actorType, e.actorId, e.action, e.aggregateType, e.aggregateId, e.correlationId, occurredAt],
  );
  return { chainSeq: r.rows[0]!.chain_seq };
};

describe('armarManifiesto', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let companyId: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp);
    companyId = (await sembrar(pool)).companyId;
  });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('E1-AUD-04 cuenta los eventos del día y fija los extremos exactos de la cadena', async () => {
    // Los eventos se fechan a mano dentro de un día fijo: leer "hoy ART" y comparar después puede cruzar
    // la medianoche y hacer fallar el test de madrugada.
    const a = await registrarEventoFechado(pool, companyId, 1, '2026-09-16T15:00:00Z');
    const b = await registrarEventoFechado(pool, companyId, 2, '2026-09-16T15:00:00Z');
    const m = await armarManifiesto(pool, '2026-09-16');
    expect(m.eventos).toBe(2);
    expect(m.primer_chain_seq).toBe(a.chainSeq);
    expect(m.ultimo_chain_seq).toBe(b.chainSeq);
    expect(m.ultimo_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.cadena).toEqual({ integra: true, roto_en: null });
    expect(m.ventana).toEqual({ desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' });
    // La retención no es parte del contenido firmado: la fija la subida.
    expect(m).not.toHaveProperty('retention_until');
  });

  it('E1-AUD-04 un día sin eventos se emite con extremos nulos y el último hash conocido', async () => {
    const m = await armarManifiesto(pool, '2026-01-05');
    expect(m).toMatchObject({ eventos: 0, primer_chain_seq: null, ultimo_chain_seq: null });
    expect(m.ultimo_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('E1-AUD-04 verifica la cadena sólo hasta el extremo del día, no más allá', async () => {
    // Un evento posterior al día reportado no puede cambiar el veredicto de ese día.
    const b = await registrarEventoFechado(pool, companyId, 2, '2026-09-16T15:00:00Z');
    const c = await registrarEventoFechado(pool, companyId, 3, '2026-09-20T15:00:00Z');
    const m = await armarManifiesto(pool, '2026-09-16');
    expect(m.ultimo_chain_seq).toBe(b.chainSeq);
    expect(m.ultimo_chain_seq).not.toBe(c.chainSeq);
    expect(m.cadena.integra).toBe(true);
  });

  it('E1-AUD-04 un día vacío no verifica más allá de su propio extremo aunque la cadena se rompa después', async () => {
    // Hallazgo de revisión: con el día vacío, `ultimo` (MAX(chain_seq) del día) es null, y
    // verify_chain(desde, hasta) interpreta hasta = NULL como "sin tope". Sin acotar con el
    // chain_seq del último hash conocido HASTA el fin del día, un día vacío terminaría
    // verificando también eventos posteriores al día reportado — justo lo que el comentario del
    // archivo dice que no puede pasar. Se arma en una base propia para no tocar la cadena de los
    // demás casos.
    const sola = await crearBaseDePrueba();
    const admin = crearPool(sola.urlAdmin); const app = crearPool(sola.urlApp);
    try {
      const semilla = await sembrar(app);
      // Un evento fechado bien DESPUÉS del día que se va a pedir: '2026-01-05' queda vacío.
      await registrarEventoFechado(app, semilla.companyId, 1, '2026-09-20T15:00:00Z');
      // Sólo un superusuario puede saltear el trigger; se corrompe ese evento posterior a propósito.
      await admin.query(`ALTER TABLE audit.audit_events DISABLE TRIGGER ALL`);
      await admin.query(`UPDATE audit.audit_events SET payload = '{"tocado":true}' WHERE chain_seq = 1`);
      const m = await armarManifiesto(app, '2026-01-05');
      expect(m.eventos).toBe(0);
      expect(m.cadena.integra).toBe(true);
      expect(m.cadena.roto_en).toBeNull();
    } finally { await admin.end(); await app.end(); await sola.borrar(); }
  });

  it('E1-AUD-04 un día vacío SÍ verifica la cadena anterior a ese día', async () => {
    // El caso que faltaba: verificado por mutación el 2026-09-18, el test de arriba pasa igual si el día vacío
    // no verifica NADA. Lo que distingue al arreglo correcto es que un día vacío sigue verificando hasta su
    // propio extremo, así que una corrupción ANTERIOR a ese día se informa igual.
    const sola = await crearBaseDePrueba();
    const admin = crearPool(sola.urlAdmin); const app = crearPool(sola.urlApp);
    try {
      const semilla = await sembrar(app);
      await registrarEventoFechado(app, semilla.companyId, 1, '2025-12-20T15:00:00Z');
      await registrarEventoFechado(app, semilla.companyId, 2, '2025-12-21T15:00:00Z');
      await admin.query(`ALTER TABLE audit.audit_events DISABLE TRIGGER ALL`);
      await admin.query(`UPDATE audit.audit_events SET payload = '{"tocado":true}' WHERE chain_seq = 1`);
      // El 2026-01-05 no tiene eventos, pero la cadena que lo precede está rota: hay que decirlo.
      const m = await armarManifiesto(app, '2026-01-05');
      expect(m.eventos).toBe(0);
      expect(m.cadena.integra).toBe(false);
      expect(m.cadena.roto_en).not.toBeNull();
    } finally { await admin.end(); await app.end(); await sola.borrar(); }
  });

  it('E1-AUD-04 un día sin eventos y sin cadena previa usa el hash cero', async () => {
    const vacia = await crearBaseDePrueba();
    const p2 = crearPool(vacia.urlApp);
    try {
      expect((await armarManifiesto(p2, '2026-01-05')).ultimo_hash).toBe('0'.repeat(64));
    } finally { await p2.end(); await vacia.borrar(); }
  });

  it('E1-AUD-04 si la cadena está rota lo informa en lugar de fallar', async () => {
    const sucia = await crearBaseDePrueba();
    const admin = crearPool(sucia.urlAdmin); const app = crearPool(sucia.urlApp);
    try {
      const semilla = await sembrar(app);
      await registrarEvento(app, evento(semilla.companyId, 1));
      await registrarEvento(app, evento(semilla.companyId, 2));
      // Sólo un superusuario puede saltear el trigger; es exactamente el ataque que el manifiesto detecta.
      await admin.query(`ALTER TABLE audit.audit_events DISABLE TRIGGER ALL`);
      await admin.query(`UPDATE audit.audit_events SET payload = '{"tocado":true}' WHERE chain_seq = 1`);
      await admin.query(`UPDATE audit.audit_events SET occurred_at = '2026-09-16T15:00:00Z'`);
      const m = await armarManifiesto(app, '2026-09-16');
      expect(m.cadena.integra).toBe(false);
      expect(m.cadena.roto_en).not.toBeNull();
    } finally { await admin.end(); await app.end(); await sucia.borrar(); }
  });
});
