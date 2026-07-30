/**
 * Señales de "este vínculo WC↔ML puede estar mal matcheado".
 * Funciones puras: no tocan DB ni red, para poder testear la lógica de decisión sola.
 *
 * Tres señales, elegidas por tener poca tasa de falso positivo:
 *   - seller_sku: el SKU cargado en ML no es el que el matcher asignó (la más objetiva)
 *   - atributos:  color/talle de ML no coinciden con los de la variación de WC
 *   - precio:     el precio de ML se desvía demasiado del precio de lista de WC
 *
 * Lo que deliberadamente NO es señal:
 *   - que un SKU tenga varias publicaciones (es intencional: distintas condiciones de venta)
 *   - que los títulos difieran (los de ML están llenos de palabras de marketing; se muestran
 *     lado a lado en el detalle para juicio humano, pero no disparan una alerta)
 */

/**
 * Desvío relativo de precio a partir del cual se sospecha. Es una constante de código a
 * propósito (no una columna de configuración ni una variable de entorno): si en la práctica
 * resulta ruidosa o laxa, se ajusta acá con un cambio de código y su test.
 */
export const UMBRAL_DESVIO_PRECIO = 0.40;

/** Minúsculas, sin acentos, sin espacios de más. Para comparar atributos de ML contra los de WC. */
export function normalizarAtributo(v) {
  if (v == null) return '';
  return String(v)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Color y talle de una variación de WC, desde catalogo_cache.atributos_json. */
export function atributosWc(atributosJson) {
  let arr;
  try {
    arr = JSON.parse(atributosJson || '[]');
  } catch (_) {
    return { color: '', talle: '' };
  }
  if (!Array.isArray(arr)) return { color: '', talle: '' };
  const buscar = (nombres) => {
    const a = arr.find(x => nombres.includes(normalizarAtributo(x?.name)));
    return a?.option ? String(a.option).trim() : '';
  };
  return {
    color: buscar(['color']),
    talle: buscar(['talle', 'tamaño', 'size']),
  };
}

/**
 * ¿Coinciden dos valores de atributo? WC suele ser más específico que ML ("M (55-59cm)" vs
 * "M"), así que se acepta que uno sea prefijo del otro. Si falta cualquiera de los dos, se
 * considera coincidencia: no tenemos evidencia de error y un falso positivo cuesta más que
 * un falso negativo en una lista que el usuario tiene que atender.
 */
function atributoCoincide(ml, wc) {
  const a = normalizarAtributo(ml);
  const b = normalizarAtributo(wc);
  if (!a || !b) return true;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Devuelve las señales disparadas por un vínculo, ordenadas por peso (alta primero).
 * `valor` es el dato concreto que disparó la señal: se persiste al descartar, para que el
 * descarte se invalide solo cuando el dato cambia.
 */
export function senalesDeVinculo(fila) {
  const senales = [];

  // 1) SKU cargado en ML vs SKU mapeado. Solo si ML tiene el dato.
  const skuMl = normalizarAtributo(fila.seller_sku);
  const skuMapeado = normalizarAtributo(fila.sku);
  if (skuMl && skuMapeado && skuMl !== skuMapeado) {
    senales.push({
      senal: 'seller_sku',
      peso: 'alta',
      detalle: `En ML el SKU cargado es "${fila.seller_sku}" pero está mapeada a "${fila.sku}"`,
      valor: String(fila.seller_sku),
    });
  }

  // 2) Color/talle de ML vs atributos de la variación de WC.
  const wc = atributosWc(fila.atributos_json);
  const colorOk = atributoCoincide(fila.color, wc.color);
  const talleOk = atributoCoincide(fila.talle, wc.talle);
  if (!colorOk || !talleOk) {
    const partes = [];
    if (!colorOk) partes.push(`color ML "${fila.color}" vs web "${wc.color}"`);
    if (!talleOk) partes.push(`talle ML "${fila.talle}" vs web "${wc.talle}"`);
    senales.push({
      senal: 'atributos',
      peso: 'alta',
      detalle: `No coinciden: ${partes.join(' · ')}`,
      valor: `${normalizarAtributo(fila.color)}|${normalizarAtributo(fila.talle)}`,
    });
  }

  // 3) Desvío de precio. Sin dato de un lado no se opina (evita falso positivo).
  const precioMl = Number(fila.precio);
  const precioWc = Number(fila.precio_wc);
  if (precioMl > 0 && precioWc > 0) {
    const desvio = Math.abs(precioMl - precioWc) / precioWc;
    if (desvio > UMBRAL_DESVIO_PRECIO) {
      senales.push({
        senal: 'precio',
        peso: 'media',
        detalle: `Precio ML $${Math.round(precioMl).toLocaleString('es-AR')} vs lista web $${Math.round(precioWc).toLocaleString('es-AR')} (${Math.round(desvio * 100)}% de desvío)`,
        valor: String(Math.round(precioMl)),
      });
    }
  }

  const orden = { alta: 0, media: 1 };
  return senales.sort((a, b) => orden[a.peso] - orden[b.peso]);
}
