import type { Consultable } from '../../db/pool.ts';
import { ErrorBarridoReintentable } from '../../worker/barridos.ts';
import { hashCanonico } from '../canonico.ts';
import { ErrorCanalTerminal, type RespuestaCanal, type TransporteCanal } from '../cliente-http.ts';
import { claveCorriente, type AdaptadorBarrido, type ContextoListado, type PaginaRemota, type RecursoRemoto, type RelacionRemota } from '../tipos.ts';
import {
  BOOTSTRAP_ORDENES_MS, DIA_MS, cicloPorEstado, esRegistro, exigirLista, exigirRegistro, fechaUtc, finSegmento,
  idTexto, inicioVentana, numeroPosicion, textoPosicion, valorOnull, type Registro,
} from './comun.ts';

export interface DependenciasMl {
  transporte: TransporteCanal; db: Consultable; sellerId: string;
  /** Inyectables para test: la espera entre reintentos/páginas y el azar del jitter. */
  esperar?: (ms: number) => Promise<void>; azar?: () => number; ahora?: () => number;
}

// Una llamada por página: el motor confirma el avance antes del siguiente consumo de cupo.
const LOTE_INDIVIDUAL = 1;
/** Relecturas de un segmento de órdenes antes de declararlo inestable y dejar el cursor quieto. */
const MAX_RELECTURAS_SEGMENTO = 3;
// El código de ml.messages lee y avanza de a UN pack (pendientes[0] + slice(1), despuesDe = último leído): con un lote
// mayor se saltearían packs en silencio. Por eso se verifica al crear el adaptador.
const LOTE_PACKS: number = 1;
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
  /*
   * `date_last_updated` no siempre viene: una orden recién creada y nunca modificada puede traerlo nulo o
   * ausente. Antes eso dejaba `version` en cadena vacía, `validarRecurso` lanzaba ErrorPaginaInvalida y el
   * worker de señales lo clasificaba como TERMINAL: la señal moría sin reintento y la orden nunca entraba
   * a la copia. Así se clavó el registro de órdenes el 2026-09-12, con 35 señales muertas.
   *
   * La fecha de creación es una versión legítima para una orden que no se modificó nunca, y es monótona
   * respecto de sí misma: si después la orden cambia, llega con `date_last_updated` posterior y gana.
   */
  const version = fechaUtc(o.date_last_updated) || fechaUtc(o.date_created);
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
      const resources: RecursoRemoto[] = [];
      const esperar = dep.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      // Al separar el lote en páginas, conservar la pausa entre envíos de la implementación anterior.
      if (despuesDe && ids.length) await esperar(PAUSA_ENTRE_PAGINAS_MS);
      for (let i = 0; i < ids.length; i++) {
        const r = await dep.transporte.get(`/shipments/${encodeURIComponent(ids[i]!)}`, { headers: { 'x-format-new': 'true' } });
        if (r.status !== 404) resources.push(envioMl(r.body));
        if (i + 1 < ids.length) await esperar(PAUSA_ENTRE_PAGINAS_MS);
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
// La guía de ML recomienda `/messages/unread` sólo como validación redundante del flujo de notificaciones.
// Las notificaciones y missed_feeds cubren el flujo frecuente; este respaldo se consulta cada seis horas.
const INTERVALO_UNREAD_MS = 6 * 60 * 60 * 1000;
// Dos ritmos (a 10 RPM los ~470 packs de 30 días tardan ~47 min y no entran en la vuelta de 20 min):
// la vuelta liviana lee sólo packs con motivo; el recorrido completo queda como control, una vez por día.
const INTERVALO_COMPLETA_MS = DIA_MS;
const MAX_AVISOS_WEBHOOK = 100;
const MAX_PACKS_CAMBIADOS = 500;
const PREFIJO_MENSAJE = 'msg:';
/** Punto de reanudación (t, id) de cada consulta liviana: se consulta con `(t, id) > (luz.t, luz.id)`, así que más filas
 *  empatadas en `t` que el tope no frenan la ventana. */
interface PuntoLuz { t: string; id: string }
interface Luz { avisos: PuntoLuz; pedidos: PuntoLuz }
const esPunto = (v: unknown): v is PuntoLuz => esRegistro(v) && typeof v.t === 'string' && Number.isFinite(Date.parse(v.t)) && typeof v.id === 'string';
function luzDe(v: unknown, respaldo: string): Luz {
  const base: PuntoLuz = { t: respaldo, id: '' };
  return esRegistro(v) ? { avisos: esPunto(v.avisos) ? v.avisos : base, pedidos: esPunto(v.pedidos) ? v.pedidos : base } : { avisos: base, pedidos: base };
}
const rutaPack = (pack: string, vendedor: string): string => `/packs/${encodeURIComponent(pack)}/sellers/${encodeURIComponent(vendedor)}`;
const packDeRecurso = (recurso: string): string => decodeURIComponent(recurso.split('/')[2]!);

/** Forma común entre GET /messages/{id} (notificación) y GET /messages/packs/{pack}/sellers/{seller}. */
export function mensajeMl(crudo: unknown, packId?: string): RecursoRemoto {
  const sobre = exigirRegistro(crudo, 'mensaje ML');
  // GET /messages/{id} puede devolver el mensaje directo (formato legacy) o el sobre actualizado
  // { messages: [...] }. El pack también entrega cada mensaje dentro de esa lista.
  const mensajes = Array.isArray(sobre.messages) ? exigirLista(sobre.messages, 'mensaje ML messages') : [sobre];
  if (mensajes.length !== 1) throw new ErrorCanalTerminal('FORMA_MENSAJE_ML');
  const m = exigirRegistro(mensajes[0], 'mensaje ML');
  const fechas = esRegistro(m.message_date) ? m.message_date : {};
  const id = idTexto(m.id ?? m.message_id);
  const packEnRecursos = Array.isArray(m.message_resources)
    ? m.message_resources.find((r) => esRegistro(r) && r.name === 'packs' && typeof r.id === 'string')
    : undefined;
  const pack = packId ?? (esRegistro(packEnRecursos) ? packEnRecursos.id as string : null);
  const projection = {
    id, pack_id: pack, status: valorOnull(m.status),
    date_created: valorOnull(fechas.created ?? m.date_created ?? m.date ?? m.date_received),
    date_available: valorOnull(fechas.available ?? m.date_available),
  };
  return { id, version: versionHash(projection), updatedAt: null, lifecycle: 'open', payload: m, projection };
}

export function adaptadorMensajesMl(dep: DependenciasMl): AdaptadorBarrido {
  if (LOTE_PACKS !== 1) throw new Error('ml.messages asume un pack por página (LOTE_PACKS=1)');
  return {
    topic: 'ml.messages', cursorKind: 'state_sweep', fullScan: false, versionKind: 'hash',
    async listar(ctx, posicionInicial): Promise<PaginaRemota> {
      const instante = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN);
      const antes = ctx.corrida.cursorBefore;
      const ultimoUnread = instante(antes?.last_unread_at);
      const ultimaCompleta = instante(antes?.last_full_at);
      const comprobarUnread = !Number.isFinite(ultimoUnread) || ctx.windowTo.getTime() - ultimoUnread >= INTERVALO_UNREAD_MS;
      const completa = posicionInicial === null
        ? !Number.isFinite(ultimaCompleta) || ctx.windowTo.getTime() - ultimaCompleta >= INTERVALO_COMPLETA_MS
        : posicionInicial.completa === true;
      const perdidosPrevios = numeroPosicion(posicionInicial, 'perdidos', 0);
      const iso = (n: number) => new Date(n).toISOString();
      // `last_light_at` es hasta dónde la vuelta liviana cubrió TODO: si un tope recortó la lista, no llega a windowTo.
      // El motor persiste este cursor sólo al cerrar la corrida (por página guarda únicamente la posición).
      const armarCursor = (luz: Luz, recortados: boolean, perdidos: number) => ({
        ...cursorGeneracion(ctx.windowTo),
        last_unread_at: comprobarUnread ? ctx.windowTo.toISOString() : iso(ultimoUnread),
        // `light` es el punto exacto por consulta; `last_light_at` es el más atrasado de los dos (informativo).
        last_light_at: Date.parse(luz.avisos.t) <= Date.parse(luz.pedidos.t) ? luz.avisos.t : luz.pedidos.t,
        light: luz,
        ...(completa ? { last_full_at: ctx.windowTo.toISOString() } : Number.isFinite(ultimaCompleta) ? { last_full_at: iso(ultimaCompleta) } : {}),
        // Mensajes que sólo el recorrido de control encontró y la sombra no tenía: lo que la vuelta liviana no avisó.
        avisos_perdidos: perdidos,
        avisos_recortados: recortados,
      });

      if (posicionInicial === null) {
        // Vuelta liviana: sólo los packs con motivo. El recorrido de 30 días queda para la vuelta de control.
        // Cursor sin `light` (versión anterior): se arranca de `last_light_at`, o de un día atrás si no hay nada.
        const inicial = typeof antes?.last_light_at === 'string' && Number.isFinite(Date.parse(antes.last_light_at))
          ? antes.last_light_at : iso(ctx.windowTo.getTime() - DIA_MS);
        const punto = luzDe(antes?.light, inicial);
        const candidatos: string[] = [];
        if (comprobarUnread) {
          const body = exigirRegistro(exigirOk(await dep.transporte.get('/messages/unread?role=seller&tag=post_sale'), '/messages/unread'), '/messages/unread');
          // `resource` se usa tal como lo devuelve ML: rearmarlo con otro vendedor produce 404.
          for (const r of exigirLista(body.results, '/messages/unread results')) {
            const recurso = esRegistro(r) && typeof r.resource === 'string' ? r.resource.trim() : '';
            if (RECURSO_PACK.test(recurso)) candidatos.push(recurso);
          }
        }
        // Avisos por webhook que todavía no se convirtieron en mensaje (los `succeeded` ya están leídos). Del más viejo al
        // más nuevo, acotados a la ventana congelada de la corrida (`<= windowTo`), por clave (t, id) y con tope+1.
        const avisos = await dep.db.query<{ resource_id: string; t: Date | string }>(
          `SELECT resource_id COLLATE "C" AS resource_id, MIN(received_at) AS t FROM integrations.reconciliation_signals
            WHERE channel_account_id=$1 AND topic='ml.messages' AND status <> 'succeeded'
              AND received_at <= $4 AND (received_at, resource_id COLLATE "C") > ($2::timestamptz, $3::text)
            GROUP BY 1 ORDER BY MIN(received_at), 1 LIMIT $5`,
          [ctx.corrida.channelAccountId, new Date(punto.avisos.t), punto.avisos.id, ctx.windowTo, MAX_AVISOS_WEBHOOK + 1],
        );
        // Pedidos que cambiaron en la ventana de la corrida, con la misma clave.
        const cambiados = await dep.db.query<{ target_id: string; t: Date | string }>(
          `SELECT target_id COLLATE "C" AS target_id, MIN(last_seen_at) AS t FROM integrations.resource_relations
            WHERE channel_account_id=$1 AND relation_type='order_pack' AND target_topic='ml.messages'
              AND last_seen_at <= $4 AND (last_seen_at, target_id COLLATE "C") > ($2::timestamptz, $3::text)
            GROUP BY 1 ORDER BY MIN(last_seen_at), 1 LIMIT $5`,
          [ctx.corrida.channelAccountId, new Date(punto.pedidos.t), punto.pedidos.id, ctx.windowTo, MAX_PACKS_CAMBIADOS + 1],
        );
        const fin: PuntoLuz = { t: iso(ctx.windowTo.getTime()), id: '' };
        const luz: Luz = { avisos: fin, pedidos: fin }; let recortados = false;
        const recortar = <T extends { t: Date | string }>(filas: T[], tope: number, clave: keyof Luz, idDe: (f: T) => string): T[] => {
          if (filas.length <= tope) return filas;
          recortados = true;
          const ultimo = filas[tope - 1]!;
          luz[clave] = { t: iso(ultimo.t instanceof Date ? ultimo.t.getTime() : Date.parse(String(ultimo.t))), id: idDe(ultimo) };
          return filas.slice(0, tope);
        };
        for (const f of recortar(avisos.rows, MAX_AVISOS_WEBHOOK, 'avisos', (x) => x.resource_id)) candidatos.push(`${PREFIJO_MENSAJE}${f.resource_id}`);
        for (const f of recortar(cambiados.rows, MAX_PACKS_CAMBIADOS, 'pedidos', (x) => x.target_id)) candidatos.push(rutaPack(f.target_id, dep.sellerId));
        const pendientes = [...new Set(candidatos)];
        const vistos = [...new Set(pendientes.filter((p) => p.startsWith('/packs/')).map(packDeRecurso))];
        return {
          resources: [],
          // Liviana sin nada que leer: la vuelta termina acá, sin una página vacía de más.
          nextPosition: !completa && !pendientes.length ? null
            : { pendientes, despuesDe: '', completa, vistos, perdidos: perdidosPrevios, luz, recortados },
          cursorAfter: armarCursor(luz, recortados, perdidosPrevios),
        };
      }

      const luz = luzDe(posicionInicial.luz, ctx.windowTo.toISOString());
      const recortados = posicionInicial.recortados === true;
      const pendientesPrevios = Array.isArray(posicionInicial.pendientes) ? posicionInicial.pendientes.filter((p): p is string => typeof p === 'string') : [];
      const vistos = new Set(Array.isArray(posicionInicial.vistos) ? posicionInicial.vistos.filter((p): p is string => typeof p === 'string') : []);
      let despuesDe = textoPosicion(posicionInicial, 'despuesDe') ?? '';
      let resto: string[] = []; let lote: string | null = null; let fin = false;
      let leidoEnControl = false;
      if (pendientesPrevios.length) {
        lote = pendientesPrevios[0]!; resto = pendientesPrevios.slice(LOTE_PACKS);
      } else if (completa) {
        const packs = (await dep.db.query<{ target_id: string }>(
          `SELECT DISTINCT target_id COLLATE "C" AS target_id FROM integrations.resource_relations
            WHERE channel_account_id=$1 AND relation_type='order_pack' AND target_topic='ml.messages'
              AND last_seen_at >= $2 AND target_id COLLATE "C" > $3
            ORDER BY 1 LIMIT $4`,
          [ctx.corrida.channelAccountId, new Date(ctx.windowTo.getTime() - 30 * DIA_MS), despuesDe, LOTE_PACKS],
        )).rows.map((f) => f.target_id);
        if (packs.length) {
          despuesDe = packs.at(-1)!;
          // Un pack que la vuelta liviana ya leyó no se pide dos veces.
          if (!vistos.has(packs[0]!)) { lote = rutaPack(packs[0]!, dep.sellerId); leidoEnControl = true; }
        }
        fin = packs.length < LOTE_PACKS;
      } else fin = true;

      const resources: RecursoRemoto[] = [];
      let perdidos = perdidosPrevios;
      if (lote !== null) {
        if (lote.startsWith(PREFIJO_MENSAJE)) {
          // Aviso por webhook: el mensaje dice a qué pack pertenece; ese pack se lee después si no estaba ya.
          const r = await dep.transporte.get(`/messages/${encodeURIComponent(lote.slice(PREFIJO_MENSAJE.length))}?tag=post_sale`, { headers: { 'x-format-new': 'true' } });
          if (r.status !== 404) {
            const recurso = mensajeMl(r.body);
            resources.push(recurso);
            const pack = esRegistro(recurso.projection) && typeof recurso.projection.pack_id === 'string' ? recurso.projection.pack_id : null;
            if (pack && !vistos.has(pack)) { vistos.add(pack); resto = [rutaPack(pack, dep.sellerId), ...resto]; }
          }
        } else {
          const packId = packDeRecurso(lote);
          vistos.add(packId);
          const r = await dep.transporte.get(`/messages${lote}?tag=post_sale&mark_as_read=false`);
          if (r.status !== 404) {
            const body = exigirRegistro(r.body, 'pack ML');
            const mensajes = exigirLista(body.messages, 'pack ML messages').map((m) => mensajeMl(m, packId));
            resources.push(...mensajes);
            if (leidoEnControl && mensajes.length) {
              // «Perdido» = mensaje que la sombra todavía no tenía proyectado; una conversación vieja ya leída no suma.
              const conocidos = await dep.db.query<{ resource_id: string }>(
                `SELECT resource_id FROM integrations.resource_observations
                  WHERE channel_account_id=$1 AND topic='ml.messages' AND resource_id = ANY($2::text[])`,
                [ctx.corrida.channelAccountId, mensajes.map((m) => m.id)],
              );
              const ya = new Set(conocidos.rows.map((f) => f.resource_id));
              perdidos += mensajes.filter((m) => !ya.has(m.id)).length;
            }
          }
        }
      }
      return {
        resources,
        nextPosition: fin ? null : { pendientes: resto, despuesDe, completa, vistos: [...vistos], perdidos, luz, recortados },
        cursorAfter: armarCursor(luz, recortados, perdidos),
      };
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

// Guía de ML (Rate limit / Error 429): backoff exponencial con jitter, sin ráfagas, y consumir el scroll
// (vence a los 5 min) de forma continua. Un 429/5xx aislado se reintenta en el mismo pedido; si la espera
// acumulada supera el presupuesto, se deja caer la vuelta para que la corrida reintente más tarde.
const PAUSA_ENTRE_PAGINAS_MS = 300;
const PRESUPUESTO_REINTENTO_MS = 90_000;
const MAX_REINTENTOS_PEDIDO = 6;

/** El presupuesto de una página: el scan y cada /items/bulk secuencial de esa página lo COMPARTEN (no uno
 *  cada uno), porque en conjunto no pueden superar los 5 minutos que dura vivo el scroll_id de ML. */
interface PresupuestoReintento { gastadoMs: number }
const nuevoPresupuesto = (): PresupuestoReintento => ({ gastadoMs: 0 });

async function conReintento<T>(dep: DependenciasMl, presupuesto: PresupuestoReintento, pedido: () => Promise<T>): Promise<T> {
  const esperar = dep.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const azar = dep.azar ?? Math.random;
  for (let intento = 0; ; intento++) {
    try {
      return await pedido();
    } catch (error) {
      if (!(error instanceof ErrorBarridoReintentable) || intento >= MAX_REINTENTOS_PEDIDO) throw error;
      const ms = error.retryAfter !== undefined
        ? error.retryAfter * 1000
        : Math.round(Math.min(30_000, 1000 * 2 ** intento) * (0.8 + 0.4 * azar()));
      if (presupuesto.gastadoMs + ms > PRESUPUESTO_REINTENTO_MS) throw error;
      presupuesto.gastadoMs += ms;
      await esperar(ms);
    }
  }
}

export function adaptadorItemsMl(dep: DependenciasMl): AdaptadorBarrido {
  return {
    // Items no tiene filtro por modificación: su única corriente es la vuelta completa diaria.
    topic: 'ml.items', cursorKind: 'full_scan', fullScan: true, versionKind: 'temporal',
    async listar(ctx, posicion): Promise<PaginaRemota> {
      // El scan y cada bulk son páginas DURABLES distintas. Si se agota el cupo, el motor ya
      // conservó los IDs enumerados y los bulk anteriores; nunca vuelve a gastar el scan para
      // reconstruir una página que necesita más permisos que los disponibles.
      const ahora = (dep.ahora ?? Date.now)();
      const scroll = textoPosicion(posicion, 'scroll_id');
      const scrollEn = typeof posicion?.scroll_en === 'number' ? posicion.scroll_en : null;
      if (scroll && scrollEn !== null && ahora - scrollEn >= 5 * 60_000) {
        // Terminal para ESTA vuelta: el motor no ejecuta declararBajas y la próxima comienza de cero.
        throw new ErrorCanalTerminal('SCROLL_VENCIDO ml.items');
      }
      const presupuesto = { gastadoMs: numeroPosicion(posicion, 'reintento_ms', 0) };
      if (posicion?.fase !== 'contenido') {
        const q = new URLSearchParams({ search_type: 'scan', limit: '100' });
        if (scroll) {
          q.set('scroll_id', scroll);
          await (dep.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(PAUSA_ENTRE_PAGINAS_MS);
        }
        // El presupuesto se reinicia por página de SCAN, no por bulk.
        const presupuestoScan = nuevoPresupuesto();
        const ruta = `/users/${encodeURIComponent(dep.sellerId)}/items/search?${q}`;
        const body = exigirRegistro(exigirOk(await conReintento(dep, presupuestoScan, () => dep.transporte.get(ruta)), 'items/search'), 'items/search');
        const ids = exigirLista(body.results, 'items/search results').map(idTexto);
        if (ids.some((id) => !id)) throw new ErrorCanalTerminal('ID_INVALIDO items/search');
        const siguiente = typeof body.scroll_id === 'string' && body.scroll_id ? body.scroll_id : null;
        return {
          resources: [],
          nextPosition: ids.length ? { fase: 'contenido', pendientes: ids, scroll_id: siguiente,
            scroll_en: (dep.ahora ?? Date.now)(), reintento_ms: presupuestoScan.gastadoMs } : null,
          cursorAfter: cursorGeneracion(ctx.windowTo),
        };
      }
      const ids = exigirLista(posicion.pendientes, 'items pendientes').map(idTexto);
      if (!ids.length || ids.some((id) => !id)) throw new ErrorCanalTerminal('ID_INVALIDO items pendientes');
      const lote = ids.slice(0, LOTE_MULTIGET);
      const respuesta = await conReintento(dep, presupuesto, () => dep.transporte.get(`/items/bulk?ids=${lote.map(encodeURIComponent).join(',')}`));
      const respuestas = [respuesta];
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
          if (!id || !lote.includes(id)) throw new ErrorCanalTerminal('BULK_ID_INVALIDO /items/bulk');
          presentes.push(id);
        }
      }
      const resto = ids.slice(LOTE_MULTIGET);
      const nextPosition = resto.length
        ? { ...posicion, pendientes: resto, reintento_ms: presupuesto.gastadoMs }
        : scroll ? { scroll_id: scroll, scroll_en: scrollEn } : null;
      return { resources, presentes, nextPosition, cursorAfter: cursorGeneracion(ctx.windowTo) };
    },
  };
}

export function crearAdaptadoresMl(dep: DependenciasMl): Record<string, AdaptadorBarrido> {
  return Object.fromEntries([
    adaptadorOrdenesMl(dep), adaptadorEnviosMl(dep), adaptadorPreguntasMl(dep),
    adaptadorMensajesMl(dep), adaptadorReclamosMl(dep), adaptadorItemsMl(dep),
  ].map((a) => [claveCorriente(a.topic, a.cursorKind), a]));
}
