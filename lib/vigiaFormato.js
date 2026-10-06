/*
 * lib/vigiaFormato.js — qué cambió en una publicación de ML.
 *
 * Lógica PURA: sin base, sin ML, sin DOM. Vive acá por el mismo motivo que conteoCantidad.js:
 * es la parte que, mal hecha, pausa el catálogo entero, y así se prueba sin un solo mock.
 *
 * La regla central es que se compara contra el PASADO, no contra un criterio. Un análisis del
 * 2026-09-12 sobre las 41 publicaciones con formato distinto de "unidad" mostró por qué: 8 de
 * las 10 activas eran packs legítimos (juegos de ruedas, pares de manijas) y las 2 restantes
 * fueron falsos positivos. En Woo no hay ningún campo que diga cuántas unidades trae un
 * producto, así que ninguna regla puede saber si un "Pack de 2" está bien o mal. Lo que sí se
 * puede afirmar sin ambigüedad es que algo CAMBIÓ.
 */

/** Los tres campos que definen qué cree ML que estás vendiendo. El título NO: ML lo reescribe
 *  por su cuenta y sería ruido constante. */
export const CAMPOS_VIGILADOS = ['catalog_product_id', 'UNITS_PER_PACK', 'SALE_FORMAT'];

function atributosDe(fila) {
  const crudo = fila?.atributos_json;
  if (!crudo) return [];
  try {
    const a = JSON.parse(crudo);
    return Array.isArray(a) ? a : [];
  } catch {
    // Fail-open: un JSON roto no puede frenar el refresco entero ni inventar un cambio.
    return [];
  }
}

/**
 * Valor comparable de un campo vigilado. Devuelve `null` cuando no hay valor — nunca la cadena
 * "null", que es justo el error que produjo un falso positivo el 2026-09-12.
 */
export function valorDeCampo(fila, campo) {
  if (campo === 'catalog_product_id') {
    const v = fila?.catalog_product_id;
    return v == null || v === '' ? null : String(v);
  }
  const attr = atributosDe(fila).find((a) => a && a.id === campo);
  if (!attr) return null;
  const v = attr.value_name;
  return v == null || v === '' ? null : String(v);
}

/**
 * @param {Map<string, object>} previas  filas del cache ANTES del refresco, por clave
 * @param {object[]} nuevas              filas que vienen de ML
 * @returns {Array<{clave,item_id,sku,campo,valor_anterior,valor_nuevo}>}
 */
export function detectarCambios(previas, nuevas) {
  const cambios = [];
  for (const nueva of nuevas || []) {
    const anterior = previas?.get(nueva.clave);
    // Sin línea base no hay cambio. Una publicación nueva que ya nace como "Pack de 2" puede
    // ser perfectamente legítima y no hay forma de saberlo desde acá.
    if (!anterior) continue;
    for (const campo of CAMPOS_VIGILADOS) {
      const antes = valorDeCampo(anterior, campo);
      const despues = valorDeCampo(nueva, campo);
      if (antes === despues) continue;
      cambios.push({
        clave: nueva.clave,
        item_id: nueva.item_id,
        sku: nueva.seller_sku || null,
        campo,
        valor_anterior: antes,
        valor_nuevo: despues,
      });
    }
  }
  return cambios;
}
