/*
 * test/identidad/api-interna.test.ts — E3 corte 1 tarea 5: la API interna de la bandeja, por HTTP y con firma real.
 * Mismo patrón que test/catalogo/api-interna.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApi } from '../../src/api/app.ts';
import { PREFIJO_IDENTIDAD } from '../../src/api/identidad-interna.ts';
import type { Canal } from '../../src/api/senales.ts';
import { crearLogger } from '../../src/comun/logger.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearOrigenes, firmar } from '../../src/seguridad/interna.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const clave = randomBytes(32);
const keyring = { activeKeyId: 'k1', keys: { k1: clave } };

describe('E3-API-01 API interna de la bandeja de identidad', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  let cuentas: Map<Canal, string>; let empresa: string; let ml: string;
  const api = (bandejaCatalogo = true) => crearApi({
    pool, logger: crearLogger('test'), estadoPgDir: '/nada',
    senales: { keyring, origenes: crearOrigenes('127.0.0.1/32'), cuentas }, bandejaCatalogo,
  });
  const cabeceras = (metodo: string, path: string, cuerpo: string, nonce = randomBytes(16).toString('base64url'), extra: Record<string, string> = {}) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { 'content-type': 'application/json', 'x-fusion-key-id': 'k1', 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
      'x-fusion-signature': firmar(clave, ts, nonce, metodo, path, Buffer.from(cuerpo)), ...extra };
  };
  /** GET firmado: el legado firma la URL completa, con la query. */
  const get = async (url: string, o: { nonce?: string; firmar?: boolean } = {}) => {
    const h = o.firmar === false ? {} : cabeceras('GET', url, '', o.nonce);
    const r = await api().inject({ method: 'GET', url, headers: h, remoteAddress: '127.0.0.1' });
    return { status: r.statusCode, body: r.json() as any, texto: r.body };
  };
  const post = async (path: string, cuerpo: unknown, o: { idem?: string | null; bandeja?: boolean; corr?: string } = {}) => {
    const texto = JSON.stringify(cuerpo);
    const extra: Record<string, string> = {};
    if (o.idem !== null) extra['idempotency-key'] = o.idem ?? randomUUID();
    if (o.corr) extra['x-correlation-id'] = o.corr;
    const r = await api(o.bandeja ?? true).inject({ method: 'POST', url: path, payload: texto, headers: cabeceras('POST', path, texto, undefined, extra), remoteAddress: '127.0.0.1' });
    return { status: r.statusCode, body: r.json() as any };
  };
  const actor = { usuario: 'jose', es_admin: false };

  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','x') returning id", [empresa])).rows[0]!.id;
    cuentas = new Map([['mercadolibre', ml]]);
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.identity_candidates, catalog.identity_evidence,
      catalog.model_attributes, catalog.model_images, catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });

  async function variante(titulo: string, sku: string | null = null, archivada = false) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $4) RETURNING id`, [empresa, ml, randomUUID(), titulo])).rows[0]!.id;
    const v = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.sellable_variants (company_id, model_id, sku, archivado_en, motivo_archivo)
       VALUES ($1, $2, $3, ${archivada ? 'now()' : 'NULL'}, ${archivada ? "'test'" : 'NULL'}) RETURNING id`, [empresa, modelo, sku])).rows[0]!.id;
    return { modelo, variante: v };
  }
  /** Una publicación de ML con su variante pendiente y un caso abierto que cuelga de la variante (como el motor real). */
  async function caso(recurso: string, o: { estado?: string; detalle?: object; activa?: boolean; abierto?: string } = {}) {
    const { modelo, variante: v } = await variante(`Bici ${recurso}`);
    await admin.query(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id, model_id, estado_remoto, stock_canal)
       VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4, NULL, $5, $6)`, [empresa, ml, recurso, v, o.activa ? 'active' : 'paused', o.activa ? 3 : 0]); // model_id NULL como en producción
    const id = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id, estado, detalle, abierto_en)
       VALUES ($1, 'sku_pendiente', $2, $3, $4::jsonb, $5::timestamptz) RETURNING id`,
      [empresa, v, o.estado ?? 'actionable', JSON.stringify(o.detalle ?? {}), o.abierto ?? new Date().toISOString()])).rows[0]!.id;
    return { id, variante: v, modelo };
  }

  it('sin firma: 401', async () => {
    expect((await get(`${PREFIJO_IDENTIDAD}/casos`, { firmar: false })).status).toBe(401);
  });

  it('un nonce repetido se rechaza (401)', async () => {
    const nonce = randomBytes(16).toString('base64url');
    expect((await get(`${PREFIJO_IDENTIDAD}/casos`, { nonce })).status).toBe(200);
    expect((await get(`${PREFIJO_IDENTIDAD}/casos`, { nonce })).status).toBe(401);
  });

  it('la query va firmada: cambiarla después de firmar invalida la firma', async () => {
    const h = cabeceras('GET', `${PREFIJO_IDENTIDAD}/casos?limit=1`, '');
    const r = await api().inject({ method: 'GET', url: `${PREFIJO_IDENTIDAD}/casos?limit=200`, headers: h, remoteAddress: '127.0.0.1' });
    expect(r.statusCode).toBe(401);
  });

  it('la cola sale en orden de prioridad (conflicto → D5 → auto_sku en sombra → activa con stock → resto) y se pagina por cursor', async () => {
    // Se crean en orden inverso al de prioridad, con abierto_en creciente: el orden sólo puede venir de la prioridad.
    const resto = await caso('MLA5', { abierto: '2026-01-01T00:00:00Z' });
    const activa = await caso('MLA4', { activa: true, abierto: '2026-01-02T00:00:00Z' });
    const conSombra = await caso('MLA3', { abierto: '2026-01-03T00:00:00Z' });
    await admin.query(
      `INSERT INTO catalog.identity_decisions (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto)
       VALUES ($1, $2, $3, 'MLA3', '', 'vincular', $4, 'auto_sku', 'motor', 'sombra')`, [empresa, conSombra.id, ml, (await variante('Destino', 'FB-9')).variante]);
    const d5 = await caso('MLA2', { detalle: { d5: true }, abierto: '2026-01-04T00:00:00Z' });
    const conflicto = await caso('MLA1', { estado: 'conflict', abierto: '2026-01-05T00:00:00Z' });
    const esperado = [conflicto.id, d5.id, conSombra.id, activa.id, resto.id];

    const todo = await get(`${PREFIJO_IDENTIDAD}/casos`);
    expect(todo.status).toBe(200);
    expect(todo.body.casos.map((c: any) => c.id)).toEqual(esperado);
    expect(todo.body.casos.map((c: any) => c.grupo)).toEqual([0, 1, 2, 3, 4]);
    expect(todo.body.casos[0].publicacion).toMatchObject({ recurso: 'MLA1', link_ml: 'https://articulo.mercadolibre.com.ar/MLA-1' });
    expect(todo.body.siguiente).toBeNull();
    expect(todo.body.contadores).toEqual({ conflictos: 1, d5: 1, sku_exacto: 1, activas_con_stock: 1, resto: 1, no_decidibles: 0 });

    const juntas: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const p = await get(`${PREFIJO_IDENTIDAD}/casos?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      juntas.push(...p.body.casos.map((c: any) => c.id));
      cursor = p.body.siguiente;
      if (!cursor) break;
    }
    expect(juntas).toEqual(esperado);
    expect((await get(`${PREFIJO_IDENTIDAD}/casos?cursor=basura`)).status).toBe(422);
    // Filtro por grupo (chips de la pantalla): sólo ese grupo, contadores intactos, y grupo inválido → 422.
    const soloD5 = await get(`${PREFIJO_IDENTIDAD}/casos?grupo=1`);
    expect(soloD5.body.casos.map((c: any) => c.id)).toEqual([d5.id]);
    expect(soloD5.body.contadores.resto).toBe(1);
    expect((await get(`${PREFIJO_IDENTIDAD}/casos?grupo=9`)).status).toBe(422);
  });

  it('un caso abierto sin publicación única no sale en la cola pero se cuenta en no_decidibles', async () => {
    const { variante: v } = await variante('Huérfana');
    await admin.query(`INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2)`, [empresa, v]);
    const r = await get(`${PREFIJO_IDENTIDAD}/casos`);
    expect(r.body.casos).toEqual([]);
    expect(r.body.contadores).toMatchObject({ no_decidibles: 1, resto: 0 });
  });

  it('un caso con representation_id hacia una representación archivada no sale en la cola y suma en no_decidibles', async () => {
    const { modelo, variante: v } = await variante('Archivada');
    const rep = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id, model_id, archivado_en, motivo_archivo)
       VALUES ($1, $2, 'mercadolibre', 'vendible', 'MLA99', '', $3, $4, now(), 'test') RETURNING id`, [empresa, ml, v, modelo])).rows[0]!.id;
    await admin.query(`INSERT INTO catalog.identity_cases (company_id, tipo, representation_id) VALUES ($1, 'sku_pendiente', $2)`, [empresa, rep]);
    const r = await get(`${PREFIJO_IDENTIDAD}/casos`);
    expect(r.body.casos).toEqual([]);
    expect(r.body.contadores).toMatchObject({ no_decidibles: 1, resto: 0 });
  });

  it('una cuenta configurada que no existe en la base: 409 cuenta_no_configurada (no 500)', async () => {
    const url = `${PREFIJO_IDENTIDAD}/casos`;
    const app = crearApi({ pool, logger: crearLogger('test'), estadoPgDir: '/nada', bandejaCatalogo: true,
      senales: { keyring, origenes: crearOrigenes('127.0.0.1/32'), cuentas: new Map([['mercadolibre', randomUUID()]]) } });
    const r = await app.inject({ method: 'GET', url, headers: cabeceras('GET', url, ''), remoteAddress: '127.0.0.1' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'cuenta_no_configurada' });
  });

  it('el detalle trae publicación, top-3 con la marca por atributo, historial y version; NUNCA el puntaje', async () => {
    const c = await caso('MLA7');
    const cand = await variante('Casco Bell Negro', 'FB-77');
    const run = randomUUID();
    await admin.query(
      `INSERT INTO catalog.identity_candidates (case_id, run_id, variant_id, rank, puntaje, explicacion, engine_version)
       VALUES ($1, $2, $3, 1, 0.91, $4::jsonb, 'v1')`,
      [c.id, run, cand.variante, JSON.stringify({ atributos: [{ nombre: 'color', marca: 'coincide', valorMl: 'negro', valorCandidato: 'negro' }] })]);
    await admin.query(
      `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
       SELECT $1, r.id, 'marca', 'Bell', now() FROM catalog.external_representations r WHERE r.recurso = 'MLA7'`, [c.modelo]);
    const d = await get(`${PREFIJO_IDENTIDAD}/casos/${c.id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ id: c.id, version: 1, tipo: 'sku_pendiente', publicacion: { recurso: 'MLA7', titulo: 'Bici MLA7' } });
    expect(d.body.candidatos).toHaveLength(1);
    expect(d.body.candidatos[0]).toMatchObject({ rank: 1, sku: 'FB-77', titulo: 'Casco Bell Negro',
      explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }], otros_atributos: [{ nombre: 'marca', marca: 'difiere', valorMl: 'Bell', valorCandidato: '' }] } });
    expect(d.texto).not.toContain('puntaje');
    expect(d.body.historial).toEqual([]);
    expect(d.body.auto_sku_en_sombra).toBeNull();
    expect((await get(`${PREFIJO_IDENTIDAD}/casos/${randomUUID()}`)).status).toBe(404);
  });

  it('POST sin Idempotency-Key: 422', async () => {
    const c = await caso('MLA8');
    const r = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, { expected_version: 1, eleccion: 'omitir', actor }, { idem: null });
    expect(r).toMatchObject({ status: 422, body: { code: 'idempotency_key_requerida' } });
  });

  it('POST con un campo de más (zod strict): 422', async () => {
    const c = await caso('MLA8');
    const r = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, { expected_version: 1, eleccion: 'omitir', actor, extra: 1 });
    expect(r.status).toBe(422);
  });

  it('POST con una versión vieja: 409 version_conflict con la versión actual y el correlation_id', async () => {
    const c = await caso('MLA9');
    const corr = randomUUID();
    const r = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, { expected_version: 99, eleccion: 'omitir', actor }, { corr });
    expect(r).toMatchObject({ status: 409, body: { code: 'version_conflict', correlation_id: corr, details: { version_actual: 1 } } });
  });

  it('POST con el flag apagado: 503 bandeja_apagada', async () => {
    const c = await caso('MLA10');
    const r = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, { expected_version: 1, eleccion: 'omitir', actor }, { bandeja: false });
    expect(r).toMatchObject({ status: 503, body: { code: 'bandeja_apagada' } });
  });

  it('POST decide de verdad: omitir → 200, la versión sube y el reintento con la misma clave devuelve lo mismo', async () => {
    const c = await caso('MLA11');
    const idem = randomUUID();
    const cuerpo = { expected_version: 1, eleccion: 'omitir', actor };
    const a = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, cuerpo, { idem });
    expect(a.status).toBe(200);
    expect(a.body.version).toBe(2);
    const b = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, cuerpo, { idem });
    expect(b).toMatchObject({ status: 200, body: { decision_id: a.body.decision_id, version: 2 } });
    const otro = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, { ...cuerpo, motivo: 'distinto' }, { idem });
    expect(otro).toMatchObject({ status: 422, body: { code: 'idempotency_mismatch' } });
  });

  it('revertir sin ser admin lo de otro: 403 solo_admin', async () => {
    const c = await caso('MLA12');
    const a = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`, { expected_version: 1, eleccion: 'omitir', actor });
    expect(a.status).toBe(200);
    const r = await post(`${PREFIJO_IDENTIDAD}/casos/${c.id}/decisiones`,
      { expected_version: 2, eleccion: 'sin_candidato', revierte: a.body.decision_id, actor: { usuario: 'maria', es_admin: false } });
    expect(r).toMatchObject({ status: 403, body: { code: 'solo_admin' } });
  });

  it('buscar otra variante: SKU exacto primero, luego por título; sin archivadas; escapa los comodines', async () => {
    await variante('Bicicleta Rodado 29', 'FB-100');
    await variante('Casco FB-100 edición', 'FB-200');
    await variante('Bicicleta archivada', 'FB-300', true);
    await variante('Cubierta 100% goma', 'FB-400');
    const exacto = await get(`${PREFIJO_IDENTIDAD}/variantes?q=FB-100`);
    expect(exacto.body.variantes.map((v: any) => v.sku)).toEqual(['FB-100', 'FB-200']);
    const porTitulo = await get(`${PREFIJO_IDENTIDAD}/variantes?q=bicicleta`);
    expect(porTitulo.body.variantes.map((v: any) => v.sku)).toEqual(['FB-100']);
    expect((await get(`${PREFIJO_IDENTIDAD}/variantes?q=%25`)).body.variantes.map((v: any) => v.sku)).toEqual(['FB-400']);
    // E: el SKU exacto se normaliza (upper/trim), como en el plan.
    expect((await get(`${PREFIJO_IDENTIDAD}/variantes?q=%20fb-100%20`)).body.variantes[0].sku).toBe('FB-100');
    expect((await get(`${PREFIJO_IDENTIDAD}/variantes`)).status).toBe(422);
  });
});
