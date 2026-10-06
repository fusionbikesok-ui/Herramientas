#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES as allowedRoles, validateTask, authoritativeGitState } from './agent-pipeline-policy.mjs';
import {
  usageText, parseArgs as parseArgsCommon, fail, parseJsonText, requiresE2E, triggersTocados,
  outputOutsideWorktree, priorEvidence, buildRolePrompt, freezeAndVerify, writeHandoffFile,
} from './agent-dispatch-common.mjs';
import { resolveRouting, escalationTriggers } from './agent-routing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HANDOFF_FILE = '/tmp/claude-to-codex-handoff.json';

function usage() {
  console.log(usageText('orchestrate-claude.mjs', 'agent:claude', DEFAULT_HANDOFF_FILE));
}

function parseArgs(argv) {
  // --escalate fuerza la subida del gate a Opus aunque el diff no toque ningún trigger (p. ej.
  // concurrencia, que no se detecta por path). La subida automática por triggers no lo necesita.
  const out = parseArgsCommon(argv, {
    defaultHandoffFile: DEFAULT_HANDOFF_FILE,
    extraFlags: { '--escalate': 'escalate' },
  });
  if (!out.help && out.escalate !== undefined) out.escalate = Number.parseInt(out.escalate, 10);
  return out;
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

  // El frontmatter es la FILA BASE y se valida contra el worktree como siempre (que ambos
  // declaren lo mismo sigue siendo la garantía de que el worktree está sincronizado). Recién
  // después la escalera puede subir el modelo para este despacho puntual.
  const baseModel = readAgentModel(args.role, worktree);
  const tools = readAgentTools(args.role);
  validateWorktreeAgentConfig(args.role, baseModel, worktree);

  let triggersHit = [];
  try {
    triggersHit = triggersTocados(worktree, gitState.base, gitState.head, escalationTriggers());
  } catch (error) { return fail(`no se pudo evaluar los triggers de riesgo: ${error.message}`); }
  let routing;
  try { routing = resolveRouting(args.role, { escalate: args.escalate || 0, triggersHit }); } catch (error) { return fail(error.message); }
  const model = routing.model || baseModel;
  if (routing.escalated) console.error(`[routing] ${args.role}: ${baseModel} → ${model} (${routing.motivo_escalada})`);

  let priorEvidenceMap; let needsE2E;
  if (args.role === 'auditor-despliegue') {
    needsE2E = requiresE2E(worktree, gitState.base, gitState.head);
    priorEvidenceMap = priorEvidence(args.priorHandoffs, worktree, gitState, ['revisor', 'tester', ...(needsE2E ? ['probador-e2e'] : [])]);
  }
  const prompt = buildRolePrompt({ role: args.role, taskFile: args.taskFile, gitState, orquestador: 'Claude' });

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
  const { handoff: finalHandoff, outputState } = freezeAndVerify({
    role: args.role, worktree, gitState, inputFingerprint, handoff, priorEvidenceMap, requiresE2E: needsE2E,
  });
  finalHandoff.orquestador = 'claude'; // Pipeline invertido: la sesión Claude Opus orquesta siempre, corra el rol donde corra.
  finalHandoff.rol = args.role;
  finalHandoff.modelo = model;
  finalHandoff.task_file = path.resolve(args.taskFile);
  finalHandoff.generado_en = new Date().toISOString();
  writeHandoffFile(handoffPath, finalHandoff, worktree, outputState);
  console.log(`Handoff válido escrito en ${handoffPath}`);
}

main().catch((error) => {
  console.error(`Orquestación fallida: ${error.message}`);
  process.exitCode = 1;
});
