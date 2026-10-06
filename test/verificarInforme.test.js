import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const correr = (args) => {
  try { return { salida: execFileSync('node', ['scripts/verificar-informe.mjs', ...args], { encoding: 'utf8' }), codigo: 0 }; }
  catch (e) { return { salida: `${e.stdout ?? ''}${e.stderr ?? ''}`, codigo: e.status }; }
};

describe('verificar-informe', () => {
  let dir; let pub; const par = generateKeyPairSync('ed25519');
  // El script no puede compartir el firmador con el test: la firma se arma acá a mano sobre el JSON canónico
  // escrito literalmente, así un error en la serialización del script no se compensa con el mismo error.
  const contenido = { tipo: 'reporte', fecha: '2026-09-16' };
  const firma = sign(null, Buffer.from('{"fecha":"2026-09-16","tipo":"reporte"}', 'utf8'), par.privateKey).toString('base64');
  const escribir = (nombre, sobre) => { const r = join(dir, nombre); writeFileSync(r, JSON.stringify(sobre)); return r; };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ver-'));
    pub = join(dir, 'k1.pub');
    writeFileSync(pub, par.publicKey.export({ type: 'spki', format: 'pem' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('acepta un sobre válido', () => {
    const r = correr([escribir('b.json', { version: 1, kid: 'k1', firma, contenido }), '--publica', `k1=${pub}`]);
    expect(r).toMatchObject({ codigo: 0 });
    expect(r.salida).toMatch(/válido \(kid k1\)/);
  });

  it('rechaza un contenido alterado', () => {
    const r = correr([escribir('m.json', { version: 1, kid: 'k1', firma, contenido: { ...contenido, fecha: '2026-09-17' } }), '--publica', `k1=${pub}`]);
    expect(r.codigo).toBe(1);
    expect(r.salida).toMatch(/inválido: firma_invalida/);
  });

  it('rechaza un kid sin clave pública conocida', () => {
    const r = correr([escribir('k.json', { version: 1, kid: 'desconocido', firma, contenido })]);
    expect(r.codigo).toBe(1);
    expect(r.salida).toMatch(/kid_desconocido/);
  });

  it('rechaza un archivo que no es JSON', () => {
    const ruta = join(dir, 'roto.json'); writeFileSync(ruta, 'no es json');
    expect(correr([ruta]).codigo).toBe(1);
  });
});
