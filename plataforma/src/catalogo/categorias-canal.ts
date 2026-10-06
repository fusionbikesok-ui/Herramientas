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
    // `String(c.id)` con `id` ausente da la cadena 'undefined', que pasa el CHECK `length > 0` y entra como
    // una categoría real: exactamente la trampa del `"null"` que ya nos mordió en el tramo 2. Un payload
    // malformado tiene que frenar la importación, no ensuciar la evidencia.
    if (c.id === null || c.id === undefined || String(c.id).trim() === '') {
      throw new Error('el canal devolvió una categoría sin id: no se importa evidencia sin identidad');
    }
    if (typeof c.name !== 'string' || c.name.trim() === '') {
      throw new Error(`la categoría ${String(c.id)} vino sin nombre`);
    }
    // Ojo con la diferencia: `parent: 0` es «es raíz» y Woo lo dice así. La CLAVE `parent` ausente es un
    // payload que no trae la jerarquía, y tomarlo como raíz aplana el árbol en silencio — que es justo el
    // defecto que acabamos de descubrir en nuestros propios datos.
    if (!('parent' in c)) {
      throw new Error(`la categoría ${String(c.id)} vino sin el campo parent: el payload no trae la jerarquía`);
    }
    const parent = c.parent;
    const parentExterno = parent === null || parent === 0 || parent === '0' || parent === ''
      ? null : String(parent);
    return {
      companyId: ctx.companyId,
      channelAccountId: ctx.channelAccountId,
      canal: ctx.canal,
      idExterno: String(c.id),
      parentExterno,
      nombre: c.name.trim(),
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
export interface OpcionesImportacion {
  dryRun?: boolean;
  /** Aceptar una baja masiva de categorías. Se pasa a mano, después de verificar que la baja es real. */
  permitirBaja?: boolean;
}

/** Una importación que se niega a seguir porque lo que leyó no parece la foto completa del canal. */
export class ErrorImportacion extends Error {
  override name = 'ErrorImportacion';
}

/** Por encima de esta proporción de categorías desaparecidas, la corrida se detiene en vez de cerrarlas. */
const UMBRAL_BAJA = 0.2;

export async function importarCategoriasCanal(
  pool: pg.Pool,
  fuente: FuenteCategoriasCanal,
  ctx: { companyId: string; channelAccountId: string; canal: 'woocommerce' | 'mercadolibre' },
  opciones: OpcionesImportacion = {},
): Promise<ResumenImportacionCategorias> {
  const dryRun = opciones.dryRun ?? false;
  const o = { permitirBaja: opciones.permitirBaja ?? false };
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
      // El `conteo` queda FUERA de lo que abre una fila nueva: es la cantidad de productos publicados y cambia
      // todos los días, así que incluirlo generaba una fila de historia por categoría por corrida, sin ningún
      // valor. Se actualiza sobre la vigente; lo que hace historia es la identidad y el lugar en el árbol.
      const cambio = previa.parentExterno !== f.parentExterno || previa.nombre !== f.nombre
        || previa.slug !== f.slug;
      if (!cambio) {
        r.sinCambios++;
        if (!dryRun && previa.conteo !== f.conteo) {
          await tx.query(
            `UPDATE catalog.channel_categories SET conteo = $3
              WHERE channel_account_id = $1 AND id_externo = $2 AND vigente_hasta IS NULL`,
            [ctx.channelAccountId, f.idExterno, f.conteo]);
        }
        continue;
      }
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

    // A1 — el defecto más grave de la primera versión: si la fuente devolvía [] (un 200 con un cuerpo que no
    // es una lista, la respuesta de un WAF, una página cortada por un error transitorio), `vistos` quedaba
    // vacío y se cerraban las 82 categorías de una. El mapeo `taxonomy_channel_map` pasaba a apuntar a ids no
    // vigentes y el informe corría sobre nada, sin un solo error. Es la misma razón por la que `catalog.copias`
    // no cierra vigencias hasta que una tanda se confirma con su conteo: una lectura parcial NO se puede
    // distinguir de una baja real, así que no se trata como una baja.
    const aCerrar = vigentes.filter((v) => !vistos.has(v.idExterno));
    if (aCerrar.length && !o.permitirBaja) {
      if (filas.length === 0) {
        throw new ErrorImportacion(
          `el canal no devolvió ninguna categoría y hay ${vigentes.length} vigentes: no se cierran a ciegas`);
      }
      const proporcion = aCerrar.length / vigentes.length;
      if (proporcion > UMBRAL_BAJA) {
        throw new ErrorImportacion(
          `el canal dejó de informar ${aCerrar.length} de ${vigentes.length} categorías (${Math.round(proporcion * 100)}%): ` +
          'parece una lectura incompleta y no una baja. Revisar y, si es real, volver a correr con permitirBaja');
      }
    }
    for (const v of aCerrar) {
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
