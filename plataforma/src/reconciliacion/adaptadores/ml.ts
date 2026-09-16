import type { Consultable } from '../../db/pool.ts';
import { ErrorBarridoReintentable } from '../../worker/barridos.ts';
import { hashCanonico } from '../canonico.ts';
import { ErrorCanalTerminal, type RespuestaCanal, type TransporteCanal } from '../cliente-http.ts';
import { claveCorriente, type AdaptadorBarrido, type ContextoListado, type PaginaRemota, type RecursoRemoto, type RelacionRemota } from '../tipos.ts';
import {
  BOOTSTRAP_ORDENES_MS, DIA_MS, cicloPorEstado, esRegistro, exigirLista, exigirRegistro, fechaUtc, finSegmento,
  idTexto, inicioVentana, numeroPosicion, textoPosicion, valorOnull, type Registro,
} from './comun.ts';

export interface DependenciasMl { transporte: TransporteCanal; db: Consultable; sellerId: string }

const LOTE_INDIVIDUAL = 20;
/** Relecturas de un segmento de órdenes antes de declararlo inestable y dejar el cursor quieto. */
const MAX_RELECTURAS_SEGMENTO = 3;
const LOTE_PACKS = 10;
const LIMITE_BUSQUEDA = 50;

function versionHash(proyeccion: unknown): string {
  return `sha256:${hashCanonico(proyeccion).toString('hex')}`;
}

function exigirOk(r: RespuestaCanal, que: string): unknown {
  if (r.status === 404) throw new ErrorCanalTerminal(`HTTP_404 ${que}`, 404);
  return r.body;
}

function cursorGeneracion(windowTo: Date): Record<string, unknown> {
  return { v: 1, generation: windowTo.toISOString() };
}

/** IDs conocidos abiertos del tópico que esta corrida todavía no volvió a leer, en orden estable. */
async function conocidasPendientes(db: Consultable, ctx: ContextoListado, despuesDe: string): Promise<string[]> {
  const r = await db.query<{ resource_id: string }>(
    `SELECT resource_id FROM integrations.resource_observations
      WHERE channel_account_id=$1 AND topic=$2 AND lifecycle='open'
        AND last_seen_run_id IS DISTINCT FROM $3 AND resource_id COLLATE "C" > $4
      ORDER BY resource_id COLLATE "C" LIMIT $5`,
    [ctx.corrida.channelAccountId, ctx.corrida.topic, ctx.corrida.id, despuesDe, LOTE_INDIVIDUAL],
  );
  return r.rows.map((f) => f.resource_id);
}

/** Normalizadores compartidos por el barrido y la relectura puntual (C6): misma versión y proyección. */
export function ordenMl(crudo: unknown): RecursoRemoto {
  const o = exigirRegistro(crudo, 'orden ML');
  const id = idTexto(o.id);
  const version = fechaUtc(o.date_last_updated);
  const envio = esRegistro(o.shipping) ? idTexto(o.shipping.id) : '';
  const pack = idTexto(o.pack_id) || id;
  const relations: RelacionRemota[] = [];
  if (envio) relations.push({ type: 'order_shipment', targetTopic: 'ml.shipments', targetId: envio });
  if (pack) relations.push({ type: 'order_pack', targetTopic: 'ml.messages', targetId: pack });
  return {
    id, version, updatedAt: version || null, lifecycle: cicloPorEstado(o.status, ['cancelled']), payload: o,
    projection: { id, status: valorOnull(o.status), date_last_updated: version, shipping_id: envio || null, pack_id: valorOnull(o.pack_id) },
    relations,
  };
}

export function adaptadorOrdenesMl(dep: DependenciasMl): AdaptadorBarrido {
  return {
    topic: 'ml.orders', cursorKind: 'state_sweep', fullScan: false, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const desdeTexto = textoPosicion(posicion, 'desde');
      const desde = desdeTexto ? new Date(desdeTexto) : inicioVentana(ctx.windowFrom, ctx.windowTo, BOOTSTRAP_ORDENES_MS);
      const hasta = finSegmento(desde, ctx.windowTo);
      const offset = numeroPosicion(posicion, 'offset', 0);
      const totalPrevio = numeroPosicion(posicion, 'total', -1);
      const relecturas = numeroPosicion(posicion, 'relecturas', 0);
      const q = new URLSearchParams({
        seller: dep.sellerId,
        'order.date_last_updated.from': desde.toISOString(),
        'order.date_last_updated.to': hasta.toISOString(),
        sort: 'date_asc', limit: String(LIMITE_BUSQUEDA), offset: String(offset),
      });
      const body = exigirRegistro(exigirOk(await dep.transporte.get(`/orders/search?${q}`), '/orders/search'), '/orders/search');
      const resultados = exigirLista(body.results, '/orders/search results');
      const total = Number(exigirRegistro(body.paging, '/orders/search paging').total);
      if (!Number.isInteger(total) || total < 0) throw new ErrorCanalTerminal('PAGING_INVALIDO /orders/search');
      const cursorAfter = { v: 1, updated_at: ctx.windowTo.toISOString(), tie_breaker: '' };

      // El offset no es estable: si una orden se modifica y sale de la ventana congelada, las páginas
      // siguientes se corren y otra orden quedaría sin leer. Un total distinto delata ese movimiento, y
      // entonces el segmento se relee completo (repetir es inocuo por la deduplicación del motor).
      if (totalPrevio >= 0 && total !== totalPrevio) {
        if (relecturas >= MAX_RELECTURAS_SEGMENTO) {
          throw new ErrorBarridoReintentable(`SEGMENTO_INESTABLE /orders/search ${desde.toISOString()}`);
        }
        return {
          resources: resultados.map(ordenMl),
          nextPosition: { desde: desde.toISOString(), offset: 0, relecturas: relecturas + 1 },
          cursorAfter,
        };
      }

      const siguiente = offset + resultados.length;
      let nextPosition: Record<string, unknown> | null = null;
      if (resultados.length > 0 && siguiente < total) nextPosition = { desde: desde.toISOString(), offset: siguiente, total, relecturas };
      else if (hasta.getTime() < ctx.windowTo.getTime()) nextPosition = { desde: hasta.toISOString(), offset: 0 };
      return { resources: resultados.map(ordenMl), nextPosition, cursorAfter };
    },
  };
}

const ENVIO_CERRADO = ['delivered', 'cancelled', 'not_delivered'];

export function envioMl(crudo: unknown): RecursoRemoto {
  const s = exigirRegistro(crudo, 'envío ML');
  const id = idTexto(s.id);
  const version = fechaUtc(s.last_updated);
  return {
    id, version, updatedAt: version || null, lifecycle: cicloPorEstado(s.status, ENVIO_CERRADO), payload: s,
    projection: { id, status: valorOnull(s.status), substatus: valorOnull(s.substatus), last_updated: version },
  };
}

export function adaptadorEnviosMl(dep: DependenciasMl): AdaptadorBarrido {
  return {
    topic: 'ml.shipments', cursorKind: 'state_sweep', fullScan: false, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const despuesDe = textoPosicion(posicion, 'despuesDe') ?? '';
      // Conocidos por relación orden→envío: abiertos, nunca leídos o cerrados en los últimos 30 días.
      const ids = (await dep.db.query<{ target_id: string }>(
        `SELECT DISTINCT r.target_id COLLATE "C" AS target_id FROM integrations.resource_relations r
           LEFT JOIN integrations.resource_observations o
             ON o.channel_account_id=r.channel_account_id AND o.topic='ml.shipments' AND o.resource_id=r.target_id
          WHERE r.channel_account_id=$1 AND r.relation_type='order_shipment' AND r.target_topic='ml.shipments'
            AND r.target_id COLLATE "C" > $2
            AND (o.resource_id IS NULL OR o.lifecycle='open' OR o.remote_updated_at >= $3)
          ORDER BY 1 LIMIT $4`,
        [ctx.corrida.channelAccountId, despuesDe, new Date(ctx.windowTo.getTime() - 30 * DIA_MS), LOTE_INDIVIDUAL],
      )).rows.map((f) => f.target_id);
      const leidos = await Promise.all(ids.map((id) =>
        dep.transporte.get(`/shipments/${encodeURIComponent(id)}`, { headers: { 'x-format-new': 'true' } })));
      const resources: RecursoRemoto[] = [];
      for (const r of leidos) {
        if (r.status === 404) continue;
        resources.push(envioMl(r.body));
      }
      return {
        resources,
        nextPosition: ids.length === LOTE_INDIVIDUAL ? { despuesDe: ids.at(-1)! } : null,
        cursorAfter: cursorGeneracion(ctx.windowTo),
      };
    },
  };
}

type Normalizador = (crudo: Registro) => { id: string; lifecycle: RecursoRemoto['lifecycle']; projection: Record<string, unknown> };

function recursoPorHash(crudo: unknown, que: string, normalizar: Normalizador): RecursoRemoto {
  const n = normalizar(exigirRegistro(crudo, que));
  return { id: n.id, version: versionHash(n.projection), updatedAt: null, lifecycle: n.lifecycle, payload: crudo, projection: n.projection };
}

/** Un conocido de preguntas o reclamos que ya no existe: el contrato de esos tópicos sí admite la baja por 404. */
export function recursoNoEncontrado(id: string): RecursoRemoto {
  const projection = { id, status: 'NOT_FOUND' };
  return { id, version: versionHash(projection), updatedAt: null, lifecycle: 'deleted', payload: projection, projection };
}

const normalizarPregunta: Normalizador = (q) => ({
  id: idTexto(q.id),
  lifecycle: q.status === 'UNANSWERED' && q.deleted_from_listing !== true ? 'open' : 'closed',
  projection: {
    id: idTexto(q.id), status: valorOnull(q.status), date_created: valorOnull(q.date_created),
    answer_status: esRegistro(q.answer) ? valorOnull(q.answer.status) : null,
  },
});

const normalizarReclamo: Normalizador = (c) => ({
  id: idTexto(c.id),
  lifecycle: c.status === 'opened' ? 'open' : 'closed',
  projection: {
    id: idTexto(c.id), status: valorOnull(c.status), last_updated: valorOnull(c.last_updated), stage: valorOnull(c.stage),
  },
});

export const preguntaMl = (crudo: unknown): RecursoRemoto => recursoPorHash(crudo, 'ml.questions', normalizarPregunta);
export const reclamoMl = (crudo: unknown): RecursoRemoto => recursoPorHash(crudo, 'ml.claims', normalizarReclamo);

/**
 * Estrategia común de preguntas y reclamos: primero el conjunto abierto enumerable completo; después,
 * relectura individual de los conocidos abiertos que ya no aparecieron (respondidos, cerrados o borrados).
 */
function adaptadorAbiertasYConocidas(dep: DependenciasMl, config: {
  topic: string;
  busqueda: (offset: number) => string;
  listaDe: (body: Registro) => unknown;
  totalDe: (body: Registro) => unknown;
  individual: (id: string) => string;
  normalizar: Normalizador;
}): AdaptadorBarrido {
  const recurso = (crudo: unknown): RecursoRemoto => recursoPorHash(crudo, config.topic, config.normalizar);
  return {
    topic: config.topic, cursorKind: 'state_sweep', fullScan: false, versionKind: 'hash',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const cursorAfter = cursorGeneracion(ctx.windowTo);
      if (textoPosicion(posicion, 'fase') !== 'conocidas') {
        const offset = numeroPosicion(posicion, 'offset', 0);
        const ruta = config.busqueda(offset);
        const body = exigirRegistro(exigirOk(await dep.transporte.get(ruta), config.topic), config.topic);
        const lista = exigirLista(config.listaDe(body), `${config.topic} lista`);
        const total = Number(config.totalDe(body));
        if (!Number.isInteger(total) || total < 0) throw new ErrorCanalTerminal(`PAGING_INVALIDO ${config.topic}`);
        const siguiente = offset + lista.length;
        return {
          resources: lista.map(recurso),
          nextPosition: lista.length > 0 && siguiente < total ? { fase: 'abiertas', offset: siguiente } : { fase: 'conocidas', despuesDe: '' },
          cursorAfter,
        };
      }
      const ids = await conocidasPendientes(dep.db, ctx, textoPosicion(posicion, 'despuesDe') ?? '');
      const leidos = await Promise.all(ids.map((id) => dep.transporte.get(config.individual(id))));
      const resources = leidos.map((r, i): RecursoRemoto => {
        if (r.status !== 404) return recurso(r.body);
        return recursoNoEncontrado(ids[i]!);
      });
      return {
        resources,
        nextPosition: ids.length === LOTE_INDIVIDUAL ? { fase: 'conocidas', despuesDe: ids.at(-1)! } : null,
        cursorAfter,
      };
    },
  };
}

export function adaptadorPreguntasMl(dep: DependenciasMl): AdaptadorBarrido {
  return adaptadorAbiertasYConocidas(dep, {
    topic: 'ml.questions',
    busqueda: (offset) => `/questions/search?${new URLSearchParams({
      seller_id: dep.sellerId, api_version: '4', status: 'UNANSWERED', limit: String(LIMITE_BUSQUEDA), offset: String(offset),
    })}`,
    listaDe: (b) => b.questions,
    totalDe: (b) => b.total,
    individual: (id) => `/questions/${encodeURIComponent(id)}`,
    normalizar: normalizarPregunta,
  });
}

export function adaptadorReclamosMl(dep: DependenciasMl): AdaptadorBarrido {
  return adaptadorAbiertasYConocidas(dep, {
    topic: 'ml.claims',
    busqueda: (offset) => `/post-purchase/v1/claims/search?${new URLSearchParams({
      status: 'opened', 'players.user_id': dep.sellerId, 'players.role': 'respondent',
      limit: String(LIMITE_BUSQUEDA), offset: String(offset),
    })}`,
    listaDe: (b) => b.data ?? b.results,
    totalDe: (b) => (esRegistro(b.paging) ? b.paging.total : undefined),
    individual: (id) => `/post-purchase/v1/claims/${encodeURIComponent(id)}`,
    normalizar: normalizarReclamo,
  });
}

const RECURSO_PACK = /^\/packs\/[^/?#]+\/sellers\/[^/?#]+$/;

export function adaptadorMensajesMl(dep: DependenciasMl): AdaptadorBarrido {
  return {
    topic: 'ml.messages', cursorKind: 'state_sweep', fullScan: false, versionKind: 'hash',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const cursorAfter = cursorGeneracion(ctx.windowTo);
      if (posicion === null) {
        const body = exigirRegistro(exigirOk(await dep.transporte.get('/messages/unread?role=seller&tag=post_sale'), '/messages/unread'), '/messages/unread');
        // `resource` se usa tal como lo devuelve ML: rearmarlo con otro vendedor produce 404.
        const pendientes = exigirLista(body.results, '/messages/unread results')
          .map((r) => (esRegistro(r) && typeof r.resource === 'string' ? r.resource.trim() : ''))
          .filter((r) => RECURSO_PACK.test(r));
        return { resources: [], nextPosition: { pendientes, despuesDe: '' }, cursorAfter };
      }
      const pendientesPrevios = Array.isArray(posicion.pendientes) ? posicion.pendientes.filter((p): p is string => typeof p === 'string') : [];
      let lote: string[]; let resto: string[]; let despuesDe = textoPosicion(posicion, 'despuesDe') ?? '';
      let fin = false;
      if (pendientesPrevios.length) {
        lote = pendientesPrevios.slice(0, LOTE_PACKS); resto = pendientesPrevios.slice(LOTE_PACKS);
      } else {
        resto = [];
        const packs = (await dep.db.query<{ target_id: string }>(
          `SELECT DISTINCT target_id COLLATE "C" AS target_id FROM integrations.resource_relations
            WHERE channel_account_id=$1 AND relation_type='order_pack' AND target_topic='ml.messages'
              AND last_seen_at >= $2 AND target_id COLLATE "C" > $3
            ORDER BY 1 LIMIT $4`,
          [ctx.corrida.channelAccountId, new Date(ctx.windowTo.getTime() - 30 * DIA_MS), despuesDe, LOTE_PACKS],
        )).rows.map((f) => f.target_id);
        lote = packs.map((p) => `/packs/${encodeURIComponent(p)}/sellers/${encodeURIComponent(dep.sellerId)}`);
        if (packs.length) despuesDe = packs.at(-1)!;
        fin = packs.length < LOTE_PACKS;
      }
      const leidos = await Promise.all(lote.map((recurso) =>
        dep.transporte.get(`/messages${recurso}?tag=post_sale&mark_as_read=false`)));
      const resources: RecursoRemoto[] = [];
      leidos.forEach((r, i) => {
        if (r.status === 404) return;
        const pack = decodeURIComponent(lote[i]!.split('/')[2]!);
        const body = exigirRegistro(r.body, 'pack ML');
        for (const crudo of exigirLista(body.messages, 'pack ML messages')) {
          const m = exigirRegistro(crudo, 'mensaje ML');
          const fechas = esRegistro(m.message_date) ? m.message_date : {};
          const id = idTexto(m.id);
          const projection = {
            id, pack_id: pack, status: valorOnull(m.status),
            date_created: valorOnull(fechas.created ?? m.date_created), date_available: valorOnull(fechas.available ?? m.date_available),
          };
          resources.push({ id, version: versionHash(projection), updatedAt: null, lifecycle: 'open', payload: m, projection });
        }
      });
      return { resources, nextPosition: fin ? null : { pendientes: resto, despuesDe }, cursorAfter };
    },
  };
}

const LOTE_MULTIGET = 20;

export function itemMl(crudo: unknown): RecursoRemoto {
  const it = exigirRegistro(crudo, 'item ML');
  const id = idTexto(it.id);
  const version = fechaUtc(it.last_updated);
  const variaciones = Array.isArray(it.variations) ? it.variations.filter(esRegistro) : [];
  return {
    id, version, updatedAt: version || null, lifecycle: cicloPorEstado(it.status, ['closed']), payload: it,
    projection: {
      id, status: valorOnull(it.status), sub_status: valorOnull(it.sub_status), last_updated: version,
      variations: variaciones.map((v) => ({ id: idTexto(v.id), available_quantity: valorOnull(v.available_quantity) })),
    },
  };
}

export function adaptadorItemsMl(dep: DependenciasMl): AdaptadorBarrido {
  return {
    // Items no tiene filtro por modificación: su única corriente es la vuelta completa diaria.
    topic: 'ml.items', cursorKind: 'full_scan', fullScan: true, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      const q = new URLSearchParams({ search_type: 'scan', limit: '100' });
      const scroll = textoPosicion(posicion, 'scroll_id');
      if (scroll) q.set('scroll_id', scroll);
      const ruta = `/users/${encodeURIComponent(dep.sellerId)}/items/search?${q}`;
      const body = exigirRegistro(exigirOk(await dep.transporte.get(ruta), 'items/search'), 'items/search');
      const ids = exigirLista(body.results, 'items/search results').map(idTexto);
      if (ids.some((id) => !id)) throw new ErrorCanalTerminal('ID_INVALIDO items/search');
      const lotes: string[][] = [];
      for (let i = 0; i < ids.length; i += LOTE_MULTIGET) lotes.push(ids.slice(i, i + LOTE_MULTIGET));
      // `/items/bulk?ids=` (sonda autenticada 2026-09-16): cada elemento trae su `status_code`.
      const respuestas = await Promise.all(lotes.map((lote) => dep.transporte.get(`/items/bulk?ids=${lote.map(encodeURIComponent).join(',')}`)));
      const resources: RecursoRemoto[] = [];
      const presentes: string[] = [];
      for (const r of respuestas) {
        for (const entrada of exigirLista(exigirOk(r, '/items/bulk'), '/items/bulk')) {
          const e = exigirRegistro(entrada, 'bulk');
          // Eliminada entre el scan y el bulk: no se observa y la vuelta completa la da de baja.
          if (e.status_code === 404) continue;
          if (e.status_code === 200) { resources.push(itemMl(e.body)); continue; }
          // Fallo parcial de un elemento: no invalida el lote ni lo da de baja; queda presente sin contenido.
          const id = idTexto(e.id);
          if (!id || !ids.includes(id)) throw new ErrorCanalTerminal('BULK_ID_INVALIDO /items/bulk');
          presentes.push(id);
        }
      }
      const siguiente = typeof body.scroll_id === 'string' && body.scroll_id && ids.length > 0 ? body.scroll_id : null;
      return { resources, presentes, nextPosition: siguiente ? { scroll_id: siguiente } : null, cursorAfter: cursorGeneracion(ctx.windowTo) };
    },
  };
}

export function crearAdaptadoresMl(dep: DependenciasMl): Record<string, AdaptadorBarrido> {
  return Object.fromEntries([
    adaptadorOrdenesMl(dep), adaptadorEnviosMl(dep), adaptadorPreguntasMl(dep),
    adaptadorMensajesMl(dep), adaptadorReclamosMl(dep), adaptadorItemsMl(dep),
  ].map((a) => [claveCorriente(a.topic, a.cursorKind), a]));
}
