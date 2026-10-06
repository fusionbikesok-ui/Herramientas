#!/usr/bin/env node
/**
 * E2 T3 — D16: `BICICLETAS INFANTILES` deja de ser nodo y pasa a la faceta `publico = infantil`.
 *
 * En UNA transacción: crea la versión nueva del árbol en BORRADOR (con el nodo `infantiles` ARCHIVADO, no ausente),
 * remapea la categoría de Woo 1538 a `bicicletas` y escribe la faceta: por regla de categoría en los que no contradice la edad
 * observada, y por decisión de una persona (lista de ids en `infantiles.ts`) en los que sí. Si algo falla, no queda nada. NO publica: publicar es `catalogo-arbol-publicar.mjs` con el id de la
 * versión que este script informa, y se niega si algún mapeo quedó apuntando a un nodo ausente o archivado.
 * Requiere la migración 0018 (`catalog.model_facets`).
 *
 * Un modelo con edad observada «Adultos» que nadie decidió NO recibe la faceta y se lista (`sinDecidirNoEscritos`).
 * Dry-run por default: informa qué haría y no escribe nada.
 *
 * Uso: node scripts/catalogo-arbol-infantiles.mjs --empresa <uuid> --cuenta <channel_account_id Woo> [--ejecutar]
 * Entorno: PG_HOST/PG_PORT/PG_DATABASE/PG_USER y PG_PASSWORD o PG_PASSWORD_FILE.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { aplicarD16 } from '../plataforma/src/catalogo/infantiles.ts';
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
    console.error('uso: catalogo-arbol-infantiles.mjs --empresa <uuid> --cuenta <uuid Woo> [--ejecutar]');
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
    const r = await aplicarD16(cliente, {
      empresa: opciones.empresa, cuentaWoo: opciones.cuenta, decididoPor: 'jose', dryRun: !opciones.ejecutar,
    });
    await cliente.query(opciones.ejecutar ? 'COMMIT' : 'ROLLBACK');
    const ver = (m) => ({ modelo: m.modelo, titulo: m.titulo, edad: m.edad });
    console.log(JSON.stringify({
      dryRun: !opciones.ejecutar,
      modelosEnLaCategoria: r.modelosEnLaCategoria,
      facetasPorRegla: r.reglaCategoria.length,
      facetasPorPersona: r.persona.map(ver),
      excluidos: r.excluidos.map(ver),
      sinDecidirNoEscritos: r.sinDecidir.map(ver),
      version: r.version, nodosActivos: r.nodosActivos, nodosArchivados: r.nodosArchivados,
      facetasQuedaron: r.facetasQuedaron, categoria1538Remapeada: r.remapeada,
      nota: opciones.ejecutar
        ? 'escrito en borrador; NO publicado. Publicar con catalogo-arbol-publicar.mjs --version <id>'
        : 'no se escribió nada',
    }, null, 2));
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
} catch (e) {
  console.error(`falló D16: ${e.message}`);
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
