/*
 * test/catalogo/clasificacion.test.ts — 6a: clasificar la foto actual (D23–D25) y los casos que cuelgan de un modelo (0019).
 * Lo que importa: que ningún canal gane un desacuerdo, que lo decidido por una persona sobreviva, que correrlo dos
 * veces no duplique nada, y que se cuente lo que QUEDÓ en la base.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCasoDeModelo, clasificarFoto, decidirClasificacion } from '../../src/catalogo/clasificacion.ts';
import { clasificarModelo, crearVersion, escribirArbol, mapearCategoria, publicarVersion } from '../../src/catalogo/taxonomia.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const SCRIPT = fileURLToPath(new URL('../../../scripts/catalogo-clasificar-foto.mjs', import.meta.url));
let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let ml: string; let woo: string; let nodos: Map<string, string>;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});

const ARBOL = [
  { clave: 'bicicletas', nombre: 'BICICLETAS', padre: null }, { clave: 'mtb', nombre: 'MTB', padre: 'bicicletas' },
  { clave: 'cubiertas', nombre: 'CUBIERTAS', padre: null }, { clave: 'camaras', nombre: 'CAMARAS', padre: null },
];

async function modelo(titulo: string, cats: Array<['woocommerce' | 'mercadolibre', string]>, o: { archivado?: boolean } = {}) {
  const m = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo, archivado_en, motivo_archivo)
     VALUES ($1, $2, 'woo_simple', $3, $4, $5, $6) RETURNING id`,
    [empresa, woo, randomUUID(), titulo, o.archivado ? new Date() : null, o.archivado ? 'test' : null])).rows[0]!.id;
  const rep = async (canal: string) => {
    const v = (await admin.query<{ id: string }>(`INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id`, [empresa, m])).rows[0]!.id;
    return (await admin.query<{ id: string }>(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id)
       VALUES ($1, $2, $3, $4, 'vendible', $5) RETURNING id`, [empresa, canal === 'mercadolibre' ? ml : woo, canal, randomUUID(), v])).rows[0]!.id;
  };
  const reps = new Map<string, string>();
  if (cats.length === 0) reps.set('woocommerce', await rep('woocommerce'));
  for (const [canal, valor] of cats) {
    if (!reps.has(canal)) reps.set(canal, await rep(canal));
    await admin.query(`INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
      VALUES ($1, $2, 'categoria_canal', $3, now())`, [m, reps.get(canal), valor]);
  }
  return m;
}

let a: string; let b: string; let c: string; let d: string; let e: string; let f: string; let h: string; let archivado: string;

beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.identity_cases, catalog.channel_categories, catalog.taxonomy_channel_map, catalog.model_categories,
    catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes, catalog.model_attributes,
    catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  ml = await cuenta('mercadolibre'); woo = await cuenta('woocommerce');
  for (const [id, nombre] of ([['10', 'BICICLETAS'], ['11', 'MTB'], ['12', 'CUBIERTAS'], ['13', 'CAMARAS'], ['14', 'SUELTA']] as const)) {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre) VALUES ($1, $2, 'woocommerce', $3, $4)`, [empresa, woo, id, nombre]);
  }
  await enTransaccion(app, async (tx) => {
    const v = await crearVersion(tx, empresa, 'test');
    nodos = await escribirArbol(tx, empresa, v.id, ARBOL);
    await publicarVersion(tx, empresa, v.id);
    for (const [id, clave] of ([['10', 'bicicletas'], ['11', 'mtb'], ['12', 'cubiertas'], ['13', 'camaras']] as const)) {
      await mapearCategoria(tx, empresa, nodos.get(clave)!, woo, 'woocommerce', id, 'jose');
    }
    for (const [id, clave] of ([['MLA1', 'mtb'], ['MLA2', 'camaras'], ['MLA3', 'cubiertas']] as const)) {
      await mapearCategoria(tx, empresa, nodos.get(clave)!, ml, 'mercadolibre', id, 'jose');
    }
  });
  a = await modelo('a: padre e hijo dentro de Woo', [['woocommerce', 'BICICLETAS'], ['woocommerce', 'MTB']]);
  b = await modelo('b: padre en Woo, hijo en ML', [['woocommerce', 'BICICLETAS'], ['mercadolibre', 'MLA1']]);
  c = await modelo('c: desacuerdo', [['woocommerce', 'CUBIERTAS'], ['mercadolibre', 'MLA2']]);
  d = await modelo('d: categoría sin mapeo', [['woocommerce', 'SUELTA']]);
  e = await modelo('e: sin categoría', []);
  f = await modelo('f: decidido por una persona', [['woocommerce', 'CUBIERTAS']]);
  h = await modelo('h: ML con un nombre de Woo', [['mercadolibre', 'CUBIERTAS']]);
  archivado = await modelo('archivado', [['woocommerce', 'CUBIERTAS']], { archivado: true });
  await admin.query(`INSERT INTO catalog.model_categories (company_id, model_id, node_id, primaria, origen) VALUES ($1, $2, $3, true, 'persona')`, [empresa, f, nodos.get('camaras')]);
});

const foto = (over: Partial<Parameters<typeof clasificarFoto>[1]> = {}) =>
  enTransaccion(app, (tx) => clasificarFoto(tx, { empresa, dryRun: false, ...over }));
const filas = async (m?: string) => (await admin.query<{ id: string; model_id: string; clave: string; primaria: boolean; origen: string; vigente: boolean; motivo_salida: string | null }>(
  `SELECT c.id, c.model_id, n.clave, c.primaria, c.origen, c.quitado_en IS NULL AS vigente, c.motivo_salida
     FROM catalog.model_categories c JOIN catalog.taxonomy_nodes n ON n.id = c.node_id
    WHERE ($1::uuid IS NULL OR c.model_id = $1) ORDER BY c.asignado_en, n.clave, c.id`, [m ?? null])).rows;
const vigentes = async (m: string) => (await filas(m)).filter((x) => x.vigente).map((x) => `${x.clave}${x.primaria ? '*' : ''}:${x.origen}`).sort();
const casos = async () => (await admin.query<{ model_id: string; tipo: string; detalle: Record<string, unknown> }>(
  `SELECT model_id, tipo, detalle FROM catalog.identity_cases WHERE model_id IS NOT NULL AND cerrado_en IS NULL ORDER BY tipo, model_id`)).rows;

describe('E2-CLA-01 la decisión pura', () => {
  const padre = new Map<string, string | null>([['bici', null], ['mtb', 'bici'], ['ruta', 'bici'], ['cub', null]]);
  it('un ancestro propio de otro nodo se descarta; padre e hijo no son desacuerdo', () => {
    expect(decidirClasificacion(['bici', 'mtb'], padre, true)).toEqual({ tipo: 'primaria', nodo: 'mtb' });
    expect(decidirClasificacion(['mtb'], padre, true)).toEqual({ tipo: 'primaria', nodo: 'mtb' });
  });
  it('hermanos o ramas distintas son desacuerdo: no hay primaria', () => {
    expect(decidirClasificacion(['mtb', 'ruta'], padre, true)).toEqual({ tipo: 'desacuerdo', nodos: ['mtb', 'ruta'] });
    expect(decidirClasificacion(['cub', 'mtb', 'bici'], padre, true)).toEqual({ tipo: 'desacuerdo', nodos: ['cub', 'mtb'] });
  });
  it('sin nodos: la razón distingue «no tiene categoría» de «tiene pero ninguna mapea»', () => {
    expect(decidirClasificacion([], padre, false)).toEqual({ tipo: 'sin_mapeo', razon: 'sin_categoria' });
    expect(decidirClasificacion([], padre, true)).toEqual({ tipo: 'sin_mapeo', razon: 'categoria_no_mapeada' });
  });
});

describe('E2-CLA-02 dry-run', () => {
  it('informa los números por grupo y no escribe nada', async () => {
    const r = await foto({ dryRun: true });
    expect(r).toMatchObject({
      modelos: 7, conPrimaria: 2, sinPrimariaPorDesacuerdo: 1, personaRespetada: 1, yaEstaban: 0, quedaron: null,
      sinMapeo: { sin_categoria: 1, categoria_no_mapeada: 2 },
      casosPorTipo: { categoria_en_desacuerdo: 1, categoria_sin_mapeo: 3 },
    });
    expect((await filas()).length).toBe(1);   // sólo la de la persona
    expect(await casos()).toEqual([]);
  });
});

describe('E2-CLA-03 aplicar', () => {
  it('primaria al más específico; desacuerdo sin primaria y con caso; sin mapeo con caso; la persona intacta', async () => {
    const antes = (await filas(f))[0]!;
    const r = await foto();
    expect(r.quedaron).toEqual({ primarias: 2, secundariasEnDesacuerdo: 2, casosAbiertos: 4 });
    expect(await vigentes(a)).toEqual(['mtb*:mapeo_canal']);
    expect(await vigentes(b)).toEqual(['mtb*:mapeo_canal']);
    expect(await vigentes(c)).toEqual(['camaras:mapeo_canal', 'cubiertas:mapeo_canal']);   // ninguna primaria: no gana ningún canal
    for (const m of [d, e, h]) expect(await vigentes(m)).toEqual([]);
    expect(await vigentes(f)).toEqual(['camaras*:persona']);
    expect((await filas(f))[0]).toEqual(antes);
    const cs = await casos();
    expect(cs.map((x) => `${x.tipo}:${x.model_id}`).sort()).toEqual([
      `categoria_en_desacuerdo:${c}`, `categoria_sin_mapeo:${d}`, `categoria_sin_mapeo:${e}`, `categoria_sin_mapeo:${h}`].sort());
    expect(cs.find((x) => x.model_id === c)!.detalle).toEqual({
      nodos: ['camaras', 'cubiertas'], por_canal: { woocommerce: ['cubiertas'], mercadolibre: ['camaras'] } });
    expect(cs.find((x) => x.model_id === d)!.detalle).toMatchObject({ razon: 'categoria_no_mapeada' });
    expect(cs.find((x) => x.model_id === e)!.detalle).toMatchObject({ razon: 'sin_categoria' });
    expect(cs.find((x) => x.model_id === h)!.detalle).toMatchObject({ razon: 'categoria_no_mapeada' });   // ML guarda el id, no el nombre
  });

  it('idempotente: correrlo de nuevo no agrega filas ni casos ni cambia ids', async () => {
    await foto();
    const filas1 = await filas(); const casos1 = await casos();
    const r = await foto();
    expect(r.yaEstaban).toBe(3);   // a, b y c (sus dos secundarias iguales); la persona y los sin mapeo no cuentan
    expect(await filas()).toEqual(filas1);
    expect(await casos()).toEqual(casos1);
    expect((await admin.query(`SELECT count(*)::int n FROM catalog.identity_cases WHERE model_id IS NOT NULL`)).rows[0].n).toBe(4);
  });

  it('D24: una clasificación de persona sobrevive aunque los canales digan otra cosa, y no abre casos', async () => {
    await foto(); await foto();
    expect(await vigentes(f)).toEqual(['camaras*:persona']);   // Woo dice CUBIERTAS
    expect((await casos()).some((x) => x.model_id === f)).toBe(false);
  });

  it('si el desacuerdo cambia, actualiza el detalle del mismo caso; si se resuelve, lo cierra y deja la historia', async () => {
    await foto();
    await admin.query(`UPDATE catalog.model_attributes SET valor = 'MLA3' WHERE model_id = $1 AND valor = 'MLA2'`, [c]);   // ML pasa a CUBIERTAS
    const r = await foto();
    expect(r.conPrimaria).toBe(3);
    expect(await vigentes(c)).toEqual(['cubiertas*:mapeo_canal']);
    expect((await casos()).some((x) => x.model_id === c)).toBe(false);
    const cerrado = (await admin.query(`SELECT motivo_cierre FROM catalog.identity_cases WHERE model_id = $1`, [c])).rows;
    expect(cerrado).toHaveLength(1); expect(cerrado[0].motivo_cierre).toMatch(/clasificado/);
    const hist = (await filas(c)).filter((x) => !x.vigente);
    expect(hist.map((x) => x.clave)).toEqual(['camaras', 'cubiertas']);
    expect(hist.every((x) => x.motivo_salida)).toBe(true);
  });

  it('el detalle de un desacuerdo que cambia se actualiza sin abrir un segundo caso', async () => {
    await foto();
    await admin.query(`UPDATE catalog.model_attributes SET valor = 'MLA1' WHERE model_id = $1 AND valor = 'MLA2'`, [c]);   // ahora cubiertas vs mtb
    await foto();
    const cs = (await casos()).filter((x) => x.model_id === c);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.detalle).toMatchObject({ nodos: ['cubiertas', 'mtb'] });
  });
});

describe('E2-CLA-04 lo que se cuenta y lo que frena', () => {
  it('cuenta lo que QUEDÓ: una escritura que no deja rastro deshace todo, filas y casos', async () => {
    await expect(foto({ clasificar: async () => 'escrita' })).rejects.toThrow(/quedaron 0 primarias/);
    expect((await filas()).length).toBe(1);
    expect(await casos()).toEqual([]);
  });
  it('una primaria que no debería existir (un modelo sin mapeo) deshace todo', async () => {
    let hecho = false;
    const traidora: typeof clasificarModelo = async (tx, emp, m, n, o) => {
      const r = await clasificarModelo(tx, emp, m, n, o);
      if (!hecho) {
        hecho = true;
        await tx.query(`INSERT INTO catalog.model_categories (company_id, model_id, node_id, primaria, origen) VALUES ($1, $2, $3, true, 'mapeo_canal')`, [emp, d, n]);
      }
      return r;
    };
    await expect(foto({ clasificar: traidora })).rejects.toThrow(/1 primarias indebidas/);
    expect((await filas()).length).toBe(1);
  });
  it('un mapeo que apunta a un nodo que la versión vigente no muestra frena antes de escribir', async () => {
    await admin.query(`UPDATE catalog.taxonomy_node_versions SET archivado = true WHERE node_id = $1`, [nodos.get('mtb')]);
    await expect(foto()).rejects.toThrow(/no están activos en la versión vigente/);
    expect((await filas()).length).toBe(1);
  });
  it('dos categorías de Woo con el mismo nombre: no se adivina', async () => {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre) VALUES ($1, $2, 'woocommerce', '99', 'MTB')`, [empresa, woo]);
    await expect(foto()).rejects.toThrow(/se llaman «MTB»/);
  });
  it('sin versión vigente frena', async () => {
    await admin.query(`UPDATE catalog.taxonomy_versions SET estado = 'reemplazada', vigente_desde = NULL, vigente_hasta = now()`);
    await expect(foto()).rejects.toThrow(/versión vigente/);
  });
});

describe('E2-CLA-05 clasificarModelo respeta a la persona y deja historia', () => {
  const clas = (m: string, n: string, o: Parameters<typeof clasificarModelo>[4]) => enTransaccion(app, (tx) => clasificarModelo(tx, empresa, m, nodos.get(n)!, o));
  it('una llamada automática sobre una fila de persona (primaria o secundaria) devuelve «respetada» y no escribe', async () => {
    expect(await clas(f, 'cubiertas', { primaria: true, origen: 'mapeo_canal' })).toBe('respetada');   // otra primaria de persona
    expect(await clas(f, 'camaras', { primaria: false, origen: 'mapeo_canal' })).toBe('respetada');   // mismo nodo de persona
    expect(await vigentes(f)).toEqual(['camaras*:persona']);
    await clas(f, 'cubiertas', { primaria: false, origen: 'persona' });
    expect(await clas(f, 'cubiertas', { primaria: true, origen: 'mapeo_canal' })).toBe('respetada');   // secundaria de persona
    expect((await filas(f)).length).toBe(2);
  });
  it('bajar una primaria automática y promover una secundaria cierran la fila con motivo, no la pisan', async () => {
    expect(await clas(a, 'mtb', { primaria: true, origen: 'mapeo_canal' })).toBe('escrita');
    expect(await clas(a, 'mtb', { primaria: true, origen: 'mapeo_canal' })).toBe('igual');
    await clas(a, 'camaras', { primaria: true, origen: 'mapeo_canal' });
    expect(await vigentes(a)).toEqual(['camaras*:mapeo_canal', 'mtb:mapeo_canal']);
    const cerradas = (await filas(a)).filter((x) => !x.vigente);
    expect(cerradas).toHaveLength(1); expect(cerradas[0]).toMatchObject({ clave: 'mtb', primaria: true });
    expect(cerradas[0]!.motivo_salida).toMatch(/deja de ser la primaria/);
    await clas(a, 'mtb', { primaria: true, origen: 'mapeo_canal' });   // promover la secundaria
    expect(await vigentes(a)).toEqual(['camaras:mapeo_canal', 'mtb*:mapeo_canal']);
    expect((await filas(a)).filter((x) => !x.vigente).map((x) => x.motivo_salida).every(Boolean)).toBe(true);
  });
});

describe('E2-CLA-06 casos que cuelgan de un modelo (0019)', () => {
  it('abrirCasoDeModelo: abre, no duplica, actualiza el detalle y distingue «igual»', async () => {
    const go = (det: Record<string, unknown>) => enTransaccion(app, (tx) => abrirCasoDeModelo(tx, empresa, d, 'categoria_sin_mapeo', det));
    expect(await go({ x: 1 })).toBe('abierto');
    expect(await go({ x: 1 })).toBe('igual');
    expect(await go({ x: 2 })).toBe('actualizado');
    expect((await casos()).filter((x) => x.model_id === d)).toEqual([{ model_id: d, tipo: 'categoria_sin_mapeo', detalle: { x: 2 } }]);
  });
  it('la base: un abierto por (modelo, tipo); cerrado puede reabrirse; sin objeto, tipo inventado y otra empresa se rechazan', async () => {
    const ins = (q: pg.Pool, tipo: string, empr: string, m: string | null) => q.query(
      `INSERT INTO catalog.identity_cases (company_id, tipo, model_id) VALUES ($1, $2, $3)`, [empr, tipo, m]);
    await ins(app, 'categoria_en_desacuerdo', empresa, c);
    await expect(ins(app, 'categoria_en_desacuerdo', empresa, c)).rejects.toThrow(/identity_cases_un_abierto_modelo/);
    await ins(app, 'categoria_sin_mapeo', empresa, c);   // otro tipo, mismo modelo: sí
    await app.query(`UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = 'x' WHERE model_id = $1 AND tipo = 'categoria_en_desacuerdo'`, [c]);
    await ins(app, 'categoria_en_desacuerdo', empresa, c);
    await expect(ins(app, 'categoria_persona_contradicha', empresa, null)).rejects.toThrow(/identity_cases_objeto_check/);
    await expect(ins(app, 'inventado', empresa, c)).rejects.toThrow(/identity_cases_tipo_check/);
    const otra = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
    await expect(ins(app, 'categoria_sin_mapeo', otra, d)).rejects.toThrow(/no es de la empresa/);
    await expect(app.query(`UPDATE catalog.identity_cases SET company_id = $1 WHERE model_id = $2`, [otra, c])).rejects.toThrow(/no es de la empresa/);
  });
  it('forward-only: la app puede INSERT y UPDATE pero no DELETE', async () => {
    await abrirCasoDeModelo(app, empresa, d, 'categoria_sin_mapeo', {});
    await app.query(`UPDATE catalog.identity_cases SET prioridad = 'baja' WHERE model_id = $1`, [d]);
    await expect(app.query(`DELETE FROM catalog.identity_cases WHERE model_id = $1`, [d])).rejects.toThrow(/permission denied/);
  });
});

describe('E2-CLA-07 el script', () => {
  const correr = (args: string[]) => {
    const p = new URL(base.urlApp);
    return spawnSync(process.execPath, [SCRIPT, '--empresa', empresa, ...args], { encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '', PG_HOST: p.hostname, PG_PORT: p.port, PG_DATABASE: p.pathname.slice(1),
      PG_USER: p.username, PG_PASSWORD: p.password } });
  };
  it('dry-run informa y no escribe; --ejecutar escribe y es idempotente', async () => {
    const seco = correr([]);
    expect(seco.status, seco.stderr).toBe(0);
    expect(JSON.parse(seco.stdout)).toMatchObject({ dryRun: true, modelos: 7, conPrimaria: 2, sinPrimariaPorDesacuerdo: 1, personaRespetada: 1 });
    expect((await filas()).length).toBe(1);
    const real = correr(['--ejecutar']);
    expect(real.status, real.stderr).toBe(0);
    expect(JSON.parse(real.stdout).quedaron).toEqual({ primarias: 2, secundariasEnDesacuerdo: 2, casosAbiertos: 4 });
    const n = (await filas()).length;
    expect(correr(['--ejecutar']).status).toBe(0);
    expect((await filas()).length).toBe(n);
  });
});
