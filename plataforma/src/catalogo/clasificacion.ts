/*
 * src/catalogo/clasificacion.ts — 6a: clasifica cada modelo en el árbol propio a partir de las categorías que los
 * canales le ponen (D23–D25), escribiendo `catalog.model_categories` para la foto actual del catálogo.
 * No toca la ingestión: engancharla es 6b.
 *
 * Reglas, en orden:
 *  1. El modelo junta los nodos a los que apuntan sus categorías, de los dos canales. Woo guarda el NOMBRE en
 *     `categoria_canal` y ML el ID: se traduce cada uno según el canal de la publicación que lo afirma.
 *     D26: antes de mapear, dentro de CADA canal se descarta toda categoría que sea ancestro (por `parent_externo`)
 *     de otra categoría del mismo modelo y del mismo canal. Nunca entre canales: una de ML no descarta a una de Woo.
 *  2. Nodo más específico: se descarta todo nodo que sea ancestro propio de otro del mismo modelo.
 *     D27: si entre los que quedan hay raíces del árbol y también algún nodo NO raíz, las raíces salen de la
 *     competencia y quedan como secundarias (una raíz genérica pierde contra un nodo específico de otra rama).
 *  3. Queda uno → primaria (`origen = 'mapeo_canal'`).
 *  4. Quedan varios NO raíz de ramas distintas, o sólo raíces (D23) → NINGUNO es primaria: entran como secundarios
 *     y se abre `categoria_en_desacuerdo`. No gana ningún canal: los dos tienen errores de carga medidos.
 *  5. Ninguno → no se escribe clasificación y se abre `categoria_sin_mapeo` (`razon`: sin_categoria | categoria_no_mapeada).
 *  6. D24: un modelo con alguna clasificación de origen `persona` no se toca.
 * Se cuenta lo que QUEDÓ en la base, no las llamadas hechas: si no coincide, se lanza y la transacción se deshace.
 */
import type { Consultable } from '../db/pool.ts';
import { clasificarModelo, desclasificarModelo, leerArbol } from './taxonomia.ts';

export type CanalClasif = 'woocommerce' | 'mercadolibre';
export type TipoCasoModelo = 'categoria_en_desacuerdo' | 'categoria_sin_mapeo' | 'categoria_persona_contradicha';
const TIPOS_CLASIFICACION: TipoCasoModelo[] = ['categoria_en_desacuerdo', 'categoria_sin_mapeo'];

export type Decision =
  | { tipo: 'primaria'; nodo: string; /** raíces que perdieron por D27: entran como secundarias */ secundarias: string[] }
  | { tipo: 'desacuerdo'; nodos: string[]; /** raíces que perdieron por D27: también entran como secundarias */ secundarias: string[] }
  | { tipo: 'sin_mapeo'; razon: 'sin_categoria' | 'categoria_no_mapeada' };

/**
 * Los ancestros de una categoría del canal, por `parent_externo`. Los datos del canal no son de fiar: tope de saltos
 * y protección contra ciclos. Si la cadena vuelve a la propia categoría, el dato es inconsistente y no se descarta
 * nada por ella (devuelve vacío): mejor un desacuerdo visible que perder una categoría por un ciclo.
 */
export function ancestrosDe(id: string, padreDe: ReadonlyMap<string, string | null>): Set<string> {
  const anc = new Set<string>();
  let p = padreDe.get(id) ?? null;
  while (p !== null && anc.size < 64) {
    if (p === id) return new Set();
    if (anc.has(p)) break;
    anc.add(p);
    p = padreDe.get(p) ?? null;
  }
  return anc;
}

/**
 * Función pura: dado el conjunto de nodos que los canales le asignan al modelo, decide. `padreDe` es el árbol de
 * la versión vigente. Un nodo desconocido se trata como raíz (no tiene ancestros que descartar).
 */
export function decidirClasificacion(
  nodos: Iterable<string>, padreDe: ReadonlyMap<string, string | null>, tieneCategorias: boolean,
): Decision {
  const todos = [...new Set(nodos)];
  if (todos.length === 0) return { tipo: 'sin_mapeo', razon: tieneCategorias ? 'categoria_no_mapeada' : 'sin_categoria' };
  const ancestros = new Set<string>();
  for (const n of todos) for (const a of ancestrosDe(n, padreDe)) ancestros.add(a);
  const hojas = todos.filter((n) => !ancestros.has(n)).sort();
  // D27: una raíz pierde contra un nodo no raíz de otra rama, y queda como secundaria. Con dos o más no raíz de ramas
  // distintas sigue habiendo desacuerdo: la raíz no se come ese caso.
  const raices = hojas.filter((n) => (padreDe.get(n) ?? null) === null);
  const noRaices = hojas.filter((n) => (padreDe.get(n) ?? null) !== null);
  if (raices.length > 0 && noRaices.length > 0) {
    return noRaices.length === 1
      ? { tipo: 'primaria', nodo: noRaices[0]!, secundarias: raices }
      : { tipo: 'desacuerdo', nodos: noRaices, secundarias: raices };
  }
  return hojas.length === 1 ? { tipo: 'primaria', nodo: hojas[0]!, secundarias: [] } : { tipo: 'desacuerdo', nodos: hojas, secundarias: [] };
}

/** Abre o actualiza el caso de un MODELO. Conflicto explícito sobre `identity_cases_un_abierto_modelo`; nunca DO NOTHING. */
export async function abrirCasoDeModelo(
  tx: Consultable, empresa: string, modelo: string, tipo: TipoCasoModelo, detalle: Record<string, unknown>,
): Promise<'abierto' | 'actualizado' | 'igual'> {
  const r = await tx.query<{ nuevo: boolean }>(
    `INSERT INTO catalog.identity_cases (company_id, tipo, prioridad, model_id, detalle)
     VALUES ($1, $2, 'normal', $3, $4::jsonb)
     ON CONFLICT (model_id, tipo) WHERE cerrado_en IS NULL AND model_id IS NOT NULL
     DO UPDATE SET detalle = EXCLUDED.detalle WHERE catalog.identity_cases.detalle IS DISTINCT FROM EXCLUDED.detalle
     RETURNING (xmax = 0) AS nuevo`, [empresa, tipo, modelo, JSON.stringify(detalle)]);
  if (!r.rows[0]) return 'igual';
  return r.rows[0].nuevo ? 'abierto' : 'actualizado';
}

async function cerrarCasosDeModelo(tx: Consultable, modelo: string, tipos: TipoCasoModelo[], motivo: string): Promise<void> {
  await tx.query(
    `UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = $3
      WHERE model_id = $1 AND tipo = ANY($2) AND cerrado_en IS NULL`, [modelo, tipos, motivo]);
}

export interface OpcionesClasificar {
  empresa: string; dryRun: boolean;
  /** Sólo para probar el chequeo final: reemplaza la escritura de la clasificación. */
  clasificar?: typeof clasificarModelo;
}
export interface ResumenClasificacion {
  modelos: number;
  conPrimaria: number;
  sinPrimariaPorDesacuerdo: number;
  sinMapeo: { sin_categoria: number; categoria_no_mapeada: number };
  personaRespetada: number;
  /** D26: modelos a los que se les descartó una categoría por ser ancestro, en su canal, de otra del mismo modelo. */
  conCategoriaDescartadaPorJerarquiaDelCanal: number;
  /** D27: modelos cuyas raíces del árbol perdieron contra un nodo no raíz y quedaron como secundarias. */
  conRaicesComoSecundarias: number;
  /** Modelos ya clasificados igual que lo que darían los canales: no se escribe nada. */
  yaEstaban: number;
  casosPorTipo: Record<string, number>;
  /** Lo que quedó en la base tras escribir (null en dry-run). */
  quedaron: { primarias: number; secundarias: number; casosAbiertos: number } | null;
}

interface FilaCategoria { modelo: string; canal: CanalClasif; cuenta: string; valor: string }

export async function clasificarFoto(tx: Consultable, o: OpcionesClasificar): Promise<ResumenClasificacion> {
  const version = (await tx.query<{ id: string }>(
    `SELECT id FROM catalog.taxonomy_versions WHERE company_id = $1 AND estado = 'vigente'`, [o.empresa])).rows[0];
  if (!version) throw new Error(`la empresa ${o.empresa} no tiene una versión vigente del árbol`);
  const arbol = await leerArbol(tx, version.id);
  const nodoPorId = new Map(arbol.map((n) => [n.node_id, n]));
  const padreDe = new Map(arbol.map((n) => [n.node_id, n.padre]));

  // Categoría del canal → nodo. Todo mapeo vigente tiene que apuntar a un nodo ACTIVO de la versión vigente:
  // que el nodo exista no alcanza (deuda de `aplicarMapeoCategorias`), y clasificar contra uno archivado dejaría
  // el modelo apuntando a algo que la versión no muestra.
  const mapeos = (await tx.query<{ cuenta: string; id_externo: string; node_id: string }>(
    `SELECT m.channel_account_id AS cuenta, m.id_externo, m.node_id
       FROM catalog.taxonomy_channel_map m JOIN core.channel_accounts a ON a.id = m.channel_account_id
      WHERE a.company_id = $1 AND m.vigente_hasta IS NULL AND m.id_externo IS NOT NULL`, [o.empresa])).rows;
  const colgados = mapeos.filter((m) => !nodoPorId.has(m.node_id));
  if (colgados.length) {
    throw new Error(`${colgados.length} mapeos apuntan a nodos que no están activos en la versión vigente `
      + `(${colgados.slice(0, 5).map((m) => m.id_externo).join(', ')}…): se corrige el mapeo antes de clasificar`);
  }
  const nodoDe = new Map(mapeos.map((m) => [`${m.cuenta}|${m.id_externo}`, m.node_id]));

  // Woo guarda el NOMBRE de la categoría: se traduce a id con las categorías vigentes de la cuenta.
  const nombres = (await tx.query<{ cuenta: string; nombre: string; id_externo: string }>(
    `SELECT c.channel_account_id AS cuenta, c.nombre, c.id_externo
       FROM catalog.channel_categories c JOIN core.channel_accounts a ON a.id = c.channel_account_id
      WHERE a.company_id = $1 AND c.canal = 'woocommerce' AND c.vigente_hasta IS NULL`, [o.empresa])).rows;
  const idPorNombre = new Map<string, string>();
  for (const n of nombres) {
    const k = `${n.cuenta}|${n.nombre}`;
    if (idPorNombre.has(k)) throw new Error(`dos categorías vigentes de Woo se llaman «${n.nombre}»: el nombre no identifica y no se adivina`);
    idPorNombre.set(k, n.id_externo);
  }

  // La jerarquía de cada canal (D26): categoría → padre, por cuenta. Woo normaliza la raíz a NULL.
  const padreCanal = new Map<string, Map<string, string | null>>();
  for (const k of (await tx.query<{ cuenta: string; id_externo: string; parent_externo: string | null }>(
    `SELECT c.channel_account_id AS cuenta, c.id_externo, c.parent_externo
       FROM catalog.channel_categories c JOIN core.channel_accounts a ON a.id = c.channel_account_id
      WHERE a.company_id = $1 AND c.vigente_hasta IS NULL`, [o.empresa])).rows) {
    if (!padreCanal.has(k.cuenta)) padreCanal.set(k.cuenta, new Map());
    padreCanal.get(k.cuenta)!.set(k.id_externo, k.parent_externo);
  }

  const filas = (await tx.query<FilaCategoria>(
    `SELECT DISTINCT p.id AS modelo, r.canal, r.channel_account_id AS cuenta, a.valor
       FROM catalog.product_models p
       JOIN catalog.model_attributes a ON a.model_id = p.id AND a.nombre_normalizado = 'categoria_canal' AND a.vigente_hasta IS NULL
       JOIN catalog.external_representations r ON r.id = a.representation_id AND r.archivado_en IS NULL
      WHERE p.company_id = $1 AND p.archivado_en IS NULL`, [o.empresa])).rows;
  const porModelo = new Map<string, FilaCategoria[]>();
  for (const f of filas) porModelo.set(f.modelo, [...(porModelo.get(f.modelo) ?? []), f]);
  const modelos = (await tx.query<{ id: string }>(
    `SELECT id FROM catalog.product_models WHERE company_id = $1 AND archivado_en IS NULL ORDER BY id`, [o.empresa])).rows.map((m) => m.id);

  const conPersona = new Set((await tx.query<{ model_id: string }>(
    `SELECT DISTINCT model_id FROM catalog.model_categories WHERE company_id = $1 AND quitado_en IS NULL AND origen = 'persona'`,
    [o.empresa])).rows.map((r) => r.model_id));
  const previas = new Map<string, Array<{ node_id: string; primaria: boolean }>>();
  for (const r of (await tx.query<{ model_id: string; node_id: string; primaria: boolean }>(
    `SELECT model_id, node_id, primaria FROM catalog.model_categories
      WHERE company_id = $1 AND quitado_en IS NULL AND origen = 'mapeo_canal'`, [o.empresa])).rows) {
    previas.set(r.model_id, [...(previas.get(r.model_id) ?? []), r]);
  }

  const r: ResumenClasificacion = {
    modelos: modelos.length, conPrimaria: 0, sinPrimariaPorDesacuerdo: 0,
    sinMapeo: { sin_categoria: 0, categoria_no_mapeada: 0 }, personaRespetada: 0, yaEstaban: 0,
    conCategoriaDescartadaPorJerarquiaDelCanal: 0, conRaicesComoSecundarias: 0,
    casosPorTipo: { categoria_en_desacuerdo: 0, categoria_sin_mapeo: 0 }, quedaron: null,
  };
  const clasificar = o.clasificar ?? clasificarModelo;
  const esperadas: { primarias: string[]; desacuerdo: Set<string>; sinMapeo: string[]; secundarias: number } =
    { primarias: [], desacuerdo: new Set(), sinMapeo: [], secundarias: 0 };

  for (const modelo of modelos) {
    if (conPersona.has(modelo)) { r.personaRespetada++; continue; }
    const cats = porModelo.get(modelo) ?? [];
    const nodos = new Set<string>();
    const porCanal: Record<string, Set<string>> = { woocommerce: new Set(), mercadolibre: new Set() };
    // Categorías del modelo por canal (cuenta), ya traducidas a id. D26: se descarta, DENTRO de cada canal, toda
    // categoría que sea ancestro de otra del mismo canal. La jerarquía de una cuenta nunca descarta a la de otra.
    const idsPorCuenta = new Map<string, { canal: CanalClasif; ids: Set<string> }>();
    for (const c of cats) {
      const id = c.canal === 'woocommerce' ? idPorNombre.get(`${c.cuenta}|${c.valor}`) : c.valor;
      if (id === undefined) continue;
      if (!idsPorCuenta.has(c.cuenta)) idsPorCuenta.set(c.cuenta, { canal: c.canal, ids: new Set() });
      idsPorCuenta.get(c.cuenta)!.ids.add(id);
    }
    let descartoCanal = false;
    for (const [cuenta, { canal, ids }] of idsPorCuenta) {
      const padres = padreCanal.get(cuenta) ?? new Map<string, string | null>();
      const anc = new Set<string>();
      for (const id of ids) for (const x of ancestrosDe(id, padres)) anc.add(x);
      for (const id of ids) {
        if (anc.has(id)) { descartoCanal = true; continue; }
        const nodo = nodoDe.get(`${cuenta}|${id}`);
        if (nodo) { nodos.add(nodo); porCanal[canal]!.add(nodoPorId.get(nodo)!.clave); }
      }
    }
    const d = decidirClasificacion(nodos, padreDe, cats.length > 0);
    const clave = (id: string) => nodoPorId.get(id)!.clave;
    const detalleDesacuerdo = d.tipo === 'desacuerdo'
      ? { nodos: d.nodos.map(clave).sort(), raices_secundarias: d.secundarias.map(clave).sort(), por_canal: { woocommerce: [...porCanal.woocommerce!].sort(), mercadolibre: [...porCanal.mercadolibre!].sort() } }
      : null;

    // Lo que dice la base hoy, para contar «ya estaban» sin escribir.
    const antes = previas.get(modelo) ?? [];
    const deseadas = d.tipo === 'primaria'
      ? [{ node_id: d.nodo, primaria: true }, ...d.secundarias.map((n) => ({ node_id: n, primaria: false }))]
      : d.tipo === 'desacuerdo' ? [...d.nodos, ...d.secundarias].map((n) => ({ node_id: n, primaria: false })) : [];
    const igual = antes.length === deseadas.length
      && deseadas.every((x) => antes.some((a) => a.node_id === x.node_id && a.primaria === x.primaria));

    if (descartoCanal) r.conCategoriaDescartadaPorJerarquiaDelCanal++;
    if (d.tipo !== 'sin_mapeo' && d.secundarias.length > 0) r.conRaicesComoSecundarias++;
    if (d.tipo === 'primaria') { r.conPrimaria++; esperadas.primarias.push(modelo); esperadas.secundarias += d.secundarias.length; }
    else if (d.tipo === 'desacuerdo') {
      r.sinPrimariaPorDesacuerdo++; r.casosPorTipo.categoria_en_desacuerdo!++;
      esperadas.desacuerdo.add(modelo); esperadas.secundarias += d.nodos.length + d.secundarias.length;
    }
    else { r.sinMapeo[d.razon]++; r.casosPorTipo.categoria_sin_mapeo!++; esperadas.sinMapeo.push(modelo); }
    if (deseadas.length > 0 && igual) r.yaEstaban++;
    if (o.dryRun) continue;

    // Lo que dejó de corresponder se cierra con motivo (forward-only) ANTES de escribir lo nuevo.
    for (const a of antes) {
      const sigue = deseadas.some((x) => x.node_id === a.node_id && x.primaria === a.primaria);
      if (!sigue) await desclasificarModelo(tx, modelo, a.node_id, 'los canales ya no lo ubican en este nodo con este carácter');
    }
    if (d.tipo === 'primaria') {
      await clasificar(tx, o.empresa, modelo, d.nodo, { primaria: true, origen: 'mapeo_canal' });
      for (const n of d.secundarias) await clasificar(tx, o.empresa, modelo, n, { primaria: false, origen: 'mapeo_canal' });
      await cerrarCasosDeModelo(tx, modelo, TIPOS_CLASIFICACION, 'el modelo quedó clasificado');
    } else if (d.tipo === 'desacuerdo') {
      for (const n of [...d.nodos, ...d.secundarias]) await clasificar(tx, o.empresa, modelo, n, { primaria: false, origen: 'mapeo_canal' });
      await cerrarCasosDeModelo(tx, modelo, ['categoria_sin_mapeo'], 'ahora tiene categorías mapeadas');
      await abrirCasoDeModelo(tx, o.empresa, modelo, 'categoria_en_desacuerdo', detalleDesacuerdo!);
    } else {
      await cerrarCasosDeModelo(tx, modelo, ['categoria_en_desacuerdo'], 'ya no tiene categorías mapeadas en desacuerdo');
      await abrirCasoDeModelo(tx, o.empresa, modelo, 'categoria_sin_mapeo', {
        razon: d.razon, categorias: cats.map((c) => ({ canal: c.canal, valor: c.valor })).sort((x, y) => (x.canal + x.valor).localeCompare(y.canal + y.valor)),
      });
    }
  }
  if (o.dryRun) return r;

  // Se cuenta lo que QUEDÓ en la base.
  const primarias = (await tx.query(
    `SELECT 1 FROM catalog.model_categories
      WHERE model_id = ANY($1) AND quitado_en IS NULL AND primaria AND origen = 'mapeo_canal'`, [esperadas.primarias])).rowCount ?? 0;
  const enDesacuerdo = [...esperadas.desacuerdo];
  const secundarias = (await tx.query(
    `SELECT 1 FROM catalog.model_categories WHERE model_id = ANY($1) AND quitado_en IS NULL AND NOT primaria AND origen = 'mapeo_canal'`,
    [[...esperadas.primarias, ...enDesacuerdo]])).rowCount ?? 0;
  const primariasIndebidas = (await tx.query(
    `SELECT 1 FROM catalog.model_categories WHERE model_id = ANY($1) AND quitado_en IS NULL AND primaria`,
    [[...enDesacuerdo, ...esperadas.sinMapeo]])).rowCount ?? 0;
  const casos = (await tx.query(
    `SELECT 1 FROM catalog.identity_cases WHERE tipo = ANY($1) AND cerrado_en IS NULL AND model_id = ANY($2)`,
    [TIPOS_CLASIFICACION, [...enDesacuerdo, ...esperadas.sinMapeo]])).rowCount ?? 0;
  const casosEsperados = enDesacuerdo.length + esperadas.sinMapeo.length;
  r.quedaron = { primarias, secundarias, casosAbiertos: casos };
  if (primarias !== esperadas.primarias.length || secundarias !== esperadas.secundarias || casos !== casosEsperados || primariasIndebidas) {
    throw new Error(`quedaron ${primarias} primarias, ${secundarias} secundarias, ${casos} casos y ${primariasIndebidas} primarias indebidas; `
      + `se esperaban ${esperadas.primarias.length}, ${esperadas.secundarias}, ${casosEsperados} y 0: se deshace todo`);
  }
  return r;
}
