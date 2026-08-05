/**
 * FUENTE ÚNICA DE VERDAD de los límites de rate de la API de MercadoLibre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REVISIÓN MENSUAL — leer esto antes de tocar nada
 * ─────────────────────────────────────────────────────────────────────────────
 * Una vez por mes hay que contrastar los valores de LIMITES_ML contra la
 * documentación oficial y actualizar `verificado_en`. Si un número cambió,
 * se cambia ACÁ y en ningún otro lado: todo el resto del código consume estas
 * constantes, nadie hardcodea un rpm por su cuenta.
 *
 * Documentación de referencia:
 *   - https://developers.mercadolibre.com.ar/es_ar/api-docs
 *   - https://developers.mercadolibre.com.ar/es_ar/limites-de-uso
 *
 * Última verificación: 2026-08-05
 * Próxima revisión: 2026-09-05
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA REGLA: usamos SIEMPRE 15% menos de lo que permite la documentación.
 * ─────────────────────────────────────────────────────────────────────────────
 * Decisión del negocio (2026-08-05): no queremos "probar si aguanta". El techo
 * efectivo es el 85% del límite documentado, sin excepción, y cuando aplican
 * varios límites a la vez gana SIEMPRE el más restrictivo.
 *
 * Honestidad sobre lo que este archivo puede y no puede garantizar:
 * respetar el presupuesto NO garantiza cero 429. La propia documentación de ML
 * advierte que hay cuotas compartidas entre integraciones y ventanas de conteo
 * que no controlamos — se puede recibir 429 con tráfico propio bajo. De hecho
 * el incidente del 2026-08-04 (16h sin sync) ocurrió consumiendo ~27% del
 * límite general. Por eso este presupuesto es la PRIMERA línea, y el cooldown
 * con backoff de mlClient.js sigue siendo la red de seguridad para el 429 que
 * igual va a llegar.
 */

/** Margen de seguridad: consumimos como máximo el 85% de lo documentado. */
export const MARGEN_SEGURIDAD = 0.15;

/**
 * `rpm` es el límite DOCUMENTADO (o, donde ML no publica número, nuestra
 * estimación conservadora — ver `documentado`). El techo efectivo que aplica
 * el código es rpm * (1 - MARGEN_SEGURIDAD), calculado en `cupoEfectivo()`.
 *
 * documentado:false significa que ML NO publica un número para ese recurso y
 * el valor es una elección prudente nuestra. No lo subas sin evidencia: el
 * recurso `oauth` es exactamente el que nos tumbó el 2026-08-04.
 */
export const LIMITES_ML = {
  // Límite general por vendedor. Documentado: 1500 rpm → 429 con cuerpo vacío.
  global: {
    rpm: 1500,
    documentado: true,
    nota: 'Límite general por vendedor publicado por ML.',
  },

  // /oauth/token. ML no publica un rpm específico, pero es el recurso escaso y
  // compartido que causó el incidente 2026-08-04: el refresh se hace cada ~6h
  // en régimen normal, así que un techo bajísimo no molesta a nadie y corta de
  // raíz cualquier bucle de refresh.
  oauth: {
    rpm: 20,
    documentado: false,
    nota: 'Sin número publicado. Techo conservador propio: en régimen normal el refresh ocurre 1 vez cada 6h.',
  },

  // Escrituras (POST/PUT) sobre items. ML documenta 500 rpm compartidos entre
  // recursos de escritura para algunos dominios (ej. mensajería). Tomamos ese
  // valor como el más restrictivo aplicable a nuestras escrituras.
  escritura: {
    rpm: 500,
    documentado: true,
    nota: 'ML documenta 500 rpm compartidos entre recursos de escritura (POST/PUT).',
  },

  // Lecturas (GET). Mismo criterio que escritura.
  lectura: {
    rpm: 500,
    documentado: true,
    nota: 'ML documenta 500 rpm compartidos entre recursos de consulta (GET).',
  },
};

/** Techo efectivo en requests/minuto para un recurso, ya con el 15% de margen. */
export function cupoEfectivo(recurso) {
  const l = LIMITES_ML[recurso];
  if (!l) throw new Error(`Recurso de rate limit desconocido: ${recurso}`);
  return Math.floor(l.rpm * (1 - MARGEN_SEGURIDAD));
}

/**
 * Clasifica una llamada en su recurso de límite específico (además del global,
 * que aplica siempre). method en minúsculas, path sin base URL.
 */
export function clasificarRecurso(method, path) {
  if (String(path || '').includes('/oauth/token')) return 'oauth';
  return String(method).toLowerCase() === 'get' ? 'lectura' : 'escritura';
}

/** Resumen legible para la revisión mensual y para exponer en /api/sync/estado. */
export function resumenLimites() {
  return Object.entries(LIMITES_ML).map(([recurso, l]) => ({
    recurso,
    documentado_rpm: l.rpm,
    efectivo_rpm: cupoEfectivo(recurso),
    es_documentado: l.documentado,
    nota: l.nota,
  }));
}
