#!/usr/bin/env node
/**
 * E2 T3 tarea 3 — el informe de candidatos, solapamientos y cobertura que José usa para decidir el árbol
 * propio (D1-D4 del plan, docs/superpowers/plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md).
 *
 * SÓLO LECTURA. Este script nunca escribe: no tiene `--ejecutar` ni ninguna otra forma de mutar la base.
 * La lógica está en plataforma/src/catalogo/informe-taxonomia.ts; acá sólo hay argumentos, conexión e
 * informe. Molde: scripts/catalogo-atributos-backfill.mjs (conexión) y catalogo-categorias-importar.mjs.
 *
 * Conexión a PostgreSQL: PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD(_FILE) de process.env ya
 * poblado. Nunca abre plataforma.env.
 *
 * Uso: node scripts/catalogo-informe-taxonomia.mjs --empresa <company_id> --cuenta <channel_account_id>
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { generarInforme } from '../plataforma/src/catalogo/informe-taxonomia.ts';
import { crearPool } from '../plataforma/src/db/pool.ts';

function leerArgs(argv) {
  const o = { empresa: null, cuenta: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--empresa') o.empresa = argv[++i];
    else if (a === '--cuenta') o.cuenta = argv[++i];
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
  if (!o.empresa) { console.error('falta --empresa <company_id>'); process.exit(2); }
  if (!o.cuenta) { console.error('falta --cuenta <channel_account_id>'); process.exit(2); }
  return o;
}

const opciones = leerArgs(process.argv.slice(2));

if (!process.env.PG_PASSWORD && !process.env.PG_PASSWORD_FILE) {
  console.error('falta PG_PASSWORD o PG_PASSWORD_FILE en el entorno');
  process.exit(2);
}
const clave = process.env.PG_PASSWORD ?? readFileSync(process.env.PG_PASSWORD_FILE, 'utf8').trim();
if (!clave) { console.error('PG_PASSWORD_FILE está vacío'); process.exit(2); }
const url = `postgres://${encodeURIComponent(process.env.PG_USER ?? '')}:${encodeURIComponent(clave)}@${process.env.PG_HOST ?? 'pg'}:${process.env.PG_PORT ?? '5432'}/${process.env.PG_DATABASE ?? 'plataforma'}`;

let codigoSalida = 0;
const pool = crearPool(url, { max: 1 });
try {
  const informe = await generarInforme(pool, opciones.empresa, opciones.cuenta);
  console.log(JSON.stringify({
    empresa: opciones.empresa,
    cuenta: opciones.cuenta,
    particion: informe.particion,
    categoriasCanal: informe.categoriasCanal,
    candidatosAtributo: informe.candidatosAtributo,
    solapamientos: informe.solapamientos,
    cobertura: informe.cobertura,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
