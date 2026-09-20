/*
 * src/catalogo/categorias-ml.ts — fuente de categorías de MercadoLibre para `importarCategoriasCanal`.
 *
 * ML no tiene un «listar las categorías de mi cuenta» como Woo: sólo `/categories/{id}` (una, con su
 * `path_from_root`) y el árbol entero del sitio. Se baja SÓLO el conjunto de ids que los modelos ya usan
 * (`categoria_canal` de las representaciones de ML) y se reconstruye el árbol de la ruta de cada una: la
 * ruta trae los ancestros con id y nombre, así que el padre sale gratis y no hace falta recorrer el sitio.
 * `/categories/{id}` es público: no lleva token ni credencial de ningún tipo.
 *
 * Decisiones que conviene no revertir sin pensarlas:
 *  - `conteo` queda NULL. `total_items_in_this_category` es lo que hay en TODO el sitio, no lo que publica
 *    esta empresa como en Woo; guardarlo bajo la misma columna sería un número que parece comparable y no lo es.
 *  - Una lectura incompleta NO se degrada en silencio: un error de red o un 5xx aborta la importación, porque
 *    lo que falte quedaría sin nombre y `importarCategoriasCanal` cerraría lo que ya estaba. Sólo un 404
 *    (la categoría ya no existe en ML) es tratable, y sólo si se pide expresamente.
 */
import type { CategoriaCanalCruda, FuenteCategoriasCanal } from './categorias-canal.ts';

export interface RespuestaHttp { estado: number; cuerpo: unknown }
export type ObtenerCategoria = (id: string) => Promise<RespuestaHttp>;

export interface OpcionesFuenteMl {
  obtener?: ObtenerCategoria;
  concurrencia?: number;
  /** Tolerar ids que ML responde 404. Sin esto, uno solo aborta la corrida. */
  omitirInexistentes?: boolean;
}

export const ID_ML = /^ML[A-Z]\d+$/;

export class ErrorFuenteMl extends Error {
  override name = 'ErrorFuenteMl';
}

const BASE = (process.env.ML_API_BASE || 'https://api.mercadolibre.com').replace(/\/+$/, '');
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET público con reintento acotado para 429/5xx/red. Nunca manda cabecera de autorización. */
export const obtenerCategoriaHttp: ObtenerCategoria = async (id) => {
  let ultimo: unknown;
  for (let intento = 0; intento < 4; intento++) {
    if (intento) await dormir(500 * 2 ** intento);
    try {
      const r = await fetch(`${BASE}/categories/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429 || r.status >= 500) { ultimo = new Error(`HTTP ${r.status}`); continue; }
      return { estado: r.status, cuerpo: r.ok ? await r.json() : null };
    } catch (e) { ultimo = e; }
  }
  throw new ErrorFuenteMl(`ML no respondió para la categoría ${id}: ${(ultimo as Error)?.message ?? ultimo}`);
};

/** De las respuestas de `/categories/{id}` al formato crudo. Exportada para probar sin red. */
export function categoriasDesdeRutas(rutas: Array<{ pedido: string; cuerpo: unknown }>): CategoriaCanalCruda[] {
  const porId = new Map<string, CategoriaCanalCruda>();
  for (const { pedido, cuerpo } of rutas) {
    const c = cuerpo as { id?: unknown; path_from_root?: unknown } | null;
    const ruta = c?.path_from_root;
    if (!Array.isArray(ruta) || ruta.length === 0) {
      throw new ErrorFuenteMl(`la categoría ${pedido} vino sin path_from_root: no hay jerarquía que importar`);
    }
    if (String(c?.id) !== pedido || String((ruta[ruta.length - 1] as { id?: unknown })?.id) !== pedido) {
      throw new ErrorFuenteMl(`ML devolvió otra categoría al pedir ${pedido}`);
    }
    ruta.forEach((nodo: { id?: unknown; name?: unknown }, i) => {
      const id = String(nodo?.id);
      if (!ID_ML.test(id) || typeof nodo.name !== 'string' || !nodo.name.trim()) {
        throw new ErrorFuenteMl(`la ruta de ${pedido} trae un nodo inválido`);
      }
      const parent = i === 0 ? 0 : String((ruta[i - 1] as { id: unknown }).id);
      const previa = porId.get(id);
      if (previa) {
        // El mismo id visto desde dos rutas tiene que decir lo mismo; si no, alguna lectura está mal.
        if (previa.name !== nodo.name.trim() || String(previa.parent) !== String(parent)) {
          throw new ErrorFuenteMl(`ML informa la categoría ${id} con dos nombres o dos padres distintos`);
        }
        return;
      }
      porId.set(id, { id, parent, name: nodo.name.trim(), slug: null, count: null });
    });
  }
  return [...porId.values()];
}

export interface FuenteMl extends FuenteCategoriasCanal {
  /** Ids que ML respondió 404 en la última lectura (sólo se llena con `omitirInexistentes`). */
  inexistentes: string[];
}

export function fuenteCategoriasMl(ids: string[], opciones: OpcionesFuenteMl = {}): FuenteMl {
  const obtener = opciones.obtener ?? obtenerCategoriaHttp;
  const concurrencia = Math.max(1, opciones.concurrencia ?? 4);
  const fuente: FuenteMl = {
    inexistentes: [],
    async listar() {
      const unicos = [...new Set(ids)];
      if (unicos.length === 0) {
        throw new ErrorFuenteMl('no hay ninguna categoría de ML en uso: una lista vacía cerraría todo lo vigente');
      }
      const malos = unicos.filter((i) => !ID_ML.test(i));
      if (malos.length) throw new ErrorFuenteMl(`ids de categoría con formato inesperado: ${malos.slice(0, 5).join(', ')}`);

      const rutas: Array<{ pedido: string; cuerpo: unknown }> = [];
      const inexistentes: string[] = [];
      let siguiente = 0;
      const trabajador = async () => {
        while (siguiente < unicos.length) {
          const id = unicos[siguiente++]!;
          const r = await obtener(id);
          if (r.estado === 404 && opciones.omitirInexistentes) { inexistentes.push(id); continue; }
          if (r.estado !== 200) throw new ErrorFuenteMl(`ML respondió ${r.estado} para la categoría ${id}`);
          rutas.push({ pedido: id, cuerpo: r.cuerpo });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrencia, unicos.length) }, trabajador));
      fuente.inexistentes = inexistentes.sort();
      return categoriasDesdeRutas(rutas);
    },
  };
  return fuente;
}
