import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROLES = new Set(['explorador', 'disenador-ux', 'disenador-ui', 'hard-worker-backend', 'hard-worker-frontend', 'revisor', 'tester', 'probador-e2e', 'auditor-despliegue']);
const roleAliases = { reviewer: 'revisor', review: 'revisor', qa: 'tester', e2e: 'probador-e2e', auditor: 'auditor-despliegue', 'deploy-auditor': 'auditor-despliegue', backend: 'hard-worker-backend', frontend: 'hard-worker-frontend' };
const fieldAliases = {
  estado: ['Estado', 'status', 'state'], base: ['Base', 'commit_base', 'base_commit'], head: ['HEAD', 'commit_head', 'head_commit'],
  diff_fingerprint: ['fingerprint', 'diffFingerprint', 'huella_diff'], codigo_bloqueo: ['codigoBloqueo', 'bloqueo_codigo'], siguiente_accion: ['siguienteAccion', 'next_action'], veredicto: ['dictamen', 'review_verdict'], hallazgos: ['findings'], resultado_suite: ['pruebas', 'resultado', 'resultado_pruebas', 'test_result'], evidencia: ['evidencia_e2e', 'e2e_evidence'], anchos_riesgos: ['anchosRiesgos', 'widths_risks'], referencias_evidencia: ['referencias', 'evidence_refs', 'evidencias'], requiere_e2e: ['requiereE2E', 'ui_tocada'],
};
const stateAliases = { APPROVED: 'APROBADO', OK: 'APROBADO', APROBADA: 'APROBADO', BLOCKED: 'BLOQUEADO', WAITING: 'WAITING_FOR_ORCHESTRATOR', PENDIENTE_ORQUESTADOR: 'WAITING_FOR_ORCHESTRATOR' };

export function canonicalRole(role) { return roleAliases[String(role || '').toLowerCase()] || String(role || '').toLowerCase(); }
export function taskField(text, key) { const m = text.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`, 'mi')); return m?.[1]?.trim() || ''; }
function git(cwd, args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`); return result.stdout; }
function frame(hash, value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); hash.update(Buffer.from(`${bytes.length}:`)); hash.update(bytes); hash.update(Buffer.from('\n')); }
export function canonicalFingerprint(input) { const hash = crypto.createHash('sha256'); for (const key of ['base', 'head', 'staged', 'unstaged', 'untracked']) { frame(hash, key); frame(hash, input[key] ?? ''); } return hash.digest('hex'); }
export function authoritativeGitState(cwd, refs = {}) {
  const requestedBase = refs.base || git(cwd, ['rev-parse', '--verify', 'HEAD^']).trim(); const requestedHead = refs.head || git(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
  const base = git(cwd, ['rev-parse', '--verify', `${requestedBase}^{commit}`]).trim(); const head = git(cwd, ['rev-parse', '--verify', `${requestedHead}^{commit}`]).trim(); git(cwd, ['merge-base', '--is-ancestor', base, head]);
  const staged = Buffer.from(git(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--']), 'utf8'); const unstaged = Buffer.from(git(cwd, ['diff', '--binary', '--no-ext-diff', '--']), 'utf8');
  const names = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort(); const untracked = Buffer.concat(names.flatMap((name) => [Buffer.from(name), Buffer.from('\0'), fs.readFileSync(path.join(cwd, name)), Buffer.from('\0')]));
  return { base, head, staged, unstaged, untracked, diff_fingerprint: canonicalFingerprint({ base, head, staged, unstaged, untracked }) };
}
function taskRefs(text) { const legacy = taskField(text, 'HEAD/base').split(' / ').map((value) => value.trim()); return { base: taskField(text, 'Base') || legacy[0], head: taskField(text, 'HEAD') || legacy[1] }; }
export function validateTask(text, { e2e = false, role } = {}) {
  for (const key of ['Tarea', 'Rama', 'Worktree']) if (!taskField(text, key)) throw new Error(`task sin ${key}`);
  if (role && taskField(text, 'Rol') && canonicalRole(taskField(text, 'Rol')) !== canonicalRole(role)) throw new Error('task asignado a otro rol');
  const refs = taskRefs(text); if ((refs.base && !refs.head) || (!refs.base && refs.head)) throw new Error('task con Base/HEAD incompletos');
  if (e2e) for (const key of ['URL exacta', 'Puerto', 'DB temporal', 'PID/sesión']) if (!taskField(text, key)) throw new Error(`task E2E sin ${key}`);
  if (e2e && (!refs.base || !refs.head)) throw new Error('task E2E sin Base/HEAD'); return { worktree: taskField(text, 'Worktree'), ...refs };
}
export function normalizeHandoff(handoff) { if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) throw new Error('handoff debe ser objeto'); for (const [canonical, aliases] of Object.entries(fieldAliases)) for (const alias of aliases) if (handoff[canonical] === undefined && handoff[alias] !== undefined) handoff[canonical] = handoff[alias]; handoff.estado = stateAliases[String(handoff.estado || '').toUpperCase()] || String(handoff.estado || '').toUpperCase(); return handoff; }
export function validateHandoff(handoff, role, { cwd } = {}) {
  const h = normalizeHandoff(handoff); const canonical = canonicalRole(role); if (!ROLES.has(canonical)) throw new Error(`rol inválido: ${role}`); if (!['APROBADO', 'BLOQUEADO', 'WAITING_FOR_ORCHESTRATOR'].includes(h.estado)) throw new Error('estado inválido'); if (!/^[0-9a-f]{64}$/i.test(h.diff_fingerprint || '')) throw new Error('diff_fingerprint SHA-256 requerido'); if (!h.base || !h.head) throw new Error('base/head requeridos');
  if (cwd) { const state = authoritativeGitState(cwd, { base: h.base, head: h.head }); if (state.base !== h.base || state.head !== h.head) throw new Error('base/head no canónicos'); }
  if (h.estado === 'BLOQUEADO' && (!h.codigo_bloqueo || !h.siguiente_accion)) throw new Error('bloqueado requiere codigo_bloqueo y siguiente_accion'); if (h.estado === 'WAITING_FOR_ORCHESTRATOR' && !h.siguiente_accion) throw new Error('waiting requiere siguiente_accion'); if (h.estado !== 'APROBADO') return h;
  if (canonical === 'revisor' && (!h.veredicto || !Array.isArray(h.hallazgos))) throw new Error('revisor requiere veredicto y hallazgos'); if (canonical === 'tester' && !h.resultado_suite) throw new Error('tester requiere resultado_suite'); if (canonical === 'probador-e2e' && (!h.evidencia || !Array.isArray(h.anchos_riesgos))) throw new Error('E2E requiere evidencia y anchos_riesgos');
  if (canonical === 'auditor-despliegue') { if (!h.referencias_evidencia || Array.isArray(h.referencias_evidencia) || typeof h.referencias_evidencia !== 'object') throw new Error('auditor requiere referencias_evidencia por rol'); const required = ['revisor', 'tester']; if (h.requiere_e2e === true) required.push('probador-e2e'); for (const gate of required) if (h.referencias_evidencia[gate] !== h.diff_fingerprint) throw new Error(`auditor sin referencia ${gate} de la misma huella`); }
  return h;
}
