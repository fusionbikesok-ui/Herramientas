#!/usr/bin/env node
/**
 * E2 T3 — mapea al árbol propio las categorías de MercadoLibre de MAPEO_ML (`arbol-fusionbikes.ts`). NO toca el
 * árbol ni MAPEO_WOO: usa los nodos que ya están cargados. Dry-run por default; escribe sólo con --ejecutar.
 * Molde: scripts/catalogo-arbol-cargar.mjs. Cuenta lo que QUEDÓ en la base, no las llamadas.
 *
 * Uso: node scripts/catalogo-arbol-mapear-ml.mjs --empresa <uuid> --cuenta <channel_account_id ML> [--ejecutar]
 * Entorno: PG_HOST/PG_PORT/PG_DATABASE/PG_USER y PG_PASSWORD o PG_PASSWORD_FILE.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { MAPEO_ML } from '../plataforma/src/catalogo/arbol-fusionbikes.ts';
import { aplicarMapeoCategorias } from '../plataforma/src/catalogo/mapeo-canal.ts';
import { crearPool } from '../plataforma/src/db/pool.ts';

function argumentos(argv) {
  const o = { ejecutar: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ejecutar') o.ejecutar = true;
    else if (a === '--empresa') o.empresa = argv[++i];
    else if (a === '--cuenta') o.cuenta = argv[++i];
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
  if (!o.empresa || !o.cuenta) {
    console.error('uso: catalogo-arbol-mapear-ml.mjs --empresa <uuid> --cuenta <uuid> [--ejecutar]');
    process.exit(2);
  }
  return o;
}

if (!process.env.PG_PASSWORD && !process.env.PG_PASSWORD_FILE) {
  console.error('falta PG_PASSWORD o PG_PASSWORD_FILE en el entorno');
  process.exit(2);
}
const opciones = argumentos(process.argv);
const clave = process.env.PG_PASSWORD ?? readFileSync(process.env.PG_PASSWORD_FILE, 'utf8').trim();
const url = `postgres://${encodeURIComponent(process.env.PG_USER ?? '')}:${encodeURIComponent(clave)}`
  + `@${process.env.PG_HOST ?? '127.0.0.1'}:${process.env.PG_PORT ?? '5432'}`
  + `/${process.env.PG_DATABASE ?? 'plataforma'}`;
const pool = crearPool(url, { max: 2 });

let codigoSalida = 0;
try {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resumen = await aplicarMapeoCategorias(cliente, {
      empresa: opciones.empresa, cuenta: opciones.cuenta, canal: 'mercadolibre',
      mapeo: MAPEO_ML, decididoPor: 'jose', dryRun: !opciones.ejecutar,
    });
    await cliente.query(opciones.ejecutar ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ dryRun: !opciones.ejecutar, ...resumen,
      nota: opciones.ejecutar ? 'mapeos escritos' : 'no se escribió nada' }, null, 2));
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
} catch (e) {
  console.error(`falló el mapeo de ML: ${e.message}`);
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
