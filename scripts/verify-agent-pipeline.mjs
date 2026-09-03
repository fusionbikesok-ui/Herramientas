import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHandoff, canonicalFingerprint } from './agent-pipeline-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(root, '.claude', 'agents');
const policyFile = path.join(root, 'scripts', 'agent-pipeline-policy.mjs');

const expectedModels = {
  'hard-worker-backend.md': 'haiku',
  'hard-worker-frontend.md': 'haiku',
  'explorador.md': 'haiku',
  'tester.md': 'sonnet',
  'probador-e2e.md': 'sonnet',
  'disenador-ux.md': 'sonnet',
  'disenador-ui.md': 'sonnet',
  'revisor.md': 'opus',
  'auditor-despliegue.md': 'opus',
};

const requiredFiles = [
  path.join(root, 'agents', 'model-routing.md'),
  path.join(root, 'agents', 'skill-routing.md'),
  path.join(root, 'docs', 'agent-coordination.md'),
  path.join(root, 'scripts', 'orchestrate-claude.mjs'),
  path.join(root, 'scripts', 'run-isolated-claude-e2e.mjs'),
  policyFile,
];

const errors = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(file)) errors.push(`falta ${path.relative(root, file)}`);
}

for (const [file, expected] of Object.entries(expectedModels)) {
  const full = path.join(agentsDir, file);
  if (!fs.existsSync(full)) {
    errors.push(`falta .claude/agents/${file}`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  const actual = text.match(/^model:\s*(\S+)\s*$/m)?.[1];
  if (actual !== expected) {
    errors.push(`.claude/agents/${file}: modelo ${actual ?? '(ausente)'}, esperado ${expected}`);
  }
}

const ownershipChecks = [
  ['hard-worker-backend.md', 'No tocás `public/`'],
  ['hard-worker-frontend.md', 'dueño de **todo `public/`'],
  ['revisor.md', 'NO escribe código'],
  ['tester.md', 'Solo escribís archivos de test'],
];
for (const [file, marker] of ownershipChecks) {
  const text = fs.readFileSync(path.join(agentsDir, file), 'utf8');
  if (!text.includes(marker)) errors.push(`.claude/agents/${file} perdió el ownership '${marker}'`);
}

const coordination = fs.readFileSync(path.join(root, 'docs', 'agent-coordination.md'), 'utf8');
for (const marker of ['Codex ↔ Claude', 'worktree', 'handoff', 'escritor']) {
  if (!coordination.includes(marker)) errors.push(`docs/agent-coordination.md no contiene '${marker}'`);
}

try {
  validateHandoff({ estado: 'APROBADO', base: 'a', head: 'b', diff_fingerprint: '0'.repeat(64), resultado_suite: 'ok' }, 'tester');
  try { validateHandoff({ estado: 'APROBADO', base: 'a', head: 'b', diff_fingerprint: 'bad', resultado_suite: 'ok' }, 'tester'); errors.push('política aceptó hash inválido'); } catch {}
  const fp = '0'.repeat(64); const core = { estado:'APROBADO', base:'a', head:'b', diff_fingerprint:fp };
  for (const [role, extra] of [['revisor',{veredicto:'OK',hallazgos:[]}],['tester',{resultado_suite:'OK'}],['probador-e2e',{evidencia:{fingerprint:fp},anchos_riesgos:[]}],['auditor-despliegue',{referencias_evidencia:[fp]}]]) {
    const normalized = role === 'auditor-despliegue' ? {...core, referencias_evidencia:{revisor:fp,tester:fp}} : {...core,...extra};
    try { validateHandoff(normalized, role); } catch (error) { errors.push(`contrato ${role} inválido: ${error.message}`); }
  }
  if (canonicalFingerprint({base:'a',head:'b'}) === canonicalFingerprint({base:'a',head:'b',untracked:'x'})) errors.push('huella no distingue untracked');
} catch (error) { errors.push(`política rechazó handoff válido: ${error.message}`); }
const controller = fs.readFileSync(path.join(root, 'scripts', 'orchestrate-claude.mjs'), 'utf8');
const e2e = fs.readFileSync(path.join(root, 'scripts', 'run-isolated-claude-e2e.mjs'), 'utf8');
if (!controller.includes('validateHandoff') || !controller.includes('authoritativeGitState') || !controller.includes('gate sin diff_fingerprint')) errors.push('controlador no aplica contrato v2');
if (!e2e.includes('authoritativeGitState') || e2e.includes('HEAD^')) errors.push('lanzador E2E no usa base segura');
for (const file of ['revisor.md','tester.md','probador-e2e.md','auditor-despliegue.md']) {
  const text = fs.readFileSync(path.join(agentsDir,file),'utf8');
  if (!text.includes('Contrato v2') || !text.includes('diff_fingerprint')) errors.push(`${file} no declara contrato v2`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.scripts?.['agent:claude'] !== 'node scripts/orchestrate-claude.mjs') {
  errors.push('package.json no expone agent:claude');
}
if (packageJson.scripts?.['agent:e2e'] !== 'node scripts/run-isolated-claude-e2e.mjs') {
  errors.push('package.json no expone agent:e2e');
}

if (errors.length) {
  console.error('Configuración de agentes inválida:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Configuración de agentes válida (${Object.keys(expectedModels).length} roles).`);
}
