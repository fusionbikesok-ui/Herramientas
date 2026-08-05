import { readFileSync } from 'node:fs';

// Extrae el bloque <script> (sin atributo src) MÁS LARGO de un archivo HTML.
// Las páginas de public/ tienen JS inline ES5 sin módulos ni exports; el script
// principal (con toda la lógica de negocio) es siempre el más extenso — los
// demás <script> son la carga de libs por src y el chequeo de permisos al final.
export function extraerScriptPrincipal(rutaHtml) {
  const html = readFileSync(rutaHtml, 'utf8');
  const regex = /<script>([\s\S]*?)<\/script>/g;
  let match;
  let mejor = '';
  while ((match = regex.exec(html))) {
    if (match[1].length > mejor.length) mejor = match[1];
  }
  if (!mejor) throw new Error('No se encontró un <script> inline en ' + rutaHtml);
  return mejor;
}
