/*
 * test/catalogo/decisiones.test.ts — E2 T1 tarea 8: el vínculo de cada publicación sigue a la decisión vigente.
 *
 * Flujos completos: el proyector ve las publicaciones como en producción, y las decisiones llegan por eventos
 * o copias.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCopia, aplicarEvento, confirmarCopia, hashFilas, recibirLote, type EventoDecision, type FilaDecision } from '../../src/catalogo/copias.ts';
import { crearProyector } from '../../src/catalogo/proyector.ts';
import { encolarInbox } from '../../src/colas/colas.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { cifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E2-DEC-01 decisiones y fusión', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let woo: string; let ml: string;
  const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 4) } };
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  let serie = 0;
  async function ver(cuenta: string, topic: 'woo.products' | 'ml.items', id: string, payload: unknown) {
    const version = `2026-09-18T11:${String(serie++).padStart(2, '0')}:00Z`;
    const { id: m } = await encolarInbox(app, { channelAccountId: cuenta, topic, resourceId: id, remoteVersion: version, source: 'sweep', correlationId: randomUUID() });
    const s = cifrarSobre(Buffer.from(JSON.stringify(payload)), { account: cuenta, topic, resource: id, remoteVersion: version }, keyring);
    await admin.query('UPDATE integrations.inbox_messages SET payload_ciphertext=$2, payload_key_id=$3, payload_nonce=$4, payload_tag=$5 WHERE id=$1', [m, s.ciphertext, s.keyId, s.nonce, s.tag]);
    await crearProyector({ pool: app, keyring, lote: 50, canario: 0, umbralErrorPorciento: 100 }).unaVuelta();
  }
  const woos = (id: number) => ver(woo, 'woo.products', String(id), { id, type: 'simple', sku: `FB-${id}`, name: `P${id}` });
  const publicacion = (id: string) => ver(ml, 'ml.items', id, { id, title: id, status: 'active' });
  const evento = (recurso: string, accion: EventoDecision['accion'], sku: string | null, ocurrido = new Date()): EventoDecision => ({
    evento_id: randomUUID(), recurso, variacion: '', accion, sku, actor: 'persona', motivo: null, confirmado_por: 'jose', ocurrido_en: ocurrido.toISOString() });
  const aplicar = (e: EventoDecision) => enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, e, { bandeja: false }));
  /** A qué SKU cuelga hoy la publicación: el SKU, 'pendiente', u 'omitida'. */
  const vinculo = async (recurso: string) => (await q<{ v: string }>(
    `SELECT CASE WHEN r.omitida_por_decision THEN 'omitida' ELSE COALESCE(v.sku, 'pendiente') END AS v
       FROM catalog.external_representations r LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id
      WHERE r.channel_account_id = $1 AND r.recurso = $2 AND r.tipo = 'vendible'`, [ml, recurso]))[0]?.v;
  const casosAbiertos = () => q<{ tipo: string }>('SELECT tipo FROM catalog.identity_cases WHERE cerrado_en IS NULL ORDER BY tipo');
  const archivadas = () => q<{ motivo_archivo: string }>('SELECT motivo_archivo FROM catalog.sellable_variants WHERE archivado_en IS NOT NULL');

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 6 }); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    const cuenta = async (canal: string) => (await app.query<{ id: string }>('insert into core.channel_accounts(company_id,channel,external_account) values ($1,$2,$3) returning id', [empresa, canal, randomUUID()])).rows[0]!.id;
    woo = await cuenta('woocommerce'); ml = await cuenta('mercadolibre');
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.matcher_decisions, catalog.copias_lotes, catalog.copias, catalog.eventos_recibidos,
      catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE; DELETE FROM integrations.inbox_messages;`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('una pendiente que recibe su decisión se fusiona con la variante de Woo', async () => {
    await woos(10);
    await publicacion('MLA1');
    expect(await vinculo('MLA1')).toBe('pendiente');
    await aplicar(evento('MLA1', 'confirmar', 'FB-10'));
    expect(await vinculo('MLA1')).toBe('FB-10');
    expect(await archivadas()).toEqual([{ motivo_archivo: expect.stringMatching(/^fusionada en /) }]);
    expect(await casosAbiertos()).toEqual([]);
  });

  it('una decisión a un SKU que todavía no existe se fusiona sola cuando el SKU aparece en Woo', async () => {
    await publicacion('MLA2');
    await aplicar(evento('MLA2', 'asignar', 'FB-20'));
    expect(await vinculo('MLA2')).toBe('pendiente');
    expect(await casosAbiertos()).toEqual([{ tipo: 'sku_inexistente_en_woo' }]);
    await woos(20);
    expect(await vinculo('MLA2')).toBe('FB-20');
    expect(await casosAbiertos()).toEqual([]);
  });

  it('cambiar de un SKU a otro mueve la publicación y no archiva la variante de Woo', async () => {
    await woos(30); await woos(31);
    await publicacion('MLA3');
    await aplicar(evento('MLA3', 'confirmar', 'FB-30'));
    await aplicar(evento('MLA3', 'confirmar', 'FB-31'));
    expect(await vinculo('MLA3')).toBe('FB-31');
    // La de FB-30 es de Woo: existe aunque ML deje de apuntarle. Sólo la pendiente original se archivó.
    expect(await q("SELECT count(*)::int n FROM catalog.sellable_variants WHERE sku IN ('FB-30','FB-31') AND archivado_en IS NULL")).toEqual([{ n: 2 }]);
    expect(await archivadas()).toHaveLength(1);
  });

  it('revocar devuelve la publicación a una variante pendiente con su caso', async () => {
    await woos(40);
    await publicacion('MLA4');
    await aplicar(evento('MLA4', 'confirmar', 'FB-40'));
    await aplicar(evento('MLA4', 'revocar', null));
    expect(await vinculo('MLA4')).toBe('pendiente');
    expect(await casosAbiertos()).toEqual([{ tipo: 'sku_pendiente' }]);
  });

  it('omitir deja la publicación sin variante; confirmarla después la vincula y cierra el caso', async () => {
    await woos(50);
    await publicacion('MLA5');
    await aplicar(evento('MLA5', 'omitir', null));
    expect(await vinculo('MLA5')).toBe('omitida');
    expect(await casosAbiertos()).toEqual([{ tipo: 'omitida_revisar' }]);
    expect(await archivadas()).toEqual([{ motivo_archivo: 'la publicación quedó omitida' }]);
    await aplicar(evento('MLA5', 'confirmar', 'FB-50'));
    expect(await vinculo('MLA5')).toBe('FB-50');
    expect(await casosAbiertos()).toEqual([]);
  });

  it('una variante con SKU no se archiva aunque se quede sin publicaciones', async () => {
    // Situación armada a mano: una variante con SKU cuya única publicación es de ML (hoy toda variante con SKU
    // conserva la de Woo que la creó; esto cubre que mañana se cree por otra vía).
    const m = (await admin.query<{ id: string }>(`INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1,$2,'woo_simple','60','P60') RETURNING id`, [empresa, woo])).rows[0]!.id;
    await admin.query("INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, 'FB-60')", [empresa, m]);
    await publicacion('MLA60');
    await aplicar(evento('MLA60', 'confirmar', 'FB-60'));
    await aplicar(evento('MLA60', 'revocar', null));
    expect(await q("SELECT archivado_en FROM catalog.sellable_variants WHERE sku = 'FB-60'")).toEqual([{ archivado_en: null }]);
  });

  it('pasar de "sin decisión" a "SKU que no existe" cambia el caso sin crear otra variante', async () => {
    await publicacion('MLA6');
    await aplicar(evento('MLA6', 'asignar', 'FB-999'));
    expect(await casosAbiertos()).toEqual([{ tipo: 'sku_inexistente_en_woo' }]);
    expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants')).toEqual([{ n: 1 }]);
  });

  it('una copia confirmada reconcilia cada publicación cuya decisión cambió', async () => {
    await woos(70); await woos(71);
    await publicacion('MLA7'); await publicacion('MLA8');
    const filas: FilaDecision[] = [
      { recurso: 'MLA7', variacion: '', sku: 'FB-70', accion: 'confirmar', actor: 'persona', motivo: null, confirmado_por: 'jose', actualizado_en_legado: null },
      { recurso: 'MLA8', variacion: '', sku: 'FB-71', accion: 'asignar', actor: 'sistema', motivo: 'SKU igual', confirmado_por: null, actualizado_en_legado: null },
    ];
    const copia = await abrirCopia(app, { empresa, tipo: 'matcher', totalEsperado: 2, hashEsperado: hashFilas(filas), corte: new Date().toISOString() });
    await recibirLote(app, copia, 1, filas);
    await enTransaccion(app, (tx) => confirmarCopia(tx, copia, ml, { bandeja: false }));
    expect([await vinculo('MLA7'), await vinculo('MLA8')]).toEqual(['FB-70', 'FB-71']);
  });

  it('cada cambio de vínculo queda en la auditoría', async () => {
    await woos(80);
    await publicacion('MLA9');
    await aplicar(evento('MLA9', 'confirmar', 'FB-80'));
    expect(await q("SELECT count(*)::int n FROM audit.audit_events WHERE action = 'catalogo.vinculo_cambiado' AND payload->>'recurso' = 'MLA9'"))
      .toEqual([{ n: 1 }]);
  });

  it('Woo asigna el SKU mientras llega la decisión que apunta a él: en cualquier orden, queda vinculada', async () => {
    for (let i = 0; i < 5; i++) {
      const id = 200 + i; const recurso = `MLA2${i}`;
      await publicacion(recurso);
      // El producto de Woo y la decisión llegan a la vez, en dos transacciones que se cruzan.
      await Promise.all([woos(id), aplicar(evento(recurso, 'confirmar', `FB-${id}`))]);
      expect(await vinculo(recurso)).toBe(`FB-${id}`);
    }
    expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants WHERE sku IS NULL AND archivado_en IS NULL')).toEqual([{ n: 0 }]);
  });

  it('dos cambios simultáneos sobre la misma publicación se serializan: gana el más nuevo, sin variantes de más', async () => {
    await woos(90); await woos(91);
    await publicacion('MLA10');
    const antes = new Date(Date.now() - 1000); const despues = new Date();
    // Las dos transacciones corren a la vez. La del evento más viejo, si llega segunda, se ignora ('viejo');
    // si llega primera, la más nueva la reemplaza. En los dos órdenes el final es el mismo.
    const r = await Promise.all([aplicar(evento('MLA10', 'confirmar', 'FB-90', antes)), aplicar(evento('MLA10', 'confirmar', 'FB-91', despues))]);
    expect(r).toContain('aplicado');
    expect(await vinculo('MLA10')).toBe('FB-91');
    expect(await q('SELECT count(*)::int n FROM catalog.matcher_decisions WHERE vigente_hasta IS NULL')).toEqual([{ n: 1 }]);
    // Ninguna pendiente viva quedó colgando: la original se fusionó y no se creó otra.
    expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants WHERE sku IS NULL AND archivado_en IS NULL')).toEqual([{ n: 0 }]);
  });
});
