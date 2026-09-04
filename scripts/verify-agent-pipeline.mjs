import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { canonicalFingerprint, canonicalRole, validateHandoff, validateTask, ROLES } from './agent-pipeline-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(root, '.claude', 'agents');
const policyFile = path.join(root, 'scripts', 'agent-pipeline-policy.mjs');
const routingFile = path.join(root, 'agents', 'routing.json');

// Los modelos esperados NO se hardcodean acá: se derivan de agents/routing.json más abajo, que
// es la única fuente de verdad del reparto. Este mapa existía cuando Codex orquestaba y quedó
// stale tras la inversión (declaraba haiku para roles que hoy corren en Codex), que es
// exactamente el problema que una segunda fuente de verdad produce.
const AGENT_FILES = [
  'hard-worker-backend.md', 'hard-worker-frontend.md', 'explorador.md', 'tester.md',
  'probador-e2e.md', 'disenador-ux.md', 'disenador-ui.md', 'revisor.md', 'auditor-despliegue.md',
];

const requiredFiles = [
  path.join(root, 'agents', 'model-routing.md'),
  path.join(root, 'agents', 'skill-routing.md'),
  path.join(root, 'agents', 'routing.json'),
  path.join(root, 'docs', 'agent-coordination.md'),
  path.join(root, 'scripts', 'orchestrate-claude.mjs'),
  path.join(root, 'scripts', 'orchestrate-codex.mjs'),
  path.join(root, 'scripts', 'agent-dispatch-common.mjs'),
  path.join(root, 'scripts', 'agent-routing.mjs'),
  path.join(root, 'scripts', 'run-isolated-claude-e2e.mjs'),
  policyFile,
];

const errors = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(file)) errors.push(`falta ${path.relative(root, file)}`);
}

// Estructura del frontmatter. La coherencia del modelo contra routing.json se valida más abajo,
// y solo para roles engine=claude: en los roles que corren en Codex el frontmatter no gobierna
// nada (el modelo sale de routing.json y lo aplica `codex exec -m`).
for (const file of AGENT_FILES) {
  const full = path.join(agentsDir, file);
  if (!fs.existsSync(full)) {
    errors.push(`falta .claude/agents/${file}`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  try { if (!frontmatter || !parse(frontmatter[1])?.name) throw new Error('sin name'); } catch (error) { errors.push(`.claude/agents/${file}: frontmatter YAML inválido (${error.message})`); }
  if (!/^model:\s*(\S+)\s*$/m.test(text)) errors.push(`.claude/agents/${file}: sin campo model`);
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
for (const marker of ['Claude ↔ Codex', 'worktree', 'handoff', 'escritor']) {
  if (!coordination.includes(marker)) errors.push(`docs/agent-coordination.md no contiene '${marker}'`);
}

// agents/routing.json es la fuente ejecutable del reparto motor/modelo/esfuerzo. Todo rol de la
// política debe tener entrada, y ningún rol inválido debe colarse. Para roles engine=claude, el
// modelo declarado tiene que coincidir con el frontmatter de .claude/agents/<rol>.md — si
// divergen, uno de los dos quedó desactualizado tras editar el otro.
let routing;
try {
  routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
} catch (error) {
  errors.push(`agents/routing.json inválido: ${error.message}`);
}
if (routing) {
  for (const role of ROLES) if (!routing.roles?.[role]) errors.push(`agents/routing.json no define el rol ${role}`);
  for (const role of Object.keys(routing.roles || {})) if (!ROLES.has(role)) errors.push(`agents/routing.json define un rol inválido: ${role}`);
  for (const [role, entry] of Object.entries(routing.roles || {})) {
    if (entry.engine === 'claude') {
      const file = path.join(agentsDir, `${role}.md`);
      const frontmatterModel = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').match(/^model:\s*(\S+)\s*$/m)?.[1] : undefined;
      if (frontmatterModel && entry.model !== frontmatterModel) {
        errors.push(`agents/routing.json declara ${role}=${entry.model}, pero .claude/agents/${role}.md declara ${frontmatterModel}`);
      }
    }
    if (entry.engine === 'codex' && ['explorador', 'revisor', 'auditor-despliegue'].includes(role) && entry.sandbox !== 'read-only') {
      errors.push(`agents/routing.json: el rol de solo lectura ${role} debe tener sandbox read-only`);
    }
  }

  // Invariante v3: ningún rol que escriba en el repo puede correr en el tramo chico. El +18.1pp
  // del cross-review se midió con un escritor a esfuerzo high; con luna/low no hay evidencia de
  // que se sostenga, y cada ciclo de rework gasta una pasada de revisor Opus (la parte cara).
  for (const role of ['hard-worker-backend', 'hard-worker-frontend', 'tester']) {
    const entry = routing.roles?.[role];
    if (entry?.engine === 'codex' && /luna/.test(entry.model || '')) {
      errors.push(`agents/routing.json: ${role} escribe en el repo y no puede correr en ${entry.model} (tramo chico); mínimo gpt-5.6-terra`);
    }
  }

  // La escalera de riesgo tiene que terminar cambiando de motor: el techo es "lo escribe Opus",
  // no "lo escribe el Codex más grande y lo revisa Opus".
  const ladder = routing.escalation?.ladder || [];
  if (!ladder.length) errors.push('agents/routing.json: escalation.ladder vacía');
  ladder.forEach((step, i) => {
    if (!step.model) errors.push(`agents/routing.json: escalation.ladder[${i}] sin model`);
    if (step.engine && !['codex', 'claude'].includes(step.engine)) errors.push(`agents/routing.json: escalation.ladder[${i}] engine inválido: ${step.engine}`);
    if (step.engine === 'codex' && !step.effort) errors.push(`agents/routing.json: escalation.ladder[${i}] (codex) sin effort`);
    if (step.engine === 'claude' && (step.effort || step.sandbox)) errors.push(`agents/routing.json: escalation.ladder[${i}] es claude y no debe declarar effort ni sandbox`);
  });
  if (ladder.length && ladder[ladder.length - 1].engine !== 'claude') {
    errors.push('agents/routing.json: el último escalón de la escalera debe tener engine=claude (techo de riesgo: lo escribe Opus)');
  }

  // Escalera de gates: revisor/auditor corren en sonnet por presupuesto, así que la subida a
  // opus tiene que existir. Sin ella los gates se quedarían en sonnet incluso para diffs que
  // tocan guardia_ml o el sync — exactamente el código que ya rompió producción.
  const gates = routing.escalation?.ladder_gates || [];
  if (!gates.length) errors.push('agents/routing.json: escalation.ladder_gates vacía (los gates en sonnet no tendrían a dónde escalar)');
  if (gates.length && (gates[gates.length - 1].engine !== 'claude' || gates[gates.length - 1].model !== 'opus')) {
    errors.push('agents/routing.json: el último escalón de ladder_gates debe ser engine=claude model=opus');
  }

  // Los triggers alimentan la escalada automática por paths: si quedan en formato viejo (strings)
  // o sin paths, la detección devuelve vacío y ningún gate escala nunca, en silencio.
  const triggers = routing.escalation?.triggers || [];
  if (!triggers.length) errors.push('agents/routing.json: escalation.triggers vacío');
  const conPaths = triggers.filter((t) => t && typeof t === 'object' && Array.isArray(t.paths) && t.paths.length);
  for (const trigger of triggers) {
    if (typeof trigger === 'string') errors.push(`agents/routing.json: trigger en formato viejo (string): ${trigger}; usá {label, paths}`);
    else if (!trigger?.label) errors.push('agents/routing.json: hay un trigger sin label');
  }
  if (!conPaths.length) errors.push('agents/routing.json: ningún trigger declara paths, la escalada automática de gates nunca dispararía');
}


try {
  validateHandoff({ estado: 'APROBADO', base: 'a', head: 'b', diff_fingerprint: '0'.repeat(64), resultado_suite: 'ok' }, 'tester');
  try { validateHandoff({ estado: 'APROBADO', base: 'a', head: 'b', diff_fingerprint: 'bad', resultado_suite: 'ok' }, 'tester'); errors.push('política aceptó hash inválido'); } catch {}
  const fp = '0'.repeat(64); const core = { estado:'APROBADO', base:'a', head:'b', diff_fingerprint:fp };
  for (const [role, extra] of [['revisor',{veredicto:'OK',hallazgos:[]}],['tester',{resultado_suite:'OK'}],['probador-e2e',{evidencia:{fingerprint:fp},anchos_riesgos:[]}],['auditor-despliegue',{referencias_evidencia:{revisor:fp,tester:fp}}]]) {
    const normalized = {...core,...extra};
    try { validateHandoff(normalized, role); } catch (error) { errors.push(`contrato ${role} inválido: ${error.message}`); }
  }
  if (canonicalFingerprint({base:'a',head:'b'}) === canonicalFingerprint({base:'a',head:'b',untracked:'x'})) errors.push('huella no distingue untracked');
  if (canonicalRole('qa') !== 'tester' || canonicalRole('deploy-auditor') !== 'auditor-despliegue') errors.push('aliases de rol legacy incompletos');
  try { validateTask('Tarea: x\nRama: x\nWorktree: /tmp/x', { e2e: true }); errors.push('task E2E inválida fue aceptada'); } catch {}
  try { validateHandoff({...core, requiere_e2e:true, referencias_evidencia:{revisor:fp,tester:fp}}, 'auditor-despliegue'); errors.push('auditor aceptó falta de referencia E2E'); } catch {}
} catch (error) { errors.push(`política rechazó handoff válido: ${error.message}`); }
// La protección semántica del congelamiento de diff vive ahora en agent-dispatch-common.mjs
// (compartida por los dos orquestadores); orchestrate-claude.mjs y orchestrate-codex.mjs deben
// importarla desde ahí en vez de reimplementarla — por eso el corpus es la concatenación de los
// tres archivos, no solo el controlador de Claude.
const claudeController = fs.readFileSync(path.join(root, 'scripts', 'orchestrate-claude.mjs'), 'utf8');
const codexController = fs.readFileSync(path.join(root, 'scripts', 'orchestrate-codex.mjs'), 'utf8');
const dispatchCommon = fs.readFileSync(path.join(root, 'scripts', 'agent-dispatch-common.mjs'), 'utf8');
const controllerCorpus = `${claudeController}\n${codexController}\n${dispatchCommon}`;
const e2e = fs.readFileSync(path.join(root, 'scripts', 'run-isolated-claude-e2e.mjs'), 'utf8');
for (const marker of ['validateHandoff(handoff, role, { cwd: worktree })', 'inputFingerprint', 'outputState', 'REFRESH_REVIEW', 'handoff diff_fingerprint no coincide', 'handoff Base/HEAD no coincide', 'priorEvidence', 'outputOutsideWorktree', 'persistedState']) if (!controllerCorpus.includes(marker)) errors.push(`orquestadores no aplican la protección semántica '${marker}'`);
// Los dos orquestadores deben usar el módulo común, no reimplementar sus funciones críticas.
for (const marker of ['freezeAndVerify', 'writeHandoffFile', 'outputOutsideWorktree', 'buildRolePrompt']) {
  if (!claudeController.includes(marker)) errors.push(`orchestrate-claude.mjs no usa ${marker} de agent-dispatch-common.mjs`);
  if (!codexController.includes(marker)) errors.push(`orchestrate-codex.mjs no usa ${marker} de agent-dispatch-common.mjs`);
}
// orchestrate-codex.mjs nunca debe pasar --add-dir apuntando al repo raíz con sandbox de
// escritura: es la vía por la que orchestrate-claude.mjs sí puede escribir fuera del worktree
// hoy (deuda existente, no replicar en el orquestador nuevo).
if (codexController.includes('--add-dir')) errors.push('orchestrate-codex.mjs no debe usar --add-dir contra el repo de producción');
if (!codexController.includes('assertNotProductionRoot')) errors.push('orchestrate-codex.mjs no valida que el worktree no sea el repo de producción');
if (!e2e.includes('authoritativeGitState') || e2e.includes('HEAD/base:') || !e2e.includes('enrichTask') || !e2e.includes('safeEnv') || !e2e.includes('HEAD actual no coincide')) errors.push('lanzador E2E no aísla campos, entorno y HEAD');
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
if (packageJson.scripts?.['agent:codex'] !== 'node scripts/orchestrate-codex.mjs') {
  errors.push('package.json no expone agent:codex');
}

if (errors.length) {
  console.error('Configuración de agentes inválida:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Configuración de agentes válida (${AGENT_FILES.length} roles).`);
}
