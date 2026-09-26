/*
 * scripts/e3-replay.ts — replay previo al canario (E3 corte 3 T7). SOLO LECTURA: imprime el JSON, no escribe nada.
 * Uso: DATABASE_URL=… node --experimental-strip-types plataforma/scripts/e3-replay.ts <empresa-uuid> [desde ISO] [hasta ISO]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { replay } from '../src/identidad/replay.ts';

const [empresa, desde, hasta] = process.argv.slice(2);
if (!empresa || !process.env.DATABASE_URL) { console.error('uso: DATABASE_URL=… e3-replay.ts <empresa> [desde] [hasta]'); process.exit(2); }
const aqui = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(aqui, '../test/identidad/fixtures/muestra-30.json'), 'utf8'));
const muestra = fx.casos.map((c: { clave: string; ml: never; sku_verdad?: string }) => ({ clave: c.clave, ml: c.ml, skuVerdad: c.sku_verdad ?? null }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const ahora = new Date();
  const r = await replay(pool, { empresa, muestra, catalogo: fx.catalogo,
    desde: desde ? new Date(desde) : new Date(ahora.getTime() - 30 * 864e5), hasta: hasta ? new Date(hasta) : ahora });
  console.log(JSON.stringify(r, null, 2));
} finally { await pool.end(); }
