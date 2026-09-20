/*
 * src/catalogo/categorias-canal.ts — E2 T3 tarea 1: importar la jerarquía de categorías de cada canal,
 * como EVIDENCIA (decisión D1 del plan, docs/superpowers/plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md).
 * NUNCA se promueve al árbol propio acá: eso es la tarea 5, con intervención humana.
 *
 * La fuente de datos va inyectada (misma forma que `FuenteLegado` en backfill-atributos.ts), para poder
 * probar sin llamar al canal de verdad. Woo informa `parent: 0` para las raíces; se normaliza a NULL acá
 * (channel_categories_no_autopadre y el propio esquema esperan NULL, no 0).
 *
 * Upsert idempotente por (channel_account_id, id_externo) vigente, y forward-only: una categoría que el
 * canal deja de informar se cierra con `vigente_hasta`, nunca se borra (`plataforma_app` no tiene DELETE).
 * El padre se guarda por ID REMOTO (parent_externo), no por FK interna: la importación puede ver un hijo
 * antes que su padre sin fallar ni inventar una fila vacía — eso es justamente lo que hace reconstruible
 * el árbol completo con una consulta recursiva después.
 */
import type pg from 'pg';
import { enTransaccion } from '../db/pool.ts';

/** Una categoría tal como la informa el canal. `parent` en 0 (Woo) significa raíz. */
export interface CategoriaCanalCruda {
  id: number | string;
  parent?: number | string | null;
  name: string;
  slug?: string | null;
  count?: number | null;
}

/** La fuente de datos, inyectada para poder probar sin llamar al canal. */
export interface FuenteCategoriasCanal {
  /** Todas las categorías vigentes que informa el canal para esa cuenta, en una sola lectura. */
  listar(): Promise<CategoriaCanalCruda[]>;
}

export interface FilaCategoriaCanal {
  companyId: string;
  channelAccountId: string;
  canal: 'woocommerce' | 'mercadolibre';
  idExterno: string;
  parentExterno: string | null;
  nombre: string;
  slug: string | null;
  conteo: number | null;
}

export interface ResumenImportacionCategorias {
  leidas: number;
  nuevas: number;
  actualizadas: number;
  sinCambios: number;
  cerradas: number;
}

/** Normaliza el payload crudo del canal a filas listas para upsert. `parent` 0/''/null → NULL (raíz). */
export function normalizarCategorias(
  crudo: CategoriaCanalCruda[],
  ctx: { companyId: string; channelAccountId: string; canal: 'woocommerce' | 'mercadolibre' },
): FilaCategoriaCanal[] {
  return crudo.map((c) => {
    const parent = c.parent;
    const parentExterno = parent === null || parent === undefined || parent === 0 || parent === '0' || parent === ''
      ? null : String(parent);
    return {
      companyId: ctx.companyId,
      channelAccountId: ctx.channelAccountId,
      canal: ctx.canal,
      idExterno: String(c.id),
      parentExterno,
      nombre: c.name,
      slug: c.slug ?? null,
      conteo: c.count ?? null,
    };
  });
}

interface FilaVigente { idExterno: string; parentExterno: string | null; nombre: string; slug: string | null; conteo: number | null }

/**
 * Importa las categorías de una cuenta de canal: upsert idempotente de lo que el canal sigue informando,
 * y cierre (`vigente_hasta`) de lo que dejó de informar. Todo en una transacción: o queda la foto completa
 * de esta corrida, o no queda nada a medias.
 */
export interface OpcionesImportacion { dryRun?: boolean }

export async function importarCategoriasCanal(
  pool: pg.Pool,
  fuente: FuenteCategoriasCanal,
  ctx: { companyId: string; channelAccountId: string; canal: 'woocommerce' | 'mercadolibre' },
  opciones: OpcionesImportacion = {},
): Promise<ResumenImportacionCategorias> {
  const dryRun = opciones.dryRun ?? false;
  const crudo = await fuente.listar();
  const filas = normalizarCategorias(crudo, ctx);
  const r: ResumenImportacionCategorias = { leidas: filas.length, nuevas: 0, actualizadas: 0, sinCambios: 0, cerradas: 0 };

  await enTransaccion(pool, async (tx) => {
    const vigentes = (await tx.query<FilaVigente>(
      `SELECT id_externo AS "idExterno", parent_externo AS "parentExterno", nombre, slug, conteo
         FROM catalog.channel_categories
        WHERE channel_account_id = $1 AND vigente_hasta IS NULL`,
      [ctx.channelAccountId])).rows;
    const porId = new Map(vigentes.map((v) => [v.idExterno, v]));
    const vistos = new Set(filas.map((f) => f.idExterno));

    for (const f of filas) {
      const previa = porId.get(f.idExterno);
      if (!previa) {
        r.nuevas++;
        if (!dryRun) {
          await tx.query(
            `INSERT INTO catalog.channel_categories
               (company_id, channel_account_id, canal, id_externo, parent_externo, nombre, slug, conteo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [f.companyId, f.channelAccountId, f.canal, f.idExterno, f.parentExterno, f.nombre, f.slug, f.conteo]);
        }
        continue;
      }
      const cambio = previa.parentExterno !== f.parentExterno || previa.nombre !== f.nombre
        || previa.slug !== f.slug || previa.conteo !== f.conteo;
      if (!cambio) { r.sinCambios++; continue; }
      r.actualizadas++;
      if (dryRun) continue;
      // Cerrar la vigente y abrir una nueva fila: preserva la historia (índice único parcial por vigente).
      await tx.query(
        `UPDATE catalog.channel_categories SET vigente_hasta = now()
          WHERE channel_account_id = $1 AND id_externo = $2 AND vigente_hasta IS NULL`,
        [ctx.channelAccountId, f.idExterno]);
      await tx.query(
        `INSERT INTO catalog.channel_categories
           (company_id, channel_account_id, canal, id_externo, parent_externo, nombre, slug, conteo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [f.companyId, f.channelAccountId, f.canal, f.idExterno, f.parentExterno, f.nombre, f.slug, f.conteo]);
    }

    for (const v of vigentes) {
      if (vistos.has(v.idExterno)) continue;
      r.cerradas++;
      if (dryRun) continue;
      await tx.query(
        `UPDATE catalog.channel_categories SET vigente_hasta = now()
          WHERE channel_account_id = $1 AND id_externo = $2 AND vigente_hasta IS NULL`,
        [ctx.channelAccountId, v.idExterno]);
    }
  });

  return r;
}
