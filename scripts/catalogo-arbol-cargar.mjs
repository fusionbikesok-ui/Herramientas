/*
 * scripts/catalogo-arbol-cargar.mjs — E2 T3 tarea 5: carga el árbol propio de FusionBikes como VERSIÓN
 * BORRADOR y mapea las categorías de Woo contra él. NO publica: publicar es un paso aparte y a mano.
 *
 * Una versión en borrador no afecta a nada. `leerArbol` de la versión vigente sigue devolviendo lo de antes,
 * y `clasificarModelo` no toca un borrador. Por eso este script puede correrse y revisarse sin riesgo, y la
 * decisión de publicar queda separada de la de cargar.
 *
 * Dry-run por default. Molde: scripts/catalogo-categorias-importar.mjs.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { ARBOL_FUSIONBIKES, FUERA_DEL_ARBOL, MAPEO_WOO }
  from '../plataforma/src/catalogo/arbol-fusionbikes.ts';
import { crearVersion, escribirArbol, mapearCategoria } from '../plataforma/src/catalogo/taxonomia.ts';

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
    console.error('uso: catalogo-arbol-cargar.mjs --empresa <uuid> --cuenta <uuid> [--ejecutar]');
    process.exit(2);
  }
  return o;
}

if (!process.env.PG_PASSWORD && !process.env.PG_PASSWORD_FILE) {
  console.error('falta PG_PASSWORD o PG_PASSWORD_FILE en el entorno');
  process.exit(2);
}
const opciones = argumentos(process.argv);
const pool = new pg.Pool({
  host: process.env.PG_HOST ?? '127.0.0.1',
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? 'plataforma',
  user: process.env.PG_USER ?? 'plataforma_app',
  password: process.env.PG_PASSWORD ?? readFileSync(process.env.PG_PASSWORD_FILE, 'utf8').trim(),
  max: 2,
});

let codigoSalida = 0;
try {
  const cta = await pool.query(
    'SELECT company_id, channel FROM core.channel_accounts WHERE id = $1', [opciones.cuenta]);
  if (!cta.rows[0]) throw new Error(`no existe channel_account ${opciones.cuenta}`);
  if (cta.rows[0].channel !== 'woocommerce') {
    throw new Error(`la cuenta ${opciones.cuenta} es de ${cta.rows[0].channel}: MAPEO_WOO son ids de Woo`);
  }
  if (cta.rows[0].company_id !== opciones.empresa) {
    throw new Error(`la cuenta ${opciones.cuenta} es de la empresa ${cta.rows[0].company_id}, no de ${opciones.empresa}`);
  }

  // Se coteja contra lo que la base tiene HOY, no contra el 82 que medimos el 2026-09-20: si Woo agregó o dio
  // de baja una categoría desde entonces, cargar un mapeo pensado para otra foto deja modelos sin clasificar
  // sin que nada proteste. Frena y que alguien decida.
  const vig = await pool.query(
    `SELECT id_externo, nombre FROM catalog.channel_categories
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL`, [opciones.cuenta]);
  const enBase = new Set(vig.rows.map((r) => r.id_externo));
  const decididas = new Set([...Object.keys(MAPEO_WOO), ...Object.keys(FUERA_DEL_ARBOL)]);
  const sinDecidir = vig.rows.filter((r) => !decididas.has(r.id_externo));
  const fantasma = [...decididas].filter((id) => !enBase.has(id));
  if (sinDecidir.length) {
    throw new Error(`hay ${sinDecidir.length} categorías vigentes sin decidir en MAPEO_WOO: `
      + sinDecidir.map((r) => `${r.nombre} [${r.id_externo}]`).join(', '));
  }
  if (fantasma.length) {
    throw new Error(`MAPEO_WOO decide ${fantasma.length} categorías que ya no están vigentes: ${fantasma.join(', ')}`);
  }

  const resumen = { nodos: ARBOL_FUSIONBIKES.length, mapeadas: 0, excluidas: Object.keys(FUERA_DEL_ARBOL).length };
  if (!opciones.ejecutar) {
    console.log(JSON.stringify({ dryRun: true, ...resumen, mapeadas: Object.keys(MAPEO_WOO).length,
      categoriasVigentes: vig.rowCount, nota: 'no se escribió nada' }, null, 2));
  } else {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const v = await crearVersion(cliente, opciones.empresa,
        'árbol propio de FusionBikes, dos niveles (D7); cargado por catalogo-arbol-cargar.mjs');
      const claves = await escribirArbol(cliente, opciones.empresa, v.id, ARBOL_FUSIONBIKES);
      for (const [idExterno, clave] of Object.entries(MAPEO_WOO)) {
        const nodo = claves.get(clave);
        if (!nodo) throw new Error(`MAPEO_WOO apunta a la clave ${clave}, que no quedó escrita`);
        await mapearCategoria(cliente, opciones.empresa, nodo, opciones.cuenta, 'woocommerce', idExterno, 'jose');
        resumen.mapeadas++;
      }
      await cliente.query('COMMIT');
      console.log(JSON.stringify({ dryRun: false, version: v.id, numero: v.numero, estado: 'borrador',
        ...resumen, nota: 'no se publicó: publicar es un paso aparte' }, null, 2));
    } catch (e) {
      await cliente.query('ROLLBACK');
      throw e;
    } finally {
      cliente.release();
    }
  }
} catch (e) {
  console.error(`falló la carga del árbol: ${e.message}`);
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
