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

/**
 * El nombre de cada categoría del canal, indexado por su id remoto. Existe por un defecto que invalidaba el
 * informe entero: T2 guarda `categoria_canal` de **Woo** como el NOMBRE de la categoría, y el de
 * **MercadoLibre** como el `category_id` ('MLA3'). Comparar un nombre contra un id da siempre «no
 * relacionados», así que TODO modelo publicado en los dos canales se contaba como contradictorio, y la lista
 * de candidatos mezclaba ids de ML con nombres de Woo. Es la misma razón por la que `categoria_canal` quedó
 * fuera de la comparación de `atributo_divergente` en el tramo 2.
 * Con este diccionario los dos canales se comparan en el mismo idioma: el nombre.
 */
export async function nombresPorIdExterno(tx: Consultable, empresa: string): Promise<Map<string, string>> {
  const r = await tx.query<{ id_externo: string; nombre: string }>(
    `SELECT c.id_externo, c.nombre FROM catalog.channel_categories c
      WHERE c.company_id = $1 AND c.vigente_hasta IS NULL`, [empresa]);
  return new Map(r.rows.map((x) => [x.id_externo, x.nombre]));
}

/** El valor de `categoria_canal` traducido a nombre cuando lo que llegó fue un id remoto (el caso de ML). */
const enNombre = (valor: string, nombres: Map<string, string>): string => nombres.get(valor) ?? valor;

// ─────────────────────────── candidatos ───────────────────────────

export interface CandidatoCategoriaCanal {
  nombreNormalizado: string;
  ejemplos: string[]; // hasta 3 formas de escritura tal como llegaron
  modelos: number;
}

/** Candidatos a nodo desde el atributo `categoria_canal` ya capturado por T2, agrupados por nombre normalizado. */
export async function candidatosDesdeAtributo(
  tx: Consultable, empresa: string, nombres: Map<string, string> = new Map(),
): Promise<CandidatoCategoriaCanal[]> {
  const r = await tx.query<{ valor: string; modelos: string }>(
    `SELECT a.valor, count(DISTINCT a.model_id) AS modelos
       FROM catalog.model_attributes a
       JOIN catalog.product_models m ON m.id = a.model_id
      WHERE m.company_id = $1 AND a.nombre_normalizado = 'categoria_canal' AND a.vigente_hasta IS NULL
      GROUP BY a.valor`, [empresa]);
  const porNormalizado = new Map<string, CandidatoCategoriaCanal>();
  for (const cruda of r.rows) {
    // El valor de ML es un id ('MLA3'): se traduce a nombre para que los dos canales agrupen juntos.
    const fila = { ...cruda, valor: enNombre(cruda.valor, nombres) };
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
  // ── Modelos publicados en AMBOS canales: `entreCanales`. Hay DOS mediciones y cada una corre sobre un
  // subconjunto distinto; el que lee el JSON tiene que ver de una cuál es cuál.
  //
  // 1. EXACTA, por nodo del árbol propio (versión vigente), para los modelos cuyos DOS canales tienen nodo.
  //    Excluyentes, precedencia mismoNodo > unoAncestroDelOtro > nodosDistintos, y
  //      mismoNodo + unoAncestroDelOtro + nodosDistintos + sinNodoEnAlgunCanal = entreCanales.
  //    «Tiene nodo» = alguna de sus categorías de ese canal resuelve a un nodo NO archivado de la versión
  //    vigente (las demás, sin nodo, no cuentan: «alguna contra alguna»). Hermanos (mismo padre, distinto
  //    nodo) NO es acuerdo: cae en nodosDistintos.
  entreCanales: number;
  mismoNodo: number;
  unoAncestroDelOtro: number;
  nodosDistintos: number;
  /** No es una clase: los modelos en ambos canales a los que les falta nodo en algún canal. Son el dominio del puente. */
  sinNodoEnAlgunCanal: number;
  /** Versión del árbol usada; null si no hay una vigente (entonces las tres clases quedan en 0 y todo va al puente). */
  versionTaxonomia: string | null;
  muestraNodosDistintos: Array<{ woo: string; ml: string; modelos: number }>;
  // 2. PUENTE PROVISORIO, por nombres y ancestros del canal. Cubre EXACTAMENTE `sinNodoEnAlgunCanal` y
  //    desaparece cuando las categorías de ML estén mapeadas del todo: entonces «¿coinciden?» es «¿caen en el
  //    mismo nodo?». Se retira, no se afina; no lo extiendas.
  //    Sabido y aceptado sin medir: una raíz genérica de Woo (ACCESORIOS) queda «compatible» con un ancestro
  //    de ML como «Accesorios para Bicicletas» por contención de tokens. Es granularidad correcta, pero puede
  //    tapar un error real dentro de esa rama.
  puente: {
    // Excluyentes, precedencia nombre > granularidad > contradicción; suman `sinNodoEnAlgunCanal`.
    relacionadosPorNombre: number;
    compatiblesPorGranularidad: number;
    contradiccionesReales: number;
    /** Categorías usadas cuya cadena de ancestros se cortó (padre ausente, ciclo o tope): la clase de granularidad puede estar subcontada. */
    cadenasIncompletas: number;
    /** Las contradicciones reales del puente de mayor a menor cantidad de modelos, acotada. */
    muestraContradicciones: Array<{ woo: string; ml: string; modelos: number }>;
  };
}

/** Tope de saltos al subir por `parent_externo`: los datos vienen del canal y no se asume que no hay ciclos. */
export const TOPE_SALTOS = 32;
const MUESTRA_CONTRADICCIONES = 20;

/**
 * Nombres de los ANCESTROS de una categoría (sin ella misma), del padre hacia la raíz. `incompleta` si se cortó
 * antes de llegar a una raíz: padre inexistente en la tabla, ciclo, o más de TOPE_SALTOS.
 */
export function ancestrosDe(
  id: string, padres: Map<string, { parent: string | null; nombre: string }>, tope = TOPE_SALTOS,
): { nombres: string[]; incompleta: boolean } {
  // Una categoría que no está en el mapa NO es una raíz: no se sabe nada de ella. Devolver [] sin marcarlo
  // hacía indistinguible «raíz legítima» de «no la encontré» y escondía cualquier desajuste de identificadores.
  if (!padres.has(id)) return { nombres: [], incompleta: true };
  const nombres: string[] = []; const visto = new Set<string>([id]);
  let actual = padres.get(id)?.parent ?? null;
  while (actual !== null) {
    if (visto.has(actual) || nombres.length >= tope) return { nombres, incompleta: true };
    visto.add(actual);
    const fila = padres.get(actual);
    if (!fila) return { nombres, incompleta: true };
    nombres.push(fila.nombre);
    actual = fila.parent;
  }
  return { nombres, incompleta: false };
}

interface FilaCategoriaModelo { modelId: string; canal: string; valor: string; crudo: string }

/**
 * Cuenta, no abre casos (igual criterio que el informe del tramo 2). `clasificacionPorNombre` es la
 * partición ya calculada por `clasificarCategorias` sobre las categorías DEL CANAL, indexada por nombre
 * normalizado con `claveNombre` — la misma clave que usa `candidatosDesdeAtributo` para agrupar los
 * valores de `categoria_canal`, así los dos lados casan.
 */
export async function medirCobertura(
  tx: Consultable, empresa: string, clasificacionPorNombre: Map<string, GrupoCategoria>,
  nombres: Map<string, string> = new Map(),
): Promise<Cobertura> {
  // Simétrico con la consulta de abajo, que ahora también excluye modelos y representaciones archivadas: con
  // un lado filtrando y el otro no, `sinCategoriaUtil` podía dar negativo.
  const totalModelos = Number((await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM catalog.product_models WHERE company_id = $1 AND archivado_en IS NULL`,
    [empresa])).rows[0]!.n);

  const filas = (await tx.query<FilaCategoriaModelo>(
    `SELECT a.model_id AS "modelId", r.canal, a.valor
       FROM catalog.model_attributes a
       JOIN catalog.product_models m ON m.id = a.model_id
       JOIN catalog.external_representations r ON r.id = a.representation_id
      WHERE m.company_id = $1 AND a.nombre_normalizado = 'categoria_canal' AND a.vigente_hasta IS NULL
        AND m.archivado_en IS NULL AND r.archivado_en IS NULL`,
    [empresa])).rows.map((f) => ({ ...f, crudo: f.valor, valor: enNombre(f.valor, nombres) }));

  const cats = (await tx.query<{ canal: string; id_externo: string; parent_externo: string | null; nombre: string }>(
    `SELECT canal, id_externo, parent_externo, nombre FROM catalog.channel_categories
      WHERE company_id = $1 AND vigente_hasta IS NULL`, [empresa])).rows;
  const padres = new Map(cats.map((c) => [c.id_externo, { parent: c.parent_externo, nombre: c.nombre }] as const));
  // Cada canal guarda `categoria_canal` en OTRA forma: Woo el NOMBRE (`woo.ts`), ML el id (`ml.ts`). Para subir
  // la cadena hay que llegar al id: si el valor ya es un id de ese canal se usa; si no, se resuelve por nombre
  // DENTRO del canal («Cubiertas» existe en los dos). Un nombre que no resuelve o que resuelve a varios ids
  // vigentes no se adivina: la cadena queda incompleta y se cuenta.
  const idsDe = new Map<string, Set<string>>(); const idsPorCanal = new Set<string>();
  for (const c of cats) {
    idsPorCanal.add(`${c.canal}\u0000${c.id_externo}`);
    const k = `${c.canal}\u0000${c.nombre}`;
    (idsDe.get(k) ?? idsDe.set(k, new Set()).get(k)!).add(c.id_externo);
  }
  const resolverId = (canal: string, crudo: string): string | null => {
    if (idsPorCanal.has(`${canal}\u0000${crudo}`)) return crudo;
    const candidatos = idsDe.get(`${canal}\u0000${crudo}`);
    return candidatos?.size === 1 ? [...candidatos][0]! : null;
  };
  const incompletas = new Set<string>();
  const ancestros = (canal: string, crudo: string): string[] => {
    const id = resolverId(canal, crudo);
    const r = id === null ? { nombres: [], incompleta: true } : ancestrosDe(id, padres);
    if (r.incompleta) incompletas.add(`${canal}\u0000${crudo}`);
    return r.nombres;
  };

  // Árbol propio: versión vigente, nodos no archivados y qué categoría de canal mapea a cuál. Sin versión
  // vigente no se inventa nada: las tres clases por nodo quedan en cero y todo va al puente.
  const versionTaxonomia = (await tx.query<{ id: string }>(
    `SELECT id FROM catalog.taxonomy_versions WHERE company_id = $1 AND estado = 'vigente'`, [empresa])).rows[0]?.id ?? null;
  const nodos = new Map<string, { parent: string | null; nombre: string }>(); // nombre = id, para que ancestrosDe devuelva ids
  const nombreNodo = new Map<string, string>();
  const nodoDeCategoria = new Map<string, string>();
  if (versionTaxonomia) {
    for (const n of (await tx.query<{ node_id: string; parent_id: string | null; nombre: string }>(
      `SELECT node_id, parent_id, nombre FROM catalog.taxonomy_node_versions
        WHERE version_id = $1 AND NOT archivado`, [versionTaxonomia])).rows) {
      nodos.set(n.node_id, { parent: n.parent_id, nombre: n.node_id });
      nombreNodo.set(n.node_id, n.nombre);
    }
    for (const m of (await tx.query<{ canal: string; id_externo: string; node_id: string }>(
      `SELECT canal, id_externo, node_id FROM catalog.taxonomy_channel_map
        WHERE company_id = $1 AND vigente_hasta IS NULL AND id_externo IS NOT NULL`, [empresa])).rows) {
      // Un mapeo a un nodo archivado o ausente en la versión vigente apunta a algo que el árbol no tiene.
      if (nodos.has(m.node_id)) nodoDeCategoria.set(`${m.canal}\u0000${m.id_externo}`, m.node_id);
    }
  }
  const nodosDe = (canal: string, valores: string[], crudoDe: Map<string, string>): Set<string> => {
    const r = new Set<string>();
    for (const v of valores) {
      const id = resolverId(canal, crudoDe.get(`${canal}\u0000${v}`)!);
      const n = id === null ? undefined : nodoDeCategoria.get(`${canal}\u0000${id}`);
      if (n) r.add(n);
    }
    return r;
  };

  const porModelo = new Map<string, FilaCategoriaModelo[]>();
  for (const f of filas) {
    const lista = porModelo.get(f.modelId) ?? [];
    lista.push(f);
    porModelo.set(f.modelId, lista);
  }

  let variasCandidatas = 0; let soloMarcaOColeccion = 0;
  let entreCanales = 0; let relacionadosPorNombre = 0; let compatiblesPorGranularidad = 0; let contradiccionesReales = 0;
  let mismoNodo = 0; let unoAncestroDelOtro = 0; let nodosDistintos = 0; let sinNodoEnAlgunCanal = 0;
  const pares = new Map<string, { woo: string; ml: string; modelos: number }>();
  const paresNodo = new Map<string, { woo: string; ml: string; modelos: number }>();
  for (const lista of porModelo.values()) {
    const valoresUnicos = new Set(lista.map((f) => f.valor));
    if (valoresUnicos.size > 1) variasCandidatas++;

    const grupos = [...valoresUnicos].map((v) => clasificacionPorNombre.get(claveNombre(v)) ?? 'taxonomia');
    if (grupos.length > 0 && grupos.every((g) => g !== 'taxonomia')) soloMarcaOColeccion++;

    const porCanal = new Map<string, Set<string>>();
    const crudoDe = new Map<string, string>(); // `canal␀nombre` → valor tal como el canal lo guardó
    for (const f of lista) {
      const s = porCanal.get(f.canal) ?? new Set<string>();
      s.add(f.valor);
      porCanal.set(f.canal, s);
      crudoDe.set(`${f.canal}\u0000${f.valor}`, f.crudo);
    }
    if (porCanal.size > 1) {
      const [canalA, canalB] = [...porCanal.keys()];
      const valoresA = [...porCanal.get(canalA!)!];
      const valoresB = [...porCanal.get(canalB!)!];
      entreCanales++;
      // Comparación exacta por nodo, si los DOS canales tienen. Para estos modelos el puente no se consulta.
      const nodosA = nodosDe(canalA!, valoresA, crudoDe);
      const nodosB = nodosDe(canalB!, valoresB, crudoDe);
      if (nodosA.size > 0 && nodosB.size > 0) {
        if ([...nodosA].some((n) => nodosB.has(n))) { mismoNodo++; continue; }
        // Ancestro en la versión VIGENTE, en cualquier sentido: es granularidad medida sobre nuestro árbol.
        const conAncestros = (n: string) => ancestrosDe(n, nodos).nombres;
        if ([...nodosA].some((a) => conAncestros(a).some((x) => nodosB.has(x)))
          || [...nodosB].some((b) => conAncestros(b).some((x) => nodosA.has(x)))) { unoAncestroDelOtro++; continue; }
        nodosDistintos++;
        if (porCanal.has('woocommerce') && porCanal.has('mercadolibre')) {
          const nombresDe = (ns: Set<string>) => [...new Set([...ns].map((n) => nombreNodo.get(n)!))].sort().join(' + ');
          const woo = nombresDe(canalA === 'woocommerce' ? nodosA : nodosB);
          const ml = nombresDe(canalA === 'woocommerce' ? nodosB : nodosA);
          const k = `${woo}\u0000${ml}`;
          const p = paresNodo.get(k) ?? { woo, ml, modelos: 0 };
          p.modelos++;
          paresNodo.set(k, p);
        }
        continue;
      }
      sinNodoEnAlgunCanal++;
      // Clase 2 — relacionadas por NOMBRE. «Alguna contra alguna»: basta un par (una de cada canal).
      if (valoresA.some((va) => valoresB.some((vb) => valoresRelacionados(va, vb)))) {
        relacionadosPorNombre++;
        continue;
      }
      // Clase 1 — mismo producto a distinta granularidad: el NOMBRE de una categoría relaciona con algún
      // ANCESTRO de la del otro canal, en cualquier sentido. Categoría contra cadena, NUNCA cadena contra
      // cadena: dos categorías que sólo comparten un ancestro genérico («Ciclismo») son parientes, no la misma.
      // Misma regla «alguna contra alguna» que la clase 2.
      const ancA = (v: string) => ancestros(canalA!, crudoDe.get(`${canalA}\u0000${v}`)!);
      const ancB = (v: string) => ancestros(canalB!, crudoDe.get(`${canalB}\u0000${v}`)!);
      const compatible = valoresA.some((va) => valoresB.some((vb) =>
        ancB(vb).some((n) => valoresRelacionados(va, n)) || ancA(va).some((n) => valoresRelacionados(vb, n))));
      if (compatible) { compatiblesPorGranularidad++; continue; }
      // Clase 3 — ni por nombre ni subiendo la cadena.
      contradiccionesReales++;
      if (porCanal.has('woocommerce') && porCanal.has('mercadolibre')) {
        const woo = [...porCanal.get('woocommerce')!].sort().join(' + ');
        const ml = [...porCanal.get('mercadolibre')!].sort().join(' + ');
        const k = `${woo}\u0000${ml}`;
        const p = pares.get(k) ?? { woo, ml, modelos: 0 };
        p.modelos++;
        pares.set(k, p);
      }
    }
  }

  return {
    totalModelos,
    sinCategoriaUtil: totalModelos - porModelo.size,
    variasCandidatas,
    soloMarcaOColeccion,
    entreCanales,
    mismoNodo, unoAncestroDelOtro, nodosDistintos, sinNodoEnAlgunCanal, versionTaxonomia,
    muestraNodosDistintos: [...paresNodo.values()]
      .sort((a, b) => b.modelos - a.modelos || a.woo.localeCompare(b.woo) || a.ml.localeCompare(b.ml))
      .slice(0, MUESTRA_CONTRADICCIONES),
    puente: {
      relacionadosPorNombre, compatiblesPorGranularidad, contradiccionesReales,
      cadenasIncompletas: incompletas.size,
      muestraContradicciones: [...pares.values()]
        .sort((a, b) => b.modelos - a.modelos || a.woo.localeCompare(b.woo) || a.ml.localeCompare(b.ml))
        .slice(0, MUESTRA_CONTRADICCIONES),
    },
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
  const nombres = await nombresPorIdExterno(tx, empresa);
  const [candidatosAtributo, categorias, marcas, colecciones] = await Promise.all([
    candidatosDesdeAtributo(tx, empresa, nombres),
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

  const cobertura = await medirCobertura(tx, empresa, clasificacionPorNombre, nombres);

  return { candidatosAtributo, categoriasCanal, particion, solapamientos, cobertura };
}
