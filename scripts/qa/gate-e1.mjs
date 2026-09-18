// Gate de escenarios de E1: exige que los IDs del tramo vigente estén cubiertos por una prueba que
// pasó. Lee el reporte JSON de vitest (`--reporter=json --outputFile=...`) y acepta además IDs
// verificados por el arnés mismo (servicios separados, por ejemplo), que no son pruebas unitarias.
//
//   node scripts/qa/gate-e1.mjs --tramo 2 --reporte /tmp/vitest.json --verificado E1-SVC-01
//   node scripts/qa/gate-e1.mjs --tramo 4 --reporte /tmp/vitest.json --evidencia E1-LAT-01=docs/.../archivo.md
//
// `--evidencia ID=ruta` acepta un escenario probado por una corrida o una decisión fechada y registrada (la
// prueba de latencia de C9, el chequeo externo, una dispensa de José), no por una prueba unitaria. El archivo
// tiene que existir: un escenario no se da por cubierto con una ruta inventada.
//
// Falla si falta un ID, si el reporte trae pruebas fallidas o si el reporte no existe: el contrato de
// `npm run test:e1` es que no puede pasar con un escenario ausente (PM-174).
import { existsSync, readFileSync } from 'node:fs';

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
// El tramo 3 ya tiene contrato exigible aunque todavía no esté implementado: `E1_TRAMO=3` falla
// mientras falte un escenario, que es exactamente para lo que existe este gate (PM-174).
const TRAMO_3 = [
  ...TRAMO_2,
  'E1-LAT-01', 'E1-PGDOWN-01', 'E1-RCP-01', 'E1-RCP-02', 'E1-QUE-01', 'E1-SIG-01', 'E1-SIG-02',
  'E1-ACC-01', 'E1-GW-01', 'E1-GW-02', 'E1-RER-01', 'E1-MFD-01', 'E1-BLK-01', 'E1-SOAK-01',
];
const TRAMO_4 = [...TRAMO_3, 'E1-AUD-04', 'E1-REC-01', 'E1-WA-01'];
const EXIGIDOS = { 1: TRAMO_1, 2: TRAMO_2, 3: TRAMO_3, 4: TRAMO_4 };
// Mínimo de pruebas que pasaron por escenario. Con un solo `it` por ID alcanzaba para pintarlo verde, sin
// demostrar los subcasos que el contrato enumera (revisión del plan del tramo 4, hallazgo 18).
const MINIMOS = { 'E1-AUD-04': 4, 'E1-REC-01': 6, 'E1-WA-01': 6 };

function argumentos(argv) {
  const salida = { tramo: '1', reportes: [], verificado: [], evidencia: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const clave = argv[i];
    if (clave === '--tramo') salida.tramo = argv[++i] ?? '';
    // Se puede repetir: desde el tramo 3 hay escenarios probados del lado del legado (recibos, cola).
    else if (clave === '--reporte') salida.reportes.push(argv[++i] ?? '');
    else if (clave === '--verificado') salida.verificado.push(...(argv[++i] ?? '').split(',').filter(Boolean));
    else if (clave === '--evidencia') {
      const [id, ruta] = (argv[++i] ?? '').split('=');
      if (!id || !ruta) { console.error('--evidencia espera ID=ruta'); process.exit(2); }
      salida.evidencia.set(id, ruta);
    }
    else { console.error(`argumento desconocido: ${clave}`); process.exit(2); }
  }
  return salida;
}

const { tramo, reportes, verificado, evidencia } = argumentos(process.argv.slice(2));
const exigidos = EXIGIDOS[tramo];
if (!exigidos) { console.error(`tramo inválido: ${tramo} (1, 2, 3 o 4)`); process.exit(2); }
for (const [id, ruta] of evidencia) {
  if (!existsSync(ruta)) { console.error(`la evidencia de ${id} no existe: ${ruta}`); process.exit(1); }
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
if (pruebas.length === 0) { console.error('el reporte no contiene pruebas'); process.exit(1); }
const fallidas = pruebas.filter((p) => p.status === 'failed').map((p) => p.fullName ?? p.title);
const pasadas = pruebas.filter((p) => p.status === 'passed').map((p) => `${p.fullName ?? ''} ${p.title ?? ''}`);

const cobertura = exigidos.map((id) => {
  if (verificado.includes(id)) return { id, por: 'arnés' };
  if (evidencia.has(id)) return { id, por: `evidencia ${evidencia.get(id)}` };
  // El id va seguido de fin de palabra para que E1-Q-01 no cubra E1-Q-010.
  const patron = new RegExp(`${id}(?![0-9-])`);
  const cuantas = pasadas.filter((n) => patron.test(n)).length;
  const minimo = MINIMOS[id] ?? 1;
  if (cuantas >= minimo) return { id, por: `${cuantas} prueba(s)` };
  return { id, por: null, detalle: cuantas ? `${cuantas} de ${minimo} pruebas mínimas` : undefined };
});
const faltantes = cobertura.filter((c) => !c.por).map((c) => c.id);

for (const c of cobertura) console.log(`${c.por ? 'ok  ' : 'FALTA'} ${c.id}${c.por ? ` (${c.por})` : c.detalle ? ` (${c.detalle})` : ''}`);
if (fallidas.length) {
  console.error(`\n${fallidas.length} prueba(s) fallaron:`);
  for (const n of fallidas.slice(0, 20)) console.error(`  - ${n}`);
}
if (faltantes.length) console.error(`\nescenarios sin cobertura en el tramo ${tramo}: ${faltantes.join(', ')}`);
if (fallidas.length || faltantes.length) process.exit(1);
console.log(`\ngate E1 tramo ${tramo}: ${exigidos.length} escenarios cubiertos, ${pruebas.length} pruebas corridas`);
