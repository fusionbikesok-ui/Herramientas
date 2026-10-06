/*
 * src/catalogo/infantiles-ml.ts — D22: D16 del lado de MercadoLibre. `Bicicletas Infantiles` (MLA459678) y `Camicletas`
 * (MLA424974) van al nodo `bicicletas` y sus modelos reciben la faceta `publico = infantil`.
 *
 * Mapear sin la faceta perdería el dato «infantil», así que es UNA transacción: mapeos + facetas + conteo de lo que
 * QUEDÓ. Si algo no cierra, se deshace todo. Reusa `escribirFaceta` y `FACETA_PUBLICO` de D16.
 *
 * Asimetría de canal: ML guarda en `categoria_canal` el ID (`MLA459678`), Woo el nombre (D16 busca por nombre).
 *
 * El atributo `edad` NO se consulta: no es confiable en ninguna dirección (en Woo decía «Adultos» en bicis de niño; en
 * ML dice «Niños» en una R29 de adulto). Los excluidos van por id, con su motivo, como una decisión de José.
 */
import type { Consultable } from '../db/pool.ts';
import { escribirFaceta } from './facetas.ts';
import { FACETA_PUBLICO } from './infantiles.ts';
import { aplicarMapeoCategorias, type ResumenMapeo } from './mapeo-canal.ts';
import { mapearCategoria } from './taxonomia.ts';

export const CATEGORIAS_D22 = [
  { id: 'MLA459678', nombre: 'Bicicletas Infantiles' },
  { id: 'MLA424974', nombre: 'Camicletas' },
] as const;
export const NODO_DESTINO_D22 = 'bicicletas';

export interface DecisionesD22 { excluidos: Array<{ modelo: string; titulo: string; motivo: string }> }

const MOTIVO_GRAVITY = 'Decisión de José (D22): Gravity Bling es rodado 29, recomendada +14 años, 1×10 con frenos hidráulicos: de adulto, '
  + 'mal categorizada en ML. No lleva faceta aunque su atributo `edad` diga «Niños» (no es confiable). Deuda: corregir la categoría en ML.';
export const DECISIONES_D22: DecisionesD22 = {
  excluidos: [
    '01a0bcb0-ee2d-78b2-bf68-b4a7905ac383', '01a0bcb0-f366-7ddc-991c-94ea1e3738a1',
    '01a0bcc7-d4e6-7408-832f-8cb5e0aee4f5', '01a0bcc7-d508-73a9-81be-bed0329e94ee',
  ].map((modelo) => ({ modelo, titulo: 'Bicicleta Mtb Gravity Bling 1x10 L-twoo', motivo: MOTIVO_GRAVITY })),
};

/** El mapeo de ML sin las categorías de D22: esas sólo se aplican junto con su faceta. */
export function sinCategoriasD22(mapeo: Record<string, string>): Record<string, string> {
  const ids = new Set<string>(CATEGORIAS_D22.map((c) => c.id));
  return Object.fromEntries(Object.entries(mapeo).filter(([id]) => !ids.has(id)));
}

export interface OpcionesD22 {
  empresa: string; cuentaMl: string; decididoPor: string; dryRun: boolean;
  decisiones?: DecisionesD22;
  /** Sólo para probar la atomicidad. */
  escribir?: typeof escribirFaceta;
  mapear?: typeof mapearCategoria;
}
export interface ModeloD22 { modelo: string; titulo: string; categoria: string }
export interface ResumenD22 {
  modelosEnLasCategorias: number;
  /** Reciben la faceta ahora, con `origen = 'regla_categoria'`. */
  nuevas: ModeloD22[];
  /** Ya tenían `publico = infantil` vigente (D16): no se tocan. */
  yaTenian: ModeloD22[];
  /** Nunca llevan faceta, por decisión explícita. */
  excluidos: ModeloD22[];
  mapeo: ResumenMapeo;
  quedaron: { regla_categoria: number; yaTenian: number } | null;
}

export async function aplicarD22(tx: Consultable, o: OpcionesD22): Promise<ResumenD22> {
  const cta = (await tx.query<{ company_id: string; channel: string }>(
    'SELECT company_id, channel FROM core.channel_accounts WHERE id = $1', [o.cuentaMl])).rows[0];
  if (!cta) throw new Error(`no existe channel_account ${o.cuentaMl}`);
  if (cta.channel !== 'mercadolibre') throw new Error(`la cuenta ${o.cuentaMl} es de ${cta.channel}: las categorías de D22 son de MercadoLibre`);
  if (cta.company_id !== o.empresa) throw new Error(`la cuenta ${o.cuentaMl} no es de la empresa ${o.empresa}`);

  const ids = CATEGORIAS_D22.map((c) => c.id);
  const nombres = new Map((await tx.query<{ id_externo: string; nombre: string }>(
    `SELECT id_externo, nombre FROM catalog.channel_categories
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuentaMl, ids])).rows
    .map((r) => [r.id_externo, r.nombre]));
  for (const c of CATEGORIAS_D22) {
    if (nombres.get(c.id) !== c.nombre) {
      throw new Error(`la categoría ${c.id} no es «${c.nombre}» en la base (es ${nombres.has(c.id) ? `«${nombres.get(c.id)}»` : 'inexistente'}): no se aplica`);
    }
  }

  // Por ID de categoría (ML guarda el id), sólo publicaciones de ML no archivadas, modelos no archivados.
  const filas = (await tx.query<ModeloD22>(
    `SELECT DISTINCT p.id AS modelo, p.titulo, a.valor AS categoria
       FROM catalog.product_models p
       JOIN catalog.model_attributes a ON a.model_id = p.id AND a.nombre_normalizado = 'categoria_canal'
            AND a.vigente_hasta IS NULL AND a.valor = ANY($2)
       JOIN catalog.external_representations r ON r.id = a.representation_id
            AND r.canal = 'mercadolibre' AND r.channel_account_id = $3 AND r.archivado_en IS NULL
      WHERE p.company_id = $1 AND p.archivado_en IS NULL
      ORDER BY p.id`, [o.empresa, ids, o.cuentaMl])).rows;
  const enCategoria = new Set(filas.map((f) => f.modelo));
  const dec = o.decisiones ?? DECISIONES_D22;
  const idsExcluidos = new Set(dec.excluidos.map((d) => d.modelo));
  const ajenos = [...idsExcluidos].filter((i) => !enCategoria.has(i));
  if (ajenos.length) throw new Error(`exclusiones sobre modelos que no están en las categorías (o están archivados): ${ajenos.join(', ')}`);

  const previas = new Map((await tx.query<{ model_id: string; valor: string }>(
    `SELECT model_id, valor FROM catalog.model_facets
      WHERE company_id = $1 AND faceta = $2 AND vigente_hasta IS NULL AND model_id = ANY($3)`,
    [o.empresa, FACETA_PUBLICO.faceta, [...enCategoria]])).rows.map((r) => [r.model_id, r.valor]));
  const otroValor = filas.filter((f) => previas.has(f.modelo) && previas.get(f.modelo) !== FACETA_PUBLICO.valor);
  if (otroValor.length) {
    throw new Error(`modelos con \`${FACETA_PUBLICO.faceta}\` distinta de «${FACETA_PUBLICO.valor}»: ${otroValor.map((m) => m.modelo).join(', ')}: se resuelve a mano`);
  }
  const excluidos = filas.filter((f) => idsExcluidos.has(f.modelo));
  const yaTenian = filas.filter((f) => !idsExcluidos.has(f.modelo) && previas.has(f.modelo));
  const nuevas = filas.filter((f) => !idsExcluidos.has(f.modelo) && !previas.has(f.modelo));

  const mapeo = await aplicarMapeoCategorias(tx, {
    empresa: o.empresa, cuenta: o.cuentaMl, canal: 'mercadolibre',
    mapeo: Object.fromEntries(ids.map((i) => [i, NODO_DESTINO_D22])), decididoPor: o.decididoPor, dryRun: o.dryRun,
    ...(o.mapear ? { mapear: o.mapear } : {}),
  });
  const r: ResumenD22 = { modelosEnLasCategorias: filas.length, nuevas, yaTenian, excluidos, mapeo, quedaron: null };
  if (o.dryRun) return r;

  const escribir = o.escribir ?? escribirFaceta;
  for (const m of nuevas) {
    await escribir(tx, {
      empresa: o.empresa, modelo: m.modelo, ...FACETA_PUBLICO, origen: 'regla_categoria', decididoPor: o.decididoPor,
      motivo: `ML lo publica en «${CATEGORIAS_D22.find((c) => c.id === m.categoria)!.nombre}» [${m.categoria}] (D22: la categoría se mapea a `
        + `«${NODO_DESTINO_D22}» y su información pasa a esta faceta)`,
    });
  }

  // Se cuenta lo que QUEDÓ en la base, no las llamadas hechas.
  const cuenta = async (modelos: string[], origen?: string) => (await tx.query(
    `SELECT 1 FROM catalog.model_facets WHERE company_id = $1 AND faceta = $2 AND valor = $3 AND vigente_hasta IS NULL
        AND model_id = ANY($4) ${origen ? 'AND origen = $5' : ''}`,
    [o.empresa, FACETA_PUBLICO.faceta, FACETA_PUBLICO.valor, modelos, ...(origen ? [origen] : [])])).rowCount ?? 0;
  const nRegla = await cuenta(nuevas.map((m) => m.modelo), 'regla_categoria');
  const nYa = await cuenta(yaTenian.map((m) => m.modelo));
  r.quedaron = { regla_categoria: nRegla, yaTenian: nYa };
  if (nRegla !== nuevas.length || nYa !== yaTenian.length) {
    throw new Error(`quedaron ${nRegla} facetas nuevas y ${nYa} previas; se esperaban ${nuevas.length} y ${yaTenian.length}: se deshace todo`);
  }
  const indebidas = await cuenta(excluidos.map((m) => m.modelo));
  if (indebidas) throw new Error(`${indebidas} modelos excluidos quedaron con la faceta: se deshace todo`);
  return r;
}
