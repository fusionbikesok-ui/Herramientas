import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROLES = new Set(['explorador','disenador-ux','disenador-ui','hard-worker-backend','hard-worker-frontend','revisor','tester','probador-e2e','auditor-despliegue']);
const aliases = { veredicto: 'veredicto', resultado_suite: 'resultado_suite', pruebas: 'resultado_suite', evidencia: 'evidencia', referencias: 'referencias_evidencia' };
export function taskField(text, key) { const m = text.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}:\\s*(.+)$`, 'mi')); return m?.[1]?.trim() || ''; }
function git(cwd, args) { const r=spawnSync('git',args,{cwd,encoding:'utf8'}); if(r.status!==0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`); return r.stdout; }
function frame(h, v) { const b=Buffer.isBuffer(v)?v:Buffer.from(String(v)); h.update(Buffer.from(`${b.length}:`)); h.update(b); h.update(Buffer.from('\n')); }
export function canonicalFingerprint(input) { const h=crypto.createHash('sha256'); for(const k of ['base','head','staged','unstaged','untracked']) { frame(h,k); frame(h,input[k] ?? ''); } return h.digest('hex'); }
export function authoritativeGitState(cwd, refs={}) {
  const base=refs.base || git(cwd,['rev-parse','--verify','HEAD^']).trim();
  const head=refs.head || git(cwd,['rev-parse','--verify','HEAD']).trim();
  const b=git(cwd,['rev-parse','--verify',`${base}^{commit}`]).trim(); const hd=git(cwd,['rev-parse','--verify',`${head}^{commit}`]).trim();
  if(git(cwd,['merge-base','--is-ancestor',b,hd]) === undefined) {} // spawnSync throws on non-ancestor
  const staged=git(cwd,['diff','--cached','--binary','--no-ext-diff','--']).trimEnd();
  const unstaged=git(cwd,['diff','--binary','--no-ext-diff','--']).trimEnd();
  const names=git(cwd,['ls-files','--others','--exclude-standard','-z']); let untracked=Buffer.alloc(0);
  for(const n of names.split('\0').filter(Boolean).sort()) { const file=path.join(cwd,n); untracked=Buffer.concat([untracked,Buffer.from(n),Buffer.from('\0'),fs.readFileSync(file)]); }
  return { base:b, head:hd, staged, unstaged, untracked, diff_fingerprint:canonicalFingerprint({base:b,head:hd,staged,unstaged,untracked}) };
}
export function validateTask(text,{e2e=false}={}) { for(const k of ['Tarea','Rama','Worktree']) if(!taskField(text,k)) throw new Error(`task sin ${k}`); const worktree=taskField(text,'Worktree'); if(e2e) for(const k of ['URL exacta','Puerto','HEAD/base','DB temporal','PID/sesión']) if(!taskField(text,k)) throw new Error(`task E2E sin ${k}`); return {worktree}; }
export function validateHandoff(h, role) {
  for (const [legacy, canonical] of Object.entries(aliases)) if (h?.[legacy] !== undefined && h[canonical] === undefined) h[canonical] = h[legacy];
  if(!ROLES.has(role)) throw new Error(`rol inválido: ${role}`); if(!h || !['APROBADO','BLOQUEADO','WAITING_FOR_ORCHESTRATOR'].includes(h.estado)) throw new Error('estado inválido');
  if(!/^[0-9a-f]{64}$/i.test(h.diff_fingerprint||'')) throw new Error('diff_fingerprint SHA-256 requerido'); if(!h.base||!h.head) throw new Error('base/head requeridos');
  if(role==='revisor' && !h.veredicto) throw new Error('veredicto requerido'); if(role==='tester' && !h.resultado_suite) throw new Error('resultado_suite requerido');
  if(role==='probador-e2e' && !h.evidencia) throw new Error('evidencia requerida'); if(role==='auditor-despliegue' && !h.referencias_evidencia) throw new Error('referencias_evidencia requerida');
  return h;
}
