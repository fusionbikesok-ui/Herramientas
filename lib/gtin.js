/**
 * Identificadores de comercio (GTIN) tipados y normalizados.
 *
 * Antes cada tabla guardaba el código tal cual venía del canal, en una columna
 * `TEXT` suelta, y las comparaciones eran literales. Eso produce falsos
 * negativos medibles: al 2026-09-06, 13 de los 650 pares SKU comparables entre
 * ML y Woo eran el mismo código escrito con distinto relleno de ceros
 * (ML `0602883701731` vs Woo `602883701731`) y se leían como códigos distintos.
 *
 * Regla de almacenamiento (GS1 General Specifications): el GTIN se guarda
 * siempre en 14 dígitos, justificado a la derecha y rellenado con ceros a la
 * izquierda. El relleno NO cambia el tipo: "adding fill zeros does not change a
 * GTIN-8, 12 or 13 into a GTIN-14". Por eso acá conviven dos datos:
 *
 *   - `canonico`: 14 dígitos, la clave con la que se compara e indexa. Se
 *     obtiene rellenando, nunca quitando: en un UPC-A como `036000291452` el
 *     cero inicial es el sistema numérico, no relleno, y sacarlo destruye el
 *     código. Rellenar alcanza igual para unir los canales, porque
 *     `0602883701731` y `602883701731` llegan ambos a `00602883701731`.
 *   - `tipo`: la representación con la que el canal entregó el código, derivada
 *     de su largo. No se infiere un tipo "verdadero" por debajo del relleno:
 *     una vez rellenado, un UPC-A y un EAN-13 son indistinguibles, y adivinar
 *     sería inventar un dato que ningún canal nos dio. Si dos canales declaran
 *     tipos distintos para el mismo canónico, eso es una observación a
 *     registrar, no un conflicto de identidad.
 *
 * Ni ML ni Woo exponen el tipo: ML publica un único atributo `GTIN` (5385 de
 * 6893 publicaciones al 2026-09-06, sin un solo `EAN`/`UPC`/`GTIN_14` aparte) y
 * Woo un único campo nativo `global_unique_id`. El tipo es información que
 * deriva Fusion, no un dato que alguno de los dos canales nos dé.
 */

/** Largos GTIN válidos según GS1. El 12 es UPC-A; no existe GTIN-11 ni GTIN-9. */
const LARGOS_VALIDOS = [8, 12, 13, 14];

const TIPO_POR_LARGO = {
  8: 'GTIN-8',
  12: 'UPC-A',
  13: 'EAN-13',
  14: 'GTIN-14',
};

/**
 * Dígito de control GS1 (módulo 10), válido para largos 8/12/13/14.
 * Se pondera desde la derecha: el dígito inmediatamente anterior al control
 * pesa 3, el siguiente 1, y así alternando.
 */
export function digitoControlOk(codigo) {
  const n = codigo.length;
  let suma = 0;
  for (let i = n - 2; i >= 0; i -= 1) {
    const d = codigo.charCodeAt(i) - 48;
    suma += d * (((n - 2 - i) % 2 === 0) ? 3 : 1);
  }
  return ((10 - (suma % 10)) % 10) === (codigo.charCodeAt(n - 1) - 48);
}

/**
 * Normaliza un código a su forma canónica de 14 dígitos y deriva su tipo.
 *
 * Devuelve `{ ok: false, motivo }` en vez de lanzar: los llamadores procesan
 * lotes de datos de canal donde un valor basura es esperable y no debe cortar
 * el lote. `motivo` distingue por qué se rechazó, para que la UI pueda decir
 * "no es numérico" en vez de un genérico "código inválido".
 *
 * @param {unknown} valor código tal cual vino del canal
 * @returns {{ok: true, canonico: string, tipo: string, crudo: string}
 *          |{ok: false, motivo: 'vacio'|'no_numerico'|'largo_invalido'|'digito_control', crudo: string}}
 */
export function normalizarGtin(valor) {
  const crudo = String(valor ?? '').trim();
  if (crudo === '') return { ok: false, motivo: 'vacio', crudo };
  if (!/^[0-9]+$/.test(crudo)) return { ok: false, motivo: 'no_numerico', crudo };

  if (!LARGOS_VALIDOS.includes(crudo.length)) {
    return { ok: false, motivo: 'largo_invalido', crudo };
  }
  if (!digitoControlOk(crudo)) {
    return { ok: false, motivo: 'digito_control', crudo };
  }

  return {
    ok: true,
    crudo,
    canonico: crudo.padStart(14, '0'),
    tipo: TIPO_POR_LARGO[crudo.length],
  };
}

/**
 * Clave de comparación entre canales, o `null` si el valor no es un GTIN.
 * Usar siempre esto en vez de comparar los códigos crudos.
 */
export function claveGtin(valor) {
  const r = normalizarGtin(valor);
  return r.ok ? r.canonico : null;
}

/** ¿Dos códigos de canales distintos son el mismo GTIN? */
export function mismoGtin(a, b) {
  const ca = claveGtin(a);
  return ca !== null && ca === claveGtin(b);
}

/**
 * Reemplazo de `looksLikeGtin` de `lib/gtinWoo.js`: mismo contrato booleano
 * para los llamadores que sólo preguntan "¿esto es un código válido?".
 */
export function esGtinCrudoValido(valor) {
  return normalizarGtin(valor).ok;
}
