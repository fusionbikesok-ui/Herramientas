#!/usr/bin/env node
// Alta idempotente de los webhooks de WooCommerce que le faltan a E-1b y E-1c: order.created, order.deleted y order.restored
// (order.updated ya existe) y product.restored (product.created/updated/deleted ya existen: ids 8/9/10 en la tienda). El handler `/api/woo/webhook/order` los acepta a los cuatro; cualquiera solo dispara el trabajo
// `order.woo` y la relectura fresca decide, así que registrar estos tres agrega cobertura (pedido creado a mano, borrado y
// restaurado se enteran al instante) sin cambiar qué se hace con cada uno.
//
// E-1c: `product.restored` (sale de la papelera) va al endpoint de producto; el handler lo trata igual que `updated`: dispara el
// trabajo `catalog.woo_product_sync` y decide la relectura. Sin este webhook propio, un producto restaurado de la papelera solo
// se entera por el barrido de catálogo. Es idempotente: los de pedidos ya creados quedan "ya_activo" y no se tocan.
//
// CUÁNDO: DESPUÉS de desplegar E-1b (pedidos) y E-1c (product.restored). Antes, el handler viejo rechaza esos topics (400) y Woo deshabilitaría el webhook tras
// varias entregas fallidas. Es decisión de José registrarlos en prod: este script no corre solo.
//
// USO (siempre con DB_PATH ABSOLUTO: un DB_PATH relativo apunta a otra base según el cwd, ver notas de deploy):
//   DB_PATH=/opt/fusionbikes/herramientas/data/fusion.sqlite node scripts/ops/alta-webhooks-woo-ordenes.mjs --dry-run
//   DB_PATH=/opt/fusionbikes/herramientas/data/fusion.sqlite node scripts/ops/alta-webhooks-woo-ordenes.mjs
//   ... --reactivar   # además pasa a "active" los que ya existen pero están paused/disabled
//
// Variables: WOO_URL, WOO_CK, WOO_CS (credenciales REST), WOO_WEBHOOK_SECRET (secreto de firma, el MISMO que usa el server;
// nunca se imprime ni se loguea), DB_PATH (absoluto; solo se usa para refrescar la lista de webhooks conocidos).
//
// Qué hace: lee `GET /wc/v3/webhooks` (todas las páginas); por cada topic, si ya hay un webhook con ese topic y nuestro
// delivery_url, NO crea otro (active → nada; paused/disabled → nada, salvo --reactivar que lo activa). Si falta, lo crea
// (status active). La versión de API del webhook es la que Woo asigna por defecto (WP REST API v3). Al terminar refresca
// `woo_webhooks_estado` para que el monitor y la lista de IDs conocidos los vean. Un aviso de un ID recién creado puede recibir
// un 401 transitorio hasta que el server relea la lista (mínimo 30 s entre lecturas); Woo reintenta la entrega.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DELIVERY_URL = 'https://herramientas.fusionbikes.com.ar/api/woo/webhook/order';
export const DELIVERY_URL_PRODUCTO = 'https://herramientas.fusionbikes.com.ar/api/woo/webhook/product';
export const TOPICS_NUEVOS = ['order.created', 'order.deleted', 'order.restored'];
export const TOPICS_PRODUCTO_NUEVOS = ['product.restored'];

const redactar = (texto, secreto) => (secreto ? String(texto ?? '').split(secreto).join('***') : String(texto ?? ''));

async function listarTodos(wooFetch, cfg) {
  const todos = [];
  for (let page = 1; page <= 20; page++) {
    const r = await wooFetch(cfg, `/webhooks?per_page=100&page=${page}`);
    if (!Array.isArray(r?.data)) throw new Error('Woo devolvió una forma inesperada en GET /webhooks');
    todos.push(...r.data);
    if (r.data.length < 100) return todos;
  }
  throw new Error('GET /webhooks: más de 20 páginas, no concluyente');
}

/**
 * @param {object} p
 * @param {Function} p.wooFetch  (cfg, path, method, body) → {status, data}
 * @param {object} p.cfg         credenciales Woo
 * @param {string} p.secreto     WOO_WEBHOOK_SECRET (se envía a Woo; jamás se imprime)
 * @param {boolean} [p.dryRun]
 * @param {boolean} [p.reactivar]
 * @param {Function} [p.refrescar]  async () → refresca la lista de webhooks conocidos (se llama solo si hubo cambios reales)
 * @param {Function} [p.log]
 * @returns {Promise<{acciones: {topic:string, accion:string, id?:number}[]}>}
 */
export async function altaWebhooksWooOrdenes({ wooFetch, cfg, secreto, dryRun = false, reactivar = false, refrescar = null, log = console.log, deliveryUrl = DELIVERY_URL, deliveryUrlProducto = DELIVERY_URL_PRODUCTO }) {
  if (!dryRun && !secreto) throw new Error('falta WOO_WEBHOOK_SECRET: sin secreto los webhooks nacerían sin firma válida');
  const lista = await listarTodos(wooFetch, cfg);
  const acciones = [];
  let hubo = false;
  const nuevos = [...TOPICS_NUEVOS.map((topic) => ({ topic, deliveryUrl })), ...TOPICS_PRODUCTO_NUEVOS.map((topic) => ({ topic, deliveryUrl: deliveryUrlProducto }))];
  for (const { topic, deliveryUrl } of nuevos) {
    const propios = lista.filter((w) => w.topic === topic && String(w.delivery_url) === deliveryUrl);
    const activo = propios.find((w) => w.status === 'active');
    if (activo) { acciones.push({ topic, accion: 'ya_activo', id: activo.id }); log(`${topic}: ya existe y está activo (id ${activo.id}), no se toca`); continue; }
    if (propios.length) {
      const w = propios[0];
      if (!reactivar) { acciones.push({ topic, accion: 'existe_inactivo', id: w.id }); log(`${topic}: existe pero está ${w.status} (id ${w.id}); no se duplica. Usá --reactivar para activarlo`); continue; }
      if (dryRun) { acciones.push({ topic, accion: 'reactivaria', id: w.id }); log(`${topic}: [dry-run] se reactivaría el id ${w.id} (${w.status})`); continue; }
      await wooFetch(cfg, `/webhooks/${w.id}`, 'put', { status: 'active' });
      hubo = true; acciones.push({ topic, accion: 'reactivado', id: w.id }); log(`${topic}: reactivado (id ${w.id})`);
      continue;
    }
    if (dryRun) { acciones.push({ topic, accion: 'crearia' }); log(`${topic}: [dry-run] se crearía → ${deliveryUrl}`); continue; }
    const r = await wooFetch(cfg, '/webhooks', 'post', { name: `Herramientas ${topic}`, topic, delivery_url: deliveryUrl, secret: secreto, status: 'active' });
    hubo = true; acciones.push({ topic, accion: 'creado', id: r?.data?.id }); log(`${topic}: creado (id ${r?.data?.id ?? '?'})`);
  }
  if (hubo && refrescar) {
    try { await refrescar(); log('lista de webhooks conocidos refrescada'); } catch (e) { log(`no se pudo refrescar la lista de webhooks: ${redactar(e.message, secreto)} (el server la relee solo al ver un ID desconocido)`); }
  }
  return { acciones };
}

async function main() {
  await import('dotenv/config');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const reactivar = args.includes('--reactivar');
  const secreto = process.env.WOO_WEBHOOK_SECRET || '';
  const dbPath = process.env.DB_PATH || '';
  if (!dryRun && (!dbPath || !path.isAbsolute(dbPath))) {
    console.error('DB_PATH debe estar definido y ser ABSOLUTO (un path relativo apunta a otra base según el cwd).');
    process.exit(2);
  }
  if (!dryRun && !secreto) { console.error('Falta WOO_WEBHOOK_SECRET.'); process.exit(2); }
  const { wooFetch } = await import('../../routes/woo.js');
  const cfg = { url: process.env.WOO_URL, ck: process.env.WOO_CK, cs: process.env.WOO_CS };
  console.log(`alta-webhooks-woo-ordenes: ${dryRun ? 'DRY-RUN (no escribe nada)' : 'APLICANDO'}${reactivar ? ' · --reactivar' : ''} · destinos ${DELIVERY_URL} y ${DELIVERY_URL_PRODUCTO}`);
  try {
    const refrescar = dryRun ? null : async () => {
      const { openDb } = await import('../../db/index.js');
      const { refrescarWebhooksWoo } = await import('../../lib/wooWebhooks.js');
      const db = openDb(dbPath);
      try { const r = await refrescarWebhooksWoo(db, cfg); if (!r.ok) throw new Error(r.error); } finally { db.close(); }
    };
    await altaWebhooksWooOrdenes({ wooFetch, cfg, secreto, dryRun, reactivar, refrescar, log: (m) => console.log(redactar(m, secreto)) });
  } catch (e) {
    console.error(`ERROR: ${redactar(e.message, secreto)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
