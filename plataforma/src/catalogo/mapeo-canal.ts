/*
 * src/catalogo/mapeo-canal.ts — aplica un mapeo explícito «categoría del canal → nodo del árbol propio» sobre
 * `taxonomy_channel_map`, verificando lo que QUEDÓ y no las llamadas hechas (la carga de Woo informó 78 mapeos
 * cuando entraron 58, porque contaba intenciones). Usa los nodos ya cargados: no crea ni toca el árbol.
 */
import type { Consultable } from '../db/pool.ts';
import { declararSinEquivalencia, mapearCategoria } from './taxonomia.ts';

export interface OpcionesMapeo {
  empresa: string; cuenta: string; canal: 'woocommerce' | 'mercadolibre';
  /** id de la categoría del canal → clave del nodo. */
  mapeo: Record<string, string>;
  /** id de la categoría del canal → MOTIVO por el que no equivale a ningún nodo (queda en la base). */
  sinEquivalencia?: Record<string, string>;
  decididoPor: string;
  dryRun: boolean;
  /** Sólo para probar el chequeo final: simula una escritura que no deja rastro. */
  mapear?: typeof mapearCategoria;
}
export interface ResumenMapeo {
  total: number; nuevos: number; iguales: number; cambiados: number;
  /** Mapeos vigentes que coinciden con lo pedido DESPUÉS de escribir; en dry-run queda en null. */
  quedaron: number | null;
  sinEquivalencia: { total: number; nuevas: number; iguales: number; cambiadas: number; quedaron: number | null };
}

export async function aplicarMapeoCategorias(tx: Consultable, o: OpcionesMapeo): Promise<ResumenMapeo> {
  const ids = Object.keys(o.mapeo);
  if (ids.length === 0) throw new Error('el mapeo está vacío');
  const sinEq = o.sinEquivalencia ?? {};
  const idsSinEq = Object.keys(sinEq);
  // Una categoría no puede estar a la vez mapeada y sin equivalencia: son dos respuestas incompatibles.
  const ambas = ids.filter((i) => i in sinEq);
  if (ambas.length) throw new Error(`categorías en el mapeo y también sin equivalencia: ${ambas.join(', ')}`);
  const sinMotivo = idsSinEq.filter((i) => !sinEq[i]?.trim());
  if (sinMotivo.length) throw new Error(`categorías sin equivalencia sin motivo escrito: ${sinMotivo.join(', ')}`);

  const cta = (await tx.query<{ company_id: string; channel: string }>(
    'SELECT company_id, channel FROM core.channel_accounts WHERE id = $1', [o.cuenta])).rows[0];
  if (!cta) throw new Error(`no existe channel_account ${o.cuenta}`);
  if (cta.channel !== o.canal) {
    throw new Error(`la cuenta ${o.cuenta} es de ${cta.channel}, y este mapeo es de ${o.canal}: los ids no son de esa cuenta`);
  }
  if (cta.company_id !== o.empresa) throw new Error(`la cuenta ${o.cuenta} no es de la empresa ${o.empresa}`);

  const vigentes = new Set((await tx.query<{ id_externo: string }>(
    `SELECT id_externo FROM catalog.channel_categories
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuenta, [...ids, ...idsSinEq]])).rows
    .map((r) => r.id_externo));
  const faltan = [...ids, ...idsSinEq].filter((i) => !vigentes.has(i));
  if (faltan.length) throw new Error(`categorías que no están vigentes en la cuenta: ${faltan.join(', ')}`);

  const claves = [...new Set(Object.values(o.mapeo))];
  const nodos = new Map((await tx.query<{ clave: string; id: string }>(
    'SELECT clave, id FROM catalog.taxonomy_nodes WHERE company_id = $1 AND clave = ANY($2)', [o.empresa, claves])).rows
    .map((r) => [r.clave, r.id]));
  const sinNodo = claves.filter((c) => !nodos.has(c));
  if (sinNodo.length) throw new Error(`nodos que no existen en el árbol cargado: ${sinNodo.join(', ')}`);

  const previos = new Map((await tx.query<{ id_externo: string; node_id: string }>(
    `SELECT id_externo, node_id FROM catalog.taxonomy_channel_map
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuenta, ids])).rows
    .map((r) => [r.id_externo, r.node_id]));
  // Mapeada → sin equivalencia NO se hace en silencio: es cambiar de opinión sobre algo ya decidido con más
  // información (un nodo), y se resuelve a mano. Al revés (sin equivalencia → mapeada) es el avance normal:
  // se cierra la decisión anterior.
  const yaMapeadas = (await tx.query<{ id_externo: string }>(
    `SELECT id_externo FROM catalog.taxonomy_channel_map
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuenta, idsSinEq])).rows;
  if (yaMapeadas.length) {
    throw new Error(`categorías ya mapeadas a un nodo que se piden sin equivalencia: ${yaMapeadas.map((r) => r.id_externo).join(', ')}`);
  }
  const previasSinEq = new Map((await tx.query<{ id_externo: string; motivo: string }>(
    `SELECT id_externo, motivo FROM catalog.channel_category_sin_equivalencia
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuenta, idsSinEq])).rows
    .map((r) => [r.id_externo, r.motivo]));
  const r: ResumenMapeo = {
    total: ids.length, nuevos: 0, iguales: 0, cambiados: 0, quedaron: null,
    sinEquivalencia: { total: idsSinEq.length, nuevas: 0, iguales: 0, cambiadas: 0, quedaron: null },
  };
  for (const id of idsSinEq) {
    const previo = previasSinEq.get(id);
    if (previo === undefined) r.sinEquivalencia.nuevas++;
    else if (previo === sinEq[id]) r.sinEquivalencia.iguales++;
    else r.sinEquivalencia.cambiadas++;
  }
  for (const id of ids) {
    const previo = previos.get(id);
    if (previo === undefined) r.nuevos++;
    else if (previo === nodos.get(o.mapeo[id]!)) r.iguales++;
    else r.cambiados++;
  }
  if (o.dryRun) return r;

  const mapear = o.mapear ?? mapearCategoria;
  // Una categoría que pasa de «sin equivalencia» a mapeada cierra esa decisión: la respuesta más rica gana.
  await tx.query(
    `UPDATE catalog.channel_category_sin_equivalencia SET vigente_hasta = now()
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuenta, ids]);
  for (const id of ids) await mapear(tx, o.empresa, nodos.get(o.mapeo[id]!)!, o.cuenta, o.canal, id, o.decididoPor);

  const despues = (await tx.query<{ id_externo: string; node_id: string }>(
    `SELECT id_externo, node_id FROM catalog.taxonomy_channel_map
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuenta, ids])).rows;
  r.quedaron = despues.filter((d) => d.node_id === nodos.get(o.mapeo[d.id_externo]!)).length;
  if (r.quedaron !== ids.length) {
    throw new Error(`quedaron ${r.quedaron} mapeos vigentes correctos y se pidieron ${ids.length}: no está completo y se deshace`);
  }
  for (const id of idsSinEq) await declararSinEquivalencia(tx, o.empresa, o.cuenta, o.canal, id, sinEq[id]!, o.decididoPor);
  const decisiones = (await tx.query<{ id_externo: string; motivo: string }>(
    `SELECT id_externo, motivo FROM catalog.channel_category_sin_equivalencia
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL AND id_externo = ANY($2)`, [o.cuenta, idsSinEq])).rows;
  r.sinEquivalencia.quedaron = decisiones.filter((d) => d.motivo === sinEq[d.id_externo]).length;
  if (r.sinEquivalencia.quedaron !== idsSinEq.length) {
    throw new Error(`quedaron ${r.sinEquivalencia.quedaron} decisiones sin equivalencia correctas y se pidieron ${idsSinEq.length}: no está completo y se deshace`);
  }
  return r;
}
