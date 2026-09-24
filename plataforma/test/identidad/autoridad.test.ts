/*
 * test/identidad/autoridad.test.ts — E3 corte 1 tarea 2: la decisión humana de la bandeja manda sobre el
 * legado cuando el flag `bandeja` está prendido; apagado, el comportamiento es idéntico al de antes de E3.
 *
 * Enmienda de la revisión de Codex (commit 7055e0ec): los escenarios (a)-(f) tienen que ejercitar
 * `vincularMl` (vía el proyector real, como en test/catalogo/proyector.test.ts) Y `reconciliarClave`
 * (vía `aplicarEvento` real, como en test/catalogo/decisiones.test.ts) — no mockear `decisionVigente`.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aplicarEvento, type EventoDecision } from '../../src/catalogo/copias.ts';
import { crearProyector, type OpcionesProyector } from '../../src/catalogo/proyector.ts';
import { encolarInbox } from '../../src/colas/colas.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { cifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-AUT-01 autoridad de la decisión humana sobre el vínculo', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let woo: string; let ml: string;
  const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 7) } };
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  let serie = 0;
  const proyector = (bandeja: boolean, extra: Partial<OpcionesProyector> = {}) =>
    crearProyector({ pool: app, keyring, lote: 50, canario: 0, umbralErrorPorciento: 100, bandeja, ...extra });
  async function ver(cuenta: string, topic: 'woo.products' | 'ml.items', id: string, payload: unknown, bandeja = false) {
    const version = `2026-09-24T09:${String(serie++).padStart(2, '0')}:00Z`;
    const { id: m } = await encolarInbox(app, { channelAccountId: cuenta, topic, resourceId: id, remoteVersion: version, source: 'sweep', correlationId: randomUUID() });
    const s = cifrarSobre(Buffer.from(JSON.stringify(payload)), { account: cuenta, topic, resource: id, remoteVersion: version }, keyring);
    await admin.query('UPDATE integrations.inbox_messages SET payload_ciphertext=$2, payload_key_id=$3, payload_nonce=$4, payload_tag=$5 WHERE id=$1', [m, s.ciphertext, s.keyId, s.nonce, s.tag]);
    await proyector(bandeja).unaVuelta();
  }
  const woos = (id: number) => ver(woo, 'woo.products', String(id), { id, type: 'simple', sku: `FB-${id}`, name: `P${id}` });
  const publicacion = (id: string, bandeja = false) => ver(ml, 'ml.items', id, { id, title: id, status: 'active' }, bandeja);

  const evento = (recurso: string, accion: EventoDecision['accion'], sku: string | null): EventoDecision => ({
    evento_id: randomUUID(), recurso, variacion: '', accion, sku, actor: 'persona', motivo: null, confirmado_por: 'jose', ocurrido_en: new Date().toISOString() });
  const aplicar = (e: EventoDecision, bandeja = false) => enTransaccion(app, (tx) => aplicarEvento(tx, empresa, ml, e, { bandeja }));

  /** A qué SKU cuelga hoy la publicación: el SKU, 'pendiente', u 'omitida'. */
  const vinculo = async (recurso: string) => (await q<{ v: string }>(
    `SELECT CASE WHEN r.omitida_por_decision THEN 'omitida' ELSE COALESCE(v.sku, 'pendiente') END AS v
       FROM catalog.external_representations r LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id
      WHERE r.channel_account_id = $1 AND r.recurso = $2 AND r.tipo = 'vendible'`, [ml, recurso]))[0]?.v;
  const casosAbiertos = (tipo?: string) => q<{ tipo: string }>(
    `SELECT tipo FROM catalog.identity_cases WHERE cerrado_en IS NULL ${tipo ? 'AND tipo = $1' : ''} ORDER BY tipo`, tipo ? [tipo] : []);

  const decisionLegado = (recurso: string, accion: string, sku: string | null) => admin.query(
    `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, sku, accion, origen, actor)
     VALUES ($1, $2, 'mercadolibre', $3, '', $4, $5, 'copia', 'persona')`, [empresa, ml, recurso, sku, accion]);

  /** Decisión humana de la bandeja directamente en identity_decisions (vía la tabla, como haría decidirCaso). */
  async function decisionHumana(recurso: string, eleccion: 'vincular' | 'omitir', variantId: string | null): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO catalog.identity_decisions
         (company_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto)
       VALUES ($1, $2, $3, '', $4, $5, 'humano', 'jose', 'aplicar') RETURNING id`,
      [empresa, ml, recurso, eleccion, variantId]);
    return rows[0]!.id;
  }
  const variantePendiente = async (sku: string | null = null): Promise<string> => {
    const m = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, randomUUID()])).rows[0]!.id;
    return (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id',
      [empresa, m, sku])).rows[0]!.id;
  };

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 6 }); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    const cuenta = async (canal: string) => (await app.query<{ id: string }>('insert into core.channel_accounts(company_id,channel,external_account) values ($1,$2,$3) returning id', [empresa, canal, randomUUID()])).rows[0]!.id;
    woo = await cuenta('woocommerce'); ml = await cuenta('mercadolibre');
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.matcher_decisions, catalog.copias_lotes,
      catalog.copias, catalog.eventos_recibidos, catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE;
      DELETE FROM integrations.inbox_messages;`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('(a) bandeja on: la decisión humana gana sobre el legado, tanto al nacer (vincularMl) como al reconciliar', async () => {
    await woos(10); // FB-10, variante V1
    const v1 = (await q<{ id: string }>("SELECT id FROM catalog.sellable_variants WHERE sku = 'FB-10'"))[0]!.id;
    const v2 = await variantePendiente('FB-11');
    await decisionHumana('MLA1', 'vincular', v2);
    await decisionLegado('MLA1', 'confirmar', 'FB-10');

    // vincularMl: la publicación nace con bandeja on → debe colgar de la humana (V2), no del legado (V1).
    await publicacion('MLA1', true);
    expect(await vinculo('MLA1')).toBe('FB-11');

    // reconciliarClave: un evento de legado que reintentaría apuntar a V1 no debe moverla si bandeja sigue on.
    await aplicar(evento('MLA1', 'confirmar', 'FB-10'), true);
    expect(await vinculo('MLA1')).toBe('FB-11');
    void v1;
  });

  it('(b) bandeja off: mismo estado, gana el legado — comportamiento de hoy sin cambios', async () => {
    await woos(20); // FB-20
    const v2 = await variantePendiente('FB-21');
    await decisionHumana('MLA2', 'vincular', v2);
    await decisionLegado('MLA2', 'confirmar', 'FB-20');

    await publicacion('MLA2', false);
    expect(await vinculo('MLA2')).toBe('FB-20');
    await aplicar(evento('MLA2', 'confirmar', 'FB-20'), false);
    expect(await vinculo('MLA2')).toBe('FB-20');
  });

  it('(c) decisión humana "omitir" deja la publicación omitida y abre omitida_revisar', async () => {
    await decisionHumana('MLA3', 'omitir', null);
    await publicacion('MLA3', true);
    expect(await vinculo('MLA3')).toBe('omitida');
    expect(await casosAbiertos('omitida_revisar')).toEqual([{ tipo: 'omitida_revisar' }]);
  });

  it('(d) evento de legado sobre una clave con decisión humana vigente: el vínculo no cambia y abre un caso de conflicto; reenviar el mismo evento no duplica el caso', async () => {
    await woos(40); // FB-40
    const vHumana = await variantePendiente('FB-41');
    await decisionHumana('MLA4', 'vincular', vHumana);
    await publicacion('MLA4', true);
    expect(await vinculo('MLA4')).toBe('FB-41');

    const e = evento('MLA4', 'confirmar', 'FB-40');
    await aplicar(e, true);
    expect(await vinculo('MLA4')).toBe('FB-41'); // sin cambios: la humana manda
    expect(await casosAbiertos('decision_en_conflicto')).toEqual([{ tipo: 'decision_en_conflicto' }]);

    // Reenvío del MISMO evento (mismo evento_id): no debe abrir un segundo caso.
    await aplicar(e, true);
    expect(await casosAbiertos('decision_en_conflicto')).toEqual([{ tipo: 'decision_en_conflicto' }]);
  });

  it('(e) evento de legado sobre una clave SIN decisión humana: comportamiento de hoy, sin cambios', async () => {
    await woos(50); // FB-50
    await publicacion('MLA5', true);
    await aplicar(evento('MLA5', 'confirmar', 'FB-50'), true);
    expect(await vinculo('MLA5')).toBe('FB-50');
    expect(await casosAbiertos('decision_en_conflicto')).toEqual([]);
  });

  it('(f) una publicación de ML nueva con decisión humana previa nace ya vinculada, no pendiente', async () => {
    const vHumana = await variantePendiente('FB-61');
    await decisionHumana('MLA6', 'vincular', vHumana);
    await publicacion('MLA6', true);
    expect(await vinculo('MLA6')).toBe('FB-61');
    expect(await casosAbiertos()).toEqual([]);
  });
});
