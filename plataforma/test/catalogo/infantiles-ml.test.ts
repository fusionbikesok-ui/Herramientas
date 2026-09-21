/*
 * test/catalogo/infantiles-ml.test.ts — D22: las categorías infantiles de ML se mapean a `bicicletas` y sus modelos
 * reciben la faceta `publico = infantil`, en una sola transacción. Lo que importa: que no se pierda el dato «infantil»,
 * que los que ya tenían la faceta no se toquen y que los excluidos no la reciban NUNCA, ni con `edad = Niños`.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAPEO_ML } from '../../src/catalogo/arbol-fusionbikes.ts';
import { escribirFaceta } from '../../src/catalogo/facetas.ts';
import { aplicarD22, CATEGORIAS_D22, DECISIONES_D22, sinCategoriasD22, type DecisionesD22 } from '../../src/catalogo/infantiles-ml.ts';
import { crearVersion, escribirArbol } from '../../src/catalogo/taxonomia.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const SCRIPT = fileURLToPath(new URL('../../../scripts/catalogo-arbol-infantiles-ml.mjs', import.meta.url));
let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let ml: string; let woo: string;
let camicleta: string; let infantil: string; let yaRegla: string; let yaPersona: string; let gravity: string;
let otra: string; let porNombre: string; let soloWoo: string;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});

async function modelo(titulo: string, categoria: string, o: { edad?: string[]; canal?: 'mercadolibre' | 'woocommerce'; archivado?: boolean; repArchivada?: boolean; id?: string } = {}) {
  const canal = o.canal ?? 'mercadolibre'; const cuenta = canal === 'mercadolibre' ? ml : woo;
  const m = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (id, company_id, channel_account_id, origen, clave_origen, titulo, archivado_en, motivo_archivo)
     VALUES (COALESCE($8::uuid, uuidv7()), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [empresa, cuenta, canal === 'mercadolibre' ? 'ml_simple' : 'woo_simple', randomUUID(), titulo, o.archivado ? new Date() : null, o.archivado ? 'test' : null, o.id ?? null])).rows[0]!.id;
  const v = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id`, [empresa, m])).rows[0]!.id;
  const rep = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id)
     VALUES ($1, $2, $3, $4, 'vendible', $5) RETURNING id`, [empresa, cuenta, canal, randomUUID(), v])).rows[0]!.id;
  if (o.repArchivada) await admin.query(`UPDATE catalog.external_representations SET archivado_en = now(), motivo_archivo = 'test' WHERE id = $1`, [rep]);
  for (const [n, val] of [['categoria_canal', categoria], ...(o.edad ?? []).map((e) => ['edad', e])]) {
    await admin.query(`INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
      VALUES ($1, $2, $3, $4, now())`, [m, rep, n, val]);
  }
  return m;
}

beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.model_facets, catalog.channel_categories, catalog.taxonomy_channel_map, catalog.channel_category_sin_equivalencia,
    catalog.model_categories, catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes, catalog.model_attributes,
    catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  ml = await cuenta('mercadolibre'); woo = await cuenta('woocommerce');
  for (const c of CATEGORIAS_D22) {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre)
      VALUES ($1, $2, 'mercadolibre', $3, $4)`, [empresa, ml, c.id, c.nombre]);
  }
  await enTransaccion(app, async (tx) => {
    const v = await crearVersion(tx, empresa, 'test');
    await escribirArbol(tx, empresa, v.id, [{ clave: 'bicicletas', nombre: 'BICICLETAS', padre: null }]);
  });
  camicleta = await modelo('Camicleta Rembrandt', 'MLA424974');
  infantil = await modelo('Bici Niño Polygon', 'MLA459678', { edad: ['Niños'] });
  yaRegla = await modelo('Bici Niña Topmega', 'MLA459678', { edad: ['Niños'] });
  yaPersona = await modelo('Bici Twitter', 'MLA459678');
  gravity = await modelo('Bicicleta Mtb Gravity Bling', 'MLA459678', { edad: ['Niños'] });   // edad = Niños y aun así es de adulto
  otra = await modelo('Bici Trek', 'MLA6143', { edad: ['Niños'] });
  porNombre = await modelo('Trampa por nombre', 'Bicicletas Infantiles');               // el nombre es de Woo: ML guarda el id
  soloWoo = await modelo('Sólo en Woo', 'MLA459678', { canal: 'woocommerce' });           // el id en una publicación de Woo no cuenta
  await modelo('Archivada', 'MLA459678', { archivado: true });
  await modelo('Publicación archivada', 'MLA459678', { repArchivada: true });
  await enTransaccion(app, async (tx) => {
    await escribirFaceta(tx, { empresa, modelo: yaRegla, faceta: 'publico', valor: 'infantil', origen: 'regla_categoria', motivo: 'D16', decididoPor: 'jose' });
    await escribirFaceta(tx, { empresa, modelo: yaPersona, faceta: 'publico', valor: 'infantil', origen: 'persona', motivo: 'D16 persona', decididoPor: 'jose' });
  });
});

const decisiones = (): DecisionesD22 => ({ excluidos: [{ modelo: gravity, titulo: 'Gravity Bling', motivo: 'de adulto, mal categorizada en ML' }] });
const aplicar = (over: Partial<Parameters<typeof aplicarD22>[1]> = {}) =>
  enTransaccion(app, (tx) => aplicarD22(tx, { empresa, cuentaMl: ml, decididoPor: 'jose', dryRun: false, decisiones: decisiones(), ...over }));
const facetas = async () => (await admin.query<{ id: string; model_id: string; valor: string; origen: string; motivo: string }>(
  `SELECT id, model_id, valor, origen, motivo FROM catalog.model_facets WHERE faceta = 'publico' AND vigente_hasta IS NULL ORDER BY model_id`)).rows;
const mapeos = async () => (await admin.query<{ id_externo: string; clave: string }>(
  `SELECT m.id_externo, n.clave FROM catalog.taxonomy_channel_map m JOIN catalog.taxonomy_nodes n ON n.id = m.node_id
    WHERE m.channel_account_id = $1 AND m.vigente_hasta IS NULL ORDER BY 1`, [ml])).rows;

describe('E2-D22-01 qué modelos reciben la faceta', () => {
  it('dry-run: busca por ID de categoría en ML, separa nuevas / ya tenían / excluidos, y no escribe nada', async () => {
    const r = await aplicar({ dryRun: true });
    expect(r.modelosEnLasCategorias).toBe(5);   // ni archivados, ni publicación archivada, ni por nombre, ni de Woo, ni otra categoría
    expect(r.nuevas.map((m) => m.modelo).sort()).toEqual([camicleta, infantil].sort());
    expect(r.yaTenian.map((m) => m.modelo).sort()).toEqual([yaRegla, yaPersona].sort());
    expect(r.excluidos.map((m) => m.modelo)).toEqual([gravity]);
    expect(r.mapeo).toMatchObject({ total: 2, nuevos: 2, quedaron: null });
    expect(r.quedaron).toBeNull();
    expect(await mapeos()).toEqual([]);
    expect((await facetas()).map((f) => f.model_id).sort()).toEqual([yaRegla, yaPersona].sort());
  });
});

describe('E2-D22-02 aplicar', () => {
  it('mapea las dos a bicicletas y escribe la faceta por regla sólo a los nuevos, contando lo que quedó', async () => {
    const r = await aplicar();
    expect(r.quedaron).toEqual({ regla_categoria: 2, yaTenian: 2 });
    expect(r.mapeo.quedaron).toBe(2);
    expect(await mapeos()).toEqual([{ id_externo: 'MLA424974', clave: 'bicicletas' }, { id_externo: 'MLA459678', clave: 'bicicletas' }]);
    const f = await facetas();
    const de = (m: string) => f.find((x) => x.model_id === m);
    expect(de(camicleta)).toMatchObject({ valor: 'infantil', origen: 'regla_categoria' });
    expect(de(infantil)).toMatchObject({ valor: 'infantil', origen: 'regla_categoria' });
    expect(de(camicleta)!.motivo).toContain('MLA424974');
    expect(de(infantil)!.motivo).toContain('MLA459678');
    // Nada de lo que no corresponde: ni la de otra categoría, ni la de Woo, ni la que sólo coincide por nombre.
    expect(f.some((x) => [otra, porNombre, soloWoo].includes(x.model_id))).toBe(false);
  });

  it('los que YA tenían la faceta no se tocan: misma fila, mismo origen, sin duplicar', async () => {
    const antes = await facetas();
    await aplicar();
    const despues = await facetas();
    for (const m of [yaRegla, yaPersona]) {
      expect(despues.filter((x) => x.model_id === m)).toEqual(antes.filter((x) => x.model_id === m));
    }
    expect(despues.find((x) => x.model_id === yaPersona)!.origen).toBe('persona');   // no se pisó con `regla_categoria`
    expect((await admin.query(`SELECT 1 FROM catalog.model_facets WHERE model_id = ANY($1)`, [[yaRegla, yaPersona]])).rowCount).toBe(2); // ni historia nueva
  });

  it('el excluido NO recibe la faceta aunque su atributo `edad` diga «Niños» (el caso que la regla de D16 no cubre)', async () => {
    expect((await admin.query(`SELECT 1 FROM catalog.model_attributes WHERE model_id = $1 AND nombre_normalizado = 'edad' AND valor = 'Niños'`, [gravity])).rowCount).toBe(1);
    const r = await aplicar();
    expect(r.excluidos.map((m) => m.modelo)).toEqual([gravity]);
    expect((await facetas()).some((x) => x.model_id === gravity)).toBe(false);
  });

  it('sin la exclusión, ese mismo modelo SÍ la recibiría: la exclusión es lo único que lo frena', async () => {
    await aplicar({ decisiones: { excluidos: [] } });
    expect((await facetas()).some((x) => x.model_id === gravity)).toBe(true);
  });

  it('es idempotente: una segunda corrida no escribe facetas nuevas y los cuenta como «ya tenían»', async () => {
    await aplicar();
    const r = await aplicar();
    expect(r.nuevas).toEqual([]);
    expect(r.yaTenian).toHaveLength(4);
    expect(r.mapeo).toMatchObject({ nuevos: 0, iguales: 2 });
  });
});

describe('E2-D22-03 atomicidad y verificación de lo que quedó', () => {
  it('si falla la escritura de una faceta no queda NINGÚN mapeo ni faceta nueva', async () => {
    await expect(aplicar({ escribir: async () => { throw new Error('falla a propósito'); } })).rejects.toThrow(/falla a propósito/);
    expect(await mapeos()).toEqual([]);
    expect((await facetas()).map((f) => f.model_id).sort()).toEqual([yaRegla, yaPersona].sort());
  });
  it('una faceta que no deja rastro se detecta por lo que quedó y deshace también los mapeos', async () => {
    await expect(aplicar({ escribir: async () => true })).rejects.toThrow(/quedaron 0 facetas nuevas/);
    expect(await mapeos()).toEqual([]);
  });
  it('un excluido que ya tenía la faceta hace fallar todo (no se deja pasar en silencio)', async () => {
    await enTransaccion(app, (tx) => escribirFaceta(tx, { empresa, modelo: gravity, faceta: 'publico', valor: 'infantil', origen: 'regla_categoria', motivo: 'x', decididoPor: 'jose' }));
    await expect(aplicar()).rejects.toThrow(/excluidos quedaron con la faceta/);
    expect(await mapeos()).toEqual([]);
  });
  it('un modelo con `publico` de otro valor no se pisa: se frena y se resuelve a mano', async () => {
    await enTransaccion(app, (tx) => escribirFaceta(tx, { empresa, modelo: camicleta, faceta: 'publico', valor: 'adulto', origen: 'persona', motivo: 'x', decididoPor: 'jose' }));
    await expect(aplicar()).rejects.toThrow(/distinta de «infantil»/);
    expect(await mapeos()).toEqual([]);
  });
});

describe('E2-D22-04 lo que frena', () => {
  it('una cuenta de Woo', async () => {
    await expect(aplicar({ cuentaMl: woo })).rejects.toThrow(/es de woocommerce/);
  });
  it('una exclusión sobre un modelo que no está en las categorías', async () => {
    await expect(aplicar({ decisiones: { excluidos: [{ modelo: otra, titulo: 'x', motivo: 'y' }] } })).rejects.toThrow(/exclusiones sobre modelos que no están/);
  });
  it('una categoría cuyo nombre en la base no es el esperado', async () => {
    await admin.query(`UPDATE catalog.channel_categories SET nombre = 'Otra cosa' WHERE id_externo = 'MLA424974'`);
    await expect(aplicar()).rejects.toThrow(/MLA424974 no es «Camicletas»/);
  });
});

describe('E2-D22-05 las decisiones tal como están en el código', () => {
  it('son 4 Gravity Bling por id, con motivo, y ninguna regla las deduce del atributo', () => {
    expect(DECISIONES_D22.excluidos.map((d) => d.modelo).sort()).toEqual([
      '01a0bcb0-ee2d-78b2-bf68-b4a7905ac383', '01a0bcb0-f366-7ddc-991c-94ea1e3738a1',
      '01a0bcc7-d4e6-7408-832f-8cb5e0aee4f5', '01a0bcc7-d508-73a9-81be-bed0329e94ee']);
    expect(DECISIONES_D22.excluidos.every((d) => d.motivo.includes('rodado 29') && d.motivo.includes('`edad`'))).toBe(true);
  });
  it('las categorías de D22 están en MAPEO_ML pero el script general las saltea (se aplican con su faceta)', () => {
    for (const c of CATEGORIAS_D22) expect(MAPEO_ML[c.id]).toBe('bicicletas');
    const resto = sinCategoriasD22(MAPEO_ML);
    expect(Object.keys(resto)).toHaveLength(Object.keys(MAPEO_ML).length - 2);
    expect(CATEGORIAS_D22.some((c) => c.id in resto)).toBe(false);
  });
});

describe('E2-D22-06 el script', () => {
  const correr = (args: string[]) => {
    const p = new URL(base.urlApp);
    return spawnSync(process.execPath, [SCRIPT, '--empresa', empresa, '--cuenta', ml, ...args], { encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '', PG_HOST: p.hostname, PG_PORT: p.port, PG_DATABASE: p.pathname.slice(1),
      PG_USER: p.username, PG_PASSWORD: p.password } });
  };
  it('dry-run no escribe; --ejecutar escribe. Sin decisiones de test, las 4 Gravity no existen aquí: frena', async () => {
    // Las exclusiones reales (ids de producción) no existen en esta base: el script real tiene que frenar y no escribir.
    const seco = correr([]);
    expect(seco.status).toBe(1);
    expect(seco.stderr).toMatch(/exclusiones sobre modelos que no están/);
    expect(await mapeos()).toEqual([]);
  });
  it('con los ids reales presentes, informa por grupos y escribe lo esperado', async () => {
    for (const d of DECISIONES_D22.excluidos) await modelo('Gravity real', 'MLA459678', { edad: ['Niños'], id: d.modelo });
    const seco = correr([]);
    expect(seco.status, seco.stderr).toBe(0);
    const j = JSON.parse(seco.stdout);
    expect(j).toMatchObject({ dryRun: true, modelosEnLasCategorias: 9 });
    // `gravity` (id de prueba) no está en la lista real de exclusiones: cuenta como nueva.
    expect(j.excluidos).toHaveLength(4); expect(j.yaTenianLaFaceta).toHaveLength(2); expect(j.facetasNuevas).toHaveLength(3);
    expect(await mapeos()).toEqual([]);
    expect(correr(['--ejecutar']).status).toBe(0);
    expect(await mapeos()).toHaveLength(2);
    expect((await facetas()).some((f) => DECISIONES_D22.excluidos.some((d) => d.modelo === f.model_id))).toBe(false);
  });
});
