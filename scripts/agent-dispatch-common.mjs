// Lógica compartida entre orchestrate-claude.mjs (Codex → Claude) y orchestrate-codex.mjs
// (Claude → Codex). Nada acá es específico de un motor: resolución de argumentos, extracción
// de JSON de una respuesta envuelta en prosa/Markdown, protección de rutas de handoff fuera del
// worktree, validación de evidencia previa, y el congelamiento semántico del diff (huella antes
// y después de despachar). Cambiar este archivo afecta a los dos orquestadores por igual.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalRole, validateHandoff, authoritativeGitState } from './agent-pipeline-policy.mjs';

export function usageText(binScript, npmScript, defaultHandoffFile) {
  return `Uso:
  npm run ${npmScript} -- --role <rol> --task-file <archivo> [opciones]

Opciones:
  --handoff-file <archivo>       Salida JSON (default: ${defaultHandoffFile})
  --timeout-ms <ms>              Tope de la ejecución (default: 1200000)
  --permission-mode <modo>       dontAsk (default), plan o acceptEdits
  --prior-handoff <rol=archivo>  Evidencia previa, repetible para el auditor
  --help                         Mostrar esta ayuda

El task file debe contener al menos: Tarea, Rama y Worktree. Para probador-e2e también
debe incluir URL exacta, puerto, HEAD/base, DB temporal, PID/sesión y sesión Playwright.`;
}

// `extraFlags` mapea flag → clave de salida para las opciones propias de cada orquestador
// (`--force-engine`, `--escalate`). Sin esto, un flag que el llamador parseaba por su cuenta
// después moría acá con "opción desconocida" antes de llegar a leerlo.
export function parseArgs(argv, { defaultHandoffFile, extraFlags = {} }) {
  const out = { timeoutMs: 1_200_000, permissionMode: 'dontAsk', handoffFile: defaultHandoffFile };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    if (arg === '--role') out.role = argv[++i];
    else if (arg === '--task-file') out.taskFile = argv[++i];
    else if (arg === '--handoff-file') out.handoffFile = argv[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--permission-mode') out.permissionMode = argv[++i];
    else if (arg === '--prior-handoff') (out.priorHandoffs ??= []).push(argv[++i]);
    else if (extraFlags[arg]) out[extraFlags[arg]] = argv[++i];
    else throw new Error(`opción desconocida: ${arg}`);
  }
  return out;
}

export function fail(message) {
  console.error(`Orquestación rechazada: ${message}`);
  process.exitCode = 2;
}

export function parseJsonText(text) {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // El agente puede envolver el JSON en una frase o en un bloque Markdown.
    }
  }
  throw new Error('la respuesta del agente no es el JSON de handoff requerido');
}

// Todos los archivos que el diff toca (commiteados, staged, sin stagear y sin trackear).
// -z es obligatorio, no cosmético: sin él git cita los paths no-ASCII (core.quotePath), así que
// `public/café.js` sale como `"public/caf\303\251.js"` y deja de matchear el prefijo. En un
// detector que decide si escalar a Opus, ese fallo escala DE MENOS — justo la dirección peligrosa.
export function changedFiles(worktree, base, head) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} falló`);
    return result.stdout.split('\0').filter(Boolean);
  };
  return [
    ...run(['diff', '-z', '--name-only', base, head]),
    ...run(['diff', '-z', '--name-only']),
    ...run(['diff', '-z', '--cached', '--name-only']),
    ...run(['ls-files', '-z', '--others', '--exclude-standard']),
  ];
}

export function requiresE2E(worktree, base, head) {
  return changedFiles(worktree, base, head).some((name) => name.startsWith('public/'));
}

// Labels de los triggers de riesgo que toca el diff. Alimenta la escalada automática de los
// gates (sonnet → opus): se dispara por paths y no por criterio del orquestador, para que no
// dependa de que alguien se acuerde. Un trigger sin `paths` (concurrencia) nunca dispara solo.
export function triggersTocados(worktree, base, head, triggers) {
  const files = changedFiles(worktree, base, head);
  return (triggers || [])
    .filter((trigger) => (trigger.paths || []).some((prefix) => files.some((file) => file.startsWith(prefix))))
    .map((trigger) => trigger.label);
}

export function outputOutsideWorktree(output, worktree) {
  const target = path.resolve(output); const worktreeRoot = fs.realpathSync(worktree);
  if (target === worktreeRoot || target.startsWith(`${worktreeRoot}${path.sep}`)) throw new Error('--handoff-file no puede estar dentro del worktree');
  const directory = path.dirname(target); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const realDirectory = fs.realpathSync(directory);
  if (realDirectory === worktreeRoot || realDirectory.startsWith(`${worktreeRoot}${path.sep}`)) throw new Error('--handoff-file resuelve dentro del worktree');
  return target;
}

export function priorEvidence(entries, worktree, state, required) {
  const evidence = {};
  for (const entry of entries || []) { const [rawRole, file] = entry.split('=', 2); const role = canonicalRole(rawRole); if (!role || !file || !fs.existsSync(file)) throw new Error('--prior-handoff requiere rol=archivo existente'); const handoff = JSON.parse(fs.readFileSync(file, 'utf8')); validateHandoff(handoff, role, { cwd: worktree }); if (handoff.estado !== 'APROBADO' || handoff.base !== state.base || handoff.head !== state.head || handoff.diff_fingerprint !== state.diff_fingerprint) throw new Error(`evidencia previa ${role} no coincide con el diff congelado`); evidence[role] = handoff.diff_fingerprint; }
  for (const role of required) if (evidence[role] !== state.diff_fingerprint) throw new Error(`falta --prior-handoff válido para ${role}`);
  return evidence;
}

// Addendas por rol. El prompt se paga en cada despacho, así que solo se agregan donde el reparto
// de motores crea un punto ciego que el contrato genérico no cubre.
const ROLE_ADDENDA = {
  // Los tests los escribe `tester` en Codex, el mismo proveedor que implementó: comparten modos
  // de falla, y un tester no detecta el bug que su propio proveedor acaba de introducir. El
  // cross-review real sobre los tests solo ocurre acá, en el revisor Opus.
  revisor: [
    'Auditá también los archivos de test del diff, no solo el código de producción.',
    'Por cada test agregado o modificado, decidí si realmente falla cuando se rompe el comportamiento que dice cubrir:',
    'un test que seguiría pasando con la implementación mutada no es cobertura, es decoración, y debe figurar como hallazgo.',
    'Precedente del repo: el bug del invariante de responsable en lib/guardiaMl.js rompió el 100% de las escrituras en producción con la suite en verde.',
  ].join(' '),
};

export function buildRolePrompt({ role, taskFile, gitState, orquestador }) {
  const addendum = ROLE_ADDENDA[role];
  return [
    `Sos el rol ${role} dentro de un despacho coordinado por ${orquestador}.`,
    `Leé el task file completo en ${taskFile} antes de actuar.`,
    'No redescubras contexto que ya esté en ese archivo.',
    'Respetá estrictamente el worktree, ownership y permisos indicados.',
    ...(addendum ? [addendum] : []),
    'Al finalizar devolvé únicamente un objeto JSON válido con las claves:',
    'devolvé estado, base, head y diff_fingerprint; completá el contrato de tu rol (veredicto/hallazgos, resultado_suite, evidencia/anchos_riesgos o referencias_evidencia).',
    `Valores autoritativos del worktree: base=${gitState.base}, head=${gitState.head}, diff_fingerprint=${gitState.diff_fingerprint}. Debés devolverlos exactamente; una huella distinta será rechazada.`,
    'No devuelvas Markdown, logs ni transcripciones.',
  ].join('\n');
}

// Congelamiento semántico del diff: compara la huella de entrada contra la de salida, decide si
// un gate de solo lectura mutó el worktree (error duro) o si un rol de escritura necesita
// REFRESH_REVIEW, fija base/head/diff_fingerprint autoritativos en el handoff y corre
// validateHandoff. No escribe el archivo ni agrega los campos de proveniencia
// (orquestador/rol/modelo/task_file/generado_en) — eso queda a cargo del llamador, porque difiere
// entre motores.
export function freezeAndVerify({ role, worktree, gitState, inputFingerprint, handoff, priorEvidenceMap, requiresE2E: needsE2E }) {
  const returnedFingerprint = handoff.diff_fingerprint;
  if ((handoff.base && handoff.base !== gitState.base) || (handoff.head && handoff.head !== gitState.head)) throw new Error('handoff Base/HEAD no coincide con el worktree congelado');
  if (['revisor', 'tester', 'probador-e2e', 'auditor-despliegue'].includes(role) && !returnedFingerprint) throw new Error('gate sin diff_fingerprint autoritativo');
  if (returnedFingerprint && returnedFingerprint !== gitState.diff_fingerprint) throw new Error('handoff diff_fingerprint no coincide con el worktree');
  if (role === 'auditor-despliegue') {
    if (handoff.referencias_evidencia && JSON.stringify(handoff.referencias_evidencia) !== JSON.stringify(priorEvidenceMap)) throw new Error('auditor no puede autodeclarar referencias de evidencia');
    handoff.referencias_evidencia = priorEvidenceMap; handoff.requiere_e2e = needsE2E;
  }
  const outputState = authoritativeGitState(worktree, { base: gitState.base });
  const readOnly = ['revisor', 'probador-e2e', 'auditor-despliegue'].includes(role);
  if (readOnly && outputState.diff_fingerprint !== inputFingerprint) throw new Error('gate de solo lectura mutó el worktree; diff requiere re-freeze');
  if (!readOnly && outputState.diff_fingerprint !== inputFingerprint) {
    handoff.estado = 'WAITING_FOR_ORCHESTRATOR';
    handoff.siguiente_accion = 'REFRESH_REVIEW';
  }
  handoff.base = outputState.base; handoff.head = outputState.head; handoff.diff_fingerprint = outputState.diff_fingerprint;
  // Alias legacy se conservan; no se inventan campos ausentes.
  validateHandoff(handoff, role, { cwd: worktree });
  return { handoff, outputState };
}

// Escribe el handoff ya finalizado y confirma que la escritura en sí no alteró el worktree
// (persistedState debe coincidir con outputState).
export function writeHandoffFile(handoffPath, handoff, worktree, outputState) {
  fs.writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
  const persistedState = authoritativeGitState(worktree, { base: outputState.base, head: outputState.head });
  if (persistedState.diff_fingerprint !== outputState.diff_fingerprint) throw new Error('escribir handoff alteró el worktree');
}
