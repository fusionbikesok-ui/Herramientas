/*
 * test/worker/catalogo.test.ts — backoff exponencial del ciclo de bootstrap ante 429 (E2, corrección del
 * 2026-09-20: el bootstrap de ml.items reintentaba cada `esperaCedido` fijo aunque el canal siguiera sin
 * cupo, y en producción hizo 11 cesiones seguidas sobre un cupo agotado en 11 minutos).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iniciarCicloBootstrap, type LectorBootstrap, type RegistroCiclo } from '../../src/worker/catalogo.ts';
import type { CuentaBootstrap, ResultadoPagina } from '../../src/catalogo/bootstrap.ts';

const cuenta = (id: string, topic: CuentaBootstrap['topic'] = 'ml.items'): CuentaBootstrap =>
  ({ id, topic, transporte: { get: async () => { throw new Error('no debería llamar al canal'); } } });

const logMudo: RegistroCiclo = { info: () => undefined, error: () => undefined };
const PAUSA_MS = 1000; // la pausa de avanzo/terminada/ocupada: se filtra de `esperas`, que sólo mira cesiones.

/** Lector falso: devuelve la próxima respuesta de una cola fija, sin importar qué cuenta la pida. */
function lectorFalso(respuestas: ResultadoPagina[]): LectorBootstrap {
  let i = 0;
  return { async unaPagina() { return respuestas[Math.min(i++, respuestas.length - 1)]!; } };
}

/**
 * Corre el ciclo `vueltas` veces con reloj falso y devuelve las esperas de CESIÓN usadas (filtra `PAUSA_MS`,
 * que es la de avanzo/terminada/ocupada). `porCuenta`, si se pasa, agrupa la espera con la cuenta que la
 * generó — la usa el test de aislamiento por cuenta.
 */
async function correr(
  lector: LectorBootstrap, cuentas: CuentaBootstrap[], vueltas: number, esperaCedido: number | undefined,
  porCuenta?: (cuentaId: string, ms: number) => void,
): Promise<number[]> {
  vi.useFakeTimers();
  const esperas: number[] = [];
  let ultimaCuenta = '';
  const lectorEspiado: LectorBootstrap = {
    async unaPagina(c) { ultimaCuenta = c.id; return lector.unaPagina(c); },
  };
  const original = globalThis.setTimeout;
  vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
    if (ms !== undefined && ms !== PAUSA_MS) { esperas.push(ms); porCuenta?.(ultimaCuenta, ms); }
    return original(fn, ms);
  }) as typeof setTimeout);
  const ciclo = iniciarCicloBootstrap(lectorEspiado, cuentas, PAUSA_MS, logMudo, esperaCedido);
  for (let i = 0; i < vueltas; i++) await vi.advanceTimersToNextTimerAsync();
  await ciclo.detener();
  vi.unstubAllGlobals();
  return esperas;
}

afterEach(() => { vi.useRealTimers(); });

describe('iniciarCicloBootstrap — backoff de cedio_429', () => {
  it('el reintento crece exponencialmente con cesiones cedio_429 consecutivas', async () => {
    const lector = lectorFalso([
      { estado: 'cedio_429', detalle: 'HTTP_429 1' },
      { estado: 'cedio_429', detalle: 'HTTP_429 2' },
      { estado: 'cedio_429', detalle: 'HTTP_429 3' },
    ]);
    const esperas = await correr(lector, [cuenta('a')], 3, 10_000);
    // 10_000 * 2^0, 10_000 * 2^1, 10_000 * 2^2: cada cesión duplica la anterior.
    expect(esperas).toEqual([10_000, 20_000, 40_000]);
  });

  it('un avanzo resetea el backoff: la próxima cesión vuelve a la base', async () => {
    const lector = lectorFalso([
      { estado: 'cedio_429', detalle: 'HTTP_429 1' },
      { estado: 'cedio_429', detalle: 'HTTP_429 2' },
      { estado: 'avanzo', pagina: 1, encolados: 1, leidos: 1 },
      { estado: 'cedio_429', detalle: 'HTTP_429 3' },
    ]);
    const esperas = await correr(lector, [cuenta('a')], 4, 10_000);
    // El avanzo programa con PAUSA_MS (se filtra); la cesión siguiente vuelve a la base 10_000, no a 40_000.
    expect(esperas).toEqual([10_000, 20_000, 10_000]);
  });

  it('el backoff no supera el tope de 180_000 ms aunque haya muchas cesiones seguidas', async () => {
    const respuestas: ResultadoPagina[] = Array.from({ length: 8 }, (_, i) => ({ estado: 'cedio_429', detalle: `HTTP_429 ${i}` }));
    const esperas = await correr(lectorFalso(respuestas), [cuenta('a')], 8, 60_000);
    // 60_000 * 2^2 = 240_000 ya superaría el tope: de la tercera cesión en adelante queda clavado en 180_000.
    expect(Math.max(...esperas)).toBe(180_000);
    expect(esperas.every((e) => e <= 180_000)).toBe(true);
  });

  it('respeta Retry-After como piso cuando pide más que el backoff calculado', async () => {
    const lector = lectorFalso([{ estado: 'cedio_429', detalle: 'HTTP_429 1', retryAfterS: 300 }]);
    const esperas = await correr(lector, [cuenta('a')], 1, 10_000);
    // El backoff calculado (10_000) es menor que Retry-After (300_000): gana el piso del header.
    expect(esperas).toEqual([300_000]);
  });

  it('el contador de cesiones es por cuenta: una cuenta en backoff no afecta a otra', async () => {
    // 'a' termina enseguida y sale del ciclo; todas las vueltas restantes son de 'b', que cede dos veces.
    const lector: LectorBootstrap = {
      async unaPagina(c) { return c.id === 'a' ? { estado: 'terminada' } : { estado: 'cedio_429', detalle: 'HTTP_429' }; },
    };
    const porCuenta: Record<string, number[]> = {};
    await correr(lector, [cuenta('a', 'ml.items'), cuenta('b', 'woo.products')], 3, 10_000,
      (cuentaId, ms) => { (porCuenta[cuentaId] ??= []).push(ms); });
    expect(porCuenta.b).toEqual([10_000, 20_000]);
  });

  it('cedio_senales no tiene backoff: la espera queda fija en esperaCedido', async () => {
    const lector = lectorFalso([
      { estado: 'cedio_senales', detalle: '5 señales' },
      { estado: 'cedio_senales', detalle: '5 señales' },
      { estado: 'cedio_senales', detalle: '5 señales' },
    ]);
    const esperas = await correr(lector, [cuenta('a')], 3, 10_000);
    expect(esperas).toEqual([10_000, 10_000, 10_000]);
  });

  it('reinicio_scan no tiene backoff: la espera queda fija en esperaCedido aunque se repita', async () => {
    const lector = lectorFalso([{ estado: 'reinicio_scan' }, { estado: 'reinicio_scan' }, { estado: 'reinicio_scan' }]);
    const esperas = await correr(lector, [cuenta('a')], 3, 10_000);
    expect(esperas).toEqual([10_000, 10_000, 10_000]);
  });
});
