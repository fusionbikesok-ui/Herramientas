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
});
