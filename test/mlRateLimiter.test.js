import { describe, it, expect, beforeEach } from 'vitest';
import { LIMITES_ML, MARGEN_SEGURIDAD, cupoEfectivo, clasificarRecurso, resumenLimites } from '../lib/mlLimites.js';
import { reservarCupo, estadoPresupuesto, _resetPresupuestoParaTests } from '../lib/mlRateLimiter.js';

describe('lib/mlLimites — presupuesto del 15%', () => {
  it('el margen de seguridad es 15% y NO se afloja', () => {
    // Este test es intencionalmente rígido: es una decisión de negocio
    // (2026-08-05), no un parámetro para tunear cuando algo va lento.
    expect(MARGEN_SEGURIDAD).toBe(0.15);
  });

  it('el cupo efectivo es siempre el 85% del límite documentado', () => {
    for (const [recurso, l] of Object.entries(LIMITES_ML)) {
      expect(cupoEfectivo(recurso)).toBe(Math.floor(l.rpm * 0.85));
      expect(cupoEfectivo(recurso)).toBeLessThan(l.rpm);
    }
  });

  it('el límite general documentado por ML es 1500 rpm → techo efectivo 1275', () => {
    expect(LIMITES_ML.global.rpm).toBe(1500);
    expect(cupoEfectivo('global')).toBe(1275);
  });

  it('clasifica cada llamada en su recurso específico', () => {
    expect(clasificarRecurso('post', '/oauth/token')).toBe('oauth');
    expect(clasificarRecurso('get', '/items/MLA123')).toBe('lectura');
    expect(clasificarRecurso('put', '/items/MLA123')).toBe('escritura');
    expect(clasificarRecurso('post', '/items')).toBe('escritura');
  });

  it('un recurso desconocido explota en vez de asumir un techo silencioso', () => {
    expect(() => cupoEfectivo('inventado')).toThrow(/desconocido/);
  });

  it('el resumen marca cuáles límites son documentados y cuáles estimación propia', () => {
    const porRecurso = Object.fromEntries(resumenLimites().map(r => [r.recurso, r]));
    expect(porRecurso.global.es_documentado).toBe(true);
    // oauth no tiene número publicado: debe quedar explícito, para no confundir
    // una elección nuestra con una cifra oficial en la revisión mensual.
    expect(porRecurso.oauth.es_documentado).toBe(false);
  });
});

describe('lib/mlRateLimiter — token bucket', () => {
  beforeEach(() => {
    _resetPresupuestoParaTests();
  });

  it('deja pasar mientras haya cupo', async () => {
    expect(await reservarCupo(['global', 'lectura'])).toBe(true);
    expect(await reservarCupo(['global', 'lectura'])).toBe(true);
  });

  it('descuenta del recurso específico Y del global en la misma llamada', async () => {
    await reservarCupo(['global', 'escritura']);
    const estado = estadoPresupuesto();
    expect(estado.global.disponibles).toBe(cupoEfectivo('global') - 1);
    expect(estado.escritura.disponibles).toBe(cupoEfectivo('escritura') - 1);
  });

  it('gana el más restrictivo: agotar oauth frena aunque el global tenga cupo de sobra', async () => {
    // oauth tiene el techo más bajo (17/min efectivo). Lo vaciamos entero.
    const cupoOauth = cupoEfectivo('oauth');
    for (let i = 0; i < cupoOauth; i++) {
      expect(await reservarCupo(['global', 'oauth'])).toBe(true);
    }
    expect(estadoPresupuesto().oauth.disponibles).toBe(0);
    // El global sigue teniendo muchísimo cupo...
    expect(estadoPresupuesto().global.disponibles).toBeGreaterThan(1000);

    // ...y aun así la próxima llamada NO sale al toque: tiene que esperar a que
    // el bucket de oauth recargue (17/min ≈ 1 token cada 3,5s). El limitador
    // FRENA en vez de rechazar — el caller se ralentiza, no falla. Ésa es la
    // regla pedida: gana siempre el recurso más restrictivo.
    const t0 = Date.now();
    expect(await reservarCupo(['global', 'oauth'])).toBe(true);
    const esperoMs = Date.now() - t0;
    expect(esperoMs).toBeGreaterThan(2500);
  }, 30_000);

  it('el bucket se recarga con el tiempo (refill continuo, sin picos de ventana fija)', async () => {
    const cupoOauth = cupoEfectivo('oauth');
    for (let i = 0; i < cupoOauth; i++) await reservarCupo(['oauth']);
    expect(estadoPresupuesto().oauth.disponibles).toBe(0);

    // Un bucket de 17/min recarga ~1 token cada 3,5s. Esperamos algo más.
    await new Promise(r => setTimeout(r, 4500));
    expect(estadoPresupuesto().oauth.disponibles).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('bajo contención sostenida devuelve false en vez de esperar para siempre', async () => {
    // 40 llamadas peleando por un bucket de 17/min: las primeras entran, y las
    // que no consigan cupo dentro de la espera máxima (15s) deben rendirse con
    // false para que el caller las trate como 429 — nunca colgarse.
    const cupoOauth = cupoEfectivo('oauth');
    for (let i = 0; i < cupoOauth; i++) await reservarCupo(['oauth']);

    const resultados = await Promise.all(
      Array.from({ length: 40 }, () => reservarCupo(['oauth']))
    );
    expect(resultados.some(r => r === false)).toBe(true);
  }, 40_000);

  it('nunca acumula más cupo que el techo, por más que el proceso esté ocioso', async () => {
    await reservarCupo(['oauth']);
    await new Promise(r => setTimeout(r, 300));
    expect(estadoPresupuesto().oauth.disponibles).toBeLessThanOrEqual(cupoEfectivo('oauth'));
  });
});
