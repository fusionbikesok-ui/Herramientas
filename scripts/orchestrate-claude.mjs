#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES as allowedRoles, canonicalRole, validateTask, validateHandoff, authoritativeGitState } from './agent-pipeline-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`Uso:
  npm run agent:claude -- --role <rol> --task-file <archivo> [opciones]

Opciones:
  --handoff-file <archivo>       Salida JSON (default: /tmp/claude-to-codex-handoff.json)
  --timeout-ms <ms>              Tope de la ejecución (default: 1200000)
  --permission-mode <modo>       dontAsk (default), plan o acceptEdits
  --prior-handoff <rol=archivo>  Evidencia previa, repetible para el auditor
  --help                         Mostrar esta ayuda

El task file debe contener al menos: Tarea, Rama y Worktree. Para probador-e2e también
debe incluir URL exacta, puerto, HEAD/base, DB temporal, PID/sesión y sesión Playwright.`);
}

function parseArgs(argv) {
  const out = { timeoutMs: 1_200_000, permissionMode: 'dontAsk', handoffFile: '/tmp/claude-to-codex-handoff.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    if (arg === '--role') out.role = argv[++i];
    else if (arg === '--task-file') out.taskFile = argv[++i];
    else if (arg === '--handoff-file') out.handoffFile = argv[++i];
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--permission-mode') out.permissionMode = argv[++i];
    else if (arg === '--prior-handoff') (out.priorHandoffs ??= []).push(argv[++i]);
    else throw new Error(`opción desconocida: ${arg}`);
  }
  return out;
}

function fail(message) {
  console.error(`Orquestación rechazada: ${message}`);
  process.exitCode = 2;
}

function readAgentModel(role, worktree) {
  const candidates = [
    path.join(root, '.claude', 'agents', `${role}.md`),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const model = fs.readFileSync(file, 'utf8').match(/^model:\s*(\S+)\s*$/m)?.[1];
    if (model) return model;
  }
  throw new Error(`no se pudo resolver el modelo de ${role}`);
}

function readAgentTools(role) {
  const file = path.join(root, '.claude', 'agents', `${role}.md`);
  if (!fs.existsSync(file)) throw new Error(`no se pudo resolver las herramientas de ${role}`);
  const tools = fs.readFileSync(file, 'utf8').match(/^tools:\s*(.+)$/m)?.[1]
    ?.split(',').map((tool) => tool.trim()).filter(Boolean);
  if (!tools?.length) throw new Error(`el agente ${role} no declara herramientas`);
  return tools;
}

function validateWorktreeAgentConfig(role, model, worktree) {
  const file = path.join(worktree, '.claude', 'agents', `${role}.md`);
  if (!fs.existsSync(file)) return;
  const actual = fs.readFileSync(file, 'utf8').match(/^model:\s*(\S+)\s*$/m)?.[1];
  if (actual && actual !== model) {
    throw new Error(`el worktree usa ${role}=${actual}, pero la configuración coordinadora exige ${model}; sincronizá el worktree antes de despachar`);
  }
}

function parseJsonText(text) {
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
      // Claude puede envolver el JSON en una frase o en un bloque Markdown.
    }
  }
  throw new Error('la respuesta de Claude no es el JSON de handoff requerido');
}

function parseClaudeResult(raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error('Claude no devolvió JSON válido');
  }
  if (envelope.is_error) throw new Error(envelope.result || 'Claude devolvió un error');
  const result = envelope.result ?? envelope;
  if (typeof result === 'object' && result !== null) return result;
  if (typeof result !== 'string') throw new Error('respuesta de Claude sin contenido estructurado');
  return parseJsonText(result);
}

function requiresE2E(worktree, base, head) {
  const run = (args) => { const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`git ${args.join(' ')} falló`); return result.stdout; };
  const names = `${run(['diff', '--name-only', base, head])}${run(['diff', '--name-only'])}${run(['diff', '--cached', '--name-only'])}${run(['ls-files', '--others', '--exclude-standard'])}`.split('\n');
  return names.some((name) => name.startsWith('public/'));
}

function outputOutsideWorktree(output, worktree) {
  const target = path.resolve(output); const root = fs.realpathSync(worktree);
  if (target === root || target.startsWith(`${root}${path.sep}`)) throw new Error('--handoff-file no puede estar dentro del worktree');
  const directory = path.dirname(target); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const realDirectory = fs.realpathSync(directory);
  if (realDirectory === root || realDirectory.startsWith(`${root}${path.sep}`)) throw new Error('--handoff-file resuelve dentro del worktree');
  return target;
}
function priorEvidence(entries, worktree, state, required) {
  const evidence = {};
  for (const entry of entries || []) { const [rawRole, file] = entry.split('=', 2); const role = canonicalRole(rawRole); if (!role || !file || !fs.existsSync(file)) throw new Error('--prior-handoff requiere rol=archivo existente'); const handoff = JSON.parse(fs.readFileSync(file, 'utf8')); validateHandoff(handoff, role, { cwd: worktree }); if (handoff.estado !== 'APROBADO' || handoff.base !== state.base || handoff.head !== state.head || handoff.diff_fingerprint !== state.diff_fingerprint) throw new Error(`evidencia previa ${role} no coincide con el diff congelado`); evidence[role] = handoff.diff_fingerprint; }
  for (const role of required) if (evidence[role] !== state.diff_fingerprint) throw new Error(`falta --prior-handoff válido para ${role}`);
  return evidence;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!args.role || !allowedRoles.has(args.role)) return fail(`rol inválido o ausente: ${args.role || '(ausente)'}`);
  if (!args.taskFile || !fs.existsSync(args.taskFile)) return fail(`no existe --task-file: ${args.taskFile || '(ausente)'}`);
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000) return fail('--timeout-ms debe ser >= 10000');
  if (!['dontAsk', 'plan', 'acceptEdits'].includes(args.permissionMode)) return fail('--permission-mode inválido');

  const task = fs.readFileSync(args.taskFile, 'utf8');
  let worktree; let taskRefs;
  try { ({ worktree, ...taskRefs } = validateTask(task, { e2e: args.role === 'probador-e2e', role: args.role })); } catch (error) { return fail(error.message); }
  if (!path.isAbsolute(worktree) || !fs.existsSync(worktree)) return fail('Worktree absoluto e inexistente');
  let handoffPath;
  try { handoffPath = outputOutsideWorktree(args.handoffFile, worktree); } catch (error) { return fail(error.message); }

  const gitState = authoritativeGitState(worktree, taskRefs);
  const inputFingerprint = gitState.diff_fingerprint;

  const model = readAgentModel(args.role, worktree);
  const tools = readAgentTools(args.role);
  validateWorktreeAgentConfig(args.role, model, worktree);
  if (args.role === 'auditor-despliegue') {
    const needsE2E = requiresE2E(worktree, gitState.base, gitState.head);
    args.priorEvidence = priorEvidence(args.priorHandoffs, worktree, gitState, ['revisor', 'tester', ...(needsE2E ? ['probador-e2e'] : [])]);
    args.requiresE2E = needsE2E;
  }
  const prompt = [
    `Sos el rol ${args.role} dentro de un despacho coordinado por Codex.`,
    `Leé el task file completo en ${args.taskFile} antes de actuar.`,
    'No redescubras contexto que ya esté en ese archivo.',
    'Respetá estrictamente el worktree, ownership y permisos indicados.',
    'Al finalizar devolvé únicamente un objeto JSON válido con las claves:',
    'devolvé estado, base, head y diff_fingerprint; completá el contrato de tu rol (veredicto/hallazgos, resultado_suite, evidencia/anchos_riesgos o referencias_evidencia).',
    `Valores autoritativos del worktree: base=${gitState.base}, head=${gitState.head}, diff_fingerprint=${gitState.diff_fingerprint}. Debés devolverlos exactamente; una huella distinta será rechazada.`,
    'No devuelvas Markdown, logs ni transcripciones.',
  ].join('\n');

  const child = spawn('claude', [
    '-p', prompt,
    '--agent', args.role,
    '--model', model,
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', args.permissionMode,
    '--allowedTools', ...tools,
    '--add-dir', root,
    '--add-dir', worktree,
  ], { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const timeout = setTimeout(() => child.kill('SIGTERM'), args.timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);

  if (exitCode.code !== 0) {
    const detail = stderr.trim().split('\n').slice(-5).join('\n');
    throw new Error(`Claude terminó con código ${exitCode.code ?? 'nulo'}${exitCode.signal ? ` (${exitCode.signal})` : ''}${detail ? `: ${detail}` : ''}`);
  }

  const handoff = parseClaudeResult(stdout);
  // Aprobaciones y evidencia quedan ligadas al diff congelado servido al agente.
  const returnedFingerprint = handoff.diff_fingerprint;
  if ((handoff.base && handoff.base !== gitState.base) || (handoff.head && handoff.head !== gitState.head)) throw new Error('handoff Base/HEAD no coincide con el worktree congelado');
  if (['revisor', 'tester', 'probador-e2e', 'auditor-despliegue'].includes(args.role) && !returnedFingerprint) throw new Error('gate sin diff_fingerprint autoritativo');
  if (returnedFingerprint && returnedFingerprint !== gitState.diff_fingerprint) throw new Error('handoff diff_fingerprint no coincide con el worktree');
  if (args.role === 'auditor-despliegue') {
    if (handoff.referencias_evidencia && JSON.stringify(handoff.referencias_evidencia) !== JSON.stringify(args.priorEvidence)) throw new Error('auditor no puede autodeclarar referencias de evidencia');
    handoff.referencias_evidencia = args.priorEvidence; handoff.requiere_e2e = args.requiresE2E;
  }
  const outputState = authoritativeGitState(worktree, { base: gitState.base });
  const readOnly = ['revisor', 'probador-e2e', 'auditor-despliegue'].includes(args.role);
  if (readOnly && outputState.diff_fingerprint !== inputFingerprint) throw new Error('gate de solo lectura mutó el worktree; diff requiere re-freeze');
  if (!readOnly && outputState.diff_fingerprint !== inputFingerprint) {
    handoff.estado = 'WAITING_FOR_ORCHESTRATOR';
    handoff.siguiente_accion = 'REFRESH_REVIEW';
  }
  handoff.base = outputState.base; handoff.head = outputState.head; handoff.diff_fingerprint = outputState.diff_fingerprint;
  // Alias legacy se conservan; no se inventan campos ausentes.
  validateHandoff(handoff, args.role, { cwd: worktree });
  handoff.orquestador = 'codex';
  handoff.rol = args.role;
  handoff.modelo = model;
  handoff.task_file = path.resolve(args.taskFile);
  handoff.generado_en = new Date().toISOString();
  fs.writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
  const persistedState = authoritativeGitState(worktree, { base: outputState.base, head: outputState.head });
  if (persistedState.diff_fingerprint !== outputState.diff_fingerprint) throw new Error('escribir handoff alteró el worktree');
  console.log(`Handoff válido escrito en ${handoffPath}`);
}

main().catch((error) => {
  console.error(`Orquestación fallida: ${error.message}`);
  process.exitCode = 1;
});
