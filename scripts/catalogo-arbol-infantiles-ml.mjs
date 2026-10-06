#!/usr/bin/env node
/**
 * E2 T3 — D22: D16 del lado de MercadoLibre. `Bicicletas Infantiles` (MLA459678) y `Camicletas` (MLA424974) se mapean a
 * `bicicletas` y sus modelos reciben la faceta `publico = infantil`, en UNA transacción (mapeos + facetas + conteo de lo
 * que QUEDÓ; si algo no cierra, no queda nada). Los que ya tenían la faceta (D16) no se tocan y se informan aparte; las 4
 * Gravity Bling se excluyen por id (`infantiles-ml.ts`). No publica versión: el árbol no cambia.
 * Dry-run por default: informa qué haría y no escribe nada. Requiere la migración 0018.
 *
 * Uso: node scripts/catalogo-arbol-infantiles-ml.mjs --empresa <uuid> --cuenta <channel_account_id ML> [--ejecutar]
 * Entorno: PG_HOST/PG_PORT/PG_DATABASE/PG_USER y PG_PASSWORD o PG_PASSWORD_FILE.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { aplicarD22 } from '../plataforma/src/catalogo/infantiles-ml.ts';
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
    console.error('uso: catalogo-arbol-infantiles-ml.mjs --empresa <uuid> --cuenta <uuid ML> [--ejecutar]');
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
    const r = await aplicarD22(cliente, {
      empresa: opciones.empresa, cuentaMl: opciones.cuenta, decididoPor: 'jose', dryRun: !opciones.ejecutar,
    });
    await cliente.query(opciones.ejecutar ? 'COMMIT' : 'ROLLBACK');
    const ver = (m) => ({ modelo: m.modelo, titulo: m.titulo, categoria: m.categoria });
    console.log(JSON.stringify({
      dryRun: !opciones.ejecutar,
      modelosEnLasCategorias: r.modelosEnLasCategorias,
      facetasNuevas: r.nuevas.map(ver),
      yaTenianLaFaceta: r.yaTenian.map(ver),
      excluidos: r.excluidos.map(ver),
      mapeo: r.mapeo, quedaron: r.quedaron,
      nota: opciones.ejecutar ? 'escrito' : 'no se escribió nada',
    }, null, 2));
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
} catch (e) {
  console.error(`falló D22: ${e.message}`);
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
