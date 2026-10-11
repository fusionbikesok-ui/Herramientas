// Búsqueda de texto por palabras, compartida por la cola de casos (catalogoVinculos) y el
// listado de candidatos del Matcher (matcherCandidatosPaginado).
//
// Semántica: se normaliza (sin acentos ni mayúsculas, con trim) y se parte por espacios; TODAS las
// palabras deben aparecer como subcadena en el texto normalizado (AND). `q` vacío o solo espacios =
// sin filtro. Una sola palabra se comporta como subcadena.

export const normTexto = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Tokens de una búsqueda `q`: normalizados y separados por espacios (dobles espacios se ignoran). */
export const tokensQ = (q) => normTexto(q).split(/\s+/).filter(Boolean);

/** AND entre tokens sobre una lista de campos: cada token debe aparecer en algún campo. Sin tokens = coincide. */
export const coincideTokens = (tokens, campos) => tokens.every((t) => campos.some((v) => v != null && normTexto(v).includes(t)));
