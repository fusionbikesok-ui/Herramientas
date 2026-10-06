#!/usr/bin/env node
/**
 * E2 T3 — tarea 6a: clasifica la foto actual del catálogo en el árbol propio (`catalog.model_categories`), con las
 * reglas D23–D25 de `plataforma/src/catalogo/clasificacion.ts`: nodo más específico; un solo nodo → primaria; varios que
 * no son padre e hijo → SIN primaria y caso `categoria_en_desacuerdo`; ninguno → caso `categoria_sin_mapeo`; lo decidido
 * por una persona no se toca. NO toca la ingestión (eso es 6b). Requiere la migración 0019.
 * Todo en UNA transacción, con conteo de lo que QUEDÓ; si algo no cierra, no queda nada.
 * Dry-run por default: informa los números y no escribe nada.
 *
 * Uso: node scripts/catalogo-clasificar-foto.mjs --empresa <uuid> [--ejecutar]
 * Entorno: PG_HOST/PG_PORT/PG_DATABASE/PG_USER y PG_PASSWORD o PG_PASSWORD_FILE.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { clasificarFoto } from '../plataforma/src/catalogo/clasificacion.ts';
import { crearPool } from '../plataforma/src/db/pool.ts';

function argumentos(argv) {
  const o = { ejecutar: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ejecutar') o.ejecutar = true;
    else if (a === '--empresa') o.empresa = argv[++i];
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
  if (!o.empresa) {
    console.error('uso: catalogo-clasificar-foto.mjs --empresa <uuid> [--ejecutar]');
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
    const r = await clasificarFoto(cliente, { empresa: opciones.empresa, dryRun: !opciones.ejecutar });
    await cliente.query(opciones.ejecutar ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({
      dryRun: !opciones.ejecutar, ...r,
      nota: opciones.ejecutar ? 'escrito' : 'no se escribió nada',
    }, null, 2));
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
} catch (e) {
  console.error(`falló la clasificación: ${e.message}`);
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
