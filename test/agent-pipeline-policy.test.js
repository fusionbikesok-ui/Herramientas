import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { authoritativeGitState, canonicalFingerprint, canonicalRole, validateHandoff, validateTask } from '../scripts/agent-pipeline-policy.mjs';

const fp = 'a'.repeat(64);
const core = { estado: 'APROBADO', base: 'a', head: 'b', diff_fingerprint: fp };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-policy-'));
const runGit = (...args) => execFileSync('git', args, { cwd: temp, encoding: 'utf8' }).trim();
runGit('init'); runGit('config', 'user.email', 'test@fusion.local'); runGit('config', 'user.name', 'Policy test'); fs.writeFileSync(path.join(temp, 'tracked.txt'), 'base\n'); runGit('add', '.'); runGit('commit', '-m', 'base'); const base = runGit('rev-parse', 'HEAD'); fs.writeFileSync(path.join(temp, 'tracked.txt'), 'head\n'); runGit('commit', '-am', 'head'); const head = runGit('rev-parse', 'HEAD');
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('política de pipeline', () => {
  it('distingue staged binario', () => expect(canonicalFingerprint({ base: 'a', head: 'b', staged: Buffer.from([0, 1]) })).not.toBe(canonicalFingerprint({ base: 'a', head: 'b', staged: Buffer.from([0, 2]) })));
  it('distingue unstaged binario', () => expect(canonicalFingerprint({ base: 'a', head: 'b', unstaged: Buffer.from([255]) })).not.toBe(canonicalFingerprint({ base: 'a', head: 'b', unstaged: Buffer.from([254]) })));
  it('distingue untracked binario', () => expect(canonicalFingerprint({ base: 'a', head: 'b', untracked: Buffer.from([0, 255]) })).not.toBe(canonicalFingerprint({ base: 'a', head: 'b', untracked: Buffer.from([0, 254]) })));
  it('captura staged, unstaged y untracked reales', () => { fs.writeFileSync(path.join(temp, 'tracked.txt'), 'unstaged\n'); fs.writeFileSync(path.join(temp, 'staged.bin'), Buffer.from([0, 255])); runGit('add', 'staged.bin'); fs.writeFileSync(path.join(temp, 'new.bin'), Buffer.from([1, 254])); const state = authoritativeGitState(temp, { base, head }); expect(state.staged.length).toBeGreaterThan(0); expect(state.unstaged.length).toBeGreaterThan(0); expect(state.untracked.length).toBeGreaterThan(0); });
  it('resuelve Base y HEAD a commits canónicos', () => { const state = authoritativeGitState(temp, { base, head }); expect(state.base).toBe(base); expect(state.head).toBe(head); });
  it('rechaza Base que no es ancestro de HEAD', () => expect(() => authoritativeGitState(temp, { base: head, head: base })).toThrow());
  it('acepta alias legacy de rol y campos tester', () => { const handoff = { ...core, status: 'approved', pruebas: 'OK' }; expect(validateHandoff(handoff, 'qa').resultado_suite).toBe('OK'); });
  it('normaliza alias legacy de bloqueo', () => expect(validateHandoff({ ...core, estado: undefined, state: 'blocked', codigoBloqueo: 'FALTA_ENTORNO', next_action: 'CONFIGURAR' }, 'backend').estado).toBe('BLOQUEADO'));
  it('exige detalle de bloqueo', () => expect(() => validateHandoff({ ...core, estado: 'BLOQUEADO' }, 'tester')).toThrow('codigo_bloqueo'));
  it('exige siguiente acción para waiting', () => expect(() => validateHandoff({ ...core, estado: 'WAITING_FOR_ORCHESTRATOR' }, 'tester')).toThrow('siguiente_accion'));
  it('exige contrato completo para revisor aprobado', () => expect(() => validateHandoff({ ...core, veredicto: 'OK' }, 'revisor')).toThrow('hallazgos'));
  it('exige contrato completo para E2E aprobado', () => expect(() => validateHandoff({ ...core, evidencia: {} }, 'e2e')).toThrow('anchos_riesgos'));
  it('requiere referencias del auditor por rol y misma huella', () => expect(() => validateHandoff({ ...core, referencias: { revisor: fp, tester: 'b'.repeat(64) } }, 'auditor')).toThrow('tester'));
  it('requiere E2E en auditor solo si la UI lo exige', () => { expect(() => validateHandoff({ ...core, requiereE2E: true, referencias: { revisor: fp, tester: fp } }, 'auditor')).toThrow('probador-e2e'); expect(() => validateHandoff({ ...core, requiere_e2e: true, referencias: { revisor: fp, tester: fp, 'probador-e2e': fp } }, 'auditor')).not.toThrow(); });
  it('rechaza task E2E incompleta', () => expect(() => validateTask(`Tarea: probar\nRama: x\nWorktree: ${temp}`, { e2e: true, role: 'e2e' })).toThrow('URL exacta'));
  it('valida task E2E con Base y HEAD coherentes', () => expect(validateTask(`Tarea: probar\nRol: e2e\nRama: x\nWorktree: ${temp}\nBase: ${base}\nHEAD: ${head}\nURL exacta: http://127.0.0.1:3199/login/\nPuerto: 3199\nDB temporal: /tmp/db\nPID/sesión: 12`, { e2e: true, role: 'probador-e2e' }).base).toBe(base));
  it('mapea los aliases de rol completos usados por CLI', () => { expect(canonicalRole('reviewer')).toBe('revisor'); expect(canonicalRole('deploy-auditor')).toBe('auditor-despliegue'); });
});
