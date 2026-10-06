// Gate de escenarios de E2 tramo 1 (catálogo canónico). Propio, separado del de E1 (hallazgo 26 de la revisión del
// plan): verificar E1 no puede depender de funcionalidad posterior.
//
//   node scripts/qa/gate-e2.mjs --reporte /tmp/plataforma.json --reporte /tmp/legado.json
//
// Exige dos cosas, igual que el de E1 desde el tramo 4:
//   1. cada ID de escenario tiene al menos una prueba que pasó;
//   2. cada ESCENARIO CONTRACTUAL (§8 del diseño, más los que agregó la revisión del plan) lo nombra al menos una
//      prueba que pasó. Contar pruebas no alcanza: varias variantes del mismo camino feliz pintaban verde sin
//      cubrir el caso. Cuando falta uno, el gate lo nombra, así que dice qué hay que escribir.
// Falla si falta algo, si el reporte trae pruebas fallidas o si no existe.
import { readFileSync } from 'node:fs';

const IDS = [
  'E2-SCH-01', 'E2-COLA-01', 'E2-CFG-01', 'E2-PRY-01', 'E2-PRY-02', 'E2-PRY-03', 'E2-PRY-10', 'E2-PRY-11',
  'E2-CPY-01', 'E2-CPY-02', 'E2-CPY-03', 'E2-DEC-01', 'E2-OBX-01', 'E2-BOO-01', 'E2-BOO-02', 'E2-LEC-01',
];

// [nombre del escenario, patrón que tiene que aparecer en el nombre de una prueba que pasó]
const CONTRACTUALES = [
  // §8 del diseño
  ['restricciones SQL del esquema', /SKU con formato no can[óo]nico se rechaza/i],
  ['importación repetida no duplica', /el mismo recurso dos veces no duplica/i],
  ['el padre no es vendible', /contenedor que no se vende/i],
  ['SKU inmutable', /SKU es inmutable/i],
  ['variante con SKU pendiente', /variante con SKU pendiente/i],
  ['omitida con caso', /omitir.*(sin variante|caso de baja prioridad)/i],
  ['SKU inexistente en Woo', /sku_inexistente_en_woo/i],
  ['Woo simple sin SKU', /sin SKU abre woo_sin_sku/i],
  ['SKU duplicado en Woo', /queda duplicado/i],
  ['ML clásico con varias variaciones', /cl[áa]sico con variaciones/i],
  ['mismo user_product_id en dos publicaciones', /mismo user_product_id/i],
  ['pendiente que recibe un SKU existente: fusión', /se fusiona con la variante de Woo/i],
  ['dos resoluciones concurrentes', /simult[áa]neos/i],
  ['revocación en el legado', /revocar/i],
  ['recurso sin cambios desde antes del bootstrap', /sin cambios desde antes del bootstrap/i],
  ['payload vencido', /payload vencido/i],
  ['429 a mitad del scan y retoma desde el checkpoint', /RETOMA/],
  ['duplicado con variación vacía', /duplicada sin variaci[óo]n/i],
  ['baja y reaparición', /reaparici[óo]n desarchiva/i],
  ['conciliación por cuenta con sus cruces', /cuatro cruces/i],
  // Revisión del plan
  ['copia incompleta no aplica nada', /lote faltante falla sin efecto/i],
  ['todo escritor del matcher queda capturado', /tres formas de escribir/i],
  ['la regla del corte', /REGLA DEL CORTE/],
  ['atomicidad del proyector con falla inyectada', /falla despu[ée]s de escribir el cat[áa]logo/i],
  ['contrato legado ↔ plataforma: eventos', /CONTRATO: lo que traduce el legado/],
  ['contrato legado ↔ plataforma: hash de la copia', /CONTRATO: el hash del legado/],
  ['reporte reproducible al corte', /es la del CORTE/],
];

const reportes = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--reporte') reportes.push(process.argv[++i] ?? '');
  else { console.error(`argumento desconocido: ${process.argv[i]}`); process.exit(2); }
}
if (!reportes.length || reportes.some((r) => !r)) { console.error('falta --reporte con el JSON de vitest'); process.exit(2); }

const pruebas = reportes.flatMap((reporte) => {
  let datos;
  try { datos = JSON.parse(readFileSync(reporte, 'utf8')); } catch (e) {
    console.error(`no se pudo leer el reporte ${reporte}: ${e.message}`);
    process.exit(1);
  }
  return (datos.testResults ?? []).flatMap((archivo) => archivo.assertionResults ?? []);
});
if (!pruebas.length) { console.error('el reporte no contiene pruebas'); process.exit(1); }
const fallidas = pruebas.filter((p) => p.status === 'failed').map((p) => p.fullName ?? p.title);
const pasadas = pruebas.filter((p) => p.status === 'passed').map((p) => `${p.fullName ?? ''} ${p.title ?? ''}`);

const faltan = [];
for (const id of IDS) {
  const n = pasadas.filter((p) => new RegExp(`${id}(?![0-9-])`).test(p)).length;
  console.log(`${n ? 'ok  ' : 'FALTA'} ${id}${n ? ` (${n} prueba(s))` : ''}`);
  if (!n) faltan.push(id);
}
for (const [nombre, patron] of CONTRACTUALES) {
  const ok = pasadas.some((p) => patron.test(p));
  console.log(`${ok ? 'ok  ' : 'FALTA'} escenario: ${nombre}`);
  if (!ok) faltan.push(nombre);
}
if (fallidas.length) {
  console.error(`\n${fallidas.length} prueba(s) fallaron:`);
  for (const n of fallidas.slice(0, 20)) console.error(`  - ${n}`);
}
if (faltan.length) console.error(`\nsin cobertura: ${faltan.join('; ')}`);
if (fallidas.length || faltan.length) process.exit(1);
console.log(`\ngate E2 tramo 1: ${IDS.length} IDs y ${CONTRACTUALES.length} escenarios cubiertos, ${pruebas.length} pruebas corridas`);
