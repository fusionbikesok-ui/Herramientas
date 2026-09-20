/*
 * src/catalogo/informe-taxonomia.ts — E2 T3 tarea 3: el insumo con el que José decide D1-D4 (el árbol,
 * ver docs/superpowers/plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md, tarea 3 y tarea 4).
 *
 * Sólo lectura: cuenta y compara, no decide ni abre casos. Igual que el informe del tramo 2, mide ANTES de
 * que los casos existan.
 *
 * Fuentes:
 *   - candidatos "categoria_canal": el atributo ya capturado por T2 en `catalog.model_attributes`
 *     (nombre_normalizado = 'categoria_canal'), aplanado, un valor por modelo y canal.
 *   - la jerarquía real del canal: `catalog.channel_categories` (T3 tarea 1, `categorias-canal.ts`), CON
 *     `parent_externo`. Es la diferencia con lo que decía el plan original: antes sólo había la lista
 *     aplanada de `categoria_canal`; ahora se sabe qué es padre de qué.
 *   - candidatos a marca: el atributo `marca`/`brand` en `model_attributes` (lo que ML declara) y
 *     `catalog.brands`/`brand_aliases` (lo que T2 ya canonicalizó, vía `normalizarMarca` de `taxonomia.ts`).
 *
 * La partición en tres grupos (taxonomía real / marca mal usada / colección) NO se hardcodea: se deriva
 * cotejando cada nombre de categoría de Woo contra las marcas conocidas (por `normalizarMarca`) y contra
 * la clave de colección conocida (`Hotsale`, ya materializada por T2 en `catalog.collections`. Si no hay
 * colección cargada, "Hotsale" cae por nombre exacto normalizado como red de contención: no debería hacer
 * falta si T2 ya corrió, pero el informe no debe reventar si corre antes).
 */
import type { Consultable } from '../db/pool.ts';
import { tokensComparacion, valoresRelacionados } from './atributos.ts';
import { normalizarMarca } from './taxonomia.ts';

/**
 * La clave con la que se compara un nombre de categoría en TODO este informe. Una sola función a propósito:
 * la partición y la medición de cobertura se indexan con ella y tienen que casar exactamente.
 */
export const claveNombre = (nombre: string): string => tokensComparacion(nombre).join(' ');

// ─────────────────────────── candidatos ───────────────────────────

export interface CandidatoCategoriaCanal {
  nombreNormalizado: string;
  ejemplos: string[]; // hasta 3 formas de escritura tal como llegaron
  modelos: number;
}

/** Candidatos a nodo desde el atributo `categoria_canal` ya capturado por T2, agrupados por nombre normalizado. */
export async function candidatosDesdeAtributo(tx: Consultable, empresa: string): Promise<CandidatoCategoriaCanal[]> {
  const r = await tx.query<{ valor: string; modelos: string }>(
    `SELECT a.valor, count(DISTINCT a.model_id) AS modelos
       FROM catalog.model_attributes a
       JOIN catalog.product_models m ON m.id = a.model_id
      WHERE m.company_id = $1 AND a.nombre_normalizado = 'categoria_canal' AND a.vigente_hasta IS NULL
      GROUP BY a.valor`, [empresa]);
  const porNormalizado = new Map<string, CandidatoCategoriaCanal>();
  for (const fila of r.rows) {
    const clave = claveNombre(fila.valor);
    const actual = porNormalizado.get(clave);
    if (!actual) {
      porNormalizado.set(clave, { nombreNormalizado: clave, ejemplos: [fila.valor], modelos: Number(fila.modelos) });
    } else {
      if (actual.ejemplos.length < 3 && !actual.ejemplos.includes(fila.valor)) actual.ejemplos.push(fila.valor);
      actual.modelos += Number(fila.modelos);
    }
  }
  return [...porNormalizado.values()].sort((a, b) => b.modelos - a.modelos);
}

export interface CategoriaChannelConPadre {
  idExterno: string;
  parentExterno: string | null;
  nombre: string;
  conteo: number | null;
}

/** La jerarquía vigente importada por T3 tarea 1, para una cuenta de canal. */
export async function categoriasDeCanal(tx: Consultable, channelAccountId: string): Promise<CategoriaChannelConPadre[]> {
  const r = await tx.query<CategoriaChannelConPadre>(
    `SELECT id_externo AS "idExterno", parent_externo AS "parentExterno", nombre, conteo
       FROM catalog.channel_categories
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL
      -- Ordenado por los DIGITOS del id y no con un cast a int: los ids de ML son 'MLA1234' y el cast
      -- reventaba el informe entero en cuanto se le pasaba una cuenta de MercadoLibre. El orden es cosmético;
      -- lo que no puede es fallar.
      ORDER BY nullif(regexp_replace(id_externo, '[^0-9]', '', 'g'), '')::bigint NULLS LAST, id_externo`,
    [channelAccountId]);
  return r.rows;
}

// ─────────────────────────── partición en tres grupos ───────────────────────────

export type GrupoCategoria = 'taxonomia' | 'marca' | 'coleccion';

export interface CategoriaClasificada extends CategoriaChannelConPadre {
  grupo: GrupoCategoria;
  motivo: string;
}

/**
 * Deriva la partición 65/15/1: cada categoría de la jerarquía se coteja contra las marcas conocidas
 * (`normalizarMarca`, para que 'FANTTIK' case aunque en Woo nunca llevó mayúsculas distintas) y contra las
 * colecciones conocidas. Todo lo que no case cae en 'taxonomia', que es el grupo por default y el más
 * grande: el informe no adivina una marca o colección que nadie declaró.
 */
export function clasificarCategorias(
  categorias: CategoriaChannelConPadre[],
  marcasConocidas: Set<string>,
  coleccionesConocidas: Set<string>,
): CategoriaClasificada[] {
  return categorias.map((c) => {
    // `claveNombre` y no `normalizarMarca`: `medirCobertura` indexa la partición con `claveNombre`, y con dos
    // normalizadores distintos un nombre con puntuación ('LIQUIDOS/FRENOS') caía en claves diferentes a cada
    // lado y el modelo quedaba sin clasificar sin que nada protestara.
    const clave = claveNombre(c.nombre);
    if (coleccionesConocidas.has(clave)) {
      return { ...c, grupo: 'coleccion', motivo: `coincide con una colección conocida ('${c.nombre}')` };
    }
    if (marcasConocidas.has(clave)) {
      return { ...c, grupo: 'marca', motivo: `coincide con una marca conocida ('${c.nombre}')` };
    }
    // 'BICICLETAS <marca>' es el patrón del legado para la marca mal usada como categoría (D2 del plan):
    // el nombre trae la marca pegada con un prefijo, así que se prueba también el resto tras "bicicletas".
    const sinPrefijo = clave.replace(/^bicicletas\s+/, '');
    if (sinPrefijo !== clave && marcasConocidas.has(sinPrefijo)) {
      return { ...c, grupo: 'marca', motivo: `'${c.nombre}' es 'bicicletas <marca>': ${sinPrefijo} es marca conocida` };
    }
    return { ...c, grupo: 'taxonomia', motivo: 'no coincide con ninguna marca ni colección conocida' };
  });
}

/** Los nombres normalizados de marca ya conocidos: `catalog.brands` + sus alias, más lo que ML declara como atributo. */
export async function marcasConocidas(tx: Consultable, empresa: string): Promise<Set<string>> {
  const desdeBrands = await tx.query<{ n: string }>(
    `SELECT nombre_normalizado AS n FROM catalog.brands WHERE company_id = $1 AND archivado_en IS NULL
     UNION
     SELECT a.alias_normalizado AS n FROM catalog.brand_aliases a
       JOIN catalog.brands b ON b.id = a.brand_id AND b.archivado_en IS NULL
      WHERE a.company_id = $1`, [empresa]);
  const desdeAtributoMl = await tx.query<{ valor: string }>(
    `SELECT DISTINCT a.valor FROM catalog.model_attributes a
       JOIN catalog.product_models m ON m.id = a.model_id
      WHERE m.company_id = $1 AND a.nombre_normalizado IN ('marca', 'brand') AND a.vigente_hasta IS NULL`, [empresa]);
  const set = new Set(desdeBrands.rows.map((r) => r.n));
  for (const r of desdeAtributoMl.rows) set.add(normalizarMarca(r.valor));
  return set;
}

/** Las claves normalizadas de las colecciones ya cargadas por T2, más 'hotsale' como red de contención. */
export async function coleccionesConocidas(tx: Consultable, empresa: string): Promise<Set<string>> {
  const r = await tx.query<{ nombre: string }>(
    `SELECT nombre FROM catalog.collections WHERE company_id = $1 AND archivado_en IS NULL`, [empresa]);
  const set = new Set(r.rows.map((x) => normalizarMarca(x.nombre)));
  set.add('hotsale');
  return set;
}

// ─────────────────────────── solapamientos ───────────────────────────

export interface Solapamiento {
  a: string; b: string;
  emparentado: boolean; // true = padre/hijo en la jerarquía del canal: no hay nada que decidir.
}

/**
 * Pares de categorías cuyos nombres se contienen por tokens (`valoresRelacionados`, igual criterio que los
 * atributos de T2). Distingue lo que YA está resuelto en la jerarquía (padre e hijo: `Cubiertas y Cámaras`
 * ⊃ `CUBIERTAS`, que José creía un solapamiento y era esto) de lo que de verdad hay que decidir (parecidos
 * pero sin relación de parentesco en el canal).
 */
export function detectarSolapamientos(categorias: CategoriaChannelConPadre[]): Solapamiento[] {
  const porId = new Map(categorias.map((c) => [c.idExterno, c]));
  const esAncestro = (posibleAncestro: string, nodo: string): boolean => {
    let actual = porId.get(nodo)?.parentExterno ?? null;
    let saltos = 0;
    while (actual !== null && saltos < 16) {
      if (actual === posibleAncestro) return true;
      actual = porId.get(actual)?.parentExterno ?? null;
      saltos++;
    }
    return false;
  };
  const pares: Solapamiento[] = [];
  for (let i = 0; i < categorias.length; i++) {
    for (let j = i + 1; j < categorias.length; j++) {
      const a = categorias[i]!; const b = categorias[j]!;
      if (!valoresRelacionados(a.nombre, b.nombre)) continue;
      const emparentado = esAncestro(a.idExterno, b.idExterno) || esAncestro(b.idExterno, a.idExterno);
      pares.push({ a: a.nombre, b: b.nombre, emparentado });
    }
  }
  return pares;
}

// ─────────────────────────── cobertura ───────────────────────────

export interface Cobertura {
  totalModelos: number;
  sinCategoriaUtil: number;   // ningún categoria_canal capturado
  variasCandidatas: number;   // más de un valor distinto de categoria_canal
  soloMarcaOColeccion: number; // su(s) categoria_canal caen todos en grupo marca/colección, ninguno en taxonomía
  contradictoriosEntreCanales: number; // categoria_canal de Woo y de ML capturados, y no están relacionados
}

interface FilaCategoriaModelo { modelId: string; canal: string; valor: string }

/**
 * Cuenta, no abre casos (igual criterio que el informe del tramo 2). `clasificacionPorNombre` es la
 * partición ya calculada por `clasificarCategorias` sobre las categorías DEL CANAL, indexada por nombre
 * normalizado con `claveNombre` — la misma clave que usa `candidatosDesdeAtributo` para agrupar los
 * valores de `categoria_canal`, así los dos lados casan.
 */
export async function medirCobertura(
  tx: Consultable, empresa: string, clasificacionPorNombre: Map<string, GrupoCategoria>,
): Promise<Cobertura> {
  const totalModelos = Number((await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM catalog.product_models WHERE company_id = $1 AND archivado_en IS NULL`,
    [empresa])).rows[0]!.n);

  const filas = (await tx.query<FilaCategoriaModelo>(
    `SELECT a.model_id AS "modelId", r.canal, a.valor
       FROM catalog.model_attributes a
       JOIN catalog.product_models m ON m.id = a.model_id
       JOIN catalog.external_representations r ON r.id = a.representation_id
      WHERE m.company_id = $1 AND a.nombre_normalizado = 'categoria_canal' AND a.vigente_hasta IS NULL`,
    [empresa])).rows;

  const porModelo = new Map<string, FilaCategoriaModelo[]>();
  for (const f of filas) {
    const lista = porModelo.get(f.modelId) ?? [];
    lista.push(f);
    porModelo.set(f.modelId, lista);
  }

  let variasCandidatas = 0; let soloMarcaOColeccion = 0; let contradictoriosEntreCanales = 0;
  for (const lista of porModelo.values()) {
    const valoresUnicos = new Set(lista.map((f) => f.valor));
    if (valoresUnicos.size > 1) variasCandidatas++;

    const grupos = [...valoresUnicos].map((v) => clasificacionPorNombre.get(claveNombre(v)) ?? 'taxonomia');
    if (grupos.length > 0 && grupos.every((g) => g !== 'taxonomia')) soloMarcaOColeccion++;

    const porCanal = new Map<string, Set<string>>();
    for (const f of lista) {
      const s = porCanal.get(f.canal) ?? new Set<string>();
      s.add(f.valor);
      porCanal.set(f.canal, s);
    }
    if (porCanal.size > 1) {
      const [canalA, canalB] = [...porCanal.keys()];
      const valoresA = [...porCanal.get(canalA!)!];
      const valoresB = [...porCanal.get(canalB!)!];
      const relacionados = valoresA.some((va) => valoresB.some((vb) => valoresRelacionados(va, vb)));
      if (!relacionados) contradictoriosEntreCanales++;
    }
  }

  return {
    totalModelos,
    sinCategoriaUtil: totalModelos - porModelo.size,
    variasCandidatas,
    soloMarcaOColeccion,
    contradictoriosEntreCanales,
  };
}

// ─────────────────────────── el informe entero ───────────────────────────

export interface InformeTaxonomia {
  candidatosAtributo: CandidatoCategoriaCanal[];
  categoriasCanal: CategoriaClasificada[];
  particion: { taxonomia: number; marca: number; coleccion: number };
  solapamientos: { emparentados: Solapamiento[]; sinEmparentar: Solapamiento[] };
  cobertura: Cobertura;
}

export async function generarInforme(
  tx: Consultable, empresa: string, channelAccountId: string,
): Promise<InformeTaxonomia> {
  const [candidatosAtributo, categorias, marcas, colecciones] = await Promise.all([
    candidatosDesdeAtributo(tx, empresa),
    categoriasDeCanal(tx, channelAccountId),
    marcasConocidas(tx, empresa),
    coleccionesConocidas(tx, empresa),
  ]);

  const categoriasCanal = clasificarCategorias(categorias, marcas, colecciones);
  const particion = { taxonomia: 0, marca: 0, coleccion: 0 };
  for (const c of categoriasCanal) particion[c.grupo]++;

  const clasificacionPorNombre = new Map<string, GrupoCategoria>();
  for (const c of categoriasCanal) clasificacionPorNombre.set(claveNombre(c.nombre), c.grupo);

  const todosLosSolapamientos = detectarSolapamientos(categorias);
  const solapamientos = {
    emparentados: todosLosSolapamientos.filter((s) => s.emparentado),
    sinEmparentar: todosLosSolapamientos.filter((s) => !s.emparentado),
  };

  const cobertura = await medirCobertura(tx, empresa, clasificacionPorNombre);

  return { candidatosAtributo, categoriasCanal, particion, solapamientos, cobertura };
}
