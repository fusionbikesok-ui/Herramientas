/*
 * src/catalogo/backfill-atributos.ts — llenar atributos, imágenes y datos comerciales de lo ya proyectado.
 *
 * Las representaciones que dejó E2 T1 no tienen nada de esto, y un producto que no vuelve a cambiar no se
 * llenaría nunca solo. Los datos salen de los cachés del legado (`catalogo_cache`, `ml_publicaciones_cache`),
 * NO del canal. Eso contradice a propósito la decisión de T1 de "releer desde el origen": T1 hablaba de
 * IDENTIDAD, donde un caché atrasado corrompe decisiones; acá son atributos descriptivos, y un color
 * desactualizado se corrige en el próximo cambio del producto sin afectar ninguna identidad. Un barrido
 * completo del canal costaría horas y el cupo de ML ya es escaso (§7 del diseño de T2).
 *
 * El checkpoint es `capturado_en`: se procesa `WHERE capturado_en IS NULL` por lotes, cada lote en su
 * transacción. Una representación sin nada en el caché también queda con `capturado_en` puesto (y el crudo
 * en NULL): se marca que se INTENTÓ, no sólo que se encontró, o cada corrida la reintentaría para siempre.
 *
 * Reusa los extractores de `woo.ts` y `ml.ts` (misma normalización y partición) reconstruyendo, desde la
 * fila del caché, la forma del payload que ellos ya entienden. No abre `atributo_divergente`: la comparación
 * nace apagada y la enciende el proyector, producto por producto, cuando se vuelva a observar.
 */
import type pg from 'pg';
import { enTransaccion } from '../db/pool.ts';
import { numeroAcotado, persistirExtras, type ResumenAplicacion } from './aplicar.ts';
import type { RepresentacionObservada } from './intenciones.ts';
import { extraerExtrasMl } from './ml.ts';
import { extraerExtrasWoo } from './woo.ts';

export type FilaCache = Record<string, unknown>;

/** Lo que el script lee del SQLite del legado. Inyectable para probar sin un archivo SQLite. */
export interface FuenteLegado {
  /** Una fila de `catalogo_cache` por su `id_woo`. */
  woo(idWoo: string): FilaCache | undefined;
  /** Una fila de `ml_publicaciones_cache` por su clave `item|variación` ('MLA1|' si no hay variación). */
  ml(clave: string): FilaCache | undefined;
  /** Cualquier fila de ese ítem (para el contenedor de un ítem con variaciones, que no tiene fila propia). */
  mlDeItem(itemId: string): FilaCache | undefined;
}

type Extras = Pick<RepresentacionObservada, 'atributos' | 'imagenes' | 'comercial' | 'crudo'>;
type Rep = { canal: string; recurso: string; variacion: string; tipo: string };

const texto = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');
const lista = (x: unknown): unknown[] => {
  if (typeof x !== 'string' || x === '') return [];
  try { const v: unknown = JSON.parse(x); return Array.isArray(v) ? v : []; } catch { return []; }
};

/**
 * Los extras de una representación, o null si el caché no tiene nada para ella (o no tiene nada capturable).
 *
 * Woo: `catalogo_cache.atributos_json` ya viene como `[{name, option}]` (el legado junta `options[]` con ", "),
 * `categorias_json` es una lista de NOMBRES y `img` una sola imagen. Se guarda `precio`, el VIGENTE (ya trae el
 * `sale_price` si hay oferta) y NO `regular_price`, que es el de LISTA: el legado usa la lista a propósito en una
 * regla de negocio (el descuento de contado de ML) y son dos cosas distintas. El caché hereda las categorías del
 * padre en cada variación, pero un payload de variación de Woo no las trae: se omiten para dar lo mismo que el
 * proyector. `marca` del caché viene de la taxonomía de marcas, no de un atributo: no se copia.
 */
export function extrasDesdeCache(rep: Rep, fuente: FuenteLegado): Extras | null {
  let extras: Extras;
  if (rep.canal === 'woocommerce') {
    const fila = fuente.woo(rep.variacion !== '' ? rep.variacion : rep.recurso);
    if (!fila) return null;
    const tipo = texto(fila.tipo);
    const nombresCategoria = tipo === 'variation' ? [] : lista(fila.categorias_json).map((n) => ({ name: texto(n) }));
    extras = extraerExtrasWoo({
      attributes: lista(fila.atributos_json),
      categories: nombresCategoria,
      images: texto(fila.img) ? [{ src: texto(fila.img) }] : [],
      price: fila.precio ?? undefined,
      stock_quantity: fila.stock ?? undefined,
      global_unique_id: fila.gtin ?? undefined,
    }, tipo);
  } else {
    const propia = fuente.ml(`${rep.recurso}|${rep.variacion}`);
    const fila = propia ?? (rep.tipo === 'contenedor' ? fuente.mlDeItem(rep.recurso) : undefined);
    if (!fila) return null;
    const esVariacion = rep.variacion !== '';
    // Un contenedor sin fila propia se describe con una fila cualquiera de su ítem, pero sólo lleva lo del ítem
    // (categoría y foto): precio, stock y atributos son de cada variación.
    const soloItem = propia === undefined;
    const item = {
      category_id: fila.category_id ?? undefined,
      pictures: texto(fila.thumbnail) ? [{ id: 'thumbnail', secure_url: texto(fila.thumbnail) }] : [],
    };
    const registro = soloItem ? {} : {
      attributes: lista(fila.atributos_json), price: fila.precio ?? undefined, available_quantity: fila.available_quantity ?? undefined,
    };
    extras = extraerExtrasMl(registro, item, esVariacion, !esVariacion);
    const gtin = texto(fila.gtin).trim();
    if (!soloItem && gtin && !extras.comercial?.gtin && extras.crudo) extras = { ...extras, comercial: { ...extras.comercial, gtin } };
  }
  return extras.crudo ? extras : null;
}

export interface OpcionesBackfill { lote: number; dryRun: boolean }

export interface ResumenBackfill {
  procesadas: number; conDatos: number; sinDatos: number; atributos: number; imagenes: number;
}

interface RepFila extends Rep { id: string; channel_account_id: string; company_id: string }

/** Recorre las representaciones sin capturar, por id y de a un lote. En dry-run sólo lee: no escribe ni marca. */
export async function backfillAtributos(pool: pg.Pool, fuente: FuenteLegado, o: OpcionesBackfill): Promise<ResumenBackfill> {
  const r: ResumenBackfill = { procesadas: 0, conDatos: 0, sinDatos: 0, atributos: 0, imagenes: 0 };
  let ultimo = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    // Keyset por id (no sólo `capturado_en IS NULL`): en dry-run nada se marca y sin cursor el bucle no terminaría;
    // en ejecución, además, una fila bloqueada por el proyector (SKIP LOCKED) se retoma en la corrida siguiente.
    const hecho = await enTransaccion(pool, async (tx) => {
      const filas = (await tx.query<RepFila>(
        `SELECT id, company_id, channel_account_id, canal, recurso, variacion_normalizada AS variacion, tipo
           FROM catalog.external_representations
          WHERE capturado_en IS NULL AND id > $1 ORDER BY id LIMIT $2 ${o.dryRun ? '' : 'FOR UPDATE SKIP LOCKED'}`,
        [ultimo, o.lote])).rows;
      for (const f of filas) {
        ultimo = f.id; r.procesadas++;
        const extras = extrasDesdeCache(f, fuente);
        if (!extras) { r.sinDatos++; } else {
          r.conDatos++; r.atributos += extras.atributos?.length ?? 0; r.imagenes += extras.imagenes?.length ?? 0;
        }
        if (o.dryRun) continue;
        if (!extras) {
          await tx.query('UPDATE catalog.external_representations SET capturado_en = now() WHERE id = $1 AND capturado_en IS NULL', [f.id]);
          continue;
        }
        const c = extras.comercial;
        const marcada = await tx.query(
          `UPDATE catalog.external_representations
              SET atributos_crudos = $2::jsonb, comercial_crudo = $3::jsonb, capturado_en = now(),
                  precio = $4::numeric, moneda = $5, stock_canal = $6::integer, gtin = $7
            WHERE id = $1 AND capturado_en IS NULL`,
          [f.id, JSON.stringify(extras.crudo!.atributos ?? null), JSON.stringify(extras.crudo!.comercial ?? null),
            numeroAcotado(c?.precio, 1e10), c?.moneda ?? null,
            numeroAcotado(c?.stock, 2 ** 31) === null ? null : Math.trunc(c!.stock!), c?.gtin ?? null]);
        if (!marcada.rowCount) continue;
        const resumen: ResumenAplicacion = { representaciones: 0, viejas: 0, casosAbiertos: [] };
        await persistirExtras(tx, { tx, cuenta: f.channel_account_id, canal: f.canal as 'woocommerce' | 'mercadolibre',
          versionRemota: '', compararAtributos: false }, f.id, extras, resumen, f.company_id);
      }
      return filas.length;
    });
    if (hecho < o.lote) return r;
  }
}
