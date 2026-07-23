/**
 * Helpers de concurrencia acotada.
 *
 * Pensado para bajar el tiempo total de lotes de llamadas a APIs externas (p. ej. ML)
 * sin dispararlas todas a la vez: procesa un array con un máximo de N tareas en vuelo
 * simultáneamente. Reemplaza el patrón `for` secuencial con `sleep` fijo entre requests.
 */

/**
 * Recorre `items` aplicando `fn(item, indice)` con como máximo `limite` promesas en vuelo
 * a la vez. Devuelve un array de resultados EN EL MISMO ORDEN que `items` (result[i] es el
 * valor devuelto por fn para items[i]), independientemente del orden en que terminen.
 *
 * Semántica de errores tipo Promise.all: si alguna `fn` rechaza, el conjunto rechaza. Para
 * que una tarea fallida no frene a las demás, `fn` debe capturar su propio error y devolver
 * un resultado (éxito/omitido/error) — así cada elemento resuelve de forma independiente.
 */
export async function mapConLimite(items, limite, fn) {
  const arr = Array.isArray(items) ? items : [...items];
  const resultados = new Array(arr.length);
  const lim = Math.max(1, Math.min(Math.floor(limite) || 1, arr.length || 1));
  let proximo = 0;

  async function worker() {
    while (true) {
      const i = proximo++;
      if (i >= arr.length) return;
      resultados[i] = await fn(arr[i], i);
    }
  }

  const workers = [];
  for (let w = 0; w < lim; w++) workers.push(worker());
  await Promise.all(workers);
  return resultados;
}
