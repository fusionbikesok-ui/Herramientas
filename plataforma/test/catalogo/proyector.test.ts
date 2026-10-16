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
import { crearVersion, escribirArbol, mapearCategoria, publicarVersion } from '../../src/catalogo/taxonomia.ts';
import { encolarInbox } from '../../src/colas/colas.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
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
      DELETE FROM integrations.resource_observations;
      DROP TRIGGER IF EXISTS falla_inyectada ON catalog.identity_cases;`);
    await admin.query('DROP TRIGGER IF EXISTS falla_cierre_baja ON integrations.inbox_messages');
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  describe('bajas sintéticas de Woo', () => {
    const observar = (recurso: string, version: string, lifecycle = 'deleted', cuenta?: string) => admin.query(
      `INSERT INTO integrations.resource_observations
       (channel_account_id,topic,resource_id,remote_version,remote_hash,projection_hash,lifecycle)
       VALUES ($1,'woo.products',$2,$3,$4,$4,$5)
       ON CONFLICT (channel_account_id,topic,resource_id) DO UPDATE
       SET remote_version=EXCLUDED.remote_version,lifecycle=EXCLUDED.lifecycle`,
      [cuenta ?? woo, recurso, version, Buffer.alloc(32), lifecycle]);
    const alta = async (id: number, extra = {}) => {
      await encolar(woo, 'woo.products', String(id), { id, type: 'simple', sku: `FB-${id}`, ...extra }, { version: '2026-10-01T00:00:00Z' });
      await proyector().unaVuelta();
    };
    const baja = (id: string, version = 'deleted:123', payload: unknown = { id, lifecycle: 'deleted' }) =>
      encolar(woo, 'woo.products', id, payload, { version });

    it('consume el sobre del motor, archiva sólo Woo y conserva identidad y modelo compartido con ML', async () => {
      await alta(901);
      await decision('MLA901', '', 'confirmar', 'FB-901');
      await encolar(ml, 'ml.items', 'MLA901', { id: 'MLA901', status: 'active' });
      await proyector().unaVuelta();
      const antes = await q('SELECT id,sku,model_id FROM catalog.sellable_variants');
      await observar('901', 'deleted:123');
      const id = await baja('901');
      expect(await proyector().unaVuelta()).toMatchObject({ aplicados: 1, rechazados: 0, errores: 0 });
      expect(await estadoMensaje(id)).toBe('succeeded');
      expect(await q(`SELECT canal,archivado_en IS NOT NULL AS archivada FROM catalog.external_representations ORDER BY canal`))
        .toEqual([{ canal: 'mercadolibre', archivada: false }, { canal: 'woocommerce', archivada: true }]);
      expect(await q('SELECT id,sku,model_id FROM catalog.sellable_variants')).toEqual(antes);
      expect(await q('SELECT archivado_en FROM catalog.product_models')).toEqual([{ archivado_en: null }]);
      expect(await q(`SELECT version_remota FROM catalog.external_representations WHERE canal='woocommerce'`))
        .toEqual([{ version_remota: '2026-10-01T00:00:00Z' }]);
    });

    it('una baja del padre archiva sus representaciones y no permite que un hijo atrasado las reactive', async () => {
      await alta(910, { type: 'variable' });
      await alta(911, { type: 'variation', parent_id: 910 });
      await observar('910', 'deleted:123');
      await baja('910');
      await proyector().unaVuelta();
      await encolar(woo, 'woo.products', '911', { id: 911, parent_id: 910, type: 'variation', sku: 'FB-911' }, { version: '2026-10-02T00:00:00Z' });
      expect(await proyector().unaVuelta()).toMatchObject({ errores: 1, rechazados: 0 });
      expect(await q(`SELECT count(*)::int n FROM catalog.external_representations WHERE archivado_en IS NOT NULL`)).toEqual([{ n: 2 }]);
    });

    it('si la hija reaparece antes del padre conserva el mensaje y reactiva ambos al reconciliarlo', async () => {
      await alta(913, { type: 'variable' });
      await alta(914, { type: 'variation', parent_id: 913 });
      await observar('913', 'deleted:123');
      await baja('913');
      await proyector().unaVuelta();
      await observar('914', '2026-10-03T00:00:00Z', 'open');
      const hija=await encolar(woo, 'woo.products', '914', { id: 914, parent_id: 913, type: 'variation', sku: 'FB-914' }, { version: '2026-10-03T00:00:00Z' });
      expect(await proyector().unaVuelta()).toMatchObject({ errores: 1, aplicados: 0 });
      expect(await estadoMensaje(hija)).toBe('retryable');
      await observar('913', '2026-10-03T00:00:00Z', 'open');
      await encolar(woo, 'woo.products', '913', { id: 913, type: 'variable' }, { version: '2026-10-03T00:00:00Z' });
      await admin.query('UPDATE integrations.inbox_messages SET available_at=now() WHERE id=$1', [hija]);
      expect(await proyector().unaVuelta()).toMatchObject({ aplicados: 2, errores: 0 });
      expect(await estadoMensaje(hija)).toBe('succeeded');
      expect(await q(`SELECT count(*)::int n FROM catalog.external_representations WHERE archivado_en IS NULL`)).toEqual([{ n: 2 }]);
    });

    it('una hija nueva con parent_id textual respeta la baja vigente del padre', async () => {
      await alta(916, { type: 'variable' });
      await observar('916', 'deleted:123');
      await baja('916');
      await proyector().unaVuelta();
      const hija=await encolar(woo, 'woo.products', '917', { id: 917, parent_id: '916', type: 'variation' });
      expect(await proyector().unaVuelta()).toMatchObject({ errores: 1, aplicados: 0 });
      expect(await estadoMensaje(hija)).toBe('retryable');
      expect(await q(`SELECT count(*)::int n FROM catalog.external_representations WHERE variacion_normalizada='917'`)).toEqual([{ n: 0 }]);
    });

    it('doce hijas esperando no detienen al proyector y la misma instancia procesa la restauración', async () => {
      await alta(1200, { type: 'variable' });
      await observar('1200', 'deleted:123');
      await baja('1200');
      await proyector().unaVuelta();
      const ids=[];
      for(let id=1201;id<=1212;id++) ids.push(await encolar(woo,'woo.products',String(id),
        {id,parent_id:1200,type:'variation',sku:`FB-${id}`},{version:'2026-10-03T00:00:00Z'}));
      const p=proyector();
      expect(await p.unaVuelta()).toMatchObject({ reclamados:12, errores:12, detenido:null });
      await observar('1200','2026-10-03T00:00:00Z','open');
      await encolar(woo,'woo.products','1200',{id:1200,type:'variable'},{version:'2026-10-03T00:00:00Z'});
      await admin.query('UPDATE integrations.inbox_messages SET available_at=now() WHERE id=ANY($1::bigint[])',[ids]);
      expect(await p.unaVuelta()).toMatchObject({ aplicados:13, errores:0, detenido:null });
      expect(await q('SELECT count(*)::int n FROM catalog.external_representations WHERE archivado_en IS NULL')).toEqual([{ n:13 }]);
    });

    it('las esperas por padre que agotan intentos sí cuentan para el freno de errores', async () => {
      await observar('1300','deleted:123');
      const ids=[];
      for(let id=1301;id<=1310;id++) ids.push(await encolar(woo,'woo.products',String(id),{id,parent_id:1300,type:'variation'}));
      await admin.query('UPDATE integrations.inbox_messages SET max_attempts=1 WHERE id=ANY($1::bigint[])',[ids]);
      const r=await proyector().unaVuelta();
      expect(r.errores).toBe(10);
      expect(r.detenido).not.toBeNull();
      expect(await q(`SELECT count(*)::int n FROM integrations.inbox_messages WHERE status='dead_lettered'`)).toEqual([{ n:10 }]);
    });

    it('la baja de una variación no archiva al padre ni a sus hermanas', async () => {
      await alta(920, { type: 'variable' });
      await alta(921, { type: 'variation', parent_id: 920 });
      await alta(922, { type: 'variation', parent_id: 920 });
      await observar('921', 'deleted:123');
      await baja('921');
      expect(await proyector().unaVuelta()).toMatchObject({ aplicados: 1, rechazados: 0 });
      expect(await q(`SELECT variacion_normalizada FROM catalog.external_representations WHERE archivado_en IS NOT NULL`))
        .toEqual([{ variacion_normalizada: '921' }]);
    });

    it('al restaurar el padre se reabren las variaciones que archivó su baja', async () => {
      await alta(1010, { type: 'variable' });
      await alta(1011, { type: 'variation', parent_id: 1010 });
      await observar('1010', 'deleted:123');
      await baja('1010');
      await proyector().unaVuelta();
      expect(await q(`SELECT count(*)::int n FROM catalog.external_representations WHERE archivado_en IS NOT NULL`)).toEqual([{ n: 2 }]);
      await observar('1010', '2026-10-03T00:00:00Z', 'open');
      await encolar(woo, 'woo.products', '1010', { id: 1010, type: 'variable' }, { version: '2026-10-03T00:00:00Z' });
      await proyector().unaVuelta();
      expect(await q(`SELECT variacion_normalizada,archivado_en,motivo_archivo FROM catalog.external_representations ORDER BY variacion_normalizada`))
        .toEqual([{ variacion_normalizada: '', archivado_en: null, motivo_archivo: null },
          { variacion_normalizada: '1011', archivado_en: null, motivo_archivo: null }]);
    });

    it('al restaurar el padre no reabre una variación cuya propia observación sigue eliminada', async () => {
      await alta(1020, { type: 'variable' });
      await alta(1021, { type: 'variation', parent_id: 1020 });
      await observar('1021', 'deleted:123');
      await baja('1021');
      await observar('1020', 'deleted:123');
      await baja('1020');
      await proyector().unaVuelta();
      await observar('1020', '2026-10-03T00:00:00Z', 'open');
      await encolar(woo, 'woo.products', '1020', { id: 1020, type: 'variable' }, { version: '2026-10-03T00:00:00Z' });
      await proyector().unaVuelta();
      expect(await q(`SELECT variacion_normalizada FROM catalog.external_representations WHERE archivado_en IS NOT NULL`))
        .toEqual([{ variacion_normalizada: '1021' }]);
    });

    it('tolera una baja sin representación y no crea productos artificiales', async () => {
      await observar('930', 'deleted:123');
      const id = await baja('930');
      expect(await proyector().unaVuelta()).toMatchObject({ aplicados: 1, rechazados: 0 });
      expect(await estadoMensaje(id)).toBe('succeeded');
      expect(await q('SELECT count(*)::int n FROM catalog.product_models')).toEqual([{ n: 0 }]);
    });

    it('restaura con una observación nueva y omite una baja anterior que llega después', async () => {
      await alta(940);
      await observar('940', 'deleted:123');
      await baja('940');
      await proyector().unaVuelta();
      await observar('940', '2026-10-03T00:00:00Z', 'open');
      await encolar(woo, 'woo.products', '940', { id: 940, type: 'simple', sku: 'FB-940' }, { version: '2026-10-03T00:00:00Z' });
      await proyector().unaVuelta();
      await baja('940', 'deleted:122');
      expect(await proyector().unaVuelta()).toMatchObject({ aplicados: 1, rechazados: 0 });
      expect(await q('SELECT archivado_en,version_remota FROM catalog.external_representations'))
        .toEqual([{ archivado_en: null, version_remota: '2026-10-03T00:00:00Z' }]);
    });

    it('omite una proyección vieja mientras la observación sigue eliminada', async () => {
      await alta(950);
      await observar('950', 'deleted:123');
      await baja('950');
      await proyector().unaVuelta();
      await encolar(woo, 'woo.products', '950', { id: 950, type: 'simple', sku: 'FB-950' }, { version: '2026-10-02T00:00:00Z' });
      await proyector().unaVuelta();
      expect(await q('SELECT archivado_en IS NOT NULL AS archivada FROM catalog.external_representations')).toEqual([{ archivada: true }]);
    });

    it('rechaza un aviso cuya identidad no coincide y no archiva otro recurso', async () => {
      await alta(960);
      await observar('960', 'deleted:123');
      const id = await baja('960', 'deleted:123', { id: '961', lifecycle: 'deleted' });
      expect(await proyector().unaVuelta()).toMatchObject({ rechazados: 1, errores: 0 });
      expect(await estadoMensaje(id)).toBe('dead_lettered');
      expect(await q('SELECT archivado_en FROM catalog.external_representations')).toEqual([{ archivado_en: null }]);
    });

    it('no usa una observación de otra cuenta para autorizar una baja', async () => {
      await alta(970);
      await observar('970', 'deleted:123', 'deleted', ml);
      const id = await baja('970');
      expect(await proyector().unaVuelta()).toMatchObject({ rechazados: 1, errores: 0 });
      expect(await estadoMensaje(id)).toBe('dead_lettered');
      expect(await q('SELECT archivado_en FROM catalog.external_representations')).toEqual([{ archivado_en: null }]);
    });

    it('reprocesar el mismo aviso conserva el archivo y no toca la misma identidad de otra cuenta', async () => {
      await alta(980);
      const otra = (await q<{ id: string }>(`INSERT INTO core.channel_accounts(company_id,channel,external_account)
        VALUES ($1,'woocommerce',$2) RETURNING id`, [empresa, randomUUID()]))[0]!.id;
      await encolar(otra, 'woo.products', '980', { id: 980, type: 'simple' });
      await proyector().unaVuelta();
      await observar('980', 'deleted:123');
      const id = await baja('980');
      await proyector().unaVuelta();
      const antes = await q(`SELECT id,archivado_en,motivo_archivo FROM catalog.external_representations ORDER BY id`);
      await admin.query(`UPDATE integrations.inbox_messages SET status='pending' WHERE id=$1`, [id]);
      expect(await proyector().unaVuelta()).toMatchObject({ aplicados: 1, rechazados: 0 });
      expect(await q(`SELECT id,archivado_en,motivo_archivo FROM catalog.external_representations ORDER BY id`)).toEqual(antes);
      expect(await q(`SELECT archivado_en FROM catalog.external_representations WHERE channel_account_id=$1`, [otra]))
        .toEqual([{ archivado_en: null }]);
    });

    it('si falla el cierre del inbox, revierte el archivo; el reintento aplica ambos juntos', async () => {
      await alta(990);
      await observar('990', 'deleted:123');
      const id = await baja('990');
      await admin.query(`CREATE OR REPLACE FUNCTION integrations.falla_cierre_baja() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'cierre de baja inyectado'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER falla_cierre_baja BEFORE UPDATE ON integrations.inbox_messages FOR EACH ROW EXECUTE FUNCTION integrations.falla_cierre_baja()`);
      expect(await proyector().unaVuelta()).toMatchObject({ errores: 1, aplicados: 0 });
      expect(await estadoMensaje(id)).toBe('retryable');
      expect(await q('SELECT archivado_en FROM catalog.external_representations')).toEqual([{ archivado_en: null }]);
      await admin.query('DROP TRIGGER falla_cierre_baja ON integrations.inbox_messages');
      await admin.query('UPDATE integrations.inbox_messages SET available_at=now() WHERE id=$1', [id]);
      expect(await proyector().unaVuelta()).toMatchObject({ aplicados: 1, errores: 0 });
      expect(await estadoMensaje(id)).toBe('succeeded');
      expect(await q('SELECT archivado_en IS NOT NULL AS archivada FROM catalog.external_representations')).toEqual([{ archivada: true }]);
    });
  });

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

    it('dos proyectores con versiones distintas de un recurso NUEVO: una sola variante y gana la más nueva', async () => {
      for (let i = 0; i < 5; i++) {
        const id = 1500 + i;
        await encolar(woo, 'woo.products', String(id), { id, type: 'simple', status: 'draft', sku: '' }, { version: '2026-09-18T12:00:00Z' });
        await encolar(woo, 'woo.products', String(id), { id, type: 'simple', status: 'publish', sku: '' }, { version: '2026-09-18T13:00:00Z' });
        // Dos workers, cada uno reclama un mensaje: las dos transacciones se cruzan sobre un recurso que no existe.
        await Promise.all([proyector({ lote: 1 }).unaVuelta(), proyector({ lote: 1 }).unaVuelta()]);
        expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants v JOIN catalog.external_representations r ON r.variant_id = v.id WHERE r.recurso = $1', [String(id)]))
          .toEqual([{ n: 1 }]);
        expect(await q('SELECT estado_remoto FROM catalog.external_representations WHERE recurso = $1', [String(id)])).toEqual([{ estado_remoto: 'publish' }]);
      }
      // Ninguna variante huérfana: todas tienen su publicación.
      expect(await q('SELECT count(*)::int n FROM catalog.sellable_variants v WHERE NOT EXISTS (SELECT 1 FROM catalog.external_representations r WHERE r.variant_id = v.id)'))
        .toEqual([{ n: 0 }]);
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

    it('si los últimos mensajes fallan más que el umbral, se detiene; los rechazos también cuentan', async () => {
      // Sobres cifrados con otra clave (no se pueden descifrar) y productos agrupados (rechazados).
      for (let i = 0; i < 6; i++) await encolar(woo, 'woo.products', String(1200 + i), { id: 1200 + i, type: 'simple' }, { keyring: otroKeyring });
      for (let i = 0; i < 6; i++) await encolar(woo, 'woo.products', String(1210 + i), { id: 1210 + i, type: 'grouped' });
      const r = await proyector().unaVuelta();
      expect(r.errores + r.rechazados).toBe(12);
      expect(r.detenido).toMatch(/umbral/);
    });

    it('un fallo suelto no detiene el proyector: el umbral necesita al menos diez mensajes', async () => {
      await encolar(woo, 'woo.products', '1250', { id: 1250, type: 'grouped' });
      const p = proyector();
      expect((await p.unaVuelta()).detenido).toBeNull();
      await encolar(woo, 'woo.products', '1251', { id: 1251, type: 'simple', sku: 'FB-1251' });
      expect(await p.unaVuelta()).toMatchObject({ aplicados: 1, detenido: null });
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

  describe('6b: clasificar al ingerir', () => {
    let cubiertas: string; let camaras: string;

    beforeEach(async () => {
      await admin.query(`TRUNCATE catalog.channel_categories, catalog.taxonomy_channel_map, catalog.model_categories,
        catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes, catalog.model_attributes CASCADE`);
      await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre) VALUES
        ($1, $2, 'woocommerce', 'C1', 'CUBIERTAS'), ($1, $2, 'woocommerce', 'C2', 'CAMARAS')`, [empresa, woo]);
      await enTransaccion(app, async (tx) => {
        const v = await crearVersion(tx, empresa, 'test');
        const nodos = await escribirArbol(tx, empresa, v.id, [
          { clave: 'cubiertas', nombre: 'CUBIERTAS', padre: null }, { clave: 'camaras', nombre: 'CAMARAS', padre: null },
        ]);
        await publicarVersion(tx, empresa, v.id);
        cubiertas = nodos.get('cubiertas')!; camaras = nodos.get('camaras')!;
        await mapearCategoria(tx, empresa, cubiertas, woo, 'woocommerce', 'C1', 'jose');
        await mapearCategoria(tx, empresa, camaras, woo, 'woocommerce', 'C2', 'jose');
      });
    });

    const modeloDe = async (recurso: string) => (await q<{ model_id: string }>(
      `SELECT model_id FROM catalog.external_representations WHERE channel_account_id = $1 AND recurso = $2`, [woo, recurso]))[0]!.model_id;
    const claveVigente = async (m: string) => (await q<{ clave: string; primaria: boolean }>(
      `SELECT n.clave, c.primaria FROM catalog.model_categories c JOIN catalog.taxonomy_nodes n ON n.id = c.node_id
        WHERE c.model_id = $1 AND c.quitado_en IS NULL ORDER BY n.clave`, [m]));

    it('un producto con categoría mapeada queda clasificado primario al ingerir', async () => {
      await encolar(woo, 'woo.products', '2000', {
        id: 2000, type: 'simple', sku: 'FB-2000', categories: [{ id: 'C1', name: 'CUBIERTAS' }],
      });
      await proyector().unaVuelta();
      const m = await modeloDe('2000');
      expect(await claveVigente(m)).toEqual([{ clave: 'cubiertas', primaria: true }]);
      expect(await casos()).toEqual([]);
    });

    it('un producto con categorías en desacuerdo abre el caso al ingerir', async () => {
      await encolar(woo, 'woo.products', '2001', {
        id: 2001, type: 'simple', sku: 'FB-2001',
        categories: [{ id: 'C1', name: 'CUBIERTAS' }, { id: 'C2', name: 'CAMARAS' }],
      });
      await proyector().unaVuelta();
      const m = await modeloDe('2001');
      expect((await q('SELECT tipo FROM catalog.identity_cases WHERE model_id = $1 AND cerrado_en IS NULL', [m])))
        .toEqual([{ tipo: 'categoria_en_desacuerdo' }]);
    });

    it('persona contradicha: la persona decide, después el canal cambia a otra categoría y se abre el caso sin pisar', async () => {
      await encolar(woo, 'woo.products', '2002', { id: 2002, type: 'simple', sku: 'FB-2002', categories: [{ id: 'C1', name: 'CUBIERTAS' }] });
      await proyector().unaVuelta();
      const m = await modeloDe('2002');
      await admin.query(`UPDATE catalog.model_categories SET quitado_en = now(), motivo_salida = 'test' WHERE model_id = $1 AND quitado_en IS NULL`, [m]);
      await admin.query(`INSERT INTO catalog.model_categories (company_id, model_id, node_id, primaria, origen) VALUES ($1, $2, $3, true, 'persona')`,
        [empresa, m, camaras]);
      await encolar(woo, 'woo.products', '2002', { id: 2002, type: 'simple', sku: 'FB-2002', categories: [{ id: 'C1', name: 'CUBIERTAS' }, { id: 'C2', name: 'CAMARAS' }] });
      // Da la misma categoría que ya tenía persona antes: no dispara nada. Ahora cambiamos de verdad:
      await encolar(woo, 'woo.products', '2002', { id: 2002, type: 'simple', sku: 'FB-2002', categories: [{ id: 'C1', name: 'CUBIERTAS' }] });
      await proyector().unaVuelta();
      expect(await claveVigente(m)).toEqual([{ clave: 'camaras', primaria: true }]);
      expect((await q('SELECT tipo, detalle FROM catalog.identity_cases WHERE model_id = $1 AND cerrado_en IS NULL', [m])))
        .toEqual([{ tipo: 'categoria_persona_contradicha', detalle: expect.objectContaining({ persona: ['camaras'] }) }]);
    });

    it('sin cambio de categoria_canal, D24 no abre nada aunque persona y canal difieran', async () => {
      await encolar(woo, 'woo.products', '2003', { id: 2003, type: 'simple', sku: 'FB-2003', categories: [{ id: 'C1', name: 'CUBIERTAS' }] });
      await proyector().unaVuelta();
      const m = await modeloDe('2003');
      await admin.query(`UPDATE catalog.model_categories SET quitado_en = now(), motivo_salida = 'test' WHERE model_id = $1 AND quitado_en IS NULL`, [m]);
      await admin.query(`INSERT INTO catalog.model_categories (company_id, model_id, node_id, primaria, origen) VALUES ($1, $2, $3, true, 'persona')`,
        [empresa, m, camaras]);
      // Mismo recurso, mismos datos: no toca categoria_canal (mismo nombre/valor ya vigente).
      await encolar(woo, 'woo.products', '2003', { id: 2003, type: 'simple', sku: 'FB-2003', categories: [{ id: 'C1', name: 'CUBIERTAS' }], name: 'otro título' });
      await proyector().unaVuelta();
      expect(await claveVigente(m)).toEqual([{ clave: 'camaras', primaria: true }]);
      expect(await q('SELECT tipo FROM catalog.identity_cases WHERE model_id = $1 AND cerrado_en IS NULL', [m])).toEqual([]);
    });

    it('si el canal cambia a lo mismo que ya decidió la persona, el caso se cierra', async () => {
      await encolar(woo, 'woo.products', '2004', { id: 2004, type: 'simple', sku: 'FB-2004', categories: [{ id: 'C1', name: 'CUBIERTAS' }] });
      await proyector().unaVuelta();
      const m = await modeloDe('2004');
      await admin.query(`UPDATE catalog.model_categories SET quitado_en = now(), motivo_salida = 'test' WHERE model_id = $1 AND quitado_en IS NULL`, [m]);
      await admin.query(`INSERT INTO catalog.model_categories (company_id, model_id, node_id, primaria, origen) VALUES ($1, $2, $3, true, 'persona')`,
        [empresa, m, camaras]);
      // Sigue en C1 (CUBIERTAS): eso YA difería de la persona (CAMARAS) cuando persona se decidió, pero recién
      // ahora categoria_canal vuelve a escribirse (mismo valor, pero re-observada) — igual no alcanza para abrir
      // si el valor no cambió realmente. Forzamos un cambio real: C1 -> C2 (coincide con persona) primero no abre nada,
      // y de C2 a C1 (difiere) abre; volver a C2 (coincide) cierra.
      await encolar(woo, 'woo.products', '2004', { id: 2004, type: 'simple', sku: 'FB-2004', categories: [{ id: 'C2', name: 'CAMARAS' }] });
      await proyector().unaVuelta();
      expect(await q('SELECT tipo FROM catalog.identity_cases WHERE model_id = $1 AND cerrado_en IS NULL', [m])).toEqual([]);
      await encolar(woo, 'woo.products', '2004', { id: 2004, type: 'simple', sku: 'FB-2004', categories: [{ id: 'C1', name: 'CUBIERTAS' }] });
      await proyector().unaVuelta();
      expect((await q('SELECT tipo FROM catalog.identity_cases WHERE model_id = $1 AND cerrado_en IS NULL', [m])))
        .toEqual([{ tipo: 'categoria_persona_contradicha' }]);
      await encolar(woo, 'woo.products', '2004', { id: 2004, type: 'simple', sku: 'FB-2004', categories: [{ id: 'C2', name: 'CAMARAS' }] });
      await proyector().unaVuelta();
      expect(await q('SELECT tipo FROM catalog.identity_cases WHERE model_id = $1 AND cerrado_en IS NULL', [m])).toEqual([]);
    });

    it('un error de clasificación no deshace la proyección ya aplicada', async () => {
      // Dos categorías vigentes de Woo con el mismo nombre: clasificarModelos no puede identificar cuál es
      // «CUBIERTAS» y tira («el nombre no identifica y no se adivina»).
      await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre) VALUES
        ($1, $2, 'woocommerce', 'C1B', 'CUBIERTAS')`, [empresa, woo]);
      const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
      await encolar(woo, 'woo.products', '2005', { id: 2005, type: 'simple', sku: 'FB-2005', categories: [{ id: 'C1', name: 'CUBIERTAS' }] });
      const r = await proyector({ log: { error: (obj, msg) => logs.push({ obj, msg }) } }).unaVuelta();
      expect(r).toMatchObject({ aplicados: 1, errores: 0 });
      const m = await modeloDe('2005');
      expect(m).toBeTruthy();
      expect(await q('SELECT sku FROM catalog.sellable_variants WHERE model_id = $1', [m])).toEqual([{ sku: 'FB-2005' }]);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.msg).toMatch(/clasificación/);
    });
  });
});
