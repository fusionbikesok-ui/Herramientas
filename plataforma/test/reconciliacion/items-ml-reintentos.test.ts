import { describe, expect, it } from 'vitest';
import { adaptadorItemsMl } from '../../src/reconciliacion/adaptadores/ml.ts';
import type { RespuestaCanal, TransporteCanal } from '../../src/reconciliacion/cliente-http.ts';
import type { ContextoListado } from '../../src/reconciliacion/tipos.ts';
import { ErrorBarridoReintentable } from '../../src/worker/barridos.ts';

// Vuelta completa de ml.items contra la guía de ML (Rate limit / Error 429): un 429 o un 5xx aislado se
// reintenta en el mismo pedido con backoff y jitter, sin tirar la vuelta entera; los /items/bulk van de a uno.
const ctx = { corrida: {}, windowFrom: null, windowTo: new Date('2026-09-25T07:00:00Z') } as unknown as ContextoListado;
const ok = (body: unknown): RespuestaCanal => ({ status: 200, body } as RespuestaCanal);
const ids = (n: number) => Array.from({ length: n }, (_, i) => `MLA${1000 + i}`);
const bulk = (ruta: string) => ok(new URL(ruta, 'http://x').searchParams.get('ids')!.split(',').map((id) => ({
  id, status_code: 200, body: { id, status: 'active', last_updated: '2026-09-24T00:00:00.000Z', variations: [] },
})));

function transporte(fallos: Record<string, number>, retryAfter?: number) {
  const llamadas: string[] = []; let enVuelo = 0; let maxEnVuelo = 0;
  const t: TransporteCanal = {
    async get(ruta) {
      llamadas.push(ruta); enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      await Promise.resolve();
      enVuelo--;
      const clave = ruta.startsWith('/items/bulk') ? 'bulk' : 'scan';
      if ((fallos[clave] ?? 0) > 0) { fallos[clave]!--; throw new ErrorBarridoReintentable(`HTTP_429 ${clave}`, retryAfter); }
      return clave === 'scan' ? ok({ results: ids(60), scroll_id: 'S2' }) : bulk(ruta);
    },
  };
  return { t, llamadas, maxEnVuelo: () => maxEnVuelo };
}

describe('ml.items full_scan: reintento por pedido y ritmo', () => {
  it('un 429 en el scan y otro en un bulk se reintentan sin fallar la página', async () => {
    const esperas: number[] = [];
    const tr = transporte({ scan: 1, bulk: 1 });
    const a = adaptadorItemsMl({ transporte: tr.t, db: {} as never, sellerId: '777', esperar: async (ms) => { esperas.push(ms); }, azar: () => 0.5 });
    const p = await a.listar(ctx, null);
    expect(p.resources).toHaveLength(60);
    expect(esperas.filter((ms) => ms >= 1000)).toHaveLength(2);
  });

  it('los /items/bulk de una página van de a uno, no en paralelo', async () => {
    const tr = transporte({});
    const a = adaptadorItemsMl({ transporte: tr.t, db: {} as never, sellerId: '777', esperar: async () => {}, azar: () => 0.5 });
    await a.listar(ctx, null);
    expect(tr.llamadas.filter((r) => r.startsWith('/items/bulk'))).toHaveLength(3);
    expect(tr.maxEnVuelo()).toBe(1);
  });

  it('respeta Retry-After y agota el presupuesto antes de que venza el scroll', async () => {
    const esperas: number[] = [];
    const a = adaptadorItemsMl({ transporte: transporte({ scan: 99 }, 5).t, db: {} as never, sellerId: '777', esperar: async (ms) => { esperas.push(ms); }, azar: () => 0.5 });
    await expect(a.listar(ctx, null)).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    expect(esperas[0]).toBe(5000);
    expect(esperas.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(90_000);
  });

  it('pausa entre páginas cuando sigue un scroll', async () => {
    const esperas: number[] = [];
    const a = adaptadorItemsMl({ transporte: transporte({}).t, db: {} as never, sellerId: '777', esperar: async (ms) => { esperas.push(ms); }, azar: () => 0.5 });
    await a.listar(ctx, { scroll_id: 'S1' });
    expect(esperas[0]).toBeGreaterThan(0);
  });

  it('el presupuesto de reintento es UNO por página, compartido entre el scan y todos los bulk: si el scan ya gastó casi todo, el primer bulk que falle revienta sin margen', async () => {
    // fallos.scan = 5 con Retry-After 20s: 5*20000=100000 > 90000, así que el 5º reintento del scan ya
    // excede el presupuesto y sale con ErrorBarridoReintentable ANTES de llegar a ningún bulk (85% del correo:
    // 4*20000=80000 se gastan en 4 reintentos exitosos del scan, y el 5º pediría 100000 y revienta ahí mismo).
    // Sin presupuesto compartido esto sería idéntico (es sólo el scan) — la prueba de que el presupuesto es
    // COMPARTIDO está en que estas 4 esperas del scan (80s) son las ÚNICAS: nada de eso viene de ningún bulk,
    // y el bulk nunca llega a pedirse porque el scan ya falló. Confirma que gastadoMs persiste fuera de
    // conReintento entre llamadas del mismo presupuesto (no se reinicia por pedido).
    const esperas: number[] = [];
    const tr = transporte({ scan: 5 }, 20);
    const a = adaptadorItemsMl({ transporte: tr.t, db: {} as never, sellerId: '777', esperar: async (ms) => { esperas.push(ms); }, azar: () => 0.5 });
    await expect(a.listar(ctx, null)).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    expect(esperas).toEqual([20_000, 20_000, 20_000, 20_000]);
    expect(tr.llamadas.some((r) => r.startsWith('/items/bulk'))).toBe(false);
  });

  it('el presupuesto de reintento es UNO por página: lo que gasta el scan reduce el margen del bulk siguiente', async () => {
    // El scan gasta 60s en un único reintento (Retry-After 60). Con presupuesto COMPARTIDO, al bulk sólo le
    // quedan 30s de margen: su propio Retry-After de 40s ya no entra (60000+40000=100000 > 90000) y revienta
    // en su primer intento, sin agotar sus propios 6 reintentos. Con presupuesto por-pedido (el bug), el bulk
    // arrancaría en gastado=0 y toleraría los 40s sin problema.
    const esperas: number[] = [];
    // El helper `transporte` comparte un único Retry-After para scan y bulk; acá hace falta uno distinto
    // por tipo de pedido, así que se arma un transporte dedicado.
    const llamadas: string[] = [];
    let fallosScan = 1; let fallosBulk = 1;
    const dedicado = {
      async get(ruta: string) {
        llamadas.push(ruta);
        if (ruta.includes('items/search')) {
          if (fallosScan > 0) { fallosScan--; throw new ErrorBarridoReintentable('HTTP_429 scan', 60); }
          return ok({ results: ids(20), scroll_id: 'S2' });
        }
        if (fallosBulk > 0) { fallosBulk--; throw new ErrorBarridoReintentable('HTTP_429 bulk', 40); }
        return bulk(ruta);
      },
    };
    const a = adaptadorItemsMl({ transporte: dedicado, db: {} as never, sellerId: '777', esperar: async (ms) => { esperas.push(ms); }, azar: () => 0.5 });
    await expect(a.listar(ctx, null)).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    expect(esperas).toEqual([60_000]);
    expect(llamadas.filter((r) => r.startsWith('/items/bulk'))).toHaveLength(1);
  });

  it('el presupuesto NO cruza páginas: cada listar() arranca con el suyo propio, gastado o no en la anterior', async () => {
    // Página 1 (sin scroll_id): el scan gasta 80s (Retry-After 80, un solo reintento) del presupuesto de ESA
    // llamada a listar(). Página 2 (con scroll_id 'S1'): si el presupuesto sobreviviera entre llamadas, ya
    // arrancaría con 80s gastados y su propio Retry-After de 40s revientaría (80000+40000=120000 > 90000).
    // Como es una llamada nueva a listar(), arranca en 0 y esos 40s entran sin problema.
    const esperas: number[] = [];
    let fallosScan1 = 1; let fallosScan2 = 1;
    const dedicado = {
      async get(ruta: string) {
        if (ruta.includes('items/search')) {
          const esPagina2 = ruta.includes('scroll_id=S1');
          if (esPagina2) {
            if (fallosScan2 > 0) { fallosScan2--; throw new ErrorBarridoReintentable('HTTP_429 scan p2', 40); }
            return ok({ results: ids(5), scroll_id: null });
          }
          if (fallosScan1 > 0) { fallosScan1--; throw new ErrorBarridoReintentable('HTTP_429 scan p1', 80); }
          return ok({ results: ids(5), scroll_id: 'S1' });
        }
        return bulk(ruta);
      },
    };
    const a = adaptadorItemsMl({ transporte: dedicado, db: {} as never, sellerId: '777', esperar: async (ms) => { esperas.push(ms); }, azar: () => 0.5 });
    const p1 = await a.listar(ctx, null);
    expect(p1.nextPosition).toEqual({ scroll_id: 'S1' });
    const p2 = await a.listar(ctx, p1.nextPosition);
    expect(p2.resources).toHaveLength(5);
    // El 300 del medio es PAUSA_ENTRE_PAGINAS_MS (no exportada): la espera fija antes de reusar el scroll_id.
    expect(esperas).toEqual([80_000, 300, 40_000]);
  });
});
