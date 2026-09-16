import type pg from 'pg';
import { esRegistro, idTexto } from './adaptadores/comun.ts';
import { ErrorCanalTerminal, type TransporteCanal } from './cliente-http.ts';

/**
 * `missed_feeds` de Mercado Libre (E1 T3 §10, corte C7): avisos que ML no pudo entregar con 200, hasta
 * dos días. Es un **suplemento**, no una garantía de reparación (eso son los barridos).
 *
 * - Enumera cada tópico desde offset cero, sin cursor: nunca se omiten filas por "ya vistas".
 * - Deduplica por notification id (`_id`): la señal usa `mf:<_id>` como fingerprint, así que repetir la
 *   enumeración cada 30 minutos no crea señales nuevas.
 * - Crea señales `ml_missed_feed` y nunca observaciones: la verdad sale de la relectura.
 *
 * **La forma de la respuesta no está verificada por sonda autenticada** (sólo lo está el multiget). El
 * parser exige `messages` como lista y un total entero; ante cualquier otra forma el tópico falla
 * cerrado con `FORMA_MISSED_FEEDS` y no crea nada. Verificarla es requisito del canario (C10).
 */

/** Tópicos que se consultan, y la equivalencia de cada aviso con los ocho tópicos de E1 (§6). */
export const TOPICOS_CONSULTADOS = ['orders_v2', 'shipments', 'questions', 'messages', 'claims', 'items'] as const;
const EQUIVALENCIA: Readonly<Record<string, string>> = {
  orders: 'ml.orders', orders_v2: 'ml.orders', shipments: 'ml.shipments', questions: 'ml.questions',
  messages: 'ml.messages', claims: 'ml.claims', post_purchase: 'ml.claims', items: 'ml.items',
};
/** Id remoto pelado a partir del `resource` del aviso, por tópico E1. Mensajes: el id no se resuelve. */
const RECURSO: Readonly<Record<string, RegExp>> = {
  'ml.orders': /^\/orders\/(\d{1,20})$/,
  'ml.shipments': /^\/shipments\/(\d{1,20})$/,
  'ml.questions': /^\/questions\/(\d{1,20})$/,
  'ml.claims': /^\/(?:post-purchase\/v1\/)?claims\/(\d{1,20})$/,
  'ml.items': /^\/items\/([A-Z]{3}\d{1,15})$/,
  'ml.messages': /^\/?([A-Za-z0-9_-]{1,128})$/,
};
const MAX_PAGINAS = 200;

export interface CoberturaTopico {
  topic: string;
  total: number;
  enumerados: number;
  nuevas: number;
  duplicadas: number;
  excluidos: number;
  error?: string;
}

export async function enumerarMissedFeeds(opciones: {
  db: pg.Pool;
  transporte: TransporteCanal;
  channelAccountId: string;
  sellerId: string;
}): Promise<CoberturaTopico[]> {
  const cobertura: CoberturaTopico[] = [];
  for (const consulta of TOPICOS_CONSULTADOS) {
    const c: CoberturaTopico = { topic: consulta, total: 0, enumerados: 0, nuevas: 0, duplicadas: 0, excluidos: 0 };
    cobertura.push(c);
    try {
      let offset = 0;
      for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
        const r = await opciones.transporte.get(`/missed_feeds?${new URLSearchParams({ topic: consulta, offset: String(offset), limit: '50' })}`);
        if (r.status === 404) throw new ErrorCanalTerminal('HTTP_404 /missed_feeds', 404);
        const body = r.body;
        const total = esRegistro(body) ? Number(body.total ?? (esRegistro(body.paging) ? body.paging.total : undefined)) : Number.NaN;
        if (!esRegistro(body) || !Array.isArray(body.messages) || !Number.isInteger(total) || total < 0) {
          throw new ErrorCanalTerminal('FORMA_MISSED_FEEDS');
        }
        c.total = total;
        for (const crudo of body.messages) {
          c.enumerados++;
          const aviso = esRegistro(crudo) ? crudo : {};
          const notificacion = typeof aviso._id === 'string' ? aviso._id.trim() : '';
          const topic = typeof aviso.topic === 'string' ? EQUIVALENCIA[aviso.topic] : EQUIVALENCIA[consulta];
          const usuario = idTexto(aviso.user_id);
          const coincide = topic ? String(aviso.resource ?? '').match(RECURSO[topic]!) : null;
          // Aviso de otra cuenta, sin id de notificación, de un tópico fuera de E1 o con recurso ilegible:
          // se cuenta y se excluye, sin ampliar E1 ni inventar un recurso.
          if (!notificacion || notificacion.length > 256 || !topic || !coincide || (usuario && usuario !== opciones.sellerId)) {
            c.excluidos++;
            continue;
          }
          const insertada = await opciones.db.query(
            `INSERT INTO integrations.reconciliation_signals
               (channel_account_id,topic,resource_id,notification_id,fingerprint,source)
             VALUES ($1,$2,$3,$4,$5,'ml_missed_feed') ON CONFLICT DO NOTHING`,
            [opciones.channelAccountId, topic, coincide[1], notificacion, `mf:${notificacion}`],
          );
          if (insertada.rowCount) c.nuevas++; else c.duplicadas++;
        }
        offset += body.messages.length;
        if (body.messages.length === 0 || offset >= total) break;
      }
    } catch (error) {
      // Un tópico que falla no frena a los demás: items sin sitio configurado no tapa pedidos.
      c.error = error instanceof Error ? error.message.split(' ')[0]! : 'desconocido';
    }
  }
  return cobertura;
}
