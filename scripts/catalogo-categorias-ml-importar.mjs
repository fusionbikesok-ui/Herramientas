#!/usr/bin/env node
/**
 * E2 T3 — importa a `catalog.channel_categories` las categorías de MercadoLibre que los modelos YA usan,
 * para que el informe de taxonomía pueda traducir sus `category_id` (MLA…) a nombre. Molde:
 * scripts/catalogo-categorias-importar.mjs (Woo). Lógica en plataforma/src/catalogo/categorias-ml.ts.
 *
 * Lectura pública de `GET /categories/{id}` de ML: NO usa token y este script nunca lo busca ni abre
 * .env/plataforma.env. Los ids salen de la propia base (atributo `categoria_canal` de representaciones de ML
 * de esa cuenta). Sólo lee de la base cuando es dry-run; sólo escribe con --ejecutar.
 *
 * Uso: node scripts/catalogo-categorias-ml-importar.mjs --cuenta <channel_account_id ML> [--dry-run|--ejecutar]
 *        [--permitir-baja] [--omitir-inexistentes]
 * Entorno: PG_HOST/PG_PORT/PG_DATABASE/PG_USER y PG_PASSWORD o PG_PASSWORD_FILE.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { importarCategoriasCanal } from '../plataforma/src/catalogo/categorias-canal.ts';
import { fuenteCategoriasMl } from '../plataforma/src/catalogo/categorias-ml.ts';
import { crearPool } from '../plataforma/src/db/pool.ts';

function leerArgs(argv) {
  const o = { cuenta: null, dryRun: true, permitirBaja: false, omitirInexistentes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cuenta') o.cuenta = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--ejecutar') o.dryRun = false;
    else if (a === '--permitir-baja') o.permitirBaja = true;
    else if (a === '--omitir-inexistentes') o.omitirInexistentes = true;
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
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

// Guarda simétrica a la de Woo: con una cuenta de otro canal, las categorías de ML quedarían guardadas bajo ella.
async function companyIdDeCuenta(pool, id) {
  const r = await pool.query('SELECT company_id, channel FROM core.channel_accounts WHERE id = $1', [id]);
  if (!r.rows[0]) throw new Error(`no existe channel_account ${id}`);
  if (r.rows[0].channel !== 'mercadolibre') {
    throw new Error(`la cuenta ${id} es de ${r.rows[0].channel}, y este script solo importa categorias de ` +
      'MercadoLibre: con otra cuenta escribiria las categorias de ML bajo el canal equivocado');
  }
  return r.rows[0].company_id;
}

async function idsEnUso(pool, cuenta) {
  const r = await pool.query(
    `SELECT DISTINCT a.valor FROM catalog.model_attributes a
       JOIN catalog.external_representations r ON r.id = a.representation_id
      WHERE a.nombre_normalizado = 'categoria_canal' AND a.vigente_hasta IS NULL
        AND r.canal = 'mercadolibre' AND r.channel_account_id = $1 AND r.archivado_en IS NULL
      ORDER BY 1`, [cuenta]);
  return r.rows.map((x) => x.valor);
}

let codigoSalida = 0;
const pool = crearPool(url, { max: 1 });
try {
  const companyId = await companyIdDeCuenta(pool, opciones.cuenta);
  const ids = await idsEnUso(pool, opciones.cuenta);
  const fuente = fuenteCategoriasMl(ids, { omitirInexistentes: opciones.omitirInexistentes });
  const resumen = await importarCategoriasCanal(pool, fuente, {
    companyId, channelAccountId: opciones.cuenta, canal: 'mercadolibre',
  }, { dryRun: opciones.dryRun, permitirBaja: opciones.permitirBaja });
  console.log(JSON.stringify({
    dryRun: opciones.dryRun, cuenta: opciones.cuenta, idsEnUso: ids.length,
    inexistentes: fuente.inexistentes, ...resumen,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
