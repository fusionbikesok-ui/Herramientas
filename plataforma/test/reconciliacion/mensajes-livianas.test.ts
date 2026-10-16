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

/** Fecha → texto ISO con 6 decimales (µs), como lo entrega to_char(... 'US'): el simulador compara strings, nunca Date en ms. */
const us = (v: Date | string): string => {
  const iso = v instanceof Date ? v.toISOString() : v;
  return iso.replace(/\.(\d+)Z$/, (_m, d: string) => `.${d.padEnd(6, '0')}Z`);
};
type Fila = string | { id: string; t: Date | string };
const fila = (f: Fila, i: number) => (typeof f === 'string' ? { id: f, t: us(new Date(AHORA.getTime() - 10 * 60_000 + i)) } : { id: f.id, t: us(f.t) });

function montar(opciones: {
  cambiados?: Fila[]; senales?: Fila[]; unread?: string[]; mensajes?: Record<string, string[]>; packDeMensaje?: Record<string, string>;
  conocidos?: string[]; mensaje404?: string[];
} = {}) {
  const llamadas: string[] = [];
  const db = {
    async query(sql: string, args: unknown[]) {
      if (sql.includes('resource_observations')) {
        const conocidos = new Set(opciones.conocidos ?? []);
        return { rows: (args[1] as string[]).filter((id) => conocidos.has(id)).map((resource_id) => ({ resource_id })) };
      }
      // Consultas livianas: args = [cuenta, luz.t, luz.id, windowTo, limite]; clave (t, id) estricta y acotada a windowTo.
      const ordenadas = (filas: Fila[]) => filas.map(fila)
        .filter((f) => f.t <= us(args[3] as Date)
          && (f.t > us(args[1] as string) || (f.t === us(args[1] as string) && f.id > String(args[2]))))
        .sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.id < y.id ? -1 : 1)).slice(0, Number(args[4]));
      if (sql.includes('reconciliation_signals')) return { rows: ordenadas(opciones.senales ?? []).map((f) => ({ resource_id: f.id, t: f.t })) };
      if (sql.includes('GROUP BY')) return { rows: ordenadas(opciones.cambiados ?? []).map((f) => ({ target_id: f.id, t: f.t })) };
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
        if (msg) {
          if (opciones.mensaje404?.includes(msg[1]!)) return ok(null, 404);
          return ok({ messages: [{ id: msg[1], message_resources: [{ name: 'packs', id: opciones.packDeMensaje?.[msg[1]!] ?? 'PX' }] }] });
        }
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

  it('más de 100 avisos: procesa 100, last_light_at no pasa del último procesado, marca avisos_recortados y la corrida siguiente toma el resto', async () => {
    const senales = Array.from({ length: 130 }, (_, i) => ({ id: `msg${String(i).padStart(3, '0')}`, t: new Date(AHORA.getTime() - 130 * 60_000 + i * 60_000) }));
    const base = { ...reciente, last_light_at: new Date(AHORA.getTime() - 3 * 24 * H).toISOString(), last_full_at: new Date(AHORA.getTime() - H).toISOString() };
    const m1 = montar({ senales });
    const p1 = await correr(m1.a, contexto(base));
    expect(m1.llamadas.filter((l) => l.startsWith('/messages/msg'))).toHaveLength(100);
    const c1 = p1.at(-1)!.cursorAfter;
    expect(c1.avisos_recortados).toBe(true);
    expect(c1.last_light_at).toBe(us(senales[99]!.t));
    // La corrida siguiente arranca desde ese punto y encuentra los 30 que faltaban (clave estricta: sin repetir el último).
    const m2 = montar({ senales });
    const p2 = await correr(m2.a, contexto({ ...base, last_light_at: c1.last_light_at, light: c1.light }));
    const pedidos = m2.llamadas.filter((l) => l.startsWith('/messages/msg')).map((l) => l.split('/')[2]!.split('?')[0]);
    expect(pedidos).toEqual(senales.slice(100).map((x) => x.id));
    expect(p2.at(-1)!.cursorAfter.avisos_recortados).toBe(false);
    expect(p2.at(-1)!.cursorAfter.last_light_at).toBe(AHORA.toISOString());
  });

  it('más de 500 pedidos cambiados: lee 500, recorta y no adelanta last_light_at hasta el último', async () => {
    const cambiados = Array.from({ length: 520 }, (_, i) => ({ id: `Q${String(i).padStart(4, '0')}`, t: new Date(AHORA.getTime() - 520 * 1000 + i * 1000) }));
    const { a, llamadas } = montar({ cambiados });
    const paginas = await correr(a, contexto({ ...reciente, last_light_at: new Date(AHORA.getTime() - 2 * H).toISOString(), last_full_at: new Date(AHORA.getTime() - H).toISOString() }));
    expect(llamadas.filter((l) => l.startsWith('/messages/packs/'))).toHaveLength(500);
    expect(paginas.at(-1)!.cursorAfter.avisos_recortados).toBe(true);
    expect(paginas.at(-1)!.cursorAfter.last_light_at).toBe(us(cambiados[499]!.t));
  });

  it('avisos_perdidos no cuenta mensajes que la sombra ya tenía proyectados (conversación vieja ya leída)', async () => {
    const { a } = montar({ mensajes: { P0100: ['viejo1', 'viejo2'], P0200: ['nuevo1', 'viejo3'] }, conocidos: ['viejo1', 'viejo2', 'viejo3'] });
    const paginas = await correr(a, contexto({ ...reciente, last_full_at: new Date(AHORA.getTime() - 25 * H).toISOString() }));
    expect(paginas.at(-1)!.cursorAfter.avisos_perdidos).toBe(1);   // sólo «nuevo1»
  });

  it('un aviso cuyo GET /messages/{id} da 404 no corta la lectura redundante del siguiente', async () => {
    const { a, llamadas } = montar({ senales: ['msgX', 'msgY'], mensaje404: ['msgX'], packDeMensaje: { msgY: 'P0042' } });
    const ctx = contexto({ last_light_at: reciente.last_light_at, last_unread_at: reciente.last_unread_at, last_full_at: new Date(AHORA.getTime() - H).toISOString() });
    const paginas = await correr(a, ctx);
    expect(paginas.flatMap(p => p.resources.map(r => r.id))).toEqual(['msgY']);
    expect(llamadas).toEqual(['/messages/msgX?tag=post_sale', '/messages/msgY?tag=post_sale', '/messages/packs/P0042/sellers/777?tag=post_sale&mark_as_read=false']);
  });

  it('un corte a mitad de la liviana con avisos pendientes reanuda sin releer lo ya hecho', async () => {
    const { a, llamadas } = montar({ packDeMensaje: { msgA: 'P0007' }, mensajes: { P0007: ['z1'] } });
    const ctx = contexto({ ...reciente, last_full_at: new Date(AHORA.getTime() - H).toISOString() });
    const pos = { pendientes: ['msg:msgA', '/packs/P0009/sellers/777'], despuesDe: '', completa: false, vistos: ['P0009'], perdidos: 0, luz: AHORA.toISOString(), recortados: false };
    const p1 = await a.listar(ctx, pos);                         // lee el aviso y encola su pack al frente
    expect(p1.nextPosition?.pendientes).toEqual(['/packs/P0007/sellers/777', '/packs/P0009/sellers/777']);
    const resto = await correr(a, ctx, p1.nextPosition as Record<string, unknown>);
    expect(llamadas.filter((l) => l.startsWith('/messages/packs/')).map((l) => l.split('/')[3])).toEqual(['P0007', 'P0009']);
    expect(llamadas.filter((l) => l.startsWith('/messages/msgA'))).toHaveLength(1);
    expect(resto.at(-1)!.nextPosition).toBeNull();
  });

  it('/messages/unread: se consulta con ≥6 h sin consultar y se salta antes', async () => {
    const a1 = montar({ unread: ['P0011'] });
    await correr(a1.a, contexto({ last_unread_at: new Date(AHORA.getTime() - 7 * H).toISOString(), last_light_at: reciente.last_light_at, last_full_at: new Date(AHORA.getTime() - H).toISOString() }));
    expect(a1.llamadas.filter((l) => l.startsWith('/messages/unread'))).toHaveLength(1);
    expect(a1.llamadas.some((l) => l.includes('/packs/P0011/'))).toBe(true);
    const a2 = montar({ unread: ['P0011'] });
    await correr(a2.a, contexto({ last_unread_at: new Date(AHORA.getTime() - 5 * H).toISOString(), last_light_at: reciente.last_light_at, last_full_at: new Date(AHORA.getTime() - H).toISOString() }));
    expect(a2.llamadas.filter((l) => l.startsWith('/messages/unread'))).toHaveLength(0);
  });

  it('130 avisos con el MISMO received_at, persistentes: en 2 corridas se leen los 130 sin repetir (cursor por (t, id))', async () => {
    const t = new Date(AHORA.getTime() - 5 * 60_000);
    const senales = Array.from({ length: 130 }, (_, i) => ({ id: `msg${String(i).padStart(3, '0')}`, t }));
    const base = { ...reciente, last_light_at: new Date(AHORA.getTime() - 3 * 24 * H).toISOString(), last_full_at: new Date(AHORA.getTime() - H).toISOString() };
    const leidos = (ll: string[]) => ll.filter((l) => l.startsWith('/messages/msg')).map((l) => l.split('/')[2]!.split('?')[0]!);
    const m1 = montar({ senales });
    const p1 = await correr(m1.a, contexto(base));
    const c1 = p1.at(-1)!.cursorAfter;
    expect(leidos(m1.llamadas)).toHaveLength(100);
    expect(c1.avisos_recortados).toBe(true);
    expect(c1.light).toMatchObject({ avisos: { t: us(t), id: 'msg099' } });
    const m2 = montar({ senales });   // las señales siguen en la tabla (el simulador no las borra al leer)
    const p2 = await correr(m2.a, contexto({ ...base, last_light_at: c1.last_light_at, light: c1.light }));
    const segundos = leidos(m2.llamadas);
    expect(segundos).toHaveLength(30);
    expect(new Set([...leidos(m1.llamadas), ...segundos]).size).toBe(130);   // todos, sin repetir
    expect(p2.at(-1)!.cursorAfter.avisos_recortados).toBe(false);
  });

  it('una fila con t == windowTo exacto se lee una sola vez en 2 corridas (cierre en (windowTo, id máximo))', async () => {
    const exacta = { id: 'msgExacta', t: AHORA };
    const base = { ...reciente, last_full_at: new Date(AHORA.getTime() - H).toISOString() };
    const m1 = montar({ senales: [exacta], cambiados: [{ id: 'P0555', t: AHORA }] });
    const p1 = await correr(m1.a, contexto(base));
    const c1 = p1.at(-1)!.cursorAfter;
    expect(m1.llamadas.filter((l) => l.includes('msgExacta') || l.includes('/packs/P0555/')).length).toBeGreaterThanOrEqual(2);
    const m2 = montar({ senales: [exacta], cambiados: [{ id: 'P0555', t: AHORA }] });
    await correr(m2.a, contexto({ ...base, last_light_at: c1.last_light_at, light: c1.light }, new Date(AHORA.getTime() + 20 * 60_000)));
    expect(m2.llamadas.some((l) => l.includes('msgExacta') || l.includes('/packs/P0555/'))).toBe(false);
  });

  it('un registro posterior al inicio de la corrida (> windowTo) no se lee ni adelanta el cursor', async () => {
    const despues = { id: 'msgFuturo', t: new Date(AHORA.getTime() + 1000) };
    const m = montar({ senales: ['msgViejo', despues], cambiados: [{ id: 'P0777', t: new Date(AHORA.getTime() + 5000) }] });
    const paginas = await correr(m.a, contexto({ ...reciente, last_full_at: new Date(AHORA.getTime() - H).toISOString() }));
    expect(m.llamadas.some((l) => l.includes('msgFuturo'))).toBe(false);
    expect(m.llamadas.some((l) => l.includes('/packs/P0777/'))).toBe(false);
    const c = paginas.at(-1)!.cursorAfter;
    expect(c.last_light_at).toBe(AHORA.toISOString());
    expect(c.avisos_recortados).toBe(false);
  });

  it('timestamps con µs: filas del mismo µs (≠ .000) y tope menor se leen todas, sin repetir, en 2 corridas', async () => {
    // Mismo ms, distintos µs: truncar el cursor a ms (Date) haría releer las 130 en cada corrida.
    const mismoUs = '2026-10-15T11:55:00.123456Z';
    const siguienteUs = '2026-10-15T11:55:00.123789Z';
    const senales = [
      ...Array.from({ length: 120 }, (_, i) => ({ id: `a${String(i).padStart(3, '0')}`, t: mismoUs })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `b${String(i).padStart(3, '0')}`, t: siguienteUs })),
    ];
    const base = { ...reciente, last_light_at: new Date(AHORA.getTime() - 3 * 24 * H).toISOString(), last_full_at: new Date(AHORA.getTime() - H).toISOString() };
    const leidos = (ll: string[]) => ll.filter((l) => l.startsWith('/messages/') && !l.startsWith('/messages/packs/')).map((l) => l.split('/')[2]!.split('?')[0]!);
    const m1 = montar({ senales });
    const p1 = await correr(m1.a, contexto(base));
    const c1 = p1.at(-1)!.cursorAfter;
    expect(leidos(m1.llamadas)).toHaveLength(100);
    expect(c1.light).toMatchObject({ avisos: { t: mismoUs, id: 'a099' } });   // µs completos, no truncados a ms
    const m2 = montar({ senales });
    await correr(m2.a, contexto({ ...base, last_light_at: c1.last_light_at, light: c1.light }));
    expect(leidos(m2.llamadas)).toHaveLength(30);
    expect(new Set([...leidos(m1.llamadas), ...leidos(m2.llamadas)]).size).toBe(130);
  });

  it('un 404 de pack avanza sin cortar la vuelta', async () => {
    const llamadas: string[] = [];
    const a = adaptadorMensajesMl({
      db: { query: async (sql: string) => ({ rows: sql.includes('reconciliation_signals') ? [] : [{ target_id: 'P1', t: new Date(AHORA.getTime() - 60_000) }] }) } as never, sellerId: '777',
      transporte: { async get(ruta: string) { llamadas.push(ruta); return ok(null, 404); } },
    });
    const paginas = await correr(a, contexto({ ...reciente, last_full_at: new Date(AHORA.getTime() - H).toISOString() }));
    expect(paginas.flatMap((p) => p.resources)).toEqual([]);
    expect(llamadas).toHaveLength(1);
  });
});
