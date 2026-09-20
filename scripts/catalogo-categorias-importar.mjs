#!/usr/bin/env node
/**
 * E2 T3 tarea 1 — importa las categorías de Woo como evidencia (nunca se promueve al árbol propio acá,
 * eso es la tarea 5, con decisión humana: ver docs/superpowers/plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md).
 *
 * Lee `GET /products/categories` de Woo (lectura pura, no escribe nada en el canal) y escribe en
 * PostgreSQL, tabla `catalog.channel_categories`. La lógica (normalización + upsert idempotente + cierre
 * forward-only) está en `plataforma/src/catalogo/categorias-canal.ts`; acá sólo hay argumentos, conexión
 * al canal y a PostgreSQL, e informe. Molde: scripts/catalogo-atributos-backfill.mjs.
 *
 * Config de Woo: WOO_URL/WOO_CK/WOO_CS de process.env (dotenv/config primero). Reusa `wooFetch` de
 * routes/woo.js: mismo patrón de URL (`cfg.url.replace(/\/$/, '') + '/wp-json/wc/v3' + path`) y mismo
 * manejo de error que el resto de la integración.
 *
 * Conexión a PostgreSQL: igual que catalogo-atributos-backfill.mjs — PG_HOST/PG_PORT/PG_DATABASE/PG_USER/
 * PG_PASSWORD(_FILE) de process.env ya poblado. Nunca abre plataforma.env.
 *
 * Idempotente y reanudable: una fila que ya está vigente e igual no se toca; una que cambió cierra la
 * vieja y abre una nueva; una que el canal dejó de informar se cierra (`vigente_hasta`), nunca se borra.
 *
 * Uso: node scripts/catalogo-categorias-importar.mjs --cuenta <channel_account_id> [--dry-run|--ejecutar]
 * Por defecto es dry-run: informa qué haría sin escribir nada. Para escribir hay que pasar --ejecutar.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { importarCategoriasCanal } from '../plataforma/src/catalogo/categorias-canal.ts';
import { crearPool } from '../plataforma/src/db/pool.ts';
import { wooFetch } from '../routes/woo.js';

function leerArgs(argv) {
  const o = { cuenta: null, dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cuenta') o.cuenta = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--ejecutar') o.dryRun = false;
    // Aceptar una baja masiva de categorías. Sin esto la corrida se detiene: una lectura incompleta del canal
    // no se puede distinguir de una baja real, así que la baja grande la confirma una persona.
    else if (a === '--permitir-baja') o.permitirBaja = true;
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
  if (!o.cuenta) { console.error('falta --cuenta <channel_account_id>'); process.exit(2); }
  return o;
}

const opciones = leerArgs(process.argv.slice(2));

if (!process.env.WOO_URL || !process.env.WOO_CK || !process.env.WOO_CS) {
  console.error('faltan WOO_URL/WOO_CK/WOO_CS en el entorno');
  process.exit(2);
}
if (!process.env.PG_PASSWORD && !process.env.PG_PASSWORD_FILE) {
  console.error('falta PG_PASSWORD o PG_PASSWORD_FILE en el entorno');
  process.exit(2);
}
const clave = process.env.PG_PASSWORD ?? readFileSync(process.env.PG_PASSWORD_FILE, 'utf8').trim();
if (!clave) { console.error('PG_PASSWORD_FILE está vacío'); process.exit(2); }
const url = `postgres://${encodeURIComponent(process.env.PG_USER ?? '')}:${encodeURIComponent(clave)}@${process.env.PG_HOST ?? 'pg'}:${process.env.PG_PORT ?? '5432'}/${process.env.PG_DATABASE ?? 'plataforma'}`;
const wooCfg = { url: process.env.WOO_URL, ck: process.env.WOO_CK, cs: process.env.WOO_CS };

// En dry-run igual hace falta company_id para el resumen; se resuelve desde la propia cuenta (no hay otra
// forma segura de saber a qué empresa pertenece sin leer plataforma.env, que este script nunca abre).
async function companyIdDeCuenta(pool, channelAccountId) {
  const r = await pool.query('SELECT company_id FROM core.channel_accounts WHERE id = $1', [channelAccountId]);
  if (!r.rows[0]) throw new Error(`no existe channel_account ${channelAccountId}`);
  return r.rows[0].company_id;
}

/**
 * Trae TODAS las categorías de Woo paginando per_page=100 hasta que una página vuelva incompleta.
 *
 * Un cuerpo que NO es una lista se trata como error y no como «página vacía». Antes era
 * `Array.isArray(resp.data) ? resp.data : []`, y con eso un 200 con el HTML de un WAF, o el objeto de error
 * de WordPress, se convertía en «el canal no tiene categorías» — que aguas abajo cerraba las 82 vigentes.
 * `wooFetch` sólo lanza cuando el status queda fuera de 2xx, así que ese caso llegaba hasta acá intacto.
 * Además se cotejan las páginas contra el total que Woo informa en `X-WP-Total`, cuando lo manda: es la única
 * forma de distinguir «terminó» de «la página vino corta por un error transitorio».
 */
async function listarTodasLasCategoriasWoo() {
  const categorias = [];
  let total = null;
  for (let page = 1; ; page++) {
    const resp = await wooFetch(wooCfg, `/products/categories?per_page=100&page=${page}`);
    if (!Array.isArray(resp.data)) {
      throw new Error(`WooCommerce devolvió un cuerpo que no es una lista de categorías en la página ${page}`);
    }
    const informado = Number(resp.headers?.['x-wp-total']);
    if (Number.isInteger(informado)) total = informado;
    categorias.push(...resp.data);
    if (resp.data.length < 100) break;
  }
  if (total !== null && categorias.length !== total) {
    throw new Error(`Woo informa ${total} categorías y se leyeron ${categorias.length}: lectura incompleta, no se importa`);
  }
  return categorias;
}

let codigoSalida = 0;
const pool = crearPool(url, { max: 1 });
try {
  const companyId = await companyIdDeCuenta(pool, opciones.cuenta);
  const resumen = await importarCategoriasCanal(pool, { listar: listarTodasLasCategoriasWoo }, {
    companyId, channelAccountId: opciones.cuenta, canal: 'woocommerce',
  }, { dryRun: opciones.dryRun, permitirBaja: opciones.permitirBaja });
  console.log(JSON.stringify({ dryRun: opciones.dryRun, cuenta: opciones.cuenta, ...resumen }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
