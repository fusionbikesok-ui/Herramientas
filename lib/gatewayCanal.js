/**
 * E1 T3 C5 — gateway interno de sólo lectura (diseño T3 §8).
 *
 * La plataforma no recibe tokens de ML ni consumer keys de Woo: cuando un barrido o una relectura
 * necesita leer un canal, pide una **operación simbólica** con parámetros de esquema cerrado, y es el
 * legado quien arma la ruta con plantillas fijas y la ejecuta con sus propios clientes. Ninguna entrada
 * controla método, host, path, query libre ni encabezados: el método es siempre GET, el host lo pone el
 * cliente del legado, el path sale de la plantilla y el vendedor de ML sale de la configuración.
 *
 * Toda operación desconocida o parámetro fuera de esquema falla ANTES de tocar la red.
 */

const DIGITOS = /^\d{1,20}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ITEM = /^[A-Z]{3}\d{1,15}$/;
const SCROLL = /^[A-Za-z0-9+/=_-]{1,512}$/;
const LIMITE_BUSQUEDA_ML = 50;
const TOPICOS_MISSED = ['orders_v2', 'shipments', 'questions', 'messages', 'claims', 'items'];
const POR_PAGINA_WOO = 100;

export class ErrorOperacionInvalida extends Error {
  constructor(message) { super(message); this.name = 'ErrorOperacionInvalida'; this.code = 'invalid_operation'; }
}

const entero = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const texto = (v, re) => typeof v === 'string' && re.test(v);

function exigir(cond, que) { if (!cond) throw new ErrorOperacionInvalida(`parámetro inválido: ${que}`); }

function cerrado(params, permitidos) {
  exigir(params && typeof params === 'object' && !Array.isArray(params), 'params');
  for (const k of Object.keys(params)) exigir(permitidos.includes(k), k);
}

const q = (o) => new URLSearchParams(o).toString();

/**
 * Catálogo cerrado. Cada operación valida sus parámetros y devuelve `{ canal, ruta, headers }`; `ctx.mlUserId`
 * es el vendedor configurado en el legado, nunca un dato de la petición.
 */
export const OPERACIONES = Object.freeze({
  'ml.orders.search': (p, ctx) => {
    cerrado(p, ['from', 'to', 'offset']);
    exigir(texto(p.from, ISO), 'from'); exigir(texto(p.to, ISO), 'to'); exigir(entero(p.offset, 0, 10_000), 'offset');
    return { canal: 'ml', ruta: `/orders/search?${q({ seller: ctx.mlUserId, 'order.date_last_updated.from': p.from, 'order.date_last_updated.to': p.to, sort: 'date_asc', limit: String(LIMITE_BUSQUEDA_ML), offset: String(p.offset) })}` };
  },
  // Lecturas individuales de C6 (relectura puntual por señal).
  'ml.order': (p) => { cerrado(p, ['id']); exigir(texto(p.id, DIGITOS), 'id'); return { canal: 'ml', ruta: `/orders/${p.id}` }; },
  'woo.order': (p) => { cerrado(p, ['id']); exigir(texto(p.id, DIGITOS), 'id'); return { canal: 'woo', ruta: `/orders/${p.id}` }; },
  'woo.product': (p) => { cerrado(p, ['id']); exigir(texto(p.id, DIGITOS), 'id'); return { canal: 'woo', ruta: `/products/${p.id}` }; },
  'ml.shipment': (p) => {
    cerrado(p, ['id']); exigir(texto(p.id, DIGITOS), 'id');
    return { canal: 'ml', ruta: `/shipments/${p.id}`, headers: { 'x-format-new': 'true' } };
  },
  'ml.questions.search': (p, ctx) => {
    cerrado(p, ['offset']); exigir(entero(p.offset, 0, 10_000), 'offset');
    return { canal: 'ml', ruta: `/questions/search?${q({ seller_id: ctx.mlUserId, api_version: '4', status: 'UNANSWERED', limit: String(LIMITE_BUSQUEDA_ML), offset: String(p.offset) })}` };
  },
  'ml.question': (p) => { cerrado(p, ['id']); exigir(texto(p.id, DIGITOS), 'id'); return { canal: 'ml', ruta: `/questions/${p.id}` }; },
  'ml.claims.search': (p, ctx) => {
    cerrado(p, ['offset']); exigir(entero(p.offset, 0, 10_000), 'offset');
    return { canal: 'ml', ruta: `/post-purchase/v1/claims/search?${q({ status: 'opened', 'players.user_id': ctx.mlUserId, 'players.role': 'respondent', limit: String(LIMITE_BUSQUEDA_ML), offset: String(p.offset) })}` };
  },
  'ml.claim': (p) => { cerrado(p, ['id']); exigir(texto(p.id, DIGITOS), 'id'); return { canal: 'ml', ruta: `/post-purchase/v1/claims/${p.id}` }; },
  // `missed_feeds` (C7): avisos que ML no pudo entregar, hasta dos días. `app_id` es ML_CLIENT_ID y
  // `site_id` es ML_SITE_ID, ambos de la configuración del legado; items exige sitio (diseño §10).
  // La forma de la respuesta NO está verificada por sonda: la plataforma la valida y falla cerrado.
  'ml.missed_feeds': (p, ctx) => {
    cerrado(p, ['topic', 'offset']);
    exigir(TOPICOS_MISSED.includes(p.topic), 'topic'); exigir(entero(p.offset, 0, 10_000), 'offset');
    exigir(texto(ctx.mlAppId, DIGITOS), 'app_id no configurado');
    const query = { app_id: ctx.mlAppId, topic: p.topic, offset: String(p.offset), limit: String(LIMITE_BUSQUEDA_ML) };
    if (p.topic === 'items') {
      exigir(texto(ctx.mlSiteId, /^M[A-Z]{2}$/), 'ML_SITE_ID requerido para items');
      query.site_id = ctx.mlSiteId;
    }
    return { canal: 'ml', ruta: `/missed_feeds?${q(query)}` };
  },
  'ml.messages.unread': (p) => { cerrado(p, []); return { canal: 'ml', ruta: '/messages/unread?role=seller&tag=post_sale' }; },
  // `mark_as_read=false` es fijo: leer un pack nunca puede marcar mensajes como leídos en ML.
  'ml.messages.pack': (p, ctx) => {
    cerrado(p, ['pack']); exigir(texto(p.pack, DIGITOS), 'pack');
    return { canal: 'ml', ruta: `/messages/packs/${p.pack}/sellers/${ctx.mlUserId}?tag=post_sale&mark_as_read=false` };
  },
  'ml.items.scan': (p, ctx) => {
    cerrado(p, ['scroll_id']);
    if (p.scroll_id !== undefined) exigir(texto(p.scroll_id, SCROLL), 'scroll_id');
    const query = { search_type: 'scan', limit: '100', ...(p.scroll_id ? { scroll_id: p.scroll_id } : {}) };
    return { canal: 'ml', ruta: `/users/${ctx.mlUserId}/items/search?${q(query)}` };
  },
  'ml.items.multiget': (p) => {
    cerrado(p, ['ids']);
    exigir(Array.isArray(p.ids) && p.ids.length >= 1 && p.ids.length <= 20 && p.ids.every((i) => texto(i, ITEM)), 'ids');
    // Bulk verificado por sonda autenticada 2026-09-16: `{id, status_code, body}` por elemento.
    return { canal: 'ml', ruta: `/items/bulk?ids=${p.ids.join(',')}` };
  },
  'woo.orders.list': (p) => {
    cerrado(p, ['after', 'before', 'page', 'status']);
    exigir(texto(p.after, ISO), 'after'); exigir(texto(p.before, ISO), 'before');
    exigir(entero(p.page, 1, 10_000), 'page'); exigir(['any', 'trash'].includes(p.status), 'status');
    return { canal: 'woo', ruta: `/orders?${q({ modified_after: p.after, modified_before: p.before, dates_are_gmt: 'true', per_page: String(POR_PAGINA_WOO), page: String(p.page), orderby: 'modified', order: 'asc', status: p.status })}` };
  },
  'woo.products.list': (p) => {
    cerrado(p, ['after', 'before', 'page']);
    exigir(texto(p.after, ISO), 'after'); exigir(texto(p.before, ISO), 'before'); exigir(entero(p.page, 1, 10_000), 'page');
    return { canal: 'woo', ruta: `/products?${q({ modified_after: p.after, modified_before: p.before, dates_are_gmt: 'true', per_page: String(POR_PAGINA_WOO), page: String(p.page), orderby: 'modified', order: 'asc', status: 'any' })}` };
  },
  'woo.variations.list': (p) => {
    cerrado(p, ['product', 'page']); exigir(texto(p.product, DIGITOS), 'product'); exigir(entero(p.page, 1, 10_000), 'page');
    return { canal: 'woo', ruta: `/products/${p.product}/variations?${q({ per_page: String(POR_PAGINA_WOO), page: String(p.page) })}` };
  },
  'woo.presence.list': (p) => {
    cerrado(p, ['resource', 'page', 'status']);
    exigir(['orders', 'products'].includes(p.resource), 'resource');
    exigir(entero(p.page, 1, 10_000), 'page'); exigir(['any', 'trash'].includes(p.status), 'status');
    return { canal: 'woo', ruta: `/${p.resource}?${q({ per_page: String(POR_PAGINA_WOO), page: String(p.page), orderby: 'id', order: 'asc', status: p.status, _fields: 'id' })}` };
  },
});

export function construirOperacion(peticion, ctx) {
  exigir(peticion && typeof peticion === 'object' && !Array.isArray(peticion), 'petición');
  for (const k of Object.keys(peticion)) exigir(k === 'op' || k === 'params', k);
  const plantilla = typeof peticion.op === 'string' && Object.hasOwn(OPERACIONES, peticion.op) ? OPERACIONES[peticion.op] : null;
  if (!plantilla) throw new ErrorOperacionInvalida('operación desconocida');
  return plantilla(peticion.params ?? {}, ctx);
}

const HEADERS_DEVUELTOS = ['x-wp-totalpages', 'x-wp-total', 'retry-after'];
const MAX_CUERPO_BYTES = 10 * 1024 * 1024;

/**
 * Presupuesto shadow de ML (§8): un bucket propio por minuto que se consulta ANTES de `mlFetch`. Hasta
 * medir siete días de llamadas el techo es cero, y cero significa 429 sintético sin salir a red: la
 * sombra nunca toma capacidad del legado por defecto.
 */
export function crearPresupuestoShadow(rpm, ahora = () => Date.now()) {
  let ventana = 0; let usados = 0;
  return () => {
    if (!(rpm > 0)) return false;
    const minuto = Math.floor(ahora() / 60_000);
    if (minuto !== ventana) { ventana = minuto; usados = 0; }
    if (usados >= rpm) return false;
    usados += 1; return true;
  };
}

/**
 * Ejecuta una petición del gateway. `ejecutarMl(ruta, headers)` y `ejecutarWoo(ruta)` se inyectan: en
 * producción envuelven `mlFetch` y `wooFetch`, en pruebas son falsos. Devuelve siempre
 * `{ status, headers, body }` saneado: nunca tokens, URLs completas ni cuerpos de error remotos.
 */
export function crearGatewayCanal({ mlUserId, mlAppId = null, mlSiteId = null, ejecutarMl, ejecutarWoo, presupuestoMl = crearPresupuestoShadow(0), metricas = null }) {
  let wooEnCurso = Promise.resolve();
  return async function ejecutar(peticion) {
    const op = construirOperacion(peticion, { mlUserId, mlAppId, mlSiteId });
    const inicio = Date.now();
    let res;
    if (op.canal === 'ml') {
      if (!mlUserId) throw new ErrorOperacionInvalida('ML no configurado en el legado');
      if (!presupuestoMl()) {
        res = { status: 429, headers: { 'retry-after': '60' }, body: null };
      } else {
        const r = await ejecutarMl(op.ruta, op.headers ?? {});
        res = { status: r.status, headers: r.headers ?? {}, body: r.status >= 200 && r.status < 300 ? r.data : null };
      }
    } else {
      // Concurrencia 1 contra Woo: la tienda es un WordPress compartido con la operación.
      const turno = wooEnCurso.then(async () => {
        try {
          const r = await ejecutarWoo(op.ruta);
          return { status: r.status, headers: r.headers ?? {}, body: r.data };
        } catch (e) {
          if (Number.isInteger(e?.status)) {
            return { status: e.status, headers: e.retryAfterMs != null ? { 'retry-after': String(Math.ceil(e.retryAfterMs / 1000)) } : {}, body: null };
          }
          throw e;
        }
      });
      wooEnCurso = turno.catch(() => undefined);
      res = await turno;
    }
    const headers = {};
    for (const h of HEADERS_DEVUELTOS) {
      const v = res.headers?.[h];
      if (v !== undefined && v !== null) headers[h] = String(v).slice(0, 64);
    }
    if (res.body !== null && res.body !== undefined && Buffer.byteLength(JSON.stringify(res.body)) > MAX_CUERPO_BYTES) {
      res = { status: 502, body: null };
    }
    metricas?.({ op: peticion.op, status: res.status, ms: Date.now() - inicio });
    return { status: res.status, headers, body: res.body ?? null };
  };
}
