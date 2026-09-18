/*
 * test/catalogo/proyector.test.ts — E2 T1 tarea 6.
 *
 * Contra una base real: el proyector reclama del inbox, descifra, proyecta y aplica. Los mensajes se encolan
 * con sobre cifrado, igual que los deja el motor de barridos en producción.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearProyector, type OpcionesProyector } from '../../src/catalogo/proyector.ts';
import { encolarInbox } from '../../src/colas/colas.ts';
import { crearPool } from '../../src/db/pool.ts';
import { cifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E2-PRY-10 proyector del catálogo', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
  let empresa: string; let woo: string; let ml: string;
  const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 9) } };
  const otroKeyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 1) } };

  const proyector = (extra: Partial<OpcionesProyector> = {}) =>
    crearProyector({ pool: app, keyring, lote: 50, canario: 0, umbralErrorPorciento: 10, ...extra });

  let serie = 0;
  /** Encola un recurso con su payload cifrado. La versión por omisión crece, como la fecha de modificación. */
  async function encolar(cuenta: string, topic: 'woo.products' | 'ml.items', resourceId: string, payload: unknown,
    opciones: { version?: string; keyring?: KeyringSobre; sinPayload?: boolean } = {}): Promise<string> {
    const version = opciones.version ?? `2026-09-18T10:${String(serie++).padStart(2, '0')}:00Z`;
    const { id } = await encolarInbox(app, { channelAccountId: cuenta, topic, resourceId, remoteVersion: version, source: 'sweep', correlationId: randomUUID() });
    if (!opciones.sinPayload) {
      const s = cifrarSobre(Buffer.from(JSON.stringify(payload)), { account: cuenta, topic, resource: resourceId, remoteVersion: version }, opciones.keyring ?? keyring);
      await admin.query(`UPDATE integrations.inbox_messages SET payload_ciphertext=$2, payload_key_id=$3, payload_nonce=$4, payload_tag=$5 WHERE id=$1`,
        [id, s.ciphertext, s.keyId, s.nonce, s.tag]);
    }
    return id!;
  }
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;
  const casos = (tipo?: string) => q<{ tipo: string; prioridad: string }>(
    `SELECT tipo, prioridad FROM catalog.identity_cases WHERE cerrado_en IS NULL ${tipo ? 'AND tipo = $1' : ''} ORDER BY tipo`, tipo ? [tipo] : []);
  const estadoMensaje = async (id: string) => (await q<{ status: string }>('SELECT status FROM integrations.inbox_messages WHERE id=$1', [id]))[0]!.status;
  const decision = (recurso: string, variacion: string, accion: string, sku: string | null) => admin.query(
    `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, sku, accion, origen, actor)
     VALUES ($1, $2, 'mercadolibre', $3, $4, $5, $6, 'copia', 'persona')`, [empresa, ml, recurso, variacion, sku, accion]);

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp, { max: 6 });
    admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('Fusion') returning id")).rows[0]!.id;
    const cuenta = async (canal: string) => (await app.query<{ id: string }>(
      'insert into core.channel_accounts(company_id,channel,external_account) values ($1,$2,$3) returning id', [empresa, canal, randomUUID()])).rows[0]!.id;
    woo = await cuenta('woocommerce'); ml = await cuenta('mercadolibre');
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.matcher_decisions, catalog.external_representations,
      catalog.sellable_variants, catalog.product_models CASCADE;
      DELETE FROM integrations.dead_letters; DELETE FROM integrations.inbox_messages; DELETE FROM integrations.reconciliation_signals;
      DROP TRIGGER IF EXISTS falla_inyectada ON catalog.identity_cases;`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  describe('Woo', () => {
    it('un simple con SKU canónico crea modelo, variante con su SKU y representación', async () => {
      const id = await encolar(woo, 'woo.products', '101', { id: 101, type: 'simple', status: 'publish', name: 'Cadena', sku: 'FB-101' });
      const r = await proyector().unaVuelta();
      expect(r).toMatchObject({ reclamados: 1, aplicados: 1, errores: 0, detenido: null });
      expect(await estadoMensaje(id)).toBe('succeeded');
      expect(await q('SELECT origen, clave_origen, titulo FROM catalog.product_models')).toEqual([{ origen: 'woo_simple', clave_origen: '101', titulo: 'Cadena' }]);
      expect(await q('SELECT sku FROM catalog.sellable_variants')).toEqual([{ sku: 'FB-101' }]);
      expect(await q('SELECT recurso, variacion_normalizada, tipo, sku_observado FROM catalog.external_representations'))
        .toEqual([{ recurso: '101', variacion_normalizada: '', tipo: 'vendible', sku_observado: 'FB-101' }]);
      expect(await casos()).toEqual([]);
    });

    it('un variable y su variación: contenedor en el padre y variante colgada del mismo modelo', async () => {
      await encolar(woo, 'woo.products', '200', { id: 200, type: 'variable', name: 'Cubierta', status: 'publish' });
      await encolar(woo, 'woo.products', '201', { id: 201, parent_id: 200, type: 'variation', name: 'Cubierta - 29', sku: 'FB-201' });
      await proyector().unaVuelta();
      const modelos = await q<{ id: string; titulo: string }>('SELECT id, titulo FROM catalog.product_models');
      expect(modelos).toHaveLength(1);
      // El título es el del padre: la variación no lo pisa.
      expect(modelos[0]!.titulo).toBe('Cubierta');
      expect(await q('SELECT tipo, recurso, variacion_normalizada FROM catalog.external_representations ORDER BY tipo'))
        .toEqual([{ tipo: 'contenedor', recurso: '200', variacion_normalizada: '' }, { tipo: 'vendible', recurso: '200', variacion_normalizada: '201' }]);
      expect(await q('SELECT v.sku, v.model_id = $1 AS mismo FROM catalog.sellable_variants v', [modelos[0]!.id]))
        .toEqual([{ sku: 'FB-201', mismo: true }]);
    });

    it('sin SKU abre woo_sin_sku, y cuando aparece el canónico se asigna y el caso se cierra', async () => {
      await encolar(woo, 'woo.products', '300', { id: 300, type: 'simple', sku: '' });
      await proyector().unaVuelta();
      expect(await casos()).toEqual([{ tipo: 'woo_sin_sku', prioridad: 'normal' }]);
      expect(await q('SELECT sku FROM catalog.sellable_variants')).toEqual([{ sku: null }]);
      await encolar(woo, 'woo.products', '300', { id: 300, type: 'simple', sku: 'FB-300' });
      await proyector().unaVuelta();
      expect(await q('SELECT sku FROM catalog.sellable_variants')).toEqual([{ sku: 'FB-300' }]);
      expect(await casos()).toEqual([]);
    });

    it('SKU no canónico abre caso y no asigna nada', async () => {
      await encolar(woo, 'woo.products', '310', { id: 310, type: 'simple', sku: 'CAD-9' });
      await proyector().unaVuelta();
      expect(await casos()).toEqual([{ tipo: 'woo_sku_no_canonico', prioridad: 'normal' }]);
      expect(await q('SELECT sku FROM catalog.sellable_variants')).toEqual([{ sku: null }]);
    });

    it('un canónico que otro producto también muestra queda duplicado, sin asignar', async () => {
      // El 410 tiene cargado FB-400 por error; cuando llega el 400 con su canónico, está repetido en Woo.
      await encolar(woo, 'woo.products', '410', { id: 410, type: 'simple', sku: 'FB-400' });
      await encolar(woo, 'woo.products', '400', { id: 400, type: 'simple', sku: 'FB-400' });
      await proyector().unaVuelta();
      expect((await casos()).map((c) => c.tipo)).toEqual(['woo_sku_duplicado', 'woo_sku_no_canonico']);
      expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants WHERE sku IS NOT NULL')).toEqual([{ n: 0 }]);
    });
  });

  describe('ML', () => {
    it('sin decisión: variante con SKU pendiente bajo su propio modelo y caso sku_pendiente', async () => {
      await encolar(ml, 'ml.items', 'MLA1', { id: 'MLA1', title: 'Casco', status: 'active' });
      await proyector().unaVuelta();
      expect(await q('SELECT origen FROM catalog.product_models')).toEqual([{ origen: 'ml_simple' }]);
      expect(await q('SELECT sku FROM catalog.sellable_variants')).toEqual([{ sku: null }]);
      expect(await casos()).toEqual([{ tipo: 'sku_pendiente', prioridad: 'normal' }]);
    });

    it('con decisión a un SKU que existe: cuelga de la variante de Woo, sin modelo propio', async () => {
      await encolar(woo, 'woo.products', '500', { id: 500, type: 'simple', sku: 'FB-500', name: 'Pedal' });
      await proyector().unaVuelta();
      await decision('MLA5', '', 'confirmar', 'FB-500');
      await encolar(ml, 'ml.items', 'MLA5', { id: 'MLA5', title: 'Pedal ML', status: 'active' });
      await proyector().unaVuelta();
      expect(await q('SELECT origen FROM catalog.product_models')).toEqual([{ origen: 'woo_simple' }]);
      expect(await q(`SELECT count(DISTINCT variant_id)::int n FROM catalog.external_representations`)).toEqual([{ n: 1 }]);
      expect(await casos()).toEqual([]);
    });

    it('con decisión a un SKU que no está en Woo: pendiente y caso sku_inexistente_en_woo', async () => {
      await decision('MLA6', '', 'asignar', 'FB-999');
      await encolar(ml, 'ml.items', 'MLA6', { id: 'MLA6', status: 'active' });
      await proyector().unaVuelta();
      expect(await casos()).toEqual([{ tipo: 'sku_inexistente_en_woo', prioridad: 'normal' }]);
    });

    it('con omitir: representación omitida sin variante y caso de baja prioridad', async () => {
      await decision('MLA7', '', 'omitir', null);
      await encolar(ml, 'ml.items', 'MLA7', { id: 'MLA7', status: 'active' });
      await proyector().unaVuelta();
      expect(await q('SELECT omitida_por_decision, variant_id FROM catalog.external_representations'))
        .toEqual([{ omitida_por_decision: true, variant_id: null }]);
      expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants')).toEqual([{ n: 0 }]);
      expect(await casos()).toEqual([{ tipo: 'omitida_revisar', prioridad: 'baja' }]);
    });

    it('un clásico con variaciones: contenedor y una vendible por variación', async () => {
      await encolar(ml, 'ml.items', 'MLA8', { id: 'MLA8', title: 'Remera', variations: [{ id: 1 }, { id: 2 }] });
      await proyector().unaVuelta();
      expect(await q('SELECT tipo, variacion_normalizada FROM catalog.external_representations ORDER BY tipo, variacion_normalizada'))
        .toEqual([{ tipo: 'contenedor', variacion_normalizada: '' }, { tipo: 'vendible', variacion_normalizada: '1' }, { tipo: 'vendible', variacion_normalizada: '2' }]);
      expect((await casos()).map((c) => c.tipo)).toEqual(['sku_pendiente', 'sku_pendiente']);
    });

    it('dos publicaciones con el mismo user_product_id en variantes distintas abren un caso', async () => {
      await encolar(ml, 'ml.items', 'MLA10', { id: 'MLA10', user_product_id: 'MLAU1' });
      await encolar(ml, 'ml.items', 'MLA11', { id: 'MLA11', user_product_id: 'MLAU1' });
      await proyector().unaVuelta();
      expect((await casos('user_product_divergente'))).toHaveLength(1);
      // Y no se fusionaron: siguen siendo dos variantes.
      expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants')).toEqual([{ n: 2 }]);
    });
  });

  describe('orden, idempotencia y archivo', () => {
    it('el mismo recurso dos veces no duplica nada', async () => {
      const p = { id: 600, type: 'simple', sku: 'FB-600' };
      await encolar(woo, 'woo.products', '600', p);
      await encolar(woo, 'woo.products', '600', p);
      await proyector().unaVuelta();
      expect(await q(`SELECT (SELECT count(*) FROM catalog.product_models)::int m, (SELECT count(*) FROM catalog.sellable_variants)::int v,
                             (SELECT count(*) FROM catalog.external_representations)::int r`)).toEqual([{ m: 1, v: 1, r: 1 }]);
    });

    it('una publicación de ML vista dos veces conserva su variante pendiente, no crea otra', async () => {
      await encolar(ml, 'ml.items', 'MLA20', { id: 'MLA20', status: 'active' });
      await proyector().unaVuelta();
      await encolar(ml, 'ml.items', 'MLA20', { id: 'MLA20', status: 'paused' });
      await proyector().unaVuelta();
      expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants')).toEqual([{ n: 1 }]);
      expect(await casos()).toEqual([{ tipo: 'sku_pendiente', prioridad: 'normal' }]);
      expect(await q('SELECT estado_remoto FROM catalog.external_representations')).toEqual([{ estado_remoto: 'paused' }]);
    });

    it('una versión más vieja que la ya vista no pisa', async () => {
      await encolar(woo, 'woo.products', '700', { id: 700, type: 'simple', status: 'publish' }, { version: '2026-09-18T12:00:00Z' });
      await proyector().unaVuelta();
      await encolar(woo, 'woo.products', '700', { id: 700, type: 'simple', status: 'draft' }, { version: '2026-09-18T11:00:00Z' });
      await proyector().unaVuelta();
      expect(await q('SELECT estado_remoto, version_remota FROM catalog.external_representations'))
        .toEqual([{ estado_remoto: 'publish', version_remota: '2026-09-18T12:00:00Z' }]);
    });

    it('la papelera archiva con motivo y la reaparición desarchiva', async () => {
      await encolar(woo, 'woo.products', '800', { id: 800, type: 'simple', status: 'trash' });
      await proyector().unaVuelta();
      expect(await q('SELECT motivo_archivo FROM catalog.external_representations')).toEqual([{ motivo_archivo: 'en la papelera de Woo' }]);
      expect(await q('SELECT motivo_archivo FROM catalog.product_models')).toEqual([{ motivo_archivo: 'en la papelera de Woo' }]);
      await encolar(woo, 'woo.products', '800', { id: 800, type: 'simple', status: 'publish' });
      await proyector().unaVuelta();
      expect(await q('SELECT archivado_en, motivo_archivo FROM catalog.external_representations')).toEqual([{ archivado_en: null, motivo_archivo: null }]);
      expect(await q('SELECT archivado_en FROM catalog.product_models')).toEqual([{ archivado_en: null }]);
    });

    it('archivar una variación no archiva al padre', async () => {
      await encolar(woo, 'woo.products', '900', { id: 900, type: 'variable', status: 'publish' });
      await encolar(woo, 'woo.products', '901', { id: 901, parent_id: 900, type: 'variation', status: 'trash' });
      await proyector().unaVuelta();
      expect(await q('SELECT archivado_en FROM catalog.product_models')).toEqual([{ archivado_en: null }]);
    });
  });

  describe('el bucle', () => {
    it('una falla después de escribir el catálogo deshace todo y el mensaje no se cierra', async () => {
      // Falla inyectada DESPUÉS de que aplicar ya escribió modelo y variante: el caso es lo último.
      await admin.query(`CREATE OR REPLACE FUNCTION catalog.falla() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'falla inyectada'; END $$;
        CREATE TRIGGER falla_inyectada BEFORE INSERT ON catalog.identity_cases FOR EACH ROW EXECUTE FUNCTION catalog.falla();`);
      const id = await encolar(woo, 'woo.products', '1000', { id: 1000, type: 'simple', sku: '' });
      const r = await proyector().unaVuelta();
      expect(r.errores).toBe(1);
      expect(await q(`SELECT (SELECT count(*) FROM catalog.product_models)::int m, (SELECT count(*) FROM catalog.sellable_variants)::int v`))
        .toEqual([{ m: 0, v: 0 }]);
      // Vuelve a la cola para reintentar, no queda cerrado.
      expect(await estadoMensaje(id)).toBe('retryable');
    });

    it('el canario se detiene exactamente en el tope y lo deja en la auditoría', async () => {
      for (let i = 0; i < 5; i++) await encolar(woo, 'woo.products', String(1100 + i), { id: 1100 + i, type: 'simple', sku: `FB-${1100 + i}` });
      const p = proyector({ canario: 3, lote: 2 });
      await p.unaVuelta();
      const r = await p.unaVuelta();
      expect(p.procesados).toBe(3);
      expect(r.detenido).toMatch(/canario de 3/);
      expect(await q("SELECT count(*)::int n FROM integrations.inbox_messages WHERE status = 'pending'")).toEqual([{ n: 2 }]);
      // Detenido, no reclama más.
      expect((await p.unaVuelta()).reclamados).toBe(0);
      // La auditoría no se limpia entre casos (es append-only): se cuenta sólo la detención de este canario.
      expect(await q("SELECT count(*)::int n FROM audit.audit_events WHERE action = 'catalogo.proyector_detenido' AND reason LIKE 'canario de 3%'"))
        .toEqual([{ n: 1 }]);
    });

    it('si falla más que el umbral en una vuelta, se detiene', async () => {
      // Sobres cifrados con otra clave: no se pueden descifrar.
      for (let i = 0; i < 3; i++) await encolar(woo, 'woo.products', String(1200 + i), { id: 1200 + i, type: 'simple' }, { keyring: otroKeyring });
      const p = proyector();
      const r = await p.unaVuelta();
      expect(r.errores).toBe(3);
      expect(r.detenido).toMatch(/umbral/);
    });

    it('un payload vencido pide releer el recurso por señales y cierra el mensaje', async () => {
      const id = await encolar(ml, 'ml.items', 'MLA13', null, { sinPayload: true });
      const r = await proyector().unaVuelta();
      expect(r.vencidos).toBe(1);
      expect(await estadoMensaje(id)).toBe('succeeded');
      expect(await q("SELECT topic, resource_id, source FROM integrations.reconciliation_signals"))
        .toEqual([{ topic: 'ml.items', resource_id: 'MLA13', source: 'payload_expired' }]);
    });

    it('una proyección rechazada va a la DLQ con su causa, no se descarta ni se reintenta', async () => {
      const id = await encolar(woo, 'woo.products', '1300', { id: 1300, type: 'grouped' });
      const r = await proyector().unaVuelta();
      expect(r.rechazados).toBe(1);
      expect(await estadoMensaje(id)).toBe('dead_lettered');
      expect(await q('SELECT reason_code, detail FROM integrations.dead_letters'))
        .toEqual([{ reason_code: 'error_terminal', detail: expect.stringMatching(/grouped/) }]);
    });
  });
});
