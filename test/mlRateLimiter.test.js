import { describe, it, expect, beforeEach } from 'vitest';
import { LIMITES_ML, MARGEN_SEGURIDAD, cupoEfectivo, clasificarRecurso, resumenLimites } from '../lib/mlLimites.js';
import { reservarCupo, estadoPresupuesto, _resetPresupuestoParaTests, _techoRafagaParaTests } from '../lib/mlRateLimiter.js';

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
    // El bucket arranca en el techo de ráfaga, no en el cupo/minuto entero.
    expect(estado.global.disponibles).toBe(_techoRafagaParaTests('global') - 1);
    expect(estado.escritura.disponibles).toBe(_techoRafagaParaTests('escritura') - 1);
  });

  it('gana el más restrictivo: agotar oauth frena aunque el global tenga cupo de sobra', async () => {
    // El bucket ya NO arranca lleno con el cupo/minuto entero (17 para oauth), sino con
    // el techo de ráfaga (ventana de 3s) — para oauth eso redondea a 1 solo token.
    const techoOauth = _techoRafagaParaTests('oauth');
    for (let i = 0; i < techoOauth; i++) {
      expect(await reservarCupo(['global', 'oauth'])).toBe(true);
    }
    expect(estadoPresupuesto().oauth.disponibles).toBe(0);
    // El global (techo de ráfaga propio, no el cupo/minuto entero) sigue teniendo cupo:
    // solo se gastó 1, lo mismo que oauth en esta corrida.
    expect(estadoPresupuesto().global.disponibles).toBeGreaterThan(0);

    // ...y aun así la próxima llamada NO sale al toque: tiene que esperar a que
    // el bucket de oauth recargue (17/min ≈ 1 token cada 3,5s, el promedio no cambió).
    // El limitador FRENA en vez de rechazar — el caller se ralentiza, no falla. Ésa es la
    // regla pedida: gana siempre el recurso más restrictivo.
    const t0 = Date.now();
    expect(await reservarCupo(['global', 'oauth'])).toBe(true);
    const esperoMs = Date.now() - t0;
    expect(esperoMs).toBeGreaterThan(2500);
  }, 30_000);

  it('el bucket se recarga con el tiempo (refill continuo, sin picos de ventana fija)', async () => {
    const techoOauth = _techoRafagaParaTests('oauth');
    for (let i = 0; i < techoOauth; i++) await reservarCupo(['oauth']);
    expect(estadoPresupuesto().oauth.disponibles).toBe(0);

    // Un bucket de 17/min recarga ~1 token cada 3,5s (el refill promedio no cambió).
    // Esperamos algo más.
    await new Promise(r => setTimeout(r, 4500));
    expect(estadoPresupuesto().oauth.disponibles).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('bajo contención sostenida devuelve false en vez de esperar para siempre', async () => {
    // Muchas llamadas peleando por un bucket que arranca en el techo de ráfaga de oauth
    // (1 token): las primeras entran, y las que no consigan cupo dentro de la espera
    // máxima (15s) deben rendirse con false para que el caller las trate como 429 —
    // nunca colgarse.
    const techoOauth = _techoRafagaParaTests('oauth');
    for (let i = 0; i < techoOauth; i++) await reservarCupo(['oauth']);

    const resultados = await Promise.all(
      Array.from({ length: 40 }, () => reservarCupo(['oauth']))
    );
    expect(resultados.some(r => r === false)).toBe(true);
  }, 40_000);

  it('nunca acumula más cupo que el techo de ráfaga, por más que el proceso esté ocioso', async () => {
    await reservarCupo(['oauth']);
    await new Promise(r => setTimeout(r, 300));
    // Antes el tope era cupoEfectivo (el minuto entero); ahora es el techo de ráfaga,
    // mucho más chico — el proceso ocioso ya no puede acumular un minuto de golpe.
    expect(estadoPresupuesto().oauth.disponibles).toBeLessThanOrEqual(_techoRafagaParaTests('oauth'));
    expect(estadoPresupuesto().oauth.disponibles).toBeLessThan(cupoEfectivo('oauth'));
  });

  // Criterio de aceptación del plan (paso 2): con 'lectura' (cupo efectivo 425/min), las
  // primeras ~22 salidas de un lote de 100 no esperan (techo de ráfaga de 3s), y el resto
  // queda paceado por el refill real -> el lote entero tarda al menos lo que el promedio
  // exige, y ninguna llamada devuelve false (15s de espera máxima alcanza de sobra).
  it('techo de ráfaga: en un lote de 100 lecturas, las primeras ~22 salen sin espera y el resto se pacea sin fallar ninguna', async () => {
    const cupoLectura = cupoEfectivo('lectura');
    const techoLectura = _techoRafagaParaTests('lectura');

    const t0 = Date.now();
    const resultados = [];
    const tiemposMs = [];
    for (let i = 0; i < 100; i++) {
      resultados.push(await reservarCupo(['lectura']));
      tiemposMs.push(Date.now() - t0);
    }

    expect(resultados.every(r => r === true)).toBe(true);

    // Las primeras `techoLectura` llamadas salieron de la ráfaga inicial: rápido (bien por
    // debajo del ritmo de refill, que exigiría ~141ms cada una para 425rpm).
    expect(tiemposMs[techoLectura - 1]).toBeLessThan(1000);

    // El lote entero (100 llamadas) no puede salir más rápido que lo que el promedio de
    // 425/min permite una vez agotada la ráfaga: (100 - techoLectura) llamadas al ritmo de
    // refill.
    const esperaMinimaMs = ((100 - techoLectura) / cupoLectura) * 60_000;
    expect(tiemposMs[99]).toBeGreaterThanOrEqual(esperaMinimaMs * 0.9); // 10% de margen por jitter de setTimeout
  }, 40_000);
});
