/* scripts/e3-replay.ts — replay previo al canario. SOLO LECTURA. */
import fs from 'node:fs';
import pg from 'pg';
import { replay } from '../src/identidad/replay.ts';
import { validarMuestra } from '../src/identidad/muestra.ts';

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i < 0 ? undefined : process.argv[i + 1];
}

const empresa = process.argv[2];
const muestraPath = argumento('--muestra');
const sha256 = argumento('--sha256');
const cardinalidad = Number(argumento('--cardinalidad') ?? 299);
const parcial = process.argv.includes('--parcial');
const desdeArg = argumento('--desde');
const hastaArg = argumento('--hasta');
if (!empresa || !muestraPath || !sha256 || !Number.isInteger(cardinalidad) || cardinalidad < 1 || !process.env.DATABASE_URL) {
  console.error([
    'uso: DATABASE_URL=… e3-replay.ts <empresa> --muestra <archivo> --sha256 <hex> [--cardinalidad N] [--parcial] [--desde ISO] [--hasta ISO]',
    'Archivo esperado: la muestra canónica de 299 casos (una clave ML por caso, del legado muestra-300.json sin la clave dudosa), en JSON',
    '  {version, fuente, catalogo: [...], casos: [{clave, ml: <payload del ítem ML>, sku_verdad?}]}',
    '  — el mismo formato que test/identidad/fixtures/muestra-30.json, pero con los 299 casos. No está versionado: hay que generarlo leyendo',
    '  el payload ML de cada clave y el catálogo de Woo, y calcular el hash con `sha256sum <archivo>`.',
    'Sin ese archivo el replay no corre. --parcial permite una muestra menor (p.ej. muestra-30.json) pero el veredicto sale siempre \'parcial\', nunca \'apto\'.',
  ].join('\n')); process.exit(2);
}
let validada;
try { validada = validarMuestra(fs.readFileSync(muestraPath), { sha256, cardinalidad, parcial }); }
catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
if (validada.parcial) console.error('ADVERTENCIA: replay parcial; el veredicto nunca puede ser apto.');
const fx = validada.artefacto;
const muestra = fx.casos.map((c: { clave: string; ml: never; sku_verdad?: string }) => ({ clave: c.clave, ml: c.ml, skuVerdad: c.sku_verdad ?? null }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const ahora = new Date();
  const r = await replay(pool, { empresa, muestra, catalogo: fx.catalogo,
    desde: desdeArg ? new Date(desdeArg) : new Date(ahora.getTime() - 30 * 864e5), hasta: hastaArg ? new Date(hastaArg) : ahora });
  console.log(JSON.stringify(validada.parcial ? { ...r, veredicto: 'parcial' } : r, null, 2));
} finally { await pool.end(); }
