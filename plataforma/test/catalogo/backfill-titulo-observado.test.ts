/*
 * test/catalogo/backfill-titulo-observado.test.ts — backfill de titulo_observado desde los payloads de ML ya
 * guardados en el inbox (cifrados). Base real con el rol de la app; sin llamadas al canal.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfillTituloObservado } from '../../src/catalogo/backfill-titulo-observado.ts';
import { encolarInbox } from '../../src/colas/colas.ts';
import { crearPool } from '../../src/db/pool.ts';
import { cifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('backfill de titulo_observado desde el inbox', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
  let empresa: string; let ml: string;
  const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 9) } };

  let serie = 0;
  async function encolar(resourceId: string, payload: unknown, opciones: { version?: string; sinPayload?: boolean } = {}) {
    const version = opciones.version ?? `2026-09-18T10:${String(serie++).padStart(2, '0')}:00Z`;
    const { id } = await encolarInbox(app, { channelAccountId: ml, topic: 'ml.items', resourceId, remoteVersion: version, source: 'sweep', correlationId: randomUUID() });
    if (!opciones.sinPayload) {
      const s = cifrarSobre(Buffer.from(JSON.stringify(payload)), { account: ml, topic: 'ml.items', resource: resourceId, remoteVersion: version }, keyring);
      await admin.query('UPDATE integrations.inbox_messages SET payload_ciphertext=$2, payload_key_id=$3, payload_nonce=$4, payload_tag=$5 WHERE id=$1',
        [id, s.ciphertext, s.keyId, s.nonce, s.tag]);
    }
  }
  /** Representación vendible de ML ya vinculada a una variante (sin modelo propio), como las de producción. */
  async function rep(recurso: string, titulo: string | null = null): Promise<string> {
    const modelo = (await admin.query<{ id: string }>(`INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
      VALUES ($1, $2, 'ml_simple', $3, 'm') RETURNING id`, [empresa, ml, randomUUID()])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id', [empresa, modelo])).rows[0]!.id;
    return (await admin.query<{ id: string }>(`INSERT INTO catalog.external_representations
      (company_id, channel_account_id, canal, recurso, variacion_normalizada, tipo, variant_id, titulo_observado)
      VALUES ($1, $2, 'mercadolibre', $3, '', 'vendible', $4, $5) RETURNING id`, [empresa, ml, recurso, variante, titulo])).rows[0]!.id;
  }
  const titulo = async (id: string) => (await admin.query<{ t: string | null }>(
    'SELECT titulo_observado AS t FROM catalog.external_representations WHERE id = $1', [id])).rows[0]!.t;

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await admin.query<{ id: string }>('INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id', [`E ${randomUUID()}`])).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'mercadolibre', $2) RETURNING id",
      [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.external_representations, catalog.sellable_variants,
      catalog.product_models CASCADE; DELETE FROM integrations.inbox_messages;`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('descifra el payload más nuevo y llena el título con --apply', async () => {
    const id = await rep('MLA1');
    await encolar('MLA1', { id: 'MLA1', title: 'Título viejo', status: 'active' }, { version: '2026-09-01T00:00:00Z' });
    await encolar('MLA1', { id: 'MLA1', title: 'Cubierta Maxxis 29', status: 'active' }, { version: '2026-09-20T00:00:00Z' });
    const r = await backfillTituloObservado(app, keyring, { lote: 10, dryRun: false });
    expect(r).toMatchObject({ candidatos: 1, llenaria: 1, llenadas: 1, sinPayload: 0, tituloVacio: 0, errores: [] });
    expect(await titulo(id)).toBe('Cubierta Maxxis 29');
  });

  it('en dry-run cuenta pero no escribe', async () => {
    const id = await rep('MLA1');
    await encolar('MLA1', { id: 'MLA1', title: 'Cubierta', status: 'active' });
    const r = await backfillTituloObservado(app, keyring, { lote: 10, dryRun: true });
    expect(r).toMatchObject({ candidatos: 1, llenaria: 1, llenadas: 0 });
    expect(await titulo(id)).toBeNull();
  });

  it('sin payload guardado (vencido o nunca encolado) cuenta como sinPayload y no escribe', async () => {
    const vencido = await rep('MLA1');
    await encolar('MLA1', null, { sinPayload: true });
    const nunca = await rep('MLA2');
    const r = await backfillTituloObservado(app, keyring, { lote: 10, dryRun: false });
    expect(r).toMatchObject({ candidatos: 2, llenaria: 0, llenadas: 0, sinPayload: 2 });
    expect(await titulo(vencido)).toBeNull();
    expect(await titulo(nunca)).toBeNull();
  });

  it('una fila con titulo_observado ya puesto no se toca', async () => {
    const id = await rep('MLA1', 'Ya estaba');
    await encolar('MLA1', { id: 'MLA1', title: 'Otro', status: 'active' });
    const r = await backfillTituloObservado(app, keyring, { lote: 10, dryRun: false });
    expect(r).toMatchObject({ candidatos: 0, llenadas: 0 });
    expect(await titulo(id)).toBe('Ya estaba');
  });

  it('un título vacío o sólo espacios no se guarda (NULL, no ""), igual que el proyector', async () => {
    const id = await rep('MLA1');
    await encolar('MLA1', { id: 'MLA1', title: '   ', status: 'active' });
    const r = await backfillTituloObservado(app, keyring, { lote: 10, dryRun: false });
    expect(r).toMatchObject({ candidatos: 1, llenaria: 0, tituloVacio: 1, llenadas: 0 });
    expect(await titulo(id)).toBeNull();
  });

  it('es idempotente y recorre por lotes', async () => {
    const ids = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await rep(`MLA${i}`));
      await encolar(`MLA${i}`, { id: `MLA${i}`, title: `T${i}`, status: 'active' });
    }
    expect(await backfillTituloObservado(app, keyring, { lote: 2, dryRun: false })).toMatchObject({ candidatos: 5, llenadas: 5 });
    expect(await backfillTituloObservado(app, keyring, { lote: 2, dryRun: false })).toMatchObject({ candidatos: 0, llenadas: 0 });
    expect(await titulo(ids[4]!)).toBe('T5');
  });

  it('un sobre que no descifra queda como error, no aborta el resto', async () => {
    await rep('MLA1');
    const ok = await rep('MLA2');
    await encolar('MLA1', { id: 'MLA1', title: 'x', status: 'active' });
    await admin.query("UPDATE integrations.inbox_messages SET payload_tag = decode(repeat('00', 16), 'hex') WHERE resource_id = 'MLA1'");
    await encolar('MLA2', { id: 'MLA2', title: 'Bien', status: 'active' });
    const r = await backfillTituloObservado(app, keyring, { lote: 10, dryRun: false });
    expect(r.errores).toEqual([{ recurso: 'MLA1', motivo: expect.any(String) }]);
    expect(r.llenadas).toBe(1);
    expect(await titulo(ok)).toBe('Bien');
  });
});
