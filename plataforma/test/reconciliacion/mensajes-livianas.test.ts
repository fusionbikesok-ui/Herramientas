import { describe, expect, it } from 'vitest';
import { adaptadorMensajesMl } from '../../src/reconciliacion/adaptadores/ml.ts';
import type { ContextoListado, PaginaRemota } from '../../src/reconciliacion/tipos.ts';

const AHORA = new Date('2026-10-15T12:00:00Z');
const H = 3_600_000;
const ok = (body: unknown, status = 200) => ({ status, headers: new Headers(), body });

/** ~470 packs vistos en 30 días; sólo `cambiados` tienen last_seen_at dentro de la ventana de la vuelta. */
const TODOS = Array.from({ length: 470 }, (_, i) => `P${String(i).padStart(4, '0')}`);

function contexto(cursorBefore: Record<string, unknown>, windowTo = AHORA): ContextoListado {
  return { corrida: { channelAccountId: 'cuenta', cursorBefore }, windowFrom: null, windowTo } as unknown as ContextoListado;
}

function montar(opciones: { cambiados?: string[]; senales?: string[]; unread?: string[]; mensajes?: Record<string, string[]>; packDeMensaje?: Record<string, string> } = {}) {
  const llamadas: string[] = [];
  const db = {
    async query(sql: string, args: unknown[]) {
      if (sql.includes('reconciliation_signals')) return { rows: (opciones.senales ?? []).map((resource_id) => ({ resource_id })) };
      // Con ventana (liviana) → sólo los cambiados; recorrido de 30 días → los 470 en orden, paginados por `despuesDe`.
      const desde = (args[1] as Date).getTime();
      const barrido30 = desde <= AHORA.getTime() - 29 * 24 * H;
      if (!barrido30) return { rows: (opciones.cambiados ?? []).map((target_id) => ({ target_id })) };
      return { rows: TODOS.filter((p) => p > String(args[2])).slice(0, Number(args[3])).map((target_id) => ({ target_id })) };
    },
  };
  const a = adaptadorMensajesMl({
    db: db as never, sellerId: '777',
    transporte: {
      async get(ruta: string) {
        llamadas.push(ruta);
        if (ruta.startsWith('/messages/unread')) return ok({ results: (opciones.unread ?? []).map((p) => ({ resource: `/packs/${p}/sellers/777` })) });
        const msg = ruta.match(/^\/messages\/([^/?]+)\?tag=post_sale$/);
        if (msg) return ok({ messages: [{ id: msg[1], message_resources: [{ name: 'packs', id: opciones.packDeMensaje?.[msg[1]!] ?? 'PX' }] }] });
        const pack = ruta.match(/^\/messages\/packs\/([^/]+)\/sellers\/777/)![1]!;
        return ok({ messages: (opciones.mensajes?.[pack] ?? []).map((id) => ({ id })) });
      },
    },
  });
  return { a, llamadas };
}

async function correr(a: ReturnType<typeof montar>['a'], ctx: ContextoListado, inicial: Record<string, unknown> | null = null) {
  const paginas: PaginaRemota[] = [];
  let pos = inicial;
  for (let i = 0; i < 2000; i++) {
    const p = await a.listar(ctx, pos);
    paginas.push(p);
    if (!p.nextPosition) return paginas;
    pos = p.nextPosition;
  }
  throw new Error('no termina');
}

const reciente = { last_unread_at: AHORA.toISOString(), last_light_at: new Date(AHORA.getTime() - 20 * 60_000).toISOString() };

describe('ml.messages: vuelta liviana + control diario', () => {
  it('la vuelta liviana lee sólo los packs con motivo y no barre los 470', async () => {
    const { a, llamadas } = montar({ cambiados: ['P0001', 'P0002'], mensajes: { P0001: ['m1'] } });
    const cursor = { ...reciente, last_full_at: new Date(AHORA.getTime() - 2 * H).toISOString() };
    const paginas = await correr(a, contexto(cursor));
    const packs = llamadas.filter((l) => l.startsWith('/messages/packs/'));
    expect(packs).toHaveLength(2);
    expect(packs.every((l) => l.includes('mark_as_read=false'))).toBe(true);
    expect(paginas.flatMap((p) => p.resources.map((r) => r.id))).toEqual(['m1']);
    expect(paginas.at(-1)!.cursorAfter.last_full_at).toBe(cursor.last_full_at);   // no es una vuelta de control
  });

  it('une unread + avisos de webhook + pedidos cambiados sin repetir packs', async () => {
    const { a, llamadas } = montar({
      unread: ['P0001', 'P0003'], cambiados: ['P0001', 'P0002'], senales: ['msgA'], packDeMensaje: { msgA: 'P0003' },
    });
    const ctx = contexto({ last_light_at: reciente.last_light_at, last_full_at: new Date(AHORA.getTime() - H).toISOString() });
    await correr(a, ctx);
    expect(llamadas.filter((l) => l.startsWith('/messages/packs/')).map((l) => l.split('/')[3]).sort()).toEqual(['P0001', 'P0002', 'P0003']);
    expect(llamadas.filter((l) => l.startsWith('/messages/unread'))).toHaveLength(1);
    expect(llamadas).toContain('/messages/msgA?tag=post_sale');
  });

  it('un aviso de webhook cuyo pack ya estaba cubierto no vuelve a pedirlo', async () => {
    const { a, llamadas } = montar({ cambiados: ['P0005'], senales: ['msgB'], packDeMensaje: { msgB: 'P0005' } });
    await correr(a, contexto({ last_light_at: reciente.last_light_at, last_full_at: new Date(AHORA.getTime() - H).toISOString() }));
    expect(llamadas.filter((l) => l.includes('/messages/packs/P0005/'))).toHaveLength(1);
  });

  it('cuando pasaron ≥24 h hace el recorrido completo, sin repetir lo que ya trajo la liviana, y cuenta los avisos perdidos', async () => {
    const { a, llamadas } = montar({ cambiados: ['P0001'], mensajes: { P0001: ['m1'], P0100: ['m2'], P0200: ['m3'] } });
    const ctx = contexto({ ...reciente, last_full_at: new Date(AHORA.getTime() - 25 * H).toISOString() });
    const paginas = await correr(a, ctx);
    const packs = llamadas.filter((l) => l.startsWith('/messages/packs/')).map((l) => l.split('/')[3]);
    expect(packs).toHaveLength(470);
    expect(new Set(packs).size).toBe(470);          // P0001 se leyó una sola vez
    const final = paginas.at(-1)!.cursorAfter;
    expect(final.last_full_at).toBe(AHORA.toISOString());
    expect(final.avisos_perdidos).toBe(2);          // P0100 y P0200: sólo los encontró el control
  });

  it('sin vuelta completa previa (cursor vacío) arranca con el control completo', async () => {
    const { a, llamadas } = montar();
    await correr(a, contexto({}));
    expect(llamadas.filter((l) => l.startsWith('/messages/packs/'))).toHaveLength(470);
  });

  it('reanuda: con pendientes y el control a medias sigue donde quedó', async () => {
    const { a, llamadas } = montar({ mensajes: { P0300: ['m9'] } });
    const ctx = contexto({ ...reciente, last_full_at: new Date(AHORA.getTime() - 25 * H).toISOString() });
    const pos = { pendientes: ['/packs/PZ/sellers/777'], despuesDe: 'P0298', completa: true, vistos: ['PZ'], perdidos: 1 };
    const p1 = await a.listar(ctx, pos);
    expect(p1.resources).toEqual([]);
    expect(p1.nextPosition).toMatchObject({ pendientes: [], despuesDe: 'P0298', completa: true });
    const resto = await correr(a, ctx, p1.nextPosition as Record<string, unknown>);
    const packs = llamadas.filter((l) => l.startsWith('/messages/packs/')).map((l) => l.split('/')[3]);
    expect(packs[0]).toBe('PZ');
    expect(packs[1]).toBe('P0299');
    expect(packs).toHaveLength(1 + (470 - 299));
    expect(resto.at(-1)!.cursorAfter.avisos_perdidos).toBe(2);   // 1 previo + P0300
  });

  it('un 404 de pack avanza sin cortar la vuelta', async () => {
    const llamadas: string[] = [];
    const a = adaptadorMensajesMl({
      db: { query: async (sql: string) => ({ rows: sql.includes('reconciliation_signals') ? [] : [{ target_id: 'P1' }] }) } as never, sellerId: '777',
      transporte: { async get(ruta: string) { llamadas.push(ruta); return ok(null, 404); } },
    });
    const paginas = await correr(a, contexto({ ...reciente, last_full_at: new Date(AHORA.getTime() - H).toISOString() }));
    expect(paginas.flatMap((p) => p.resources)).toEqual([]);
    expect(llamadas).toHaveLength(1);
  });
});
