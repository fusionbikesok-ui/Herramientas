/**
 * Relevamiento de SOLO LECTURA de la superficie real de Mercado Libre.
 *
 * Objetivo: saber qué acciones permite de verdad esta cuenta con este token, en lugar de
 * planificar contra documentación que además bloquea el acceso automatizado. ML publica en
 * cada recurso un `available_actions` que depende de la cuenta, el rol y el estado del caso:
 * eso es la fuente de verdad, no el catálogo teórico de endpoints.
 *
 * Reglas de este script:
 * - Solo GET. No modifica nada en ML ni en la base.
 * - No imprime datos de clientes. De cada objeto se vuelca la ESTRUCTURA (nombres de campos)
 *   y los valores de campos operativos conocidos (estados, acciones, tipos). Cualquier otro
 *   valor se reemplaza por su tipo.
 * - Pocas llamadas y espaciadas, para no gastar la cuota compartida con la operación real.
 */
import 'dotenv/config';
import { openDb } from '../db/index.js';
import { mlFetch } from '../lib/mlClient.js';

const db = openDb(process.env.DB_PATH || 'data/fusion.sqlite');
const cfg = {
  clientId: process.env.ML_CLIENT_ID,
  clientSecret: process.env.ML_CLIENT_SECRET,
  userId: process.env.ML_USER_ID,
};

/** Campos cuyo VALOR es operativo y seguro de mostrar. El resto se reduce a su tipo. */
const SEGUROS = new Set([
  'status', 'stage', 'type', 'substatus', 'reason_id', 'site_id', 'available_actions',
  'action', 'role', 'expected_resolution', 'resolution', 'claim_id', 'resource',
  'date_created', 'last_updated', 'quantity', 'currency_id', 'shipping_mode',
  'logistic_type', 'tags', 'fulfilled', 'mediation', 'players', 'reason', 'code',
]);

const esObjeto = (v) => v !== null && typeof v === 'object';

/** Reduce un objeto a estructura + valores operativos, sin datos personales. */
function resumir(valor, profundidad = 0) {
  if (profundidad > 4) return '…';
  if (Array.isArray(valor)) {
    if (valor.length === 0) return [];
    // Un array de strings cortos suele ser una lista de acciones o tags: se muestra entero.
    if (valor.every((v) => typeof v === 'string')) return valor;
    return [resumir(valor[0], profundidad + 1), `…(${valor.length} elementos)`];
  }
  if (!esObjeto(valor)) return typeof valor;
  const salida = {};
  for (const [clave, v] of Object.entries(valor)) {
    if (SEGUROS.has(clave)) salida[clave] = esObjeto(v) ? resumir(v, profundidad + 1) : v;
    else salida[clave] = esObjeto(v) ? resumir(v, profundidad + 1) : typeof v;
  }
  return salida;
}

const resultados = {};

async function mirar(nombre, ruta) {
  try {
    const r = await mlFetch(db, cfg, 'GET', ruta);
    resultados[nombre] = { ok: true, ruta, forma: resumir(r) };
    console.error(`  ok   ${nombre}`);
  } catch (e) {
    const status = e?.response?.status || e?.status || null;
    // El error también informa: un 403 dice que el scope no alcanza; un 404, que el recurso
    // no existe para esta cuenta. Se guarda sin cuerpo, que puede traer datos.
    resultados[nombre] = { ok: false, ruta, status, motivo: e?.message?.slice(0, 120) || 'error' };
    console.error(`  FALLA ${nombre} (${status || 'sin status'})`);
  }
  await new Promise((r) => setTimeout(r, 600));
}

const unaFila = (sql) => { try { return db.prepare(sql).get(); } catch { return null; } };

console.error('Relevamiento de solo lectura de Mercado Libre');
console.error(`Cuenta configurada: ML_USER_ID=${cfg.userId ? 'definido' : 'AUSENTE'}`);

// 1. Identidad y alcance del token.
await mirar('usuario', '/users/me');

// 2. Reclamo real: es donde vive available_actions, el dato que decide qué podemos ofrecer.
const reclamo = unaFila("SELECT id FROM ml_reclamos ORDER BY actualizado_en DESC LIMIT 1");
if (reclamo?.id) {
  await mirar('reclamo_post_purchase', `/post-purchase/v1/claims/${reclamo.id}`);
  await mirar('reclamo_mensajes', `/post-purchase/v1/claims/${reclamo.id}/messages`);
  await mirar('reclamo_acciones_esperadas', `/post-purchase/v1/claims/${reclamo.id}/expected-resolutions`);
} else {
  console.error('  (sin reclamos locales para consultar)');
}

// 3. Pregunta real: para ver estado y si el recurso declara acciones.
const pregunta = unaFila("SELECT id FROM ml_preguntas ORDER BY actualizado_en DESC LIMIT 1");
if (pregunta?.id) await mirar('pregunta', `/questions/${pregunta.id}`);

// 4. Búsqueda de preguntas sin responder: es la cola de trabajo real.
if (cfg.userId) await mirar('preguntas_sin_responder', `/questions/search?seller_id=${cfg.userId}&status=UNANSWERED&limit=1`);

// 5. Orden reciente: forma del pedido y qué trae de envío.
const orden = unaFila("SELECT ml_order_id FROM pedidos_cache WHERE ml_order_id IS NOT NULL ORDER BY fecha DESC LIMIT 1");
if (orden?.ml_order_id) await mirar('orden', `/orders/${orden.ml_order_id}`);

// 6. Mensajería posventa por pack: el canal de conversación con el comprador.
const pack = unaFila("SELECT pack_id FROM pedidos_cache WHERE pack_id IS NOT NULL ORDER BY fecha DESC LIMIT 1");
if (pack?.pack_id && cfg.userId) {
  await mirar('mensajes_pack', `/messages/packs/${pack.pack_id}/sellers/${cfg.userId}`);
}

// 7. Publicación propia: qué campos son editables se deduce de lo que devuelve.
const item = unaFila("SELECT item_id FROM ml_publicaciones_cache LIMIT 1") || unaFila("SELECT item_id FROM ml_preguntas WHERE item_id IS NOT NULL LIMIT 1");
if (item?.item_id) await mirar('publicacion', `/items/${item.item_id}`);

console.log(JSON.stringify(resultados, null, 2));
db.close();
