import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const docsRoot = path.join(root, 'docs/superpowers');
const deliveriesDir = path.join(docsRoot, 'deliveries');
const program = JSON.parse(fs.readFileSync(path.join(docsRoot, 'delivery-program.json'), 'utf8'));
const decisionCrosswalk = JSON.parse(fs.readFileSync(path.join(docsRoot, 'decision-crosswalk.json'), 'utf8'));
const required = [
  '## Resultado y límites', '## Línea base verificada', '## Decisiones e invariantes',
  '## Diseño, datos e interfaces', '## Integraciones, migración y recuperación',
  '## UI, operación y observabilidad', '## Pruebas y evidencia',
  '## Rollout, rollback y aceptación', '## Continuidad', '## Decisiones PM asignadas'
];
const errors = [];
const ids = new Set();
const byId = new Map(program.deliveries.map((delivery) => [delivery.id, delivery]));
const stateRank = new Map(program.states.map((state, index) => [state, index]));

program.deliveries.forEach((delivery, index) => {
  const expected = `E${index}`;
  if (delivery.id !== expected) errors.push(`continuidad: se esperaba ${expected} y apareció ${delivery.id}`);
  if (ids.has(delivery.id)) errors.push(`ID duplicado: ${delivery.id}`);
  ids.add(delivery.id);
  if (!program.states.includes(delivery.state)) errors.push(`estado inválido en ${delivery.id}: ${delivery.state}`);
  for (const dependency of delivery.depends) if (!byId.has(dependency) || dependency === delivery.id) errors.push(`dependencia inválida en ${delivery.id}: ${dependency}`);
  const file = path.join(deliveriesDir, `${delivery.id}-${delivery.slug}.md`);
  if (!fs.existsSync(file)) { errors.push(`falta ficha: ${path.relative(root, file)}`); return; }
  const text = fs.readFileSync(file, 'utf8');
  for (const heading of required) if (!text.includes(heading)) errors.push(`${delivery.id}: falta ${heading}`);
  if (/\b(?:TODO|TBD)\b/.test(text) || /\bPOR DEFINIR\b/i.test(text)) errors.push(`${delivery.id}: contiene marcador sin resolver`);
  if (!text.includes(`npm run test:${delivery.id.toLowerCase()}`)) errors.push(`${delivery.id}: falta comando contractual`);
  if (stateRank.get(delivery.state) >= stateRank.get('desarrollo') && !program.scripts?.includes?.(`test:${delivery.id.toLowerCase()}`)) {
    const packageScripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    if (!packageScripts[`test:${delivery.id.toLowerCase()}`]) errors.push(`${delivery.id}: estado ${delivery.state} sin script test:${delivery.id.toLowerCase()} ejecutable`);
  }
  if (delivery.state === 'planificada' && /\b(?:definir|fijar|especificar|redactar|producir|diseñar)\b/i.test(delivery.next)) errors.push(`${delivery.id}: planificada con decisión de diseño pendiente en próxima acción`);
});

const visiting = new Set();
const visited = new Set();
function visit(id) {
  if (visiting.has(id)) { errors.push(`ciclo de dependencias en ${id}`); return; }
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of byId.get(id)?.depends || []) visit(dependency);
  visiting.delete(id);
  visited.add(id);
}
for (const id of ids) visit(id);

const currentFiles = fs.readdirSync(deliveriesDir).filter((name) => /^E\d+-.*\.md$/.test(name));
if (currentFiles.length !== program.deliveries.length) errors.push(`cantidad de fichas: ${currentFiles.length}, esperadas ${program.deliveries.length}`);
const deliveryIndex = fs.readFileSync(path.join(deliveriesDir, 'README.md'), 'utf8');
for (const delivery of program.deliveries) {
  const expectedRow = `| ${delivery.id} | ${delivery.title} | ${delivery.depends.join(', ') || '—'} | ${delivery.state} |`;
  if (!deliveryIndex.includes(expectedRow)) errors.push(`README de entregas desactualizado para ${delivery.id}`);
}

for (const requiredFile of ['plan-maestro.md', 'delivery-contract.md', 'crosswalk-entregas.md', 'audit-baseline-2026-09-13.md']) {
  if (!fs.existsSync(path.join(docsRoot, requiredFile))) errors.push(`falta ${requiredFile}`);
}

const decisionText = fs.readFileSync(path.join(docsRoot, 'decisions/plan-maestro-decisions.md'), 'utf8');
const expectedDecisions = [...new Set(decisionText.match(/PM-\d{3}/g) || [])].sort();
const mappedDecisions = decisionCrosswalk.decisions.map((entry) => entry.id).sort();
if (new Set(mappedDecisions).size !== mappedDecisions.length) errors.push('decision-crosswalk: IDs duplicados');
if (JSON.stringify(expectedDecisions) !== JSON.stringify(mappedDecisions)) errors.push('decision-crosswalk: no cubre exactamente las decisiones PM vigentes');
for (const entry of decisionCrosswalk.decisions) {
  if (!ids.has(entry.owner)) errors.push(`decision-crosswalk: dueño inválido ${entry.owner} para ${entry.id}`);
  if (!Array.isArray(entry.consumers)) errors.push(`decision-crosswalk: consumidores ausentes para ${entry.id}`);
  for (const consumer of entry.consumers || []) if (!ids.has(consumer) || consumer === entry.owner) errors.push(`decision-crosswalk: consumidor inválido ${consumer} para ${entry.id}`);
}
const ownerCounts = decisionCrosswalk.decisions.reduce((counts, entry) => counts.set(entry.owner, (counts.get(entry.owner) || 0) + 1), new Map());
for (const [owner, count] of ownerCounts) if (count > 60) errors.push(`decision-crosswalk: concentración excesiva en ${owner} (${count})`);

const linkedDocs = [
  path.join(docsRoot, 'INDEX.md'),
  path.join(docsRoot, 'plan-maestro.md'),
  path.join(docsRoot, 'delivery-contract.md'),
  path.join(deliveriesDir, 'README.md'),
  ...currentFiles.map((name) => path.join(deliveriesDir, name))
];
for (const file of linkedDocs) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
      errors.push(`${path.relative(root, file)}: enlace local roto ${target}`);
    }
  }
}

const operationalDocs = [
  path.join(root, 'CLAUDE.md'),
  path.join(docsRoot, 'INDEX.md'),
  path.join(docsRoot, 'plan-maestro.md'),
  path.join(deliveriesDir, 'README.md'),
  path.join(root, 'docs/memory/active.md'),
  path.join(root, 'docs/memory/modules/architecture.md'),
  path.join(root, 'docs/memory/modules/warehouse-operations.md'),
  path.join(root, 'docs/memory/modules/mobile-app.md'),
  path.join(root, 'lib/guardiaAvisos.js'),
  path.join(root, 'scripts/qa/snapshot-anonimizado.mjs'),
  path.join(root, 'scripts/qa/simulador-canales.mjs'),
  path.join(root, 'scripts/qa/qa.sh'),
  path.join(root, 'deploy/qa/Dockerfile')
];
const legacyPaths = /deliveries\/(?:PLAT-|UM1|GESTION-PEDIDOS-|E\d+\.md|CHECKPOINT-TEMPLATE)|plans\/plan-maestro-v2\.md/;
for (const file of operationalDocs) {
  if (legacyPaths.test(fs.readFileSync(file, 'utf8'))) errors.push(`${path.relative(root, file)}: referencia operativa a una ruta legacy`);
}

if (errors.length) {
  console.error(errors.map((error) => `ERROR ${error}`).join('\n'));
  process.exit(1);
}
console.log(`OK: ${program.deliveries.length} fichas E0–E${program.deliveries.length - 1}; estructura, IDs, estados, dependencias, enlaces y cobertura PM válidos`);
