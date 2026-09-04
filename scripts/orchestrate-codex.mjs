#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES as allowedRoles, validateTask, authoritativeGitState } from './agent-pipeline-policy.mjs';
import { resolveRouting } from './agent-routing.mjs';
import {
  usageText, parseArgs as parseArgsCommon, fail, parseJsonText, requiresE2E,
  outputOutsideWorktree, priorEvidence, buildRolePrompt, freezeAndVerify, writeHandoffFile,
} from './agent-dispatch-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HANDOFF_FILE = '/tmp/codex-to-claude-handoff.json';
const DEFAULT_TASK_DIR = '/tmp';

function usage() {
  console.log(usageText('orchestrate-codex.mjs', 'agent:codex', DEFAULT_HANDOFF_FILE));
}

function parseArgs(argv) {
  // --escalate: escalera de riesgo. 0 = fila base, 1 = sol/high, 2 = lo escribe Opus (cambia de
  // motor, así que este orquestador lo rechaza y redirige a agent:claude). Ver agents/routing.json.
  const out = parseArgsCommon(argv, {
    defaultHandoffFile: DEFAULT_HANDOFF_FILE,
    extraFlags: { '--force-engine': 'forceEngine', '--escalate': 'escalate' },
  });
  if (!out.help && out.escalate !== undefined) out.escalate = Number.parseInt(out.escalate, 10);
  return out;
}

function readSchemaFile(role) {
  const file = path.join(root, 'scripts', 'schemas', `handoff-${role}.json`);
  return fs.existsSync(file) ? file : null;
}

function parseCodexResult(lastMessageFile) {
  if (!fs.existsSync(lastMessageFile)) throw new Error('Codex no escribió --output-last-message');
  const raw = fs.readFileSync(lastMessageFile, 'utf8');
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Sin --output-schema (o si el modelo no lo respetó), cae al parseo tolerante.
  }
  return parseJsonText(raw);
}

// Defensa en profundidad: aunque -s workspace-write ya está confirmado que no puede escribir
// fuera de -C <worktree> cuando no se amplía el acceso de escritura del sandbox, este
// orquestador nunca debe siquiera intentar apuntar un sandbox de escritura contra el repo de
// producción.
function assertNotProductionRoot(worktree, sandbox) {
  const worktreeReal = fs.realpathSync(worktree);
  const rootReal = fs.realpathSync(root);
  if (worktreeReal === rootReal && sandbox !== 'read-only') {
    throw new Error('rechazado: el worktree coincide con el repo de producción y el sandbox no es read-only');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!args.role || !allowedRoles.has(args.role)) return fail(`rol inválido o ausente: ${args.role || '(ausente)'}`);
  if (!args.taskFile || !fs.existsSync(args.taskFile)) return fail(`no existe --task-file: ${args.taskFile || '(ausente)'}`);
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000) return fail('--timeout-ms debe ser >= 10000');
  if (!['dontAsk', 'plan', 'acceptEdits'].includes(args.permissionMode)) return fail('--permission-mode inválido');

  if (args.escalate !== undefined && (!Number.isInteger(args.escalate) || args.escalate < 0)) return fail('--escalate debe ser un entero >= 0');
  let routing;
  try { routing = resolveRouting(args.role, { escalate: args.escalate || 0 }); } catch (error) { return fail(error.message); }
  if (routing.engine !== 'codex') {
    if (args.forceEngine !== 'codex') return fail(`el rol ${args.role} no está ruteado a Codex (motor: ${routing.engine}${routing.escalated ? `, por --escalate ${args.escalate}` : ''}); usá npm run agent:claude o pasá --force-engine codex para forzarlo (queda registrado en el handoff)`);
    // El rol vive en Claude por diseño (revisor, auditor-despliegue, probador-e2e) pero se
    // fuerza a Codex explícitamente. No hay modelo/sandbox por defecto para ese rol en Codex —
    // usar el escalón medio como piso razonable y dejar constancia en el handoff.
    routing = { engine: 'codex', model: 'gpt-5.6-terra', effort: 'medium', sandbox: routing.sandbox || 'read-only', forzado: true };
  }

  const task = fs.readFileSync(args.taskFile, 'utf8');
  let worktree; let taskRefs;
  try { ({ worktree, ...taskRefs } = validateTask(task, { e2e: args.role === 'probador-e2e', role: args.role })); } catch (error) { return fail(error.message); }
  if (!path.isAbsolute(worktree) || !fs.existsSync(worktree)) return fail('Worktree absoluto e inexistente');
  let handoffPath;
  try { handoffPath = outputOutsideWorktree(args.handoffFile, worktree); } catch (error) { return fail(error.message); }

  try { assertNotProductionRoot(worktree, routing.sandbox || 'workspace-write'); } catch (error) { return fail(error.message); }

  const gitState = authoritativeGitState(worktree, taskRefs);
  const inputFingerprint = gitState.diff_fingerprint;

  let priorEvidenceMap; let needsE2E;
  if (args.role === 'auditor-despliegue') {
    needsE2E = requiresE2E(worktree, gitState.base, gitState.head);
    priorEvidenceMap = priorEvidence(args.priorHandoffs, worktree, gitState, ['revisor', 'tester', ...(needsE2E ? ['probador-e2e'] : [])]);
  }
  const prompt = buildRolePrompt({ role: args.role, taskFile: args.taskFile, gitState, orquestador: 'Claude' });

  const lastMessageFile = outputOutsideWorktree(path.join(DEFAULT_TASK_DIR, `codex-last-message-${process.pid}.json`), worktree);
  const schemaFile = readSchemaFile(args.role);

  const codexArgs = [
    'exec',
    '-m', routing.model,
    '-c', `model_reasoning_effort=${routing.effort || 'low'}`,
    '-s', routing.sandbox || 'workspace-write',
    '-C', worktree,
    '-o', lastMessageFile,
  ];
  if (schemaFile) codexArgs.push('--output-schema', schemaFile);
  codexArgs.push(prompt);

  const child = spawn('codex', codexArgs, {
    cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let killed = false;
  const timeout = setTimeout(() => {
    killed = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* el proceso ya pudo haber terminado */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* idem */ } }, 10_000);
  }, args.timeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);

  if (exitCode.code !== 0) {
    const detail = stderr.trim().split('\n').slice(-5).join('\n');
    const timeoutNote = killed ? ' (timeout)' : '';
    throw new Error(`Codex terminó con código ${exitCode.code ?? 'nulo'}${exitCode.signal ? ` (${exitCode.signal})` : ''}${timeoutNote}${detail ? `: ${detail}` : ''}`);
  }

  const handoff = parseCodexResult(lastMessageFile);
  fs.rmSync(lastMessageFile, { force: true });
  const { handoff: finalHandoff, outputState } = freezeAndVerify({
    role: args.role, worktree, gitState, inputFingerprint, handoff, priorEvidenceMap, requiresE2E: needsE2E,
  });
  finalHandoff.orquestador = 'claude';
  finalHandoff.motor = 'codex';
  finalHandoff.rol = args.role;
  finalHandoff.modelo = routing.model;
  finalHandoff.esfuerzo = routing.effort || 'low';
  if (routing.forzado) finalHandoff.motor_forzado = true;
  finalHandoff.task_file = path.resolve(args.taskFile);
  finalHandoff.generado_en = new Date().toISOString();
  writeHandoffFile(handoffPath, finalHandoff, worktree, outputState);
  console.log(`Handoff válido escrito en ${handoffPath}`);
}

main().catch((error) => {
  console.error(`Orquestación fallida: ${error.message}`);
  process.exitCode = 1;
});
