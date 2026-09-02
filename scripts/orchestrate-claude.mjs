#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedRoles = new Set([
  'explorador',
  'hard-worker-backend',
  'hard-worker-frontend',
  'disenador-ux',
  'disenador-ui',
  'revisor',
  'tester',
  'probador-e2e',
  'auditor-despliegue',
]);
const requiredHandoffFields = [
  'estado',
  'tarea',
  'rama',
  'worktree',
  'pruebas',
  'hallazgos',
  'decisiones_codex',
  'siguiente_accion',
  'procesos_activos',
];
const validStates = new Set(['APROBADO', 'NO_APROBADO', 'BLOQUEADO', 'WAITING_FOR_ORCHESTRATOR']);

function usage() {
  console.log(`Uso:
  npm run agent:claude -- --role <rol> --task-file <archivo> [opciones]

Opciones:
  --handoff-file <archivo>       Salida JSON (default: /tmp/claude-to-codex-handoff.json)
  --timeout-ms <ms>              Tope de la ejecución (default: 1200000)
  --permission-mode <modo>       dontAsk (default), plan o acceptEdits
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
    else throw new Error(`opción desconocida: ${arg}`);
  }
  return out;
}

function field(text, label) {
  const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'));
  return match?.[1]?.trim() || '';
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

function validateHandoff(handoff, role) {
  const stateAliases = {
    aprobado: 'APROBADO',
    aprobado_ok: 'APROBADO',
    completado: 'APROBADO',
    completada: 'APROBADO',
    completado_con_hallazgo: 'NO_APROBADO',
    completado_con_hallazgos: 'NO_APROBADO',
    ok_con_hallazgo: 'NO_APROBADO',
    ok_con_hallazgos: 'NO_APROBADO',
    'completado con hallazgos': 'NO_APROBADO',
    no_aprobado: 'NO_APROBADO',
    'no aprobado': 'NO_APROBADO',
    rechazado: 'NO_APROBADO',
    bloqueado: 'BLOQUEADO',
    bloqueado_parcial: 'BLOQUEADO',
    'bloqueado parcial': 'BLOQUEADO',
    esperando: 'WAITING_FOR_ORCHESTRATOR',
  };
  if (typeof handoff.estado === 'string') {
    const normalizedState = handoff.estado.replace(/[^\p{L}_ ]/gu, '').trim().toLowerCase();
    handoff.estado = stateAliases[normalizedState] || handoff.estado;
  }
  const missing = requiredHandoffFields.filter((key) => handoff[key] === undefined || handoff[key] === '');
  if (missing.length) throw new Error(`handoff incompleto; faltan: ${missing.join(', ')}`);
  if (!validStates.has(handoff.estado)) throw new Error(`estado inválido: ${handoff.estado}`);
  if (handoff.estado === 'BLOQUEADO' && !handoff.codigo_bloqueo) {
    throw new Error('un BLOQUEADO debe incluir codigo_bloqueo');
  }
  if (role === 'probador-e2e' && handoff.estado !== 'BLOQUEADO' && !handoff.evidencia) {
    throw new Error('el handoff E2E aprobado o rechazado debe incluir evidencia');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!args.role || !allowedRoles.has(args.role)) return fail(`rol inválido o ausente: ${args.role || '(ausente)'}`);
  if (!args.taskFile || !fs.existsSync(args.taskFile)) return fail(`no existe --task-file: ${args.taskFile || '(ausente)'}`);
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000) return fail('--timeout-ms debe ser >= 10000');
  if (!['dontAsk', 'plan', 'acceptEdits'].includes(args.permissionMode)) return fail('--permission-mode inválido');

  const task = fs.readFileSync(args.taskFile, 'utf8');
  const worktree = field(task, 'Worktree');
  if (!worktree || !path.isAbsolute(worktree) || !fs.existsSync(worktree)) return fail('Worktree absoluto e inexistente');
  if (!field(task, 'Tarea') || !field(task, 'Rama')) return fail('el task file requiere Tarea y Rama');
  if (args.role === 'probador-e2e') {
    const missing = ['URL exacta', 'Puerto', 'HEAD/base', 'DB temporal', 'Sesión Playwright', 'PID/sesión del servidor']
      .filter((label) => !field(task, label));
    if (missing.length) return fail(`E2E sin entorno completo: faltan ${missing.join(', ')}`);
  }

  const model = readAgentModel(args.role, worktree);
  const tools = readAgentTools(args.role);
  validateWorktreeAgentConfig(args.role, model, worktree);
  const prompt = [
    `Sos el rol ${args.role} dentro de un despacho coordinado por Codex.`,
    `Leé el task file completo en ${args.taskFile} antes de actuar.`,
    'No redescubras contexto que ya esté en ese archivo.',
    'Respetá estrictamente el worktree, ownership y permisos indicados.',
    'Al finalizar devolvé únicamente un objeto JSON válido con las claves:',
    `${requiredHandoffFields.join(', ')}, codigo_bloqueo (si aplica), evidencia (si aplica).`,
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
  validateHandoff(handoff, args.role);
  handoff.orquestador = 'codex';
  handoff.rol = args.role;
  handoff.modelo = model;
  handoff.task_file = path.resolve(args.taskFile);
  handoff.generado_en = new Date().toISOString();
  fs.mkdirSync(path.dirname(path.resolve(args.handoffFile)), { recursive: true });
  fs.writeFileSync(args.handoffFile, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
  console.log(`Handoff válido escrito en ${args.handoffFile}`);
}

main().catch((error) => {
  console.error(`Orquestación fallida: ${error.message}`);
  process.exitCode = 1;
});
