import { randomBytes } from 'node:crypto';
import { ErrorBarridoReintentable, ErrorCupoSombraAgotado } from '../worker/barridos.ts';
import { firmar } from '../seguridad/interna.ts';
import type { KeyringSobre } from '../seguridad/sobre.ts';
import {
  ErrorCanalTerminal, ErrorDestinoProhibido, parsearRetryAfter, type RespuestaCanal, type TransporteCanal,
} from './cliente-http.ts';
// Fuente única del mapeo tópico→corriente (E1 T5 spec §2.1): la validación de `missed_feeds` no mantiene
// su propia lista de tópicos aceptados, se deriva de la misma tabla que usa el gateway del legado.
// @ts-expect-error módulo JS del legado sin tipos
import { TOPIC_A_CORRIENTE } from '../../../lib/gatewayCanal.js';

const TOPICOS_MISSED_FEEDS = new Set(Object.keys(TOPIC_A_CORRIENTE as Record<string, string>));

/**
 * Transporte de canal a través del gateway GET del legado (E1 T3 §8, corte C5).
 *
 * Los adaptadores siguen pidiendo rutas como en T2; este transporte las traduce a una operación
 * simbólica del catálogo cerrado del legado (`lib/gatewayCanal.js`) y la manda firmada por el plano de
 * control. Una ruta que no corresponde exactamente a una operación —otro path, un parámetro de más, un
 * valor fijo distinto o un encabezado no previsto— falla **antes de red**. El legado vuelve a validar y
 * arma la ruta con sus propias plantillas: la plataforma nunca decide método, host, path ni query.
 *
 * No es `TransporteCanal` de T2 contra un canal: es plano de control local y no lleva `x-fusion-plano: canal`.
 */
export const RUTA_GATEWAY = '/internal/v1/channel-read';
// El plano de control sólo habla con el legado en el mismo host: loopback o el host de Docker.
const HOSTS_GATEWAY = new Set(['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal']);
const WOO = '/wp-json/wc/v3';

export interface Operacion { op: string; params: Record<string, unknown> }

/** Consumidores del gateway (spec §2.8, decisión de José opción b): E2/E3 no comparten cupo con E1. */
export type Consumidor = 'e1' | 'catalogo' | 'identidad';

function prohibida(motivo: string): never {
  throw new ErrorDestinoProhibido(`ruta sin operación de gateway: ${motivo}`);
}

/** Exige exactamente estas claves: `fijos` con su valor y `variables` presentes. `opcionales` pueden faltar. */
function exacto(q: URLSearchParams, fijos: Record<string, string>, variables: readonly string[], opcionales: readonly string[] = []): Record<string, string> {
  const claves = [...q.keys()];
  if (new Set(claves).size !== claves.length) prohibida('parámetro repetido');
  const permitidas = new Set([...Object.keys(fijos), ...variables, ...opcionales]);
  for (const k of claves) if (!permitidas.has(k)) prohibida(`parámetro ${k}`);
  for (const [k, v] of Object.entries(fijos)) if (q.get(k) !== v) prohibida(`valor de ${k}`);
  const salida: Record<string, string> = {};
  for (const k of variables) { const v = q.get(k); if (v === null) prohibida(`falta ${k}`); salida[k] = v; }
  for (const k of opcionales) { const v = q.get(k); if (v !== null) salida[k] = v; }
  return salida;
}

const entero = (v: string): number => (/^\d{1,6}$/.test(v) ? Number(v) : prohibida('entero'));

/**
 * Traduce una ruta de adaptador a operación. `sellerId` es el vendedor de la cuenta en el registro: si
 * la ruta nombra otro, es un error de configuración y no sale a red.
 */
export function rutaAOperacion(ruta: string, headers: Readonly<Record<string, string>>, sellerId?: string): Operacion {
  if (!ruta.startsWith('/') || ruta.startsWith('//')) prohibida('ruta relativa');
  const url = new URL(ruta, 'http://gateway.invalid');
  if (url.host !== 'gateway.invalid' || url.hash) prohibida('destino');
  const p = url.pathname; const q = url.searchParams;
  const cabeceras = Object.entries(headers).map(([k, v]) => `${k.toLowerCase()}=${v}`);
  const vendedor = (v: string) => { if (!sellerId || v !== sellerId) prohibida('vendedor'); };
  const sinCabeceras = () => { if (cabeceras.length) prohibida('encabezado'); };
  let m: RegExpMatchArray | null;

  if ((m = p.match(/^\/shipments\/(\d{1,20})$/))) {
    if (cabeceras.length !== 1 || cabeceras[0] !== 'x-format-new=true') prohibida('envío');
    exacto(q, {}, []);
    return { op: 'ml.shipment', params: { id: m[1]! } };
  }
  sinCabeceras();
  if (p === '/orders/search') {
    const v = exacto(q, { sort: 'date_asc', limit: '50' }, ['seller', 'order.date_last_updated.from', 'order.date_last_updated.to', 'offset']);
    vendedor(v.seller!);
    return { op: 'ml.orders.search', params: { from: v['order.date_last_updated.from'], to: v['order.date_last_updated.to'], offset: entero(v.offset!) } };
  }
  if (p === '/questions/search') {
    const v = exacto(q, { api_version: '4', status: 'UNANSWERED', limit: '50' }, ['seller_id', 'offset']);
    vendedor(v.seller_id!);
    return { op: 'ml.questions.search', params: { offset: entero(v.offset!) } };
  }
  if ((m = p.match(/^\/orders\/(\d{1,20})$/))) { exacto(q, {}, []); return { op: 'ml.order', params: { id: m[1]! } }; }
  if ((m = p.match(/^\/wp-json\/wc\/v3\/(orders|products)\/(\d{1,20})$/))) {
    exacto(q, {}, []);
    return { op: m[1] === 'orders' ? 'woo.order' : 'woo.product', params: { id: m[2]! } };
  }
  if ((m = p.match(/^\/questions\/(\d{1,20})$/))) { exacto(q, {}, []); return { op: 'ml.question', params: { id: m[1]! } }; }
  if (p === '/post-purchase/v1/claims/search') {
    const v = exacto(q, { status: 'opened', 'players.role': 'respondent', limit: '50' }, ['players.user_id', 'offset']);
    vendedor(v['players.user_id']!);
    return { op: 'ml.claims.search', params: { offset: entero(v.offset!) } };
  }
  if ((m = p.match(/^\/post-purchase\/v1\/claims\/(\d{1,20})$/))) { exacto(q, {}, []); return { op: 'ml.claim', params: { id: m[1]! } }; }
  if (p === '/missed_feeds') {
    // `app_id` y `site_id` los agrega el legado desde su configuración: la plataforma no los decide.
    const v = exacto(q, { limit: '50' }, ['topic', 'offset']);
    if (!TOPICOS_MISSED_FEEDS.has(v.topic!)) prohibida('topic');
    return { op: 'ml.missed_feeds', params: { topic: v.topic, offset: entero(v.offset!) } };
  }
  if (p === '/messages/unread') { exacto(q, { role: 'seller', tag: 'post_sale' }, []); return { op: 'ml.messages.unread', params: {} }; }
  if ((m = p.match(/^\/messages\/packs\/(\d{1,20})\/sellers\/(\d{1,20})$/))) {
    exacto(q, { tag: 'post_sale', mark_as_read: 'false' }, []);
    vendedor(m[2]!);
    return { op: 'ml.messages.pack', params: { pack: m[1]! } };
  }
  if ((m = p.match(/^\/users\/(\d{1,20})\/items\/search$/))) {
    const v = exacto(q, { search_type: 'scan', limit: '100' }, [], ['scroll_id']);
    vendedor(m[1]!);
    return { op: 'ml.items.scan', params: v.scroll_id ? { scroll_id: v.scroll_id } : {} };
  }
  if (p === '/items/bulk') {
    const v = exacto(q, {}, ['ids']);
    return { op: 'ml.items.multiget', params: { ids: v.ids!.split(',') } };
  }
  if ((m = p.match(/^\/wp-json\/wc\/v3\/(orders|products)$/))) {
    const recurso = m[1] as 'orders' | 'products';
    if (q.get('_fields') === 'id') {
      const v = exacto(q, { per_page: '100', orderby: 'id', order: 'asc', _fields: 'id' }, ['page', 'status']);
      return { op: 'woo.presence.list', params: { resource: recurso, page: entero(v.page!), status: v.status } };
    }
    const fijos = { dates_are_gmt: 'true', per_page: '100', orderby: 'modified', order: 'asc', ...(recurso === 'products' ? { status: 'any' } : {}) };
    const v = exacto(q, fijos, ['modified_after', 'modified_before', 'page', ...(recurso === 'orders' ? ['status'] : [])]);
    return recurso === 'orders'
      ? { op: 'woo.orders.list', params: { after: v.modified_after, before: v.modified_before, page: entero(v.page!), status: v.status } }
      : { op: 'woo.products.list', params: { after: v.modified_after, before: v.modified_before, page: entero(v.page!) } };
  }
  if ((m = p.match(/^\/wp-json\/wc\/v3\/products\/(\d{1,20})\/variations$/))) {
    const v = exacto(q, { per_page: '100' }, ['page']);
    return { op: 'woo.variations.list', params: { product: m[1]!, page: entero(v.page!) } };
  }
  return prohibida(p.startsWith(WOO) ? 'ruta Woo' : 'ruta');
}

export function crearTransporteGateway(opciones: {
  url: string;
  keyring: KeyringSobre;
  sellerId?: string;
  /** Fija el consumidor por instancia de transporte (spec §2.8): quien llama nunca lo decide. Default 'e1'. */
  consumidor?: Consumidor;
  timeoutMs?: number;
  fetch?: typeof fetch;
  reloj?: () => Date;
}): TransporteCanal {
  let base: URL;
  try { base = new URL(opciones.url); } catch { throw new ErrorDestinoProhibido('URL de gateway inválida'); }
  if (!['http:', 'https:'].includes(base.protocol) || !HOSTS_GATEWAY.has(base.hostname) || base.username || base.password || (base.pathname !== '/' && base.pathname !== '')) {
    throw new ErrorDestinoProhibido(`gateway no permitido: ${base.hostname}`);
  }
  const destino = new URL(RUTA_GATEWAY, base);
  const hacerFetch = opciones.fetch ?? fetch;
  const reloj = opciones.reloj ?? (() => new Date());
  const clave = opciones.keyring.keys[opciones.keyring.activeKeyId];
  if (!clave) throw new ErrorDestinoProhibido('clave activa del gateway ausente');

  return {
    async get(ruta, extra = {}) {
      const operacion = rutaAOperacion(ruta, extra.headers ?? {}, opciones.sellerId);
      const consumidor = opciones.consumidor ?? 'e1';
      const cuerpo = Buffer.from(JSON.stringify(consumidor === 'e1' ? operacion : { ...operacion, consumidor }));
      const ts = String(Math.floor(reloj().getTime() / 1000));
      const nonce = randomBytes(18).toString('base64url');
      let respuesta: Response;
      try {
        respuesta = await hacerFetch(destino, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(opciones.timeoutMs ?? 30_000),
          headers: {
            'content-type': 'application/json', accept: 'application/json',
            'x-fusion-key-id': opciones.keyring.activeKeyId, 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
            'x-fusion-signature': firmar(clave, ts, nonce, 'POST', RUTA_GATEWAY, cuerpo),
          },
          body: cuerpo,
        });
      } catch {
        throw new ErrorBarridoReintentable(`GATEWAY_RED ${operacion.op}`);
      }
      // Estado del propio gateway: 401/400 son configuración o contrato roto; 5xx es transitorio.
      if (respuesta.status !== 200) {
        await respuesta.body?.cancel().catch(() => undefined);
        if (respuesta.status >= 500) throw new ErrorBarridoReintentable(`GATEWAY_HTTP_${respuesta.status} ${operacion.op}`);
        throw new ErrorCanalTerminal(`GATEWAY_HTTP_${respuesta.status} ${operacion.op}`, respuesta.status);
      }
      let sobre: { status?: unknown; headers?: unknown; body?: unknown };
      try { sobre = await respuesta.json() as typeof sobre; } catch { throw new ErrorBarridoReintentable(`GATEWAY_RESPUESTA ${operacion.op}`); }
      const status = Number(sobre.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new ErrorCanalTerminal(`GATEWAY_SOBRE ${operacion.op}`);
      const headers = new Headers();
      if (sobre.headers && typeof sobre.headers === 'object') {
        for (const [k, v] of Object.entries(sobre.headers as Record<string, unknown>)) if (typeof v === 'string') headers.set(k, v);
      }
      // Un 429 del gateway sombra por cupo agotado (spec §2.3) no es un 429 real de ML/Woo: se distingue por
      // el header `x-fusion-cupo` y no consume intento de la corrida/señal (§2.4), a diferencia de HTTP_429.
      if (status === 429 && headers.get('x-fusion-cupo') === 'sombra-agotado') {
        throw new ErrorCupoSombraAgotado(`CUPO_SOMBRA_AGOTADO ${operacion.op}`, parsearRetryAfter(headers.get('retry-after'), reloj()) ?? 60);
      }
      // Mismo mapeo que el cliente T2 para que los adaptadores no distingan el transporte.
      if (status === 408 || status === 429 || status >= 500) {
        throw new ErrorBarridoReintentable(`HTTP_${status} ${operacion.op}`, parsearRetryAfter(headers.get('retry-after'), reloj()));
      }
      if (status >= 300 && status !== 404) throw new ErrorCanalTerminal(`HTTP_${status} ${operacion.op}`, status);
      return { status, headers, body: sobre.body ?? null } satisfies RespuestaCanal;
    },
  };
}
