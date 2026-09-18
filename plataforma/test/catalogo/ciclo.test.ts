/*
 * test/catalogo/ciclo.test.ts — E2 T1 tarea 6: el ciclo del proyector en el worker, con un proyector falso.
 */
import { describe, expect, it } from 'vitest';
import type { Proyector, ResultadoVuelta } from '../../src/catalogo/proyector.ts';
import { iniciarCicloCatalogo } from '../../src/worker/catalogo.ts';

const vacio: ResultadoVuelta = { reclamados: 0, aplicados: 0, vencidos: 0, rechazados: 0, errores: 0, detenido: null };
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

function falso(comportamiento: (n: number) => Promise<ResultadoVuelta>): Proyector & { vueltas: number; simultaneas: number } {
  let activas = 0;
  const p = {
    vueltas: 0, simultaneas: 0, procesados: 0, detenido: null,
    async unaVuelta() {
      activas++; p.simultaneas = Math.max(p.simultaneas, activas);
      try { return await comportamiento(++p.vueltas); } finally { activas--; }
    },
  };
  return p;
}
const log = () => { const l = { info: [] as string[], error: [] as string[] };
  return { l, reg: { info: (_: unknown, m: string) => { l.info.push(m); }, error: (_: unknown, m: string) => { l.error.push(m); } } }; };

describe('E2-PRY-11 ciclo del proyector', () => {
  it('corre vueltas de a una, con la pausa entre ellas', async () => {
    const p = falso(async () => { await espera(5); return vacio; });
    const c = iniciarCicloCatalogo(p, 2, log().reg);
    await espera(60);
    await c.detener();
    expect(p.vueltas).toBeGreaterThan(2);
    expect(p.simultaneas).toBe(1);
  });

  it('al detener espera la vuelta en curso y no arranca otra', async () => {
    let terminada = false;
    const p = falso(async () => { await espera(40); terminada = true; return vacio; });
    const c = iniciarCicloCatalogo(p, 1, log().reg);
    await espera(10);
    await c.detener();
    expect(terminada).toBe(true);
    const vueltas = p.vueltas;
    await espera(30);
    expect(p.vueltas).toBe(vueltas);
  });

  it('una vuelta que revienta no mata el ciclo', async () => {
    const p = falso(async (n) => { if (n === 1) throw new Error('base caída'); return vacio; });
    const { l, reg } = log();
    const c = iniciarCicloCatalogo(p, 2, reg);
    await espera(30);
    await c.detener();
    expect(p.vueltas).toBeGreaterThan(1);
    expect(l.error).toContain('vuelta del proyector del catálogo falló');
  });

  it('la detención se avisa una sola vez', async () => {
    const p = falso(async () => ({ ...vacio, detenido: 'canario de 100 completo' }));
    const { l, reg } = log();
    const c = iniciarCicloCatalogo(p, 2, reg);
    await espera(30);
    await c.detener();
    expect(l.error.filter((m) => m === 'proyector del catálogo detenido')).toHaveLength(1);
  });
});
