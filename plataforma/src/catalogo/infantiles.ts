/*
 * src/catalogo/infantiles.ts — D16: `BICICLETAS INFANTILES` deja de ser nodo y pasa a ser la faceta `publico = infantil`.
 *
 * Tiene que ser ATÓMICO: si se quitara el nodo y se remapeara la categoría de Woo `1538` a `bicicletas` sin
 * escribir la faceta, el dato «es infantil» se perdería del árbol. Por eso, en UNA transacción: se arma la versión
 * nueva del árbol (con el nodo archivado, no ausente), se remapea 1538 y se escriben las facetas, y se cuenta lo
 * que QUEDÓ. Si algo falla no queda nada. La versión nueva queda en BORRADOR: publicarla es otro paso
 * (`catalogo-arbol-publicar.mjs`), que se niega si algún mapeo quedó apuntando a un nodo que la versión no tiene.
 *
 * Los modelos cuya edad observada dice «Adultos» NO reciben la faceta: escribir `infantil` contra la única
 * evidencia observada sería inventar un hecho, y `origen = regla_categoria` sería una mentira. Se devuelven para
 * que una persona los decida uno por uno.
 */
import type { Consultable } from '../db/pool.ts';
import { ARBOL_FUSIONBIKES, NODOS_ARCHIVADOS } from './arbol-fusionbikes.ts';
import { escribirFaceta } from './facetas.ts';
import { crearVersion, escribirArbol, mapearCategoria } from './taxonomia.ts';

export const CATEGORIA_INFANTILES = { id: '1538', nombre: 'BICICLETAS INFANTILES', nodoDestino: 'bicicletas' } as const;
export const FACETA_PUBLICO = { faceta: 'publico', valor: 'infantil' } as const;

/**
 * Decisiones de José sobre los modelos que la edad observada contradice (D16), POR ID y no por una regla: una regla
 * que lee títulos nos devolvería al problema de adivinar, y una lista corta de ids se lee como lo que es, una
 * decisión. La regla de categoría sola no alcanzaba para saberlo: hizo falta que una persona mirara cada producto.
 */
export interface DecisionesPersona {
  /** Llevan la faceta con `origen = 'persona'`. */
  infantiles: Array<{ modelo: string; titulo: string }>;
  /** NUNCA llevan la faceta, aunque su edad observada cambie. */
  excluidos: Array<{ modelo: string; titulo: string; motivo: string }>;
  /** Por qué se decidió contra el atributo observado; queda escrito en cada fila. */
  motivoInfantiles: string;
}

export const DECISIONES_D16: DecisionesPersona = {
  infantiles: [
    { modelo: '01a0bbfd-2289-79a9-827e-4b4e0d1615c5', titulo: 'Bicicleta de Niño TWITTER FREEDOM R24' },
    { modelo: '01a0bbfd-17c9-71c0-ad78-aeb81ba15829', titulo: 'Bicicleta de Niño TWITTER TW2000 Pro R20' },
    { modelo: '01a0bbfd-182d-7ec9-a79f-397c4b9cd866', titulo: 'Bicicleta de Niño TWITTER TW2400 Pro R24' },
    { modelo: '01a0bc17-d933-75b7-b0d9-aea2f64fc24d', titulo: 'Bicicleta Niña R16 Topmega Vickfly' },
    { modelo: '01a0bc17-da94-7228-b1d7-db55bc2cea7b', titulo: 'Bicicleta Niña R20Topmega Vickfly' },
  ],
  excluidos: [
    { modelo: '01a0bbfe-05bb-78ef-b1c1-c191a987c3c0', titulo: 'Bicicleta MTB R26 Venzo Loki 2.1 Sensah 21V Edición 2025',
      motivo: 'Decisión de José (D16): es una MTB R26 de 21 velocidades para adulto; está mal categorizada en Woo (`BICICLETAS INFANTILES`), no es infantil. '
        + 'No lleva faceta aunque su atributo `edad` cambie. Deuda: corregir la categoría en Woo.' },
  ],
  motivoInfantiles: 'Decisión de José (D16), revisando el producto: el título dice «Niño/Niña» y el rodado (R16/R20/R24) lo confirma, '
    + 'así que el `edad = Adultos` observado en Woo es un error de carga y no una discrepancia real. Va con origen persona y no con regla '
    + 'de categoría porque la categoría sola no alcanzaba para saberlo: hizo falta mirar el producto.',
};

export interface OpcionesD16 {
  empresa: string; cuentaWoo: string; decididoPor: string; dryRun: boolean;
  decisiones?: DecisionesPersona;
  /** Sólo para probar la atomicidad: reemplaza la escritura de la faceta. */
  escribir?: typeof escribirFaceta;
}

export interface ModeloInfantil { modelo: string; titulo: string; edad: string[] }
export interface ResumenD16 {
  modelosEnLaCategoria: number;
  /** Faceta con `origen = 'regla_categoria'`: la edad observada no los contradice. */
  reglaCategoria: ModeloInfantil[];
  /** Faceta con `origen = 'persona'`: decididos uno por uno contra el atributo observado. */
  persona: ModeloInfantil[];
  /** Nunca llevan faceta, por decisión explícita. */
  excluidos: ModeloInfantil[];
  /** Los que la edad observada contradice y NADIE decidió: no se escriben. Debería quedar vacío. */
  sinDecidir: ModeloInfantil[];
  version: { id: string; numero: number } | null;
  nodosActivos: number | null;
  nodosArchivados: number | null;
  facetasQuedaron: number | null;
  remapeada: boolean | null;
}

const contradice = (edad: string[]) => edad.some((e) => e.trim().toLowerCase() === 'adultos');

export async function aplicarD16(tx: Consultable, o: OpcionesD16): Promise<ResumenD16> {
  const cta = (await tx.query<{ company_id: string; channel: string }>(
    'SELECT company_id, channel FROM core.channel_accounts WHERE id = $1', [o.cuentaWoo])).rows[0];
  if (!cta) throw new Error(`no existe channel_account ${o.cuentaWoo}`);
  if (cta.channel !== 'woocommerce') throw new Error(`la cuenta ${o.cuentaWoo} es de ${cta.channel}: la categoría ${CATEGORIA_INFANTILES.id} es de Woo`);
  if (cta.company_id !== o.empresa) throw new Error(`la cuenta ${o.cuentaWoo} no es de la empresa ${o.empresa}`);

  const cat = (await tx.query<{ nombre: string }>(
    `SELECT nombre FROM catalog.channel_categories
      WHERE channel_account_id = $1 AND id_externo = $2 AND vigente_hasta IS NULL`, [o.cuentaWoo, CATEGORIA_INFANTILES.id])).rows[0];
  if (cat?.nombre !== CATEGORIA_INFANTILES.nombre) {
    throw new Error(`la categoría ${CATEGORIA_INFANTILES.id} no es «${CATEGORIA_INFANTILES.nombre}» en la base (es ${cat ? `«${cat.nombre}»` : 'inexistente'}): no se aplica`);
  }
  const yaMapeada = (await tx.query(
    `SELECT 1 FROM catalog.taxonomy_channel_map m JOIN catalog.taxonomy_nodes n ON n.id = m.node_id
      WHERE m.channel_account_id = $1 AND m.id_externo = $2 AND m.vigente_hasta IS NULL AND n.clave = $3`,
    [o.cuentaWoo, CATEGORIA_INFANTILES.id, CATEGORIA_INFANTILES.nodoDestino])).rowCount;
  if (yaMapeada) throw new Error(`la categoría ${CATEGORIA_INFANTILES.id} ya está mapeada a «${CATEGORIA_INFANTILES.nodoDestino}»: D16 ya se aplicó`);

  // Los modelos se toman por la categoría OBSERVADA de Woo (por nombre: Woo guarda el nombre), no archivados.
  const filas = (await tx.query<{ modelo: string; titulo: string; edad: string[] }>(
    `SELECT p.id AS modelo, p.titulo,
            COALESCE((SELECT array_agg(DISTINCT e.valor ORDER BY e.valor) FROM catalog.model_attributes e
                       WHERE e.model_id = p.id AND e.nombre_normalizado = 'edad' AND e.vigente_hasta IS NULL), '{}') AS edad
       FROM catalog.product_models p
      WHERE p.company_id = $1 AND p.archivado_en IS NULL AND EXISTS (
        SELECT 1 FROM catalog.model_attributes a
          JOIN catalog.external_representations r ON r.id = a.representation_id
         WHERE a.model_id = p.id AND a.nombre_normalizado = 'categoria_canal' AND a.valor = $2
           AND a.vigente_hasta IS NULL AND r.canal = 'woocommerce' AND r.archivado_en IS NULL)
      ORDER BY p.id`, [o.empresa, CATEGORIA_INFANTILES.nombre])).rows;
  const dec = o.decisiones ?? DECISIONES_D16;
  const idsPersona = new Set(dec.infantiles.map((d) => d.modelo));
  const idsExcluidos = new Set(dec.excluidos.map((d) => d.modelo));
  const enCategoria = new Set(filas.map((f) => f.modelo));
  const solapados = [...idsPersona].filter((i) => idsExcluidos.has(i));
  if (solapados.length) throw new Error(`modelos decididos a la vez como infantiles y excluidos: ${solapados.join(', ')}`);
  // Una decisión sobre un modelo que ya no está en la categoría es una decisión sobre otra cosa: no se aplica a ciegas.
  const ajenos = [...idsPersona, ...idsExcluidos].filter((i) => !enCategoria.has(i));
  if (ajenos.length) throw new Error(`decisiones sobre modelos que no están en la categoría (o están archivados): ${ajenos.join(', ')}`);
  const persona = filas.filter((f) => idsPersona.has(f.modelo));
  const excluidos = filas.filter((f) => idsExcluidos.has(f.modelo));
  const restantes = filas.filter((f) => !idsPersona.has(f.modelo) && !idsExcluidos.has(f.modelo));
  const reglaCategoria = restantes.filter((f) => !contradice(f.edad));
  const sinDecidir = restantes.filter((f) => contradice(f.edad));
  const resumen: ResumenD16 = {
    modelosEnLaCategoria: filas.length, reglaCategoria, persona, excluidos, sinDecidir,
    version: null, nodosActivos: null, nodosArchivados: null, facetasQuedaron: null, remapeada: null,
  };
  if (o.dryRun) return resumen;

  const version = await crearVersion(tx, o.empresa,
    'árbol propio, D16: BICICLETAS INFANTILES pasa de nodo a faceta `publico = infantil`; cargado por catalogo-arbol-infantiles.mjs');
  resumen.version = version;
  const claves = await escribirArbol(tx, o.empresa, version.id, [
    ...ARBOL_FUSIONBIKES, ...NODOS_ARCHIVADOS.map(({ clave, nombre, padre }) => ({ clave, nombre, padre })),
  ]);
  for (const a of NODOS_ARCHIVADOS) {
    await tx.query('UPDATE catalog.taxonomy_node_versions SET archivado = true WHERE version_id = $1 AND node_id = $2',
      [version.id, claves.get(a.clave)]);
  }

  const destino = claves.get(CATEGORIA_INFANTILES.nodoDestino);
  if (!destino) throw new Error(`el nodo «${CATEGORIA_INFANTILES.nodoDestino}» no quedó escrito`);
  await mapearCategoria(tx, o.empresa, destino, o.cuentaWoo, 'woocommerce', CATEGORIA_INFANTILES.id, o.decididoPor);

  const escribir = o.escribir ?? escribirFaceta;
  for (const m of persona) {
    await escribir(tx, {
      empresa: o.empresa, modelo: m.modelo, ...FACETA_PUBLICO, origen: 'persona', decididoPor: o.decididoPor,
      motivo: dec.motivoInfantiles,
    });
  }
  for (const m of reglaCategoria) {
    await escribir(tx, {
      empresa: o.empresa, modelo: m.modelo, ...FACETA_PUBLICO, origen: 'regla_categoria', decididoPor: o.decididoPor,
      motivo: `Woo lo publica en «${CATEGORIA_INFANTILES.nombre}» [${CATEGORIA_INFANTILES.id}] y ninguna edad observada lo contradice (D16: `
        + 'la categoría dejó de ser nodo y su información pasa a esta faceta)',
    });
  }

  // Se cuenta lo que QUEDÓ en la base, no las llamadas hechas.
  const quedaron = async (origen: string, modelos: string[]) => (await tx.query(
    `SELECT 1 FROM catalog.model_facets WHERE company_id = $1 AND faceta = $2 AND valor = $3
        AND origen = $4 AND vigente_hasta IS NULL AND model_id = ANY($5)`,
    [o.empresa, FACETA_PUBLICO.faceta, FACETA_PUBLICO.valor, origen, modelos])).rowCount ?? 0;
  const nRegla = await quedaron('regla_categoria', reglaCategoria.map((m) => m.modelo));
  const nPersona = await quedaron('persona', persona.map((m) => m.modelo));
  resumen.facetasQuedaron = nRegla + nPersona;
  const esperadas = reglaCategoria.length + persona.length;
  if (nRegla !== reglaCategoria.length || nPersona !== persona.length) {
    throw new Error(`quedaron ${nRegla} facetas por regla y ${nPersona} por persona; se esperaban ${reglaCategoria.length} y ${persona.length} (${esperadas}): se deshace todo`);
  }
  // Y ningún excluido ni ningún sin decidir puede tener la faceta.
  const indebidas = (await tx.query(
    `SELECT 1 FROM catalog.model_facets WHERE company_id = $1 AND faceta = $2 AND vigente_hasta IS NULL AND model_id = ANY($3)`,
    [o.empresa, FACETA_PUBLICO.faceta, [...excluidos, ...sinDecidir].map((m) => m.modelo)])).rowCount ?? 0;
  if (indebidas) throw new Error(`${indebidas} modelos excluidos o sin decidir quedaron con la faceta: se deshace todo`);
  const remap = (await tx.query(
    `SELECT 1 FROM catalog.taxonomy_channel_map WHERE channel_account_id = $1 AND id_externo = $2
        AND vigente_hasta IS NULL AND node_id = $3`, [o.cuentaWoo, CATEGORIA_INFANTILES.id, destino])).rowCount;
  resumen.remapeada = remap === 1;
  if (!resumen.remapeada) throw new Error(`la categoría ${CATEGORIA_INFANTILES.id} no quedó mapeada a «${CATEGORIA_INFANTILES.nodoDestino}»: se deshace todo`);
  const nv = (await tx.query<{ archivado: boolean; n: number }>(
    'SELECT archivado, count(*)::int AS n FROM catalog.taxonomy_node_versions WHERE version_id = $1 GROUP BY 1', [version.id])).rows;
  resumen.nodosActivos = nv.find((r) => !r.archivado)?.n ?? 0;
  resumen.nodosArchivados = nv.find((r) => r.archivado)?.n ?? 0;
  if (resumen.nodosActivos !== ARBOL_FUSIONBIKES.length || resumen.nodosArchivados !== NODOS_ARCHIVADOS.length) {
    throw new Error(`la versión quedó con ${resumen.nodosActivos} nodos activos y ${resumen.nodosArchivados} archivados; `
      + `se esperaban ${ARBOL_FUSIONBIKES.length} y ${NODOS_ARCHIVADOS.length}: se deshace todo`);
  }
  return resumen;
}
