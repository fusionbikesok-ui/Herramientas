/*
 * test/catalogo/api-interna.test.ts — E2 T1 tarea 7: la API interna por HTTP, con firma real.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApi } from '../../src/api/app.ts';
import { PREFIJO_CATALOGO } from '../../src/api/catalogo-interna.ts';
import type { Canal } from '../../src/api/senales.ts';
import { hashFilas, type FilaDecision } from '../../src/catalogo/copias.ts';
import { crearLogger } from '../../src/comun/logger.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearOrigenes, firmar } from '../../src/seguridad/interna.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
// La traducción real del legado: contrato de punta a punta entre la fila que deja el trigger y la API.
// @ts-expect-error módulo JS del legado sin tipos
import { traducirEvento } from '../../../lib/outboxPlataforma.js';
// @ts-expect-error módulo JS del legado sin tipos
import { enviarCopia, hashFilas as hashLegado } from '../../../lib/catalogoCopia.js';

const clave = randomBytes(32);
const keyring = { activeKeyId: 'k1', keys: { k1: clave } };

describe('E2-CPY-02 API interna del catálogo', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  let cuentas: Map<Canal, string>;
  const api = (c: ReadonlyMap<Canal, string> = cuentas, bandejaCatalogo = false) => crearApi({
    pool, logger: crearLogger('test'), estadoPgDir: '/nada',
    senales: { keyring, origenes: crearOrigenes('127.0.0.1/32'), cuentas: c }, bandejaCatalogo,
  });
  const firmado = (path: string, cuerpo: string, nonce = randomBytes(16).toString('base64url'), k = clave) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { 'content-type': 'application/json', 'x-fusion-key-id': 'k1', 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
      'x-fusion-signature': firmar(k, ts, nonce, 'POST', path, Buffer.from(cuerpo)) };
  };
  const post = async (path: string, cuerpo: unknown,
    o: { nonce?: string; clave?: typeof clave; c?: ReadonlyMap<Canal, string>; bandeja?: boolean } = {}) => {
    const texto = JSON.stringify(cuerpo);
    const r = await api(o.c, o.bandeja).inject({ method: 'POST', url: path, payload: texto, headers: firmado(path, texto, o.nonce, o.clave), remoteAddress: '127.0.0.1' });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  const fila = (recurso: string, sku: string): FilaDecision => ({
    recurso, variacion: '', sku, accion: 'confirmar', actor: 'persona', motivo: null, confirmado_por: 'jose', actualizado_en_legado: null,
  });
  const abrir = (filas: FilaDecision[]) => post(`${PREFIJO_CATALOGO}/copias`, {
    tipo: 'matcher', total_esperado: filas.length, hash_esperado: hashFilas(filas), corte: new Date().toISOString() });

  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    const empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    const ml = (await admin.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','x') returning id", [empresa])).rows[0]!.id;
    cuentas = new Map([['mercadolibre', ml]]);
  });
  beforeEach(async () => { await admin.query('TRUNCATE catalog.matcher_decisions, catalog.copias_lotes, catalog.copias, catalog.eventos_recibidos CASCADE'); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });

  it('el recorrido completo: abrir, dos lotes y confirmar', async () => {
    const filas = [fila('MLA1', 'FB-1'), fila('MLA2', 'FB-2')];
    const a = await abrir(filas);
    expect(a.status).toBe(201);
    const id = a.body.copy_id as string;
    expect((await post(`${PREFIJO_CATALOGO}/copias/${id}/lotes`, { numero: 1, filas: [filas[0]] })).status).toBe(202);
    expect((await post(`${PREFIJO_CATALOGO}/copias/${id}/lotes`, { numero: 2, filas: [filas[1]] })).status).toBe(202);
    const c = await post(`${PREFIJO_CATALOGO}/copias/${id}/confirmar`, {});
    expect(c).toMatchObject({ status: 200, body: { abiertas: 2 } });
    expect((await admin.query('SELECT count(*)::int n FROM catalog.matcher_decisions WHERE vigente_hasta IS NULL')).rows).toEqual([{ n: 2 }]);
  });

  it('confirmar una copia incompleta da 409 y no aplica nada', async () => {
    const filas = [fila('MLA1', 'FB-1'), fila('MLA2', 'FB-2')];
    const id = (await abrir(filas)).body.copy_id as string;
    await post(`${PREFIJO_CATALOGO}/copias/${id}/lotes`, { numero: 1, filas: [filas[0]] });
    expect(await post(`${PREFIJO_CATALOGO}/copias/${id}/confirmar`, {})).toMatchObject({ status: 409, body: { code: 'copia_incompleta' } });
    expect((await admin.query('SELECT count(*)::int n FROM catalog.matcher_decisions')).rows).toEqual([{ n: 0 }]);
  });

  it('una copia que no existe da 404', async () => {
    expect(await post(`${PREFIJO_CATALOGO}/copias/${randomUUID()}/confirmar`, {})).toMatchObject({ status: 404, body: { code: 'copia_inexistente' } });
  });

  it('un lote con una fila mal formada se rechaza entero', async () => {
    const id = (await abrir([fila('MLA1', 'FB-1')])).body.copy_id as string;
    const r = await post(`${PREFIJO_CATALOGO}/copias/${id}/lotes`, { numero: 1, filas: [{ ...fila('MLA1', 'FB-1'), sku: 'SIN-FORMATO' }] });
    expect(r.status).toBe(400);
    expect((await admin.query('SELECT count(*)::int n FROM catalog.copias_lotes')).rows).toEqual([{ n: 0 }]);
  });

  it('un evento se aplica, y reenviado con otra firma se reconoce como repetido', async () => {
    const e = { evento_id: randomUUID(), recurso: 'MLA1', variacion: '', accion: 'confirmar', sku: 'FB-1', actor: 'sistema',
      motivo: 'autoasignación por SKU', confirmado_por: null, ocurrido_en: new Date().toISOString() };
    expect(await post(`${PREFIJO_CATALOGO}/eventos`, e)).toMatchObject({ status: 200, body: { resultado: 'aplicado' } });
    // La outbox reintenta con una firma nueva: el nonce es otro, pero el evento es el mismo.
    expect(await post(`${PREFIJO_CATALOGO}/eventos`, e)).toMatchObject({ status: 200, body: { resultado: 'repetido' } });
  });

  it('CONTRATO: lo que traduce el legado desde las filas del trigger, la API lo acepta', async () => {
    const creado_en = new Date().toISOString();
    const filas = [
      { tipo: 'matcher.decision', payload: { op: 'vigente', clave: 'MLA70|', sku: 'FB-70', accion: 'confirmar', origen: null, confirmado_por: 'jose' } },
      { tipo: 'matcher.decision', payload: { op: 'vigente', clave: 'MLA71|55', sku: 'FB-71', accion: 'asignar', origen: 'auto_seller_sku', confirmado_por: null } },
      { tipo: 'matcher.decision', payload: { op: 'vigente', clave: 'MLA72|', sku: '', accion: 'omitir', origen: null, confirmado_por: null } },
      { tipo: 'matcher.decision', payload: { op: 'borrada', clave: 'MLA70|' } },
      { tipo: 'identidad.caso', payload: { id: 9, ml_key: 'MLA73|', estado: 'pendiente', severidad: 'critica', clasificacion: 'c', direccion: 'ml_fusion' } },
    ];
    for (const f of filas) {
      const { ruta, cuerpo } = traducirEvento({ evento_id: randomUUID(), creado_en, ...f }) as { ruta: string; cuerpo: unknown };
      const r = await post(ruta, cuerpo);
      expect(r.status, `${f.tipo} ${JSON.stringify(f.payload)}`).toBe(200);
    }
  });

  it('CONTRATO: el hash del legado es el mismo que el de la plataforma', () => {
    const filas = [
      { recurso: 'MLA2', variacion: '', sku: null, accion: 'omitir', actor: 'persona', motivo: null, confirmado_por: null, actualizado_en_legado: null },
      { recurso: 'MLA1', variacion: '9', sku: 'FB-1', accion: 'confirmar', actor: 'sistema', motivo: 'autoasignación por SKU — ñ "comillas" \\ 🚲', confirmado_por: null, actualizado_en_legado: '2026-09-18T10:00:00.000Z' },
    ];
    const identidad = [{ caso_legado: '7', recurso: 'MLA3', variacion: '', prioridad: 'urgente', detalle: { z: 1, a: { b: [true, null, 'x'] }, 'ü': 'é' } }];
    expect(hashLegado(filas)).toBe(hashFilas(filas as FilaDecision[]));
    expect(hashLegado(identidad)).toBe(hashFilas(identidad as never));
  });

  it('CONTRATO: la copia completa del legado contra la API real, en varios lotes', async () => {
    // Un fetch que en vez de salir a la red le pega a la app con inject: la firma, las rutas y los cuerpos
    // son los reales del legado.
    const app = api();
    const fetch = async (url: URL, init: { headers: Record<string, string>; body: Buffer }) => {
      const r = await app.inject({ method: 'POST', url: url.pathname, payload: init.body, headers: init.headers, remoteAddress: '127.0.0.1' });
      return { status: r.statusCode, text: async () => r.body };
    };
    const filas = Array.from({ length: 7 }, (_, i) => ({ recurso: `MLA9${i}`, variacion: '', sku: `FB-9${i}`, accion: 'confirmar',
      actor: 'persona', motivo: null, confirmado_por: 'jose', actualizado_en_legado: null }));
    const r = await enviarCopia({ url: 'http://plataforma', keyring, fetch, tipo: 'matcher', filas, corte: new Date(), lote: 3 }) as { resultado: { abiertas: number } };
    expect(r.resultado.abiertas).toBe(7);
    expect((await admin.query("SELECT resultado->>'abiertas' AS a FROM catalog.copias WHERE estado = 'confirmada'")).rows).toEqual([{ a: '7' }]);
  });

  it('sin firma válida, 401, y no se escribe nada', async () => {
    const r = await post(`${PREFIJO_CATALOGO}/copias`, { tipo: 'matcher', total_esperado: 0, hash_esperado: 'a'.repeat(64), corte: new Date().toISOString() },
      { clave: randomBytes(32) });
    expect(r.status).toBe(401);
    expect((await admin.query('SELECT count(*)::int n FROM catalog.copias')).rows).toEqual([{ n: 0 }]);
  });

  it('la misma petición firmada reenviada tal cual es un replay: 401', async () => {
    const nonce = randomBytes(16).toString('base64url');
    const cuerpo = { tipo: 'matcher', total_esperado: 0, hash_esperado: hashFilas([]), corte: new Date().toISOString() };
    expect((await post(`${PREFIJO_CATALOGO}/copias`, cuerpo, { nonce })).status).toBe(201);
    expect((await post(`${PREFIJO_CATALOGO}/copias`, cuerpo, { nonce })).status).toBe(401);
  });

  it('una firma calculada para otra ruta no sirve', async () => {
    const texto = JSON.stringify({ evento_id: 'x' });
    const r = await api().inject({ method: 'POST', url: `${PREFIJO_CATALOGO}/eventos`, payload: texto,
      headers: firmado(`${PREFIJO_CATALOGO}/copias`, texto), remoteAddress: '127.0.0.1' });
    expect(r.statusCode).toBe(401);
  });

  it('E3 corte 1, hallazgo ALTO (commit b3e72186): la API interna con la bandeja encendida no pisa una decisión humana vigente al aplicar un evento del legado', async () => {
    const empresa = (await admin.query<{ company_id: string }>('SELECT company_id FROM core.channel_accounts WHERE id = $1', [cuentas.get('mercadolibre')])).rows[0]!.company_id;
    const cuenta = cuentas.get('mercadolibre')!;
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', 'MLA80', 'MLA80') RETURNING id`, [empresa, cuenta])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      "INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, 'FB-81') RETURNING id",
      [empresa, modelo])).rows[0]!.id;
    await admin.query(
      `INSERT INTO catalog.identity_decisions (company_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto)
       VALUES ($1, $2, 'MLA80', '', 'vincular', $3, 'humano', 'jose', 'aplicar')`, [empresa, cuenta, variante]);
    await admin.query(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id)
       VALUES ($1, $2, 'mercadolibre', 'vendible', 'MLA80', '', $3)`, [empresa, cuenta, variante]);

    const e = { evento_id: randomUUID(), recurso: 'MLA80', variacion: '', accion: 'confirmar', sku: 'FB-80', actor: 'sistema',
      motivo: null, confirmado_por: null, ocurrido_en: new Date().toISOString() };
    expect(await post(`${PREFIJO_CATALOGO}/eventos`, e, { bandeja: true })).toMatchObject({ status: 200, body: { resultado: 'aplicado' } });
    // El vínculo sigue en la variante que puso la humana: la API no lo movió a FB-80.
    expect((await admin.query('SELECT variant_id FROM catalog.external_representations WHERE recurso = $1', ['MLA80'])).rows)
      .toEqual([{ variant_id: variante }]);
    expect((await admin.query("SELECT count(*)::int n FROM catalog.identity_cases WHERE tipo = 'decision_en_conflicto'")).rows).toEqual([{ n: 1 }]);
  });

  it('sin cuenta de ML configurada, 409', async () => {
    const r = await post(`${PREFIJO_CATALOGO}/copias`, { tipo: 'matcher', total_esperado: 0, hash_esperado: hashFilas([]), corte: new Date().toISOString() },
      { c: new Map() });
    expect(r).toMatchObject({ status: 409, body: { code: 'cuenta_no_configurada' } });
  });
});
