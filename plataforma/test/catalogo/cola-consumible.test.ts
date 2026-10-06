/*
 * test/catalogo/cola-consumible.test.ts — E2 T1 tarea 2.
 *
 * E2 es el primer consumidor real del inbox de E1, y al ir a escribirlo aparecieron dos huecos que la
 * revisión externa marcó como críticos:
 *
 *   1. `reclamar` devolvía id, token, tipo, intentos y correlación, pero no lo que hace falta para
 *      descifrar el sobre: la cuenta, el recurso, la versión remota y las cuatro partes del cifrado.
 *      Sin eso, el proyector tendría que volver a consultar la fila, es decir confiar en que nadie la
 *      cambió entre el reclamo y la lectura.
 *   2. `completar` abre su propia transacción, así que "proyectar y marcar el mensaje como hecho" eran
 *      dos transacciones: un corte en el medio dejaba el catálogo escrito y el mensaje sin cerrar, o al
 *      revés. `completarEnTx` permite que las dos cosas vivan o mueran juntas.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { completar, completarEnTx, encolarInbox, liberarVencidos, reclamar, type Reclamo } from '../../src/colas/colas.ts';
import { ErrorLeaseVencido } from '../../src/colas/errores.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { cifrarSobre, descifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E2-COLA-01 la cola entrega lo necesario para consumirla', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let cuenta: string;
  const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 7) } };

  const msg = (resourceId: string, remoteVersion = 'v1') => ({
    channelAccountId: cuenta, topic: 'ml.items', resourceId, remoteVersion,
    source: 'bootstrap' as const, correlationId: randomUUID(),
  });

  /** Encola con payload cifrado, como lo hace el motor de barridos en producción. */
  async function encolarConSobre(resourceId: string, payload: unknown, version = 'v1'): Promise<string> {
    const { id } = await encolarInbox(app, msg(resourceId, version));
    const sobre = cifrarSobre(Buffer.from(JSON.stringify(payload), 'utf8'),
      { account: cuenta, topic: 'ml.items', resource: resourceId, remoteVersion: version }, keyring);
    await app.query(
      `UPDATE integrations.inbox_messages
          SET payload_ciphertext = $2, payload_key_id = $3, payload_nonce = $4, payload_tag = $5
        WHERE id = $1`,
      [id, sobre.ciphertext, sobre.keyId, sobre.nonce, sobre.tag]);
    return id!;
  }

  const estado = async (id: string) => (await admin.query<{ status: string; lease_token: string | null }>(
    'select status, lease_token from integrations.inbox_messages where id = $1', [id])).rows[0]!;

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp, { max: 6 });
    admin = crearPool(base.urlAdmin, { max: 2 });
    const empresa = (await app.query<{ id: string }>(
      "insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    cuenta = (await app.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id",
      [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { await admin.query('delete from integrations.dead_letters; delete from integrations.inbox_messages'); });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('reclamar trae los datos del sobre y el payload se descifra con ellos', async () => {
    await encolarConSobre('MLA1', { id: 'MLA1', title: 'Cubierta 29' });
    const [r] = await reclamar(app, 'inbox', ['ml.items'], 10);
    // Lo que el proyector necesita para armar el AAD, sin volver a consultar la fila.
    expect(r).toMatchObject({ channelAccountId: cuenta, resourceId: 'MLA1', remoteVersion: 'v1', tipo: 'ml.items' });
    expect(r!.sobre).toBeTruthy();
    const claro = descifrarSobre(r!.sobre!,
      { account: r!.channelAccountId, topic: r!.tipo, resource: r!.resourceId, remoteVersion: r!.remoteVersion },
      keyring);
    expect(JSON.parse(claro.toString('utf8'))).toEqual({ id: 'MLA1', title: 'Cubierta 29' });
  });

  it('un AAD de otro recurso no descifra: la cuenta y el recurso son parte del cifrado', async () => {
    await encolarConSobre('MLA2', { id: 'MLA2' });
    const [r] = await reclamar(app, 'inbox', ['ml.items'], 10);
    expect(() => descifrarSobre(r!.sobre!,
      { account: r!.channelAccountId, topic: r!.tipo, resource: 'MLA999', remoteVersion: r!.remoteVersion },
      keyring)).toThrow();
  });

  it('un mensaje sin payload llega con el sobre en null, no con basura', async () => {
    // Es el caso del payload vencido a los 90 días: el mensaje existe, el contenido ya no.
    await encolarInbox(app, msg('MLA3'));
    const [r] = await reclamar(app, 'inbox', ['ml.items'], 10);
    expect(r!.sobre).toBeNull();
  });

  it('completarEnTx cierra el mensaje dentro de una transacción ajena', async () => {
    const id = await encolarConSobre('MLA4', { id: 'MLA4' });
    const [r] = await reclamar(app, 'inbox', ['ml.items'], 10);
    await enTransaccion(app, async (tx) => {
      // Una escritura cualquiera que represente la proyección del catálogo.
      await tx.query("insert into core.companies(legal_name) values ('proyectada')");
      await completarEnTx(tx, r!);
    });
    expect((await estado(id)).status).toBe('succeeded');
  });

  it('si la transacción externa se deshace, el mensaje sigue reclamado y vuelve a la cola', async () => {
    const id = await encolarConSobre('MLA5', { id: 'MLA5' });
    const [r] = await reclamar(app, 'inbox', ['ml.items'], 10);
    await expect(enTransaccion(app, async (tx) => {
      await completarEnTx(tx, r!);
      // El defecto que este test simula: la proyección falla DESPUÉS de marcar el mensaje.
      throw new Error('falla de la proyección');
    })).rejects.toThrow('falla de la proyección');
    // Nada quedó cerrado: es el punto de la atomicidad.
    expect((await estado(id)).status).toBe('claimed');
    // Y el mensaje vuelve a la cola por el camino que ya existe: el lease vence y `liberarVencidos` lo
    // devuelve a 'pending'. `reclamar` por sí solo no toca un 'claimed', ni siquiera vencido.
    await admin.query("update integrations.inbox_messages set lease_until = now() - interval '1 minute' where id = $1", [id]);
    expect(await liberarVencidos(app, 'inbox')).toEqual({ pendientes: 1, muertos: 0 });
    const [otra] = await reclamar(app, 'inbox', ['ml.items'], 10, 60);
    expect(otra?.id).toBe(id);
  });

  it('completarEnTx con un lease vencido o ajeno no cierra nada', async () => {
    const id = await encolarConSobre('MLA6', { id: 'MLA6' });
    const [r] = await reclamar(app, 'inbox', ['ml.items'], 10);
    const ajeno: Reclamo = { ...r!, token: randomUUID() };
    await expect(enTransaccion(app, async (tx) => completarEnTx(tx, ajeno)))
      .rejects.toBeInstanceOf(ErrorLeaseVencido);
    expect((await estado(id)).status).toBe('claimed');

    await admin.query("update integrations.inbox_messages set lease_until = now() - interval '1 minute' where id = $1", [id]);
    await expect(enTransaccion(app, async (tx) => completarEnTx(tx, r!)))
      .rejects.toBeInstanceOf(ErrorLeaseVencido);
  });

  it('completar sigue funcionando: usa completarEnTx por dentro', async () => {
    const id = await encolarConSobre('MLA7', { id: 'MLA7' });
    const [r] = await reclamar(app, 'inbox', ['ml.items'], 10);
    await completar(app, r!);
    expect((await estado(id)).status).toBe('succeeded');
    // Y deja su evento de auditoría, que es el contrato que ya tenía.
    const ev = await admin.query<{ n: string }>(
      "select count(*) as n from audit.audit_events where action = 'cola.succeeded' and aggregate_id = $1", [String(id)]);
    expect(ev.rows[0]!.n).toBe('1');
  });
});
