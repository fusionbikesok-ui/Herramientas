import { describe, expect, it } from 'vitest';
import { canonicalFingerprint, validateHandoff } from '../scripts/agent-pipeline-policy.mjs';

const core = { estado: 'APROBADO', base: 'a', head: 'b', diff_fingerprint: 'a'.repeat(64) };
describe('política de pipeline', () => {
  it('distingue bytes staged, unstaged y untracked, incluso binarios', () => {
    const a = canonicalFingerprint({ base:'a', head:'b', staged:Buffer.from([0,1]), unstaged:'x', untracked:Buffer.from([255]) });
    expect(a).not.toBe(canonicalFingerprint({ base:'a', head:'b', staged:Buffer.from([0,2]), unstaged:'x', untracked:Buffer.from([255]) }));
    expect(a).not.toBe(canonicalFingerprint({ base:'a', head:'b', staged:Buffer.from([0,1]), unstaged:'x', untracked:Buffer.from([254]) }));
  });
  it('acepta aliases legacy y exige contrato de cada gate', () => {
    expect(() => validateHandoff({...core, pruebas:'verde'}, 'tester')).not.toThrow();
    expect(() => validateHandoff({...core, veredicto:'OK'}, 'revisor')).not.toThrow();
    expect(() => validateHandoff({...core, evidencia:{fingerprint:core.diff_fingerprint}}, 'probador-e2e')).not.toThrow();
    expect(() => validateHandoff({...core, referencias_evidencia:{revisor:core.diff_fingerprint}}, 'auditor-despliegue')).not.toThrow();
    expect(() => validateHandoff({...core}, 'tester')).toThrow();
  });
});
