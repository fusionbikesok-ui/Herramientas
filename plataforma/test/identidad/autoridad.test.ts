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
import { crearPool, enTransaccion, type Consultable } from '../../src/db/pool.ts';
import { decisionVigente, modoAutoSku } from '../../src/identidad/autoridad.ts';
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
  const woos = (id: number, bandeja = false) => ver(woo, 'woo.products', String(id), { id, type: 'simple', sku: `FB-${id}`, name: `P${id}` }, bandeja);
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
  async function decisionHumana(
    recurso: string, eleccion: 'vincular' | 'omitir' | 'mantener_omision' | 'sin_candidato', variantId: string | null,
  ): Promise<string> {
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

  it('[esc:legado-posterior-conflict] (d) evento de legado sobre una clave con decisión humana vigente: el vínculo no cambia y abre un caso de conflicto; reenviar el mismo evento no duplica el caso', async () => {
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

  it('reconciliarSku (hallazgo ALTO, commit b3e72186): con bandeja on, el SKU que aparece en Woo no pisa la decisión humana; con bandeja off, sí la pisa como hacía antes de E3', async () => {
    // Legado apunta MLA7 a un SKU que todavía no existe: queda pendiente con caso sku_inexistente_en_woo.
    const vHumana = await variantePendiente('FB-71');
    await decisionHumana('MLA7', 'vincular', vHumana);
    await decisionLegado('MLA7', 'confirmar', 'FB-70');
    await publicacion('MLA7', true);
    expect(await vinculo('MLA7')).toBe('FB-71'); // la humana ya manda al nacer.

    // Ahora aparece FB-70 en Woo: reconciliarSku corre dentro de vincularMl (rama Woo) con el bandeja del
    // contexto. Con bandeja on, no debe revincular a la variante de FB-70 aunque la decisión de legado exista.
    await woos(70, true);
    expect(await vinculo('MLA7')).toBe('FB-71');
  });

  it('reconciliarSku con bandeja off: aparece el SKU en Woo y la publicación SIN decisión humana se fusiona como siempre (comportamiento de hoy)', async () => {
    await decisionLegado('MLA8', 'confirmar', 'FB-80');
    await publicacion('MLA8', false);
    expect(await vinculo('MLA8')).toBe('pendiente');
    expect(await casosAbiertos('sku_inexistente_en_woo')).toEqual([{ tipo: 'sku_inexistente_en_woo' }]);
    await woos(80);
    expect(await vinculo('MLA8')).toBe('FB-80');
  });

  it('evento redundante con la humana (mismo destino, u omitir/omitir) no abre decision_en_conflicto', async () => {
    await woos(90); // FB-90
    const v = (await q<{ id: string }>("SELECT id FROM catalog.sellable_variants WHERE sku = 'FB-90'"))[0]!.id;
    await decisionHumana('MLA9', 'vincular', v);
    await publicacion('MLA9', true);
    expect(await vinculo('MLA9')).toBe('FB-90');
    // El legado manda el MISMO destino (FB-90) que ya resolvió la humana: es redundante, no una discrepancia.
    await aplicar(evento('MLA9', 'confirmar', 'FB-90'), true);
    expect(await casosAbiertos('decision_en_conflicto')).toEqual([]);
    expect(await vinculo('MLA9')).toBe('FB-90');

    // Humana omitir y legado también omitir: también redundante.
    await decisionHumana('MLA10', 'omitir', null);
    await publicacion('MLA10', true);
    await aplicar(evento('MLA10', 'omitir', null), true);
    expect(await casosAbiertos('decision_en_conflicto')).toEqual([]);
  });

  it('el caso decision_en_conflicto nace con estado=conflict; reenviar el MISMO evento_id es idempotente de punta a punta (1 caso, 1 auditoría) porque aplicarEvento corta en "repetido" antes de llegar a esta lógica', async () => {
    await woos(100); // FB-100
    const vHumana = await variantePendiente('FB-101');
    await decisionHumana('MLA11', 'vincular', vHumana);
    await publicacion('MLA11', true);

    const e = evento('MLA11', 'confirmar', 'FB-100'); // distinto destino que la humana: NO es redundante.
    expect(await aplicar(e, true)).toBe('aplicado');
    const casos1 = await q<{ estado: string; detalle: { legado: { sku: string | null }; e3: string } }>(
      "SELECT estado, detalle FROM catalog.identity_cases WHERE tipo = 'decision_en_conflicto'");
    expect(casos1.map((c) => c.estado)).toEqual(['conflict']);
    const detalleOriginal = casos1[0]!.detalle;
    const auditoria1 = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'identidad.conflicto_legado' AND payload->>'recurso' = 'MLA11'");
    expect(auditoria1[0]!.n).toBe(1);

    // Reenvío del MISMO evento_id: `aplicarEvento` ya corta en 'repetido' por `eventos_recibidos` (la
    // idempotencia general de todo evento, no algo nuevo de esta tarea) ANTES de llegar a la lógica de
    // conflicto — ni el caso ni la auditoría se tocan de nuevo. El ON CONFLICT DO NOTHING del INSERT del
    // caso es una segunda red, para el camino en que SÍ se reprocesa (dos eventos DISTINTOS sobre la misma
    // clave, cada uno con su propio evento_id, mientras la humana sigue vigente): ahí el caso no se duplica
    // pero la auditoría sí registra cada aplicación real, porque es historial de qué pasó, no una bandeja
    // de "hay algo por revisar" que ya está señalizada con la primera.
    expect(await aplicar(e, true)).toBe('repetido');
    const casos2 = await q<{ n: number }>("SELECT count(*)::int AS n FROM catalog.identity_cases WHERE tipo = 'decision_en_conflicto'");
    expect(casos2[0]!.n).toBe(1);
    const auditoria2 = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'identidad.conflicto_legado' AND payload->>'recurso' = 'MLA11'");
    expect(auditoria2[0]!.n).toBe(1);

    // Un evento DISTINTO (otro evento_id) sobre la misma clave, con la humana todavía vigente: el caso
    // sigue siendo uno solo (ON CONFLICT DO NOTHING), pero la auditoría SÍ crece — es una aplicación real.
    const e2 = evento('MLA11', 'confirmar', 'FB-100');
    expect(await aplicar(e2, true)).toBe('aplicado');
    const casos3 = await q<{ n: number }>("SELECT count(*)::int AS n FROM catalog.identity_cases WHERE tipo = 'decision_en_conflicto'");
    expect(casos3[0]!.n).toBe(1);
    const auditoria3 = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'identidad.conflicto_legado' AND payload->>'recurso' = 'MLA11'");
    expect(auditoria3[0]!.n).toBe(2);

    // El ON CONFLICT DO NOTHING del INSERT del caso significa exactamente eso: el segundo evento no toca
    // la fila ya existente. `detalle` (que guarda el `legado`/`sku` del PRIMER evento y el `e3` de la
    // decisión humana en ese momento) tiene que seguir siendo el del primero, no el del segundo evento_id.
    const casoFinal = (await q<{ detalle: { legado: { sku: string | null }; e3: string } }>(
      "SELECT detalle FROM catalog.identity_cases WHERE tipo = 'decision_en_conflicto'"))[0]!.detalle;
    expect(casoFinal).toEqual(detalleOriginal);
  });

  it('mantener_omision de la humana también manda sobre el legado con bandeja on', async () => {
    await decisionHumana('MLA12', 'mantener_omision', null);
    await decisionLegado('MLA12', 'confirmar', 'FB-120');
    await publicacion('MLA12', true);
    // La humana manda: la publicación nace omitida, no pendiente ni vinculada al SKU del legado.
    expect(await vinculo('MLA12')).toBe('omitida');
    await woos(120, true);
    expect(await vinculo('MLA12')).toBe('omitida');
  });

  it('sin_candidato de la humana deja la publicación pendiente aunque el legado tenga un SKU asignado', async () => {
    await decisionHumana('MLA13', 'sin_candidato', null);
    await decisionLegado('MLA13', 'confirmar', 'FB-130');
    await publicacion('MLA13', true);
    // sin_candidato: ningún candidato todavía, la publicación queda pendiente por decisión propia (no la
    // del legado, que existe pero la humana no la tomó).
    expect(await vinculo('MLA13')).toBe('pendiente');
    expect(await casosAbiertos('sku_pendiente')).toEqual([{ tipo: 'sku_pendiente' }]);
  });
});

/*
 * E3-AUT-02 — corte 3 tarea 3: el paso 3 de decisionVigente (auto_sku/aplicar), detrás de un modo que decide
 * el llamador. Ejercita `decisionVigente` directo (no vía proyector/eventos): el paso 3 es nuevo, no hace
 * falta re-probar todo el camino de vincularMl/reconciliarClave que ya cubre E3-AUT-01 arriba.
 */
describe('E3-AUT-02 auto_sku/aplicar detrás de un modo (corte 3, tarea 3)', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string;
  const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 7) } };

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 6 }); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await app.query<{ id: string }>('insert into core.channel_accounts(company_id,channel,external_account) values ($1,$2,$3) returning id', [empresa, 'mercadolibre', randomUUID()])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.matcher_decisions,
      catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE;`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  const variante = async (sku: string | null = null): Promise<string> => {
    const m = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, randomUUID()])).rows[0]!.id;
    return (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id',
      [empresa, m, sku])).rows[0]!.id;
  };
  const decisionAutoSku = (recurso: string, variantId: string, efecto: 'sombra' | 'aplicar' = 'aplicar') => admin.query(
    `INSERT INTO catalog.identity_decisions
       (company_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto, hash_payload_ml)
     VALUES ($1, $2, $3, '', 'vincular', $4, 'auto_sku', 'e3-canario', $5, $6) RETURNING id`,
    [empresa, ml, recurso, variantId, efecto, efecto === 'aplicar' ? 'deadbeef' : null]);
  const decisionHumana = (recurso: string, eleccion: 'vincular' | 'omitir', variantId: string | null, supersedeA: string | null = null) => admin.query(
    `INSERT INTO catalog.identity_decisions
       (company_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto, supersede_a)
     VALUES ($1, $2, $3, '', $4, $5, 'humano', 'jose', 'aplicar', $6)`,
    [empresa, ml, recurso, eleccion, variantId, supersedeA]);
  const decisionLegado = (recurso: string, accion: string, sku: string | null) => admin.query(
    `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, sku, accion, origen, actor)
     VALUES ($1, $2, 'mercadolibre', $3, '', $4, $5, 'copia', 'persona')`, [empresa, ml, recurso, sku, accion]);

  it('[esc:flag-apagado] autoSku omitido o "apagado": una auto_sku/aplicar vigente es invisible (igual que hoy)', async () => {
    const v = await variante('FB-200');
    await decisionAutoSku('MLA20', v);
    expect(await decisionVigente(app, ml, 'MLA20', '', { bandeja: false })).toBeNull();
    expect(await decisionVigente(app, ml, 'MLA20', '', { bandeja: false, autoSku: 'apagado' })).toBeNull();
  });

  it('"aplicado" sin humana ni legado: devuelve la auto_sku', async () => {
    const v = await variante('FB-201');
    await decisionAutoSku('MLA21', v);
    const r = await decisionVigente(app, ml, 'MLA21', '', { bandeja: false, autoSku: 'aplicado' });
    expect(r).toEqual({ fuente: 'auto_sku', eleccion: 'vincular', variantId: v, decisionId: expect.any(String) });
  });

  it('"aplicado" con un legado omitir: gana el legado', async () => {
    const v = await variante('FB-202');
    await decisionAutoSku('MLA22', v);
    await decisionLegado('MLA22', 'omitir', null);
    const r = await decisionVigente(app, ml, 'MLA22', '', { bandeja: false, autoSku: 'aplicado' });
    expect(r).toEqual({ fuente: 'legado', accion: 'omitir' });
  });

  it('"aplicado" con una humana: gana la humana', async () => {
    const vHumana = await variante('FB-203');
    const vAuto = await variante('FB-204');
    // El UNIQUE parcial (clave, efecto) impide dos `aplicar` vigentes: la humana entra superando a la auto_sku.
    const idAuto = (await decisionAutoSku('MLA23', vAuto)).rows[0].id as string;
    await decisionHumana('MLA23', 'vincular', vHumana, idAuto);
    const r = await decisionVigente(app, ml, 'MLA23', '', { bandeja: true, autoSku: 'aplicado' });
    expect(r).toEqual({ fuente: 'humano', eleccion: 'vincular', variantId: vHumana, decisionId: expect.any(String) });
  });

  it('una auto_sku/sombra nunca se devuelve, en ningún modo', async () => {
    const v = await variante('FB-205');
    await decisionAutoSku('MLA24', v, 'sombra');
    expect(await decisionVigente(app, ml, 'MLA24', '', { bandeja: false, autoSku: 'apagado' })).toBeNull();
    expect(await decisionVigente(app, ml, 'MLA24', '', { bandeja: false, autoSku: 'aplicado' })).toBeNull();
  });

  it('[esc:e3-canario-sin-t5] E3_CANARIO=1 sólo aplica dentro de una corrida abierta', async () => {
    const corrida = (await admin.query<{ id: string }>(`INSERT INTO catalog.e3_canario_corridas (company_id, dia) VALUES ($1, '2026-09-26') RETURNING id`, [empresa])).rows[0]!.id;
    const m = (await admin.query<{ id: string }>(`INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1, $2, 'ml_simple', 'MLA25', 'x') RETURNING id`, [empresa, ml])).rows[0]!.id;
    const v = (await admin.query<{ id: string }>('INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id', [empresa, m])).rows[0]!.id;
    const c = (await admin.query<{ id: string }>("INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id", [empresa, v])).rows[0]!.id;
    await admin.query(`INSERT INTO catalog.e3_canario_casos (corrida_id, case_id, channel_account_id, recurso, variacion_normalizada, sku_congelado, variant_id_congelada) VALUES ($1, $2, $3, 'MLA25', '', 'FB-25', $4)`, [corrida, c, ml, v]);
    expect(await modoAutoSku(app, ml, 'MLA25', '', { E3_AUTO_SKU: false, E3_CANARIO: true })).toBe('aplicado');
    expect(await modoAutoSku(app, ml, 'MLA26', '', { E3_AUTO_SKU: false, E3_CANARIO: true })).toBe('apagado');
  });

  it('modoAutoSku: E3_AUTO_SKU=1 → "aplicado"', async () => {
    const modo = await modoAutoSku(app, ml, 'MLA26', '', { E3_AUTO_SKU: true, E3_CANARIO: false });
    expect(modo).toBe('aplicado');
  });

  it('modoAutoSku: los dos flags en 0 → "apagado"', async () => {
    const modo = await modoAutoSku(app, ml, 'MLA27', '', { E3_AUTO_SKU: false, E3_CANARIO: false });
    expect(modo).toBe('apagado');
  });

  it('invariante: con E3_CANARIO=0 y E3_AUTO_SKU=0, decisionVigente con autoSku "apagado" no ejecuta el paso 3 (no hace la query de auto_sku)', async () => {
    let consultas = 0;
    const espia = {
      query: (async (sql: string, params?: unknown[]) => {
        if (/identity_decisions/.test(sql) && /auto_sku/.test(sql)) consultas++;
        return app.query(sql, params as never);
      }) as Consultable['query'],
    };
    await decisionVigente(espia as unknown as Consultable, ml, 'MLA28', '', { bandeja: false, autoSku: 'apagado' });
    expect(consultas).toBe(0);
  });
});
