import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(root, '.claude', 'agents');

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
