/*
 * src/catalogo/taxonomia.ts — los tres ejes con los que se clasifica el catálogo propio.
 *
 * Son tres entidades distintas y no una sola con un campo `tipo` (decisión 2 del plan del tramo 3):
 *   - MARCA: quién lo fabrica. Un modelo tiene a lo sumo una.
 *   - RUBRO (nodo del árbol): qué clase de cosa es. Un modelo está en varios, con exactamente una primaria.
 *   - COLECCIÓN: una agrupación con vigencia (`Hotsale`). Vive AFUERA del árbol.
 * Mezclarlas es justo lo que hizo Woo —`FANTTIK` (marca) y `Hotsale` (promo) como ramas del árbol— y es lo
 * que este tramo deshace.
 *
 * La jerarquía de los canales NO entra acá: es evidencia (`catalog.channel_categories`, ver
 * `categorias-canal.ts`) y se une al árbol propio sólo por un mapeo explícito y humano
 * (`catalog.taxonomy_channel_map`). Decisión D1, cerrada por José el 2026-09-20.
 *
 * Nada de este archivo escribe en ningún canal. Forward-only: no hay DELETE en ninguna consulta, porque
 * `plataforma_app` no lo tiene y porque perder que algo estuvo en una colección es perder la historia.
 */
import type { Consultable } from '../db/pool.ts';

/** Una identidad de marca que una persona tiene que resolver: no se adivina ni se sigue de largo. */
export class ErrorMarca extends Error {
  override name = 'ErrorMarca';
}

// ───────────────────────────────── marcas ─────────────────────────────────

/**
 * La clave de una marca. NO reusa `normalizarNombre` de `atributos.ts` a propósito: ahí el separador es `_`
 * porque la clave es un nombre de atributo (`tipo_de_producto`), y acá hay que colapsar la puntuación con la
 * que una misma marca se escribe en cada canal — `Mafia Bikes`, `MAFIA-BIKES` y `Mafia  Bikes.` son una.
 * Conservadora igual que el resto del tramo: no quita palabras («bikes», «components») ni corrige typos. Un
 * alias que no cae solo se resuelve a mano y queda registrado en `brand_aliases`.
 */
export function normalizarMarca(nombre: string): string {
  return nombre.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export type OrigenAlias = 'legado' | 'ml_atributo' | 'woo_taxonomia' | 'categoria_canal' | 'persona';

/** La marca canónica de un nombre tal como lo escribe un canal, o null si nadie la registró todavía. */
export async function resolverMarca(tx: Consultable, empresa: string, nombre: string): Promise<string | null> {
  const clave = normalizarMarca(nombre);
  if (clave === '') return null;
  // El nombre propio primero y el alias después: es lo que permite que 'FANTTIK' (que en Woo era una categoría) y el atributo `BRAND`
  // de ML lleguen a la misma fila sin duplicarla.
  // El `ORDER BY prioridad` no es adorno: con `UNION ALL ... LIMIT 1` a secas, un nombre que es a la vez el
  // nombre de una marca y el alias de OTRA devolvía una de las dos al azar, y el comentario de esta función
  // afirmaba un orden que el SQL no garantizaba. Gana el nombre propio sobre el alias ajeno.
  const r = await tx.query<{ brand_id: string }>(
    `SELECT b.id AS brand_id, 0 AS prioridad FROM catalog.brands b
      WHERE b.company_id = $1 AND b.nombre_normalizado = $2 AND b.archivado_en IS NULL
      UNION ALL
     SELECT a.brand_id, 1 FROM catalog.brand_aliases a
       JOIN catalog.brands b ON b.id = a.brand_id AND b.archivado_en IS NULL
      WHERE a.company_id = $1 AND a.alias_normalizado = $2
      ORDER BY prioridad
      LIMIT 1`, [empresa, clave]);
  return r.rows[0]?.brand_id ?? null;
}

/**
 * La marca canónica de `nombre`, creándola si no existe. `alias` son las otras escrituras con las que la misma
 * marca llega; se registran para que la próxima vez caigan solas. Un alias que ya apunta a OTRA marca no se
 * roba: la base lo prohíbe (UNIQUE por empresa) y acá se deja pasar en silencio porque es exactamente el caso
 * que tiene que revisar una persona — quien importa abre `marca_ambigua`, no decide por parecido.
 */
export async function asegurarMarca(
  tx: Consultable, empresa: string, nombre: string,
  { origen, alias = [] }: { origen: OrigenAlias; alias?: string[] },
): Promise<string | null> {
  const clave = normalizarMarca(nombre);
  if (clave === '') return null;
  let id = await resolverMarca(tx, empresa, nombre);
  if (id === null) {
    // `resolverMarca` filtra las archivadas, así que acá el ON CONFLICT podía devolver la fila ARCHIVADA y
    // seguir como si nada: se le colgaban modelos y alias a una marca dada de baja, y el informe (que sí
    // filtra archivadas) no la mostraba. Ahora se distingue «no existe» de «existe pero está de baja».
    const r = await tx.query<{ id: string; archivada: boolean }>(
      `INSERT INTO catalog.brands (company_id, nombre, nombre_normalizado) VALUES ($1, $2, $3)
         ON CONFLICT (company_id, nombre_normalizado) DO UPDATE SET nombre = catalog.brands.nombre
       RETURNING id, archivado_en IS NOT NULL AS archivada`, [empresa, nombre.trim(), clave]);
    if (r.rows[0]!.archivada) {
      throw new ErrorMarca(`la marca ${nombre} está archivada: hay que reactivarla a mano antes de usarla`);
    }
    id = r.rows[0]!.id;
  }
  for (const a of new Set([...alias, nombre].map(normalizarMarca))) {
    if (a === '') continue;
    // Un alias ya tomado por OTRA marca FALLA. Antes era `ON CONFLICT DO NOTHING`: la ambigüedad que el
    // esquema dice prohibir pasaba en silencio, y el comentario decía que «quien importa abre
    // marca_ambigua» cuando nadie lo abría (y `identity_cases` no puede ni alojar ese caso, porque exige
    // una variante o una representación). Ahora la decisión vuelve a quien importa, con el alias nombrado.
    const r = await tx.query<{ brand_id: string }>(
      `INSERT INTO catalog.brand_aliases (company_id, brand_id, alias_normalizado, origen)
       VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, alias_normalizado) DO NOTHING
       RETURNING brand_id`, [empresa, id, a, origen]);
    if (r.rowCount) continue;
    const dueño = await tx.query<{ brand_id: string }>(
      'SELECT brand_id FROM catalog.brand_aliases WHERE company_id = $1 AND alias_normalizado = $2', [empresa, a]);
    if (dueño.rows[0]?.brand_id !== id) {
      throw new ErrorMarca(`el alias «${a}» ya es de otra marca: no se puede usar también para ${nombre}`);
    }
  }
  return id;
}

/**
 * La marca de un modelo. Sólo la pone si el modelo no tenía: cambiar una marca ya asignada es una corrección
 * de identidad y se hace a mano, con motivo, no en el medio de una importación.
 * Devuelve si la escribió.
 */
export async function asignarMarca(tx: Consultable, modelo: string, marca: string): Promise<boolean> {
  const r = await tx.query(
    'UPDATE catalog.product_models SET brand_id = $2 WHERE id = $1 AND brand_id IS NULL', [modelo, marca]);
  return (r.rowCount ?? 0) > 0;
}

// ─────────────────────────────── colecciones ───────────────────────────────

export interface ColeccionNueva {
  clave: string; nombre: string; descripcion?: string;
  vigenteDesde?: Date | null; vigenteHasta?: Date | null;
}

/** Crea la colección o devuelve la que ya existe con esa clave, sin pisarle la vigencia que ya tenga. */
export async function asegurarColeccion(tx: Consultable, empresa: string, c: ColeccionNueva): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO catalog.collections (company_id, clave, nombre, descripcion, vigente_desde, vigente_hasta)
     VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, clave) DO UPDATE SET clave = catalog.collections.clave
     RETURNING id`,
    [empresa, c.clave, c.nombre, c.descripcion ?? null, c.vigenteDesde ?? null, c.vigenteHasta ?? null]);
  return r.rows[0]!.id;
}

/** Suma un modelo a una colección. Idempotente: si ya está vigente adentro, no hace nada. */
export async function agregarAColeccion(
  tx: Consultable, coleccion: string, modelo: string, origen: 'categoria_canal' | 'persona',
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO catalog.collection_members (collection_id, model_id, origen) VALUES ($1, $2, $3)
       ON CONFLICT (collection_id, model_id) WHERE quitado_en IS NULL DO NOTHING`,
    [coleccion, modelo, origen]);
  return (r.rowCount ?? 0) > 0;
}

/** Saca un modelo de una colección sin borrar que estuvo. */
export async function quitarDeColeccion(
  tx: Consultable, coleccion: string, modelo: string, motivo: string,
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE catalog.collection_members SET quitado_en = now(), motivo_salida = $3
      WHERE collection_id = $1 AND model_id = $2 AND quitado_en IS NULL`, [coleccion, modelo, motivo]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Los modelos que la colección lista en una fecha. Una colección vencida no lista NADA aunque conserve sus
 * miembros: es la diferencia entre «la promo terminó» y «la promo se borró», y es la razón por la que
 * `Hotsale` es colección y no un rubro del árbol.
 */
export async function modelosDeColeccion(
  tx: Consultable, coleccion: string, cuando: Date = new Date(),
): Promise<string[]> {
  const r = await tx.query<{ model_id: string }>(
    `SELECT m.model_id FROM catalog.collection_members m
       JOIN catalog.collections c ON c.id = m.collection_id
      WHERE m.collection_id = $1 AND m.quitado_en IS NULL
        AND c.archivado_en IS NULL
        AND (c.vigente_desde IS NULL OR c.vigente_desde <= $2)
        AND (c.vigente_hasta IS NULL OR c.vigente_hasta > $2)
      ORDER BY m.agregado_en`, [coleccion, cuando]);
  return r.rows.map((x) => x.model_id);
}

// ─────────────────────────── el árbol propio, versionado ───────────────────────────

export interface NodoArbol {
  /** Clave estable, independiente del nombre: renombrar `LÍQUIDOS` no cambia `liquidos` ni rompe mapeos. */
  clave: string;
  nombre: string;
  /** La clave del padre, o null si es raíz de esta versión. */
  padre?: string | null;
  rubro?: 'producto' | 'servicio';
  orden?: number;
}

/** Abre una versión en borrador. No toca la vigente: se publica aparte, cuando José la aprueba. */
export async function crearVersion(tx: Consultable, empresa: string, notas?: string): Promise<{ id: string; numero: number }> {
  const r = await tx.query<{ id: string; numero: number }>(
    `INSERT INTO catalog.taxonomy_versions (company_id, numero, notas)
     VALUES ($1, COALESCE((SELECT max(numero) FROM catalog.taxonomy_versions WHERE company_id = $1), 0) + 1, $2)
     RETURNING id, numero`, [empresa, notas ?? null]);
  return r.rows[0]!;
}

/**
 * El orden en que hay que escribir los nodos: cada padre antes que sus hijos. Los ciclos se detectan acá con
 * un mensaje claro, además de en la base: el trigger es la garantía, esto es el diagnóstico.
 */
function ordenTopologico(nodos: NodoArbol[]): NodoArbol[] {
  const porClave = new Map(nodos.map((n) => [n.clave, n]));
  const listos = new Set<string>();
  const enCamino = new Set<string>();
  const salida: NodoArbol[] = [];
  const visitar = (n: NodoArbol): void => {
    if (listos.has(n.clave)) return;
    if (enCamino.has(n.clave)) throw new Error(`el árbol tiene un ciclo que pasa por ${n.clave}`);
    enCamino.add(n.clave);
    if (n.padre != null) {
      const padre = porClave.get(n.padre);
      if (padre === undefined) throw new Error(`el nodo ${n.clave} cuelga de ${n.padre}, que no está en el árbol`);
      visitar(padre);
    }
    enCamino.delete(n.clave); listos.add(n.clave); salida.push(n);
  };
  for (const n of nodos) visitar(n);
  return salida;
}

/**
 * Escribe un árbol entero en una versión EN BORRADOR. Una versión ya vigente o reemplazada no se puede
 * reescribir: si se pudiera, «E13 publica exactamente lo que E12 propuso» sería una frase sin respaldo, y
 * versionar el árbol no serviría para nada. La versión tiene que ser de la misma empresa por el mismo motivo.
 *
 * Se escribe en tres pasadas:
 *   1. las identidades (`taxonomy_nodes`), que no llevan nombre ni padre;
 *   2. las filas de la versión con el padre en NULL;
 *   3. los padres, en orden topológico.
 * Parece rebuscado y no lo es: la pasada 2 evita que una REORGANIZACIÓN falle por un ciclo transitorio
 * (intercambiar el padre entre dos nodos pasa por un estado intermedio inválido si se escribe de una), y la
 * pasada 3 garantiza que cuando se cuelga un hijo su padre ya tiene fila en esta versión, que es lo que la
 * base ahora exige. Así el resultado no depende del orden en que venga el arreglo de entrada.
 *
 * `rubro` NO se pisa cuando no viene explícito: vive en la identidad y no está versionado, así que un
 * `SET rubro = EXCLUDED.rubro` con el default 'producto' convertía un nodo de servicios (SERVICES, Taller)
 * en un nodo de producto, y no sólo en esta versión — en todas, incluida la vigente.
 */
export async function escribirArbol(
  tx: Consultable, empresa: string, version: string, nodos: NodoArbol[],
): Promise<Map<string, string>> {
  const v = await tx.query<{ estado: string }>(
    'SELECT estado FROM catalog.taxonomy_versions WHERE id = $1 AND company_id = $2', [version, empresa]);
  if (!v.rowCount) throw new Error(`la versión ${version} no existe en esta empresa`);
  if (v.rows[0]!.estado !== 'borrador') throw new Error(`la versión ${version} está ${v.rows[0]!.estado}: sólo se escribe un borrador`);

  const ordenados = ordenTopologico(nodos);
  const porClave = new Map<string, string>();
  for (const n of ordenados) {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO catalog.taxonomy_nodes (company_id, clave, rubro) VALUES ($1, $2, COALESCE($3, 'producto'))
         ON CONFLICT (company_id, clave) DO UPDATE SET rubro = COALESCE($3, catalog.taxonomy_nodes.rubro)
       RETURNING id`, [empresa, n.clave, n.rubro ?? null]);
    porClave.set(n.clave, r.rows[0]!.id);
  }
  for (const n of ordenados) {
    await tx.query(
      `INSERT INTO catalog.taxonomy_node_versions (version_id, node_id, parent_id, nombre, orden)
       VALUES ($1, $2, NULL, $3, $4)
         ON CONFLICT (version_id, node_id) DO UPDATE
            SET parent_id = NULL, nombre = EXCLUDED.nombre, orden = EXCLUDED.orden`,
      [version, porClave.get(n.clave), n.nombre, n.orden ?? 0]);
  }
  for (const n of ordenados) {
    if (n.padre == null) continue;
    await tx.query(
      'UPDATE catalog.taxonomy_node_versions SET parent_id = $3 WHERE version_id = $1 AND node_id = $2',
      [version, porClave.get(n.clave), porClave.get(n.padre)]);
  }
  return porClave;
}

/** Pone vigente una versión y cierra la que lo estaba. El índice único de la base garantiza que haya una sola. */
export async function publicarVersion(tx: Consultable, empresa: string, version: string): Promise<void> {
  await tx.query(
    `UPDATE catalog.taxonomy_versions SET estado = 'reemplazada', vigente_hasta = now()
      WHERE company_id = $1 AND estado = 'vigente'`, [empresa]);
  const r = await tx.query(
    `UPDATE catalog.taxonomy_versions SET estado = 'vigente', vigente_desde = now()
      WHERE id = $1 AND company_id = $2 AND estado = 'borrador'`, [version, empresa]);
  if (!r.rowCount) throw new Error(`la versión ${version} no está en borrador: no se puede publicar`);
}

export interface FilaArbol { node_id: string; clave: string; nombre: string; padre: string | null; rubro: string; camino: string[] }

/**
 * El árbol de una versión, entero y en orden de recorrido. Reconstruye una versión pasada sin recalcular
 * nada: es lo que E13 necesita para publicar exactamente lo que E12 propuso.
 */
export async function leerArbol(tx: Consultable, version: string): Promise<FilaArbol[]> {
  const r = await tx.query<FilaArbol>(
    `WITH RECURSIVE arbol AS (
       SELECT v.node_id, n.clave, v.nombre, v.parent_id AS padre, n.rubro,
              ARRAY[n.clave] AS camino, ARRAY[v.orden, 0] AS orden
         FROM catalog.taxonomy_node_versions v
         JOIN catalog.taxonomy_nodes n ON n.id = v.node_id
        WHERE v.version_id = $1 AND v.parent_id IS NULL AND NOT v.archivado
       UNION ALL
       SELECT v.node_id, n.clave, v.nombre, v.parent_id, n.rubro,
              a.camino || n.clave, a.orden || v.orden
         FROM catalog.taxonomy_node_versions v
         JOIN catalog.taxonomy_nodes n ON n.id = v.node_id
         JOIN arbol a ON a.node_id = v.parent_id
        WHERE v.version_id = $1 AND NOT v.archivado
     )
     SELECT node_id, clave, nombre, padre, rubro, camino FROM arbol ORDER BY orden, camino`, [version]);
  return r.rows;
}

// ─────────────────── el mapeo con las categorías del canal ───────────────────

/**
 * Mapea un nodo propio a una categoría del canal por su ID REMOTO, nunca por nombre (decisión 5 del plan):
 * el nombre de una categoría de Woo cambia cuando alguien la edita y el mapeo seguiría apuntando a otra cosa.
 * `null` en `idExterno` es «sin equivalencia», que es una decisión tomada y distinta de una fila que falta.
 */
export async function mapearCategoria(
  tx: Consultable, empresa: string, nodo: string, cuenta: string, canal: 'woocommerce' | 'mercadolibre',
  idExterno: string | null, decididoPor: string,
): Promise<void> {
  // Se cierra por CATEGORÍA y no por nodo: mover `CUBIERTAS` de un nodo a otro cierra el mapeo de CUBIERTAS,
  // y nada más. Cerrar por nodo (como hacía antes) rompía la absorción muchos a uno de D7: al mapear la
  // segunda categoría de un nodo se cerraba la primera, quedaba una sola por nodo y los modelos de las otras
  // se quedaban sin clasificar, sin un solo error. Ver migración 0016.
  if (idExterno !== null) {
    await tx.query(
      `UPDATE catalog.taxonomy_channel_map SET vigente_hasta = now()
        WHERE channel_account_id = $1 AND id_externo = $2 AND vigente_hasta IS NULL
          AND node_id IS DISTINCT FROM $3`, [cuenta, idExterno, nodo]);
  } else {
    // «Este nodo no tiene equivalente en el canal» sí es uno por nodo: no hay categoría que lo identifique.
    await tx.query(
      `UPDATE catalog.taxonomy_channel_map SET vigente_hasta = now()
        WHERE node_id = $1 AND channel_account_id = $2 AND vigente_hasta IS NULL AND id_externo IS NOT NULL`,
      [nodo, cuenta]);
  }
  await tx.query(
    `INSERT INTO catalog.taxonomy_channel_map
       (company_id, node_id, channel_account_id, canal, id_externo, sin_equivalencia, decidido_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
    [empresa, nodo, cuenta, canal, idExterno, idExterno === null, decididoPor]);
}

// ─────────────────── tarea 6: el modelo en el árbol ───────────────────

/**
 * Clasifica un modelo en un nodo. `primaria` es la que usan los informes y E13: hay a lo sumo UNA vigente por
 * modelo (índice único parcial), y si se pide una nueva se cierra la anterior en vez de fallar — reclasificar
 * es una operación legítima; tener dos primarias, no, porque el modelo contaría dos veces por rubro.
 */
export async function clasificarModelo(
  tx: Consultable, empresa: string, modelo: string, nodo: string,
  { primaria = false, origen = 'persona' }: { primaria?: boolean; origen?: 'mapeo_canal' | 'persona' } = {},
): Promise<void> {
  if (primaria) {
    // Una importación (`mapeo_canal`) no degrada una primaria puesta por una PERSONA: si lo hiciera, la
    // próxima corrida del mapeo desharía en silencio una clasificación que alguien decidió a mano. Es el
    // mismo criterio que `asignarMarca`, que no pisa una marca ya asignada.
    await tx.query(
      `UPDATE catalog.model_categories SET primaria = false
        WHERE model_id = $1 AND quitado_en IS NULL AND primaria AND node_id <> $2
          AND ($3 = 'persona' OR origen <> 'persona')`, [modelo, nodo, origen]);
    const otra = await tx.query<{ node_id: string }>(
      `SELECT node_id FROM catalog.model_categories
        WHERE model_id = $1 AND quitado_en IS NULL AND primaria AND node_id <> $2`, [modelo, nodo]);
    if (otra.rowCount) {
      throw new Error(`el modelo ${modelo} ya tiene una primaria puesta por una persona (${otra.rows[0]!.node_id}): un mapeo automático no la cambia`);
    }
  }
  await tx.query(
    `INSERT INTO catalog.model_categories (company_id, model_id, node_id, primaria, origen)
     VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (model_id, node_id) WHERE quitado_en IS NULL
       DO UPDATE SET primaria = catalog.model_categories.primaria OR EXCLUDED.primaria`,
    [empresa, modelo, nodo, primaria, origen]);
}

/** Saca un modelo de un rubro sin borrar que estuvo. */
export async function desclasificarModelo(
  tx: Consultable, modelo: string, nodo: string, motivo: string,
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE catalog.model_categories SET quitado_en = now(), motivo_salida = $3
      WHERE model_id = $1 AND node_id = $2 AND quitado_en IS NULL`, [modelo, nodo, motivo]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Los modelos CLASIFICADOS que no tienen primaria. El esquema garantiza «a lo sumo una» (índice único
 * parcial); «exactamente una» no lo puede garantizar una restricción de fila, así que la diferencia se mide
 * en vez de prometerse. Un modelo acá no aparece en ningún informe por rubro: es el hueco que hay que cerrar
 * antes de darle valor a un conteo por categoría.
 */
export async function modelosSinPrimaria(tx: Consultable, empresa: string): Promise<string[]> {
  const r = await tx.query<{ model_id: string }>(
    `SELECT c.model_id FROM catalog.model_categories c
      WHERE c.company_id = $1 AND c.quitado_en IS NULL
      GROUP BY c.model_id
     HAVING count(*) FILTER (WHERE c.primaria) = 0
      ORDER BY c.model_id`, [empresa]);
  return r.rows.map((x) => x.model_id);
}
