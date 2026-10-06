/*
 * src/catalogo/packs.ts — la composición de un pack o kit, en sombra.
 *
 * Un pack es una variante vendible más, con composición: se compone de OTRAS VARIANTES VENDIBLES, nunca de
 * modelos (decisión 7 del plan del tramo 3). Un modelo no tiene stock ni precio, así que un pack compuesto
 * por modelos no podría descontar stock ni cotizarse sin volver a elegir la variante en cada venta — eso se
 * paga caro en E5, no acá.
 *
 * Nace en BORRADOR y deliberadamente SIN: precio, reserva de stock, explosión de pedidos y publicación. Las
 * cuatro están diferidas y no se "resuelven de paso": un pack vigente en esta tabla no vende nada todavía.
 *
 * La vigencia de cada componente no es decoración. Una venta de un pack tiene que poder reconstruir qué
 * llevaba el pack EL DÍA DE LA VENTA, no lo que lleva hoy: sin eso, cambiar la composición reescribe
 * retroactivamente lo que se despachó.
 *
 * Los ciclos (un pack que se contiene por una cadena) y los componentes archivados los rechaza la base
 * (trigger `pack_components_valido`), no este código: una segunda vía de escritura no podría saltearlos.
 */
import type { Consultable } from '../db/pool.ts';

export type EstadoPack = 'borrador' | 'vigente' | 'archivado';

/** Declara que una variante es un pack. Nace en borrador siempre; el estado no se pasa por parámetro. */
export async function declararPack(
  tx: Consultable, empresa: string, variante: string, nombre: string, notas?: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO catalog.packs (variant_id, company_id, nombre, notas) VALUES ($1, $2, $3, $4)
       ON CONFLICT (variant_id) DO UPDATE SET nombre = EXCLUDED.nombre, notas = EXCLUDED.notas`,
    [variante, empresa, nombre, notas ?? null]);
}

export interface Componente { variante: string; cantidad: number; unidad?: string }

/**
 * Pone o corrige un componente. Corregir la cantidad NO edita la fila: cierra la vigente y abre otra, para
 * que la composición de ayer siga siendo consultable. Idempotente: la misma cantidad no genera una fila nueva.
 * Devuelve si cambió algo.
 */
export async function ponerComponente(
  tx: Consultable, pack: string, c: Componente, motivo = 'composición corregida',
): Promise<boolean> {
  const unidad = c.unidad ?? 'unidad';
  // `NaN` (el resultado típico de un `parseFloat('')`) llega a PostgreSQL como 'NaN', y `'NaN'::numeric > 0`
  // es TRUE: el CHECK `cantidad > 0` lo dejaba pasar y quedaba un componente con cantidad NaN. Y una cantidad
  // con más de 4 decimales se redondeaba sin aviso al insertar, con lo que la comparación de idempotencia no
  // volvía a calzar nunca y cada llamada cerraba y reabría la fila.
  if (!Number.isFinite(c.cantidad) || c.cantidad <= 0) {
    throw new Error(`cantidad inválida para el componente ${c.variante}: ${c.cantidad}`);
  }
  if (Number(c.cantidad.toFixed(4)) !== c.cantidad) {
    throw new Error(`la cantidad ${c.cantidad} tiene más de 4 decimales: numeric(12,4) la redondearía en silencio`);
  }
  const ya = await tx.query<{ id: string }>(
    `SELECT id FROM catalog.pack_components
      WHERE pack_variant_id = $1 AND variant_id = $2 AND vigente_hasta IS NULL
        AND cantidad = $3::numeric AND unidad = $4`, [pack, c.variante, c.cantidad, unidad]);
  if (ya.rowCount) return false;
  await tx.query(
    `UPDATE catalog.pack_components SET vigente_hasta = now(), motivo_cierre = $3
      WHERE pack_variant_id = $1 AND variant_id = $2 AND vigente_hasta IS NULL`, [pack, c.variante, motivo]);
  await tx.query(
    `INSERT INTO catalog.pack_components (pack_variant_id, variant_id, cantidad, unidad)
     VALUES ($1, $2, $3::numeric, $4)`, [pack, c.variante, c.cantidad, unidad]);
  return true;
}

/** Saca un componente del pack sin borrar que estuvo. */
export async function quitarComponente(
  tx: Consultable, pack: string, variante: string, motivo: string,
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE catalog.pack_components SET vigente_hasta = now(), motivo_cierre = $3
      WHERE pack_variant_id = $1 AND variant_id = $2 AND vigente_hasta IS NULL`, [pack, variante, motivo]);
  return (r.rowCount ?? 0) > 0;
}

export interface FilaComponente { variant_id: string; sku: string | null; cantidad: string; unidad: string }

/**
 * Los componentes que el pack tenía en una fecha. Por defecto, ahora. `cantidad` viene como texto porque es
 * `numeric`: convertirla a `number` acá perdería precisión en una cantidad fraccionaria, y quien la use para
 * una cuenta de negocio tiene que decidir con qué la hace.
 */
export async function componentes(
  tx: Consultable, pack: string, cuando?: Date,
): Promise<FilaComponente[]> {
  const r = await tx.query<FilaComponente>(
    `SELECT c.variant_id, v.sku, c.cantidad::text AS cantidad, c.unidad
       FROM catalog.pack_components c
       JOIN catalog.sellable_variants v ON v.id = c.variant_id
      WHERE c.pack_variant_id = $1
        AND c.vigente_desde <= COALESCE($2::timestamptz, now())
        AND (c.vigente_hasta IS NULL OR c.vigente_hasta > COALESCE($2::timestamptz, now()))
      ORDER BY v.sku NULLS LAST, c.variant_id`, [pack, cuando ?? null]);
  return r.rows;
}

/**
 * Pasa el pack a vigente. Exige que tenga al menos un componente: un pack vigente vacío es una venta que no
 * se puede cumplir, y prohibirlo acá es más barato que descubrirlo en el depósito.
 * Sigue sin precio, sin stock y sin publicación: «vigente» es la composición, no la venta.
 */
export async function activarPack(tx: Consultable, pack: string): Promise<void> {
  const n = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM catalog.pack_components WHERE pack_variant_id = $1 AND vigente_hasta IS NULL`, [pack]);
  if (n.rows[0]!.n === '0') throw new Error(`el pack ${pack} no tiene componentes vigentes: no se puede activar`);
  const r = await tx.query(
    `UPDATE catalog.packs SET estado = 'vigente' WHERE variant_id = $1 AND estado = 'borrador'`, [pack]);
  if (!r.rowCount) throw new Error(`el pack ${pack} no está en borrador`);
}

export async function archivarPack(tx: Consultable, pack: string): Promise<void> {
  await tx.query(`UPDATE catalog.packs SET estado = 'archivado' WHERE variant_id = $1`, [pack]);
}
