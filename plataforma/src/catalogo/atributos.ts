/*
 * src/catalogo/atributos.ts — normalización y partición de atributos, común a Woo, ML y al backfill.
 *
 * Conservadora a propósito: NO hay diccionario de sinónimos. `rodado` y `diametro_de_rodado` quedan como dos
 * atributos distintos; unificarlos es una decisión de negocio que no es de este tramo.
 */
import type { AtributoObservado, ImagenObservada } from './intenciones.ts';

/** `Tipo de Producto` → `tipo_de_producto`, `Diámetro` → `diametro`. Minúsculas, sin acentos, espacios a `_`. */
export function normalizarNombre(nombre: string): string {
  return nombre.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim().replace(/\s+/g, '_');
}

/**
 * Atributos de texto libre. Es una red preventiva: medido sobre los 5.235 productos de Woo, ningún nombre real
 * del catálogo (color, talle, marca, tipo_de_producto, largo, ancho, rodado…) es de texto libre, así que hoy
 * no cubre ningún caso. Protege un texto con comas, NO los decimales: eso lo resuelve el corte de `partirValores`.
 * Antes: la coma es parte del valor y partirlos lo destruiría ("Ideal para ruta, gravel
 * y cicloturismo" no son tres valores). Lista cerrada y fijada acá, no adivinada en tiempo de ejecución.
 * Es la lista mínima que el nombre justifica por sí solo; falta contrastarla con los payloads reales del
 * catálogo antes de ampliarla. Un falso negativo (partir de más) se corrige reproyectando desde el crudo.
 */
export const ATRIBUTOS_TEXTO_LIBRE: ReadonlySet<string> = new Set([
  'descripcion', 'descripcion_corta', 'observaciones', 'observacion', 'notas', 'comentarios', 'detalle',
]);

/**
 * Los valores de un atributo. Se parte por coma SEGUIDA DE ESPACIO, no por coma sola: en este catálogo la coma
 * también es separador decimal ("Largo: 110, 117,5, 122,5" son tres largos; con `split(',')` salían
 * 110, 117, 5, 122, 5, valores inventados). El separador de valores siempre trae espacio y el decimal nunca
 * (medido sobre los 5.235 productos: cero casos de valores pegados tipo "Negro,Plateado"). No volver a la coma
 * sola por parecer más simple. Cada parte lleva `trim`, sin comas sueltas en los bordes y sin las vacías;
 * no se parte si el nombre normalizado es de texto libre.
 * Ojo para quien compare medidas entre canales: `largo` usa coma decimal y `ancho` punto ("2.25, 2.35"); el
 * valor se guarda como lo dice el canal, sin normalizar. Sin repetidos: la base tiene UNIQUE (representación, nombre, valor).
 */
export function partirValores(nombreNormalizado: string, valor: string): string[] {
  const partes = ATRIBUTOS_TEXTO_LIBRE.has(nombreNormalizado) ? [valor] : valor.split(/,\s/);
  return [...new Set(partes.map((p) => p.replace(/^[\s,]+|[\s,]+$/g, '')).filter((p) => p !== ''))];
}

/** Cadenas que son el rastro de un `String(null)` o `String(undefined)` y no un valor (falso positivo del 2026-09-12). */
const RASTRO_DE_NULO = new Set(['null', 'undefined']);

/** Agrega un atributo ya normalizado, sin repetir (nombre, valor). Omite vacíos y el rastro de un nulo. */
export function agregarAtributo(lista: AtributoObservado[], nombre: string, valores: string[]): void {
  const n = normalizarNombre(nombre);
  if (n === '') return;
  for (const valor of valores) {
    if (valor !== '' && !RASTRO_DE_NULO.has(valor.toLowerCase()) && !lista.some((a) => a.nombre === n && a.valor === valor)) lista.push({ nombre: n, valor });
  }
}

/** Imágenes sin URL repetida (la base tiene UNIQUE (representación, url)); `orden` es el de la lista original. */
export function agregarImagen(lista: ImagenObservada[], url: string, orden: number): void {
  const u = url.trim();
  if (u !== '' && !lista.some((i) => i.url === u)) lista.push({ url: u, orden });
}

/** Tokens de un valor para comparar entre canales: sin acentos, en minúsculas, y con `/`, `-` y espacios como separador. */
export function tokensComparacion(valor: string): string[] {
  return valor.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().split(/[\s/-]+/).filter((t) => t !== '');
}

/**
 * Dos valores de canales distintos se consideran el mismo (o compatibles) si los tokens de uno están contenidos
 * en los del otro. Medido en el ensayo en seco (5.235 productos de Woo cruzados por SKU con 2.785 publicaciones
 * de ML): comparar por igualdad exacta abría 333 casos y 8 de cada 10 eran notación ("43" vs "43 eu", "m/l" vs
 * "m-l"), granularidad ("verde" vs "verde agua") o marca contra marca+modelo ("shimano" vs "shimano tiagra"); con
 * contención por tokens quedan 114, que son typos de carga ("amarilllo") y errores reales ("rojo" vs "azul").
 * Limitación conocida: idioma ("gris" vs "stone gray") y sinónimos ("plata" vs "plateado") siguen dando caso;
 * resolverlos pide un diccionario, que es decisión de negocio y no de este tramo.
 */
export function valoresRelacionados(a: string, b: string): boolean {
  const ta = new Set(tokensComparacion(a)); const tb = new Set(tokensComparacion(b));
  if (ta.size === 0 || tb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const contenido = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t));
  return contenido(ta, tb) || contenido(tb, ta);
}
