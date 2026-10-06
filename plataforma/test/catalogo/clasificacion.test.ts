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
import { abrirCasoDeModelo, ancestrosDe, clasificarFoto, decidirClasificacion } from '../../src/catalogo/clasificacion.ts';
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
  { clave: 'ruta', nombre: 'RUTA', padre: 'bicicletas' },
  { clave: 'cubiertas', nombre: 'CUBIERTAS', padre: null }, { clave: 'camaras', nombre: 'CAMARAS', padre: null },
];

// Cada entrada de `cats` puede fijar una cuenta explícita (para Woo con dos cuentas: multi-tienda) o
// dejar la cuenta por defecto de ese canal (woo / ml).
type CatModelo = ['woocommerce' | 'mercadolibre', string] | ['woocommerce' | 'mercadolibre', string, string];
async function modelo(titulo: string, cats: CatModelo[], o: { archivado?: boolean } = {}) {
  const m = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo, archivado_en, motivo_archivo)
     VALUES ($1, $2, 'woo_simple', $3, $4, $5, $6) RETURNING id`,
    [empresa, woo, randomUUID(), titulo, o.archivado ? new Date() : null, o.archivado ? 'test' : null])).rows[0]!.id;
  const rep = async (canal: string, cuentaId: string) => {
    const v = (await admin.query<{ id: string }>(`INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id`, [empresa, m])).rows[0]!.id;
    return (await admin.query<{ id: string }>(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id)
       VALUES ($1, $2, $3, $4, 'vendible', $5) RETURNING id`, [empresa, cuentaId, canal, randomUUID(), v])).rows[0]!.id;
  };
  const reps = new Map<string, string>();
  const cuentaPorDefecto = (canal: string) => (canal === 'mercadolibre' ? ml : woo);
  if (cats.length === 0) reps.set(`woocommerce|${woo}`, await rep('woocommerce', woo));
  for (const [canal, valor, cuentaId] of cats) {
    const cta = cuentaId ?? cuentaPorDefecto(canal);
    const clave = `${canal}|${cta}`;
    if (!reps.has(clave)) reps.set(clave, await rep(canal, cta));
    await admin.query(`INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
      VALUES ($1, $2, 'categoria_canal', $3, now())`, [m, reps.get(clave), valor]);
  }
  return m;
}

let a: string; let b: string; let c: string; let d: string; let e: string; let f: string; let h: string; let archivado: string;
let i: string; let j: string; let k: string; let l: string; let n: string; let woo2: string;

beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.identity_cases, catalog.channel_categories, catalog.taxonomy_channel_map, catalog.model_categories,
    catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes, catalog.model_attributes,
    catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  ml = await cuenta('mercadolibre'); woo = await cuenta('woocommerce'); woo2 = await cuenta('woocommerce');
  for (const [id, nombre] of ([['10', 'BICICLETAS'], ['11', 'MTB'], ['12', 'CUBIERTAS'], ['13', 'CAMARAS'], ['14', 'SUELTA'], ['15', 'RUTA']] as const)) {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre) VALUES ($1, $2, 'woocommerce', $3, $4)`, [empresa, woo, id, nombre]);
  }
  // D26: en Woo, CAMARAS cuelga de CUBIERTAS; y una jerarquía cíclica (dato inconsistente). En ML, MLA2 «cuelga» de '12':
  // el id coincide con el de una categoría de Woo A PROPÓSITO, para probar que una cuenta nunca descarta a la de otra.
  await admin.query(`UPDATE catalog.channel_categories SET parent_externo = '12' WHERE channel_account_id = $1 AND id_externo = '13'`, [woo]);
  for (const [id, nombre, padre] of [['50', 'CICLO_A', '51'], ['51', 'CICLO_B', '50']] as const) {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, parent_externo, nombre) VALUES ($1, $2, 'woocommerce', $3, $4, $5)`, [empresa, woo, id, padre, nombre]);
  }
  for (const [id, padre] of [['MLA1', null], ['MLA2', '12'], ['MLA3', null]] as const) {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, parent_externo, nombre) VALUES ($1, $2, 'mercadolibre', $3, $4, $3)`, [empresa, ml, id, padre]);
  }
  // Veneno para el mutante manual (a) (un solo Map de padres compartido entre cuentas, sin
  // separar por canal): ML declara SU PROPIA categoría con id_externo='14' (mismo string que
  // SUELTA de Woo) y la cuelga de '15' (RUTA de Woo). Es un choque de id_externo real —a
  // propósito— entre cuentas. Con un Map por cuenta esto no afecta a Woo. Con un Map único
  // (mutante), la entrada de Woo para '14' queda pisada por la de ML: dentro del canal Woo, '14'
  // (SUELTA) pasa a "colgar" de '15' (RUTA). El modelo `l` (Woo: SUELTA + RUTA) tendría entonces,
  // bajo el mutante, a RUTA como ancestro de SUELTA dentro de Woo y D26 descartaría RUTA
  // (quedando sólo SUELTA, sin nodo mapeado → sin clasificación) — cosa que el código correcto,
  // con un Map por cuenta, nunca hace (en Woo, RUTA y SUELTA son dos raíces sin relación, y con
  // RUTA presente el modelo debería clasificar en `ruta`).
  await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, parent_externo, nombre) VALUES ($1, $2, 'mercadolibre', '14', '15', 'VENENO')`, [empresa, ml]);
  // Segunda cuenta Woo (multi-tienda): su propia jerarquía, con un id_externo ('15') que
  // COLISIONA con RUTA de la cuenta Woo1 a propósito, pero cuelga de un padre DISTINTO ('X0') que
  // sólo existe en esta cuenta. Sirve para el mutante manual (b) (agrupar `idsPorCuenta` por
  // canal en vez de por cuenta): si se mezclan los ids de las dos cuentas Woo en un mismo balde
  // "woocommerce", el `padres` de UNA cuenta se usa por error para los ids de la OTRA.
  for (const [id, nombre, padre] of [['X0', 'RAIZ W2', null], ['15', 'HIJO W2', 'X0']] as const) {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, parent_externo, nombre) VALUES ($1, $2, 'woocommerce', $3, $4, $5)`, [empresa, woo2, id, padre, nombre]);
  }
  await enTransaccion(app, async (tx) => {
    const v = await crearVersion(tx, empresa, 'test');
    nodos = await escribirArbol(tx, empresa, v.id, ARBOL);
    await publicarVersion(tx, empresa, v.id);
    for (const [id, clave] of ([['10', 'bicicletas'], ['11', 'mtb'], ['12', 'cubiertas'], ['13', 'camaras'], ['15', 'ruta']] as const)) {
      await mapearCategoria(tx, empresa, nodos.get(clave)!, woo, 'woocommerce', id, 'jose');
    }
    await mapearCategoria(tx, empresa, nodos.get('cubiertas')!, woo, 'woocommerce', '50', 'jose');
    await mapearCategoria(tx, empresa, nodos.get('camaras')!, woo, 'woocommerce', '51', 'jose');
    for (const [id, clave] of ([['MLA1', 'mtb'], ['MLA2', 'camaras'], ['MLA3', 'cubiertas']] as const)) {
      await mapearCategoria(tx, empresa, nodos.get(clave)!, ml, 'mercadolibre', id, 'jose');
    }
    await mapearCategoria(tx, empresa, nodos.get('mtb')!, woo2, 'woocommerce', 'X0', 'jose');
  });
  a = await modelo('a: padre e hijo dentro de Woo', [['woocommerce', 'BICICLETAS'], ['woocommerce', 'MTB']]);
  b = await modelo('b: padre en Woo, hijo en ML', [['woocommerce', 'BICICLETAS'], ['mercadolibre', 'MLA1']]);
  c = await modelo('c: desacuerdo', [['woocommerce', 'CUBIERTAS'], ['mercadolibre', 'MLA2']]);
  d = await modelo('d: categoría sin mapeo', [['woocommerce', 'SUELTA']]);
  e = await modelo('e: sin categoría', []);
  f = await modelo('f: decidido por una persona', [['woocommerce', 'CUBIERTAS']]);
  h = await modelo('h: ML con un nombre de Woo', [['mercadolibre', 'CUBIERTAS']]);
  i = await modelo('i: D26, CAMARAS cuelga de CUBIERTAS en Woo', [['woocommerce', 'CUBIERTAS'], ['woocommerce', 'CAMARAS']]);
  j = await modelo('j: D27, raíz contra no raíz', [['woocommerce', 'CUBIERTAS'], ['woocommerce', 'MTB']]);
  k = await modelo('k: jerarquía cíclica en el canal', [['woocommerce', 'CICLO_A'], ['woocommerce', 'CICLO_B']]);
  l = await modelo('l: SUELTA + RUTA en Woo, sin relación real (mutante manual a: choque de id_externo con veneno de ML)', [['woocommerce', 'SUELTA'], ['woocommerce', 'RUTA']]);
  // Mutante manual (b): dos cuentas Woo (multi-tienda) sin relación real entre sus categorías —
  // desacuerdo real (D23). Si se agrupa por canal en vez de por cuenta, los ids de las dos
  // cuentas Woo se mezclan y el `padres` de una sola cuenta (Woo2, donde '15' cuelga de 'X0') se
  // usa también para los ids de Woo1: D26 descartaría a 'X0' como si fuera ancestro de '15',
  // dejando una falsa primaria en vez del desacuerdo real.
  n = await modelo('n: D26/D27 cruzando DOS cuentas Woo (multi-tienda), sin relación real', [
    ['woocommerce', 'RUTA', woo], ['woocommerce', 'RAIZ W2', woo2],
  ]);
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
    expect(decidirClasificacion(['bici', 'mtb'], padre, true)).toEqual({ tipo: 'primaria', nodo: 'mtb', secundarias: [] });
    expect(decidirClasificacion(['mtb'], padre, true)).toEqual({ tipo: 'primaria', nodo: 'mtb', secundarias: [] });
  });
  it('hermanos o ramas distintas son desacuerdo: no hay primaria', () => {
    expect(decidirClasificacion(['mtb', 'ruta'], padre, true)).toEqual({ tipo: 'desacuerdo', nodos: ['mtb', 'ruta'], secundarias: [] });
    expect(decidirClasificacion(['mtb', 'ruta', 'bici'], padre, true)).toEqual({ tipo: 'desacuerdo', nodos: ['mtb', 'ruta'], secundarias: [] });
  });
  it('sin nodos: la razón distingue «no tiene categoría» de «tiene pero ninguna mapea»', () => {
    expect(decidirClasificacion([], padre, false)).toEqual({ tipo: 'sin_mapeo', razon: 'sin_categoria' });
    expect(decidirClasificacion([], padre, true)).toEqual({ tipo: 'sin_mapeo', razon: 'categoria_no_mapeada' });
  });
});

describe('E2-CLA-01b D27: una raíz pierde contra un nodo no raíz, sin comerse los desacuerdos reales', () => {
  const padre = new Map<string, string | null>([['comp', null], ['santini', null], ['limp', null], ['grasas', 'limp'], ['lub', 'limp'], ['mtb', 'bici'], ['bici', null], ['freno', 'comp']]);
  it('raíz + un nodo no raíz: primaria en el no raíz y la raíz queda secundaria', () => {
    expect(decidirClasificacion(['comp', 'grasas'], padre, true)).toEqual({ tipo: 'primaria', nodo: 'grasas', secundarias: ['comp'] });
  });
  it('raíz + DOS no raíz de ramas distintas: sigue siendo desacuerdo (la raíz no se come el caso)', () => {
    expect(decidirClasificacion(['comp', 'grasas', 'mtb'], padre, true))
      .toEqual({ tipo: 'desacuerdo', nodos: ['grasas', 'mtb'], secundarias: ['comp'] });
    expect(decidirClasificacion(['comp', 'grasas', 'lub'], padre, true))
      .toEqual({ tipo: 'desacuerdo', nodos: ['grasas', 'lub'], secundarias: ['comp'] });
  });
  it('sólo raíces varias: desacuerdo; una sola raíz y nada más: primaria en la raíz', () => {
    expect(decidirClasificacion(['comp', 'santini'], padre, true)).toEqual({ tipo: 'desacuerdo', nodos: ['comp', 'santini'], secundarias: [] });
    expect(decidirClasificacion(['santini'], padre, true)).toEqual({ tipo: 'primaria', nodo: 'santini', secundarias: [] });
  });
  it('la raíz que es ancestro del no raíz se descarta como antes (no queda ni secundaria)', () => {
    expect(decidirClasificacion(['comp', 'freno'], padre, true)).toEqual({ tipo: 'primaria', nodo: 'freno', secundarias: [] });
  });
});

describe('E2-CLA-01c D26: ancestros en la jerarquía del canal', () => {
  it('recorre hasta la raíz, con tope y sin colgarse ante un ciclo', () => {
    const p = new Map<string, string | null>([['a', 'b'], ['b', 'c'], ['c', null]]);
    expect([...ancestrosDe('a', p)].sort()).toEqual(['b', 'c']);
    expect(ancestrosDe('c', p).size).toBe(0);
    expect(ancestrosDe('x', p).size).toBe(0);
    const ciclo = new Map<string, string | null>([['a', 'b'], ['b', 'a']]);
    expect(ancestrosDe('a', ciclo).size).toBe(0);   // dato inconsistente: no descarta nada por él
    const cola = new Map<string, string | null>([['a', 'b'], ['b', 'c'], ['c', 'b']]);
    expect([...ancestrosDe('a', cola)].sort()).toEqual(['b', 'c']);
  });
});

describe('E2-CLA-02 dry-run', () => {
  it('informa los números por grupo y no escribe nada', async () => {
    const r = await foto({ dryRun: true });
    expect(r).toMatchObject({
      modelos: 12, conPrimaria: 5, sinPrimariaPorDesacuerdo: 3, personaRespetada: 1, yaEstaban: 0, quedaron: null,
      sinMapeo: { sin_categoria: 1, categoria_no_mapeada: 2 },
      casosPorTipo: { categoria_en_desacuerdo: 3, categoria_sin_mapeo: 3 },
      conCategoriaDescartadaPorJerarquiaDelCanal: 1, conRaicesComoSecundarias: 1,
    });
    expect((await filas()).length).toBe(1);   // sólo la de la persona
    expect(await casos()).toEqual([]);
  });
});

describe('E2-CLA-03 aplicar', () => {
  it('primaria al más específico; desacuerdo sin primaria y con caso; sin mapeo con caso; la persona intacta', async () => {
    const antes = (await filas(f))[0]!;
    const r = await foto();
    expect(r.quedaron).toEqual({ primarias: 5, secundarias: 7, casosAbiertos: 6 });
    expect(await vigentes(a)).toEqual(['mtb*:mapeo_canal']);
    expect(await vigentes(b)).toEqual(['mtb*:mapeo_canal']);
    expect(await vigentes(c)).toEqual(['camaras:mapeo_canal', 'cubiertas:mapeo_canal']);   // ninguna primaria: no gana ningún canal
    for (const m of [d, e, h]) expect(await vigentes(m)).toEqual([]);
    expect(await vigentes(f)).toEqual(['camaras*:persona']);
    expect((await filas(f))[0]).toEqual(antes);
    expect(await vigentes(i)).toEqual(['camaras*:mapeo_canal']);   // D26: CUBIERTAS es ancestro de CAMARAS en Woo
    expect(await vigentes(j)).toEqual(['cubiertas:mapeo_canal', 'mtb*:mapeo_canal']);   // D27: la raíz queda secundaria
    expect(await vigentes(k)).toEqual(['camaras:mapeo_canal', 'cubiertas:mapeo_canal']);   // ciclo: no se descarta nada
    // D26 cruzando canales: RUTA (Woo) no tiene nada que ver con SUELTA (Woo, id '14'); el hecho
    // de que ML declare (para SU cuenta) una categoría con el mismo id_externo '15' colgando de
    // '14' no puede hacer que la cuenta de Woo descarte su propia RUTA. SUELTA no tiene nodo
    // mapeado, así que sólo cuenta RUTA.
    expect(await vigentes(l)).toEqual(['ruta*:mapeo_canal']);
    // Mutante manual (b): RUTA (cuenta woo) y RAIZ W2 (cuenta woo2) no tienen relación real entre
    // sí (cada una es raíz dentro de SU propia cuenta) — desacuerdo real, ninguna es primaria.
    expect(await vigentes(n)).toEqual(['mtb:mapeo_canal', 'ruta:mapeo_canal']);
    const cs = await casos();
    expect(cs.map((x) => `${x.tipo}:${x.model_id}`).sort()).toEqual([
      `categoria_en_desacuerdo:${c}`, `categoria_en_desacuerdo:${k}`, `categoria_en_desacuerdo:${n}`,
      `categoria_sin_mapeo:${d}`, `categoria_sin_mapeo:${e}`, `categoria_sin_mapeo:${h}`].sort());
    expect(cs.find((x) => x.model_id === c)!.detalle).toEqual({
      nodos: ['camaras', 'cubiertas'], raices_secundarias: [], por_canal: { woocommerce: ['cubiertas'], mercadolibre: ['camaras'] } });
    expect(cs.find((x) => x.model_id === d)!.detalle).toMatchObject({ razon: 'categoria_no_mapeada' });
    expect(cs.find((x) => x.model_id === e)!.detalle).toMatchObject({ razon: 'sin_categoria' });
    expect(cs.find((x) => x.model_id === h)!.detalle).toMatchObject({ razon: 'categoria_no_mapeada' });   // ML guarda el id, no el nombre
  });

  it('idempotente: correrlo de nuevo no agrega filas ni casos ni cambia ids', async () => {
    await foto();
    const filas1 = await filas(); const casos1 = await casos();
    const r = await foto();
    expect(r.yaEstaban).toBe(8);   // a, b, c, i, j, k y n (sus secundarias iguales); la persona y los sin mapeo no cuentan
    expect(await filas()).toEqual(filas1);
    expect(await casos()).toEqual(casos1);
    expect((await admin.query(`SELECT count(*)::int n FROM catalog.identity_cases WHERE model_id IS NOT NULL`)).rows[0].n).toBe(6);
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
    expect(r.conPrimaria).toBe(6);
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
    await admin.query(`UPDATE catalog.model_attributes SET valor = 'MLA1' WHERE model_id = $1 AND valor = 'MLA2'`, [c]);   // ML: mtb
    await admin.query(`UPDATE catalog.model_attributes SET valor = 'RUTA' WHERE model_id = $1 AND valor = 'CUBIERTAS'`, [c]);   // Woo: ruta
    await foto();
    const cs = (await casos()).filter((x) => x.model_id === c);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.detalle).toMatchObject({ nodos: ['mtb', 'ruta'] });
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
    expect(JSON.parse(seco.stdout)).toMatchObject({ dryRun: true, modelos: 12, conPrimaria: 5, sinPrimariaPorDesacuerdo: 3, personaRespetada: 1 });
    expect((await filas()).length).toBe(1);
    const real = correr(['--ejecutar']);
    expect(real.status, real.stderr).toBe(0);
    expect(JSON.parse(real.stdout).quedaron).toEqual({ primarias: 5, secundarias: 7, casosAbiertos: 6 });
    const n = (await filas()).length;
    expect(correr(['--ejecutar']).status).toBe(0);
    expect((await filas()).length).toBe(n);
  });
});
