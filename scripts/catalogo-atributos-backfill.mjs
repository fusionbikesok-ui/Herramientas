#!/usr/bin/env node
/**
 * E2 T2 — llena atributos, imágenes y datos comerciales de las representaciones que T1 ya proyectó.
 *
 * Lee los cachés del legado (`catalogo_cache`, `ml_publicaciones_cache`) y escribe en PostgreSQL. Vive acá porque
 * es el único lugar desde donde se puede leer el SQLite del legado y escribir en PostgreSQL a la vez. La lógica
 * está en `plataforma/src/catalogo/backfill-atributos.ts` (y reusa los extractores de woo.ts y ml.ts: una sola
 * implementación de la normalización); acá sólo hay argumentos, conexiones e informe.
 *
 * Usa los cachés y no el canal a propósito, contradiciendo la decisión de T1 de "releer desde el origen": T1
 * hablaba de identidad, donde un caché atrasado corrompe decisiones; acá son atributos descriptivos y un color
 * desactualizado se corrige en el próximo cambio del producto. Ver §7 del diseño de T2.
 *
 * Idempotente y reanudable sin estado extra: procesa `capturado_en IS NULL`. No abre casos de divergencia.
 * El SQLite se abre de sólo lectura y no pasa por `openDb` (que crea el directorio y migra: un script que sólo
 * mira no debe poder escribir la base del legado). `DB_PATH` sale de `dotenv/config`; sin él llega undefined.
 *
 * Conexión a PostgreSQL: igual que revivir-senales.mjs — PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD(_FILE)
 * de process.env ya poblado. Nunca abre plataforma.env.
 *
 * Uso: node scripts/catalogo-atributos-backfill.mjs [--lote N] [--dry-run|--ejecutar]
 * Por defecto es dry-run: informa qué haría sin escribir nada. Para escribir hay que pasar --ejecutar.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { backfillAtributos } from '../plataforma/src/catalogo/backfill-atributos.ts';
import { crearPool } from '../plataforma/src/db/pool.ts';

function leerArgs(argv) {
  const o = { lote: 200, dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lote') o.lote = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--ejecutar') o.dryRun = false;
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
  if (!Number.isInteger(o.lote) || o.lote < 1 || o.lote > 1000) { console.error('--lote debe ser un entero entre 1 y 1000'); process.exit(2); }
  return o;
}

const opciones = leerArgs(process.argv.slice(2));

if (!process.env.DB_PATH) { console.error('falta DB_PATH (la base SQLite del legado)'); process.exit(2); }
if (!process.env.PG_PASSWORD && !process.env.PG_PASSWORD_FILE) {
  console.error('falta PG_PASSWORD o PG_PASSWORD_FILE en el entorno');
  process.exit(2);
}
const clave = process.env.PG_PASSWORD ?? readFileSync(process.env.PG_PASSWORD_FILE, 'utf8').trim();
if (!clave) { console.error('PG_PASSWORD_FILE está vacío'); process.exit(2); }
const url = `postgres://${encodeURIComponent(process.env.PG_USER ?? '')}:${encodeURIComponent(clave)}@${process.env.PG_HOST ?? 'pg'}:${process.env.PG_PORT ?? '5432'}/${process.env.PG_DATABASE ?? 'plataforma'}`;

let codigoSalida = 0;
let sqlite;
const pool = crearPool(url, { max: 1 });
try {
  sqlite = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
  const woo = sqlite.prepare('SELECT * FROM catalogo_cache WHERE id_woo = ?');
  const ml = sqlite.prepare('SELECT * FROM ml_publicaciones_cache WHERE clave = ?');
  const mlItem = sqlite.prepare('SELECT * FROM ml_publicaciones_cache WHERE item_id = ? ORDER BY clave LIMIT 1');
  const resumen = await backfillAtributos(pool, {
    woo: (id) => woo.get(/^[0-9]+$/.test(id) ? Number(id) : -1),
    ml: (c) => ml.get(c),
    mlDeItem: (item) => mlItem.get(item),
  }, opciones);
  console.log(JSON.stringify({ dryRun: opciones.dryRun, lote: opciones.lote, ...resumen }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  codigoSalida = 1;
} finally {
  sqlite?.close();
  await pool.end();
}
process.exit(codigoSalida);
