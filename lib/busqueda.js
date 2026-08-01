// Helper único para armar patrones LIKE seguros.
//
// sqlite interpreta `%` y `_` como comodines dentro de un LIKE. Si el término
// de búsqueda del usuario los trae literalmente (ej. buscar el texto "50%"),
// hay que escaparlos antes de envolverlos entre `%...%`, y la query tiene que
// declarar la barra invertida como carácter de escape con `ESCAPE '\\'`.
// Sin esto, `q=%` o `q=_` matchean cualquier fila (comodín total) en vez de
// buscarse como texto literal.
export function armarLike(q) {
  const escapado = String(q ?? '')
    .replace(/\\/g, '\\\\') // la barra de escape va primero
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  return `%${escapado}%`;
}
