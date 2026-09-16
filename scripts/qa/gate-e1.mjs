// Gate de escenarios de E1: exige que los IDs del tramo vigente estén cubiertos por una prueba que
// pasó. Lee el reporte JSON de vitest (`--reporter=json --outputFile=...`) y acepta además IDs
// verificados por el arnés mismo (servicios separados, por ejemplo), que no son pruebas unitarias.
//
//   node scripts/qa/gate-e1.mjs --tramo 2 --reporte /tmp/vitest.json --verificado E1-SVC-01
//
// Falla si falta un ID, si el reporte trae pruebas fallidas o si el reporte no existe: el contrato de
// `npm run test:e1` es que no puede pasar con un escenario ausente (PM-174).
import { readFileSync } from 'node:fs';

const TRAMO_1 = [
  'E1-SCH-01', 'E1-SCH-02', 'E1-AUD-01', 'E1-AUD-02', 'E1-AUD-03',
  'E1-Q-01', 'E1-Q-02', 'E1-Q-03', 'E1-Q-04', 'E1-Q-05', 'E1-Q-06',
  'E1-DUP-01', 'E1-CAP-01', 'E1-API-01', 'E1-SVC-01',
];
const TRAMO_2 = [
  ...TRAMO_1,
  'E1-SWP-01', 'E1-SWP-02', 'E1-SWP-03', 'E1-SWP-04', 'E1-SWP-05',
  'E1-SWP-06', 'E1-SWP-07', 'E1-SWP-08', 'E1-SWP-09', 'E1-CONV-01', 'E1-DEL-01',
];
const EXIGIDOS = { 1: TRAMO_1, 2: TRAMO_2 };

function argumentos(argv) {
  const salida = { tramo: '1', reporte: '', verificado: [] };
  for (let i = 0; i < argv.length; i++) {
    const clave = argv[i];
    if (clave === '--tramo') salida.tramo = argv[++i] ?? '';
    else if (clave === '--reporte') salida.reporte = argv[++i] ?? '';
    else if (clave === '--verificado') salida.verificado.push(...(argv[++i] ?? '').split(',').filter(Boolean));
    else { console.error(`argumento desconocido: ${clave}`); process.exit(2); }
  }
  return salida;
}

const { tramo, reporte, verificado } = argumentos(process.argv.slice(2));
const exigidos = EXIGIDOS[tramo];
if (!exigidos) { console.error(`tramo inválido: ${tramo} (1 o 2)`); process.exit(2); }
if (!reporte) { console.error('falta --reporte con el JSON de vitest'); process.exit(2); }

let datos;
try { datos = JSON.parse(readFileSync(reporte, 'utf8')); } catch (e) {
  console.error(`no se pudo leer el reporte ${reporte}: ${e.message}`);
  process.exit(1);
}

const pruebas = (datos.testResults ?? []).flatMap((archivo) => archivo.assertionResults ?? []);
if (pruebas.length === 0) { console.error('el reporte no contiene pruebas'); process.exit(1); }
const fallidas = pruebas.filter((p) => p.status === 'failed').map((p) => p.fullName ?? p.title);
const pasadas = pruebas.filter((p) => p.status === 'passed').map((p) => `${p.fullName ?? ''} ${p.title ?? ''}`);

const cobertura = exigidos.map((id) => {
  if (verificado.includes(id)) return { id, por: 'arnés' };
  // El id va seguido de fin de palabra para que E1-Q-01 no cubra E1-Q-010.
  const patron = new RegExp(`${id}(?![0-9-])`);
  return { id, por: pasadas.some((n) => patron.test(n)) ? 'prueba' : null };
});
const faltantes = cobertura.filter((c) => !c.por).map((c) => c.id);

for (const c of cobertura) console.log(`${c.por ? 'ok  ' : 'FALTA'} ${c.id}${c.por ? ` (${c.por})` : ''}`);
if (fallidas.length) {
  console.error(`\n${fallidas.length} prueba(s) fallaron:`);
  for (const n of fallidas.slice(0, 20)) console.error(`  - ${n}`);
}
if (faltantes.length) console.error(`\nescenarios sin cobertura en el tramo ${tramo}: ${faltantes.join(', ')}`);
if (fallidas.length || faltantes.length) process.exit(1);
console.log(`\ngate E1 tramo ${tramo}: ${exigidos.length} escenarios cubiertos, ${pruebas.length} pruebas corridas`);
