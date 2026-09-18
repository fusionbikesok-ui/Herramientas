/*
 * src/catalogo/intenciones.ts — lo que una observación de un canal dice sobre el catálogo.
 *
 * Las proyecciones de Woo y de ML (`woo.ts`, `ml.ts`) son puras: reciben el payload crudo que el inbox
 * guardó y devuelven intenciones. No saben nada de la base, de las decisiones del matcher ni de los SKU
 * que ya existen. Eso lo resuelve el proyector (tarea 6), que es quien tiene el contexto.
 *
 * La división importa porque las reglas del §5.2 del diseño son muchas y finas, y así se prueban una por
 * una con un objeto en memoria, sin montar una base para cada caso.
 */

export type OrigenModelo = 'woo_padre' | 'woo_simple' | 'ml_familia' | 'ml_clasico' | 'ml_simple';

/** Un modelo por su clave natural. La cuenta la agrega el proyector, que sabe de qué cuenta vino el mensaje. */
export interface ModeloObservado {
  origen: OrigenModelo;
  claveOrigen: string;
  titulo: string;
}

/**
 * Qué dice el canal del SKU de algo vendible. Son cuatro estados y no dos, porque el proyector necesita
 * distinguir "Woo dice que no tiene" (un caso) de "ML no nos lo mostró" (nada que decidir).
 */
export type SkuObservado =
  /** Coincide con FB-{ID_WOO}. Todavía puede estar duplicado: eso lo mira el proyector contra la base. */
  | { estado: 'canonico'; valor: string }
  /** Woo sin SKU cargado. Caso `woo_sin_sku`. */
  | { estado: 'vacio' }
  /** Hay algo, pero no es el canónico. Caso `woo_sku_no_canonico` en Woo; en ML es sólo informativo. */
  | { estado: 'otro'; valor: string }
  /**
   * El canal no lo informó en este payload. Pasa con las variaciones de ML: el multiget no trae el
   * atributo SELLER_SKU (sólo el endpoint puntual de cada variación, ver `lib/matcherPush.js`). No es
   * un caso: la identidad de ML sale de las decisiones del matcher, no de lo que ML muestra.
   */
  | { estado: 'no_informado' };

export interface RepresentacionObservada {
  recurso: string;
  /** '' cuando no hay variación. Nunca null: ver la migración 0013. */
  variacion: string;
  tipo: 'contenedor' | 'vendible';
  sku: SkuObservado;
  userProductId: string | null;
  estadoRemoto: string | null;
  /** Para Woo, el id del producto o de la variación que se vende: con él se arma FB-{ID_WOO}. */
  idWoo: string | null;
}

export interface Proyeccion {
  modelo: ModeloObservado;
  representaciones: RepresentacionObservada[];
  /** Con motivo, cuando el canal dice que esto ya no está (papelera de Woo, ítem cerrado de ML). */
  archivar: string | null;
}

/**
 * Un payload que no se puede proyectar. No se descarta: el diseño pide que cada fila del origen termine
 * importada, como caso, o **rechazada con causa**, y esta es la causa.
 */
export interface Rechazo { rechazo: string }

export type ResultadoProyeccion = Proyeccion | Rechazo;

export const esRechazo = (r: ResultadoProyeccion): r is Rechazo => 'rechazo' in r;

/** FB-{ID_WOO}: la única forma canónica. `id` tiene que ser sólo dígitos, igual que el CHECK de la base. */
export function skuCanonicoDe(idWoo: string): string | null {
  return /^[0-9]+$/.test(idWoo) ? `FB-${idWoo}` : null;
}
