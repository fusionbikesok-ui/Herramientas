/*
 * scripts/catalogo-arbol-publicar.mjs — E2 T3 tarea 5, paso final: publica una versión del árbol propio.
 *
 * Es la PRIMERA acción del tramo que cambia lo que el sistema hace: hasta acá todo era evidencia y borradores.
 * `leerArbol` y `clasificarModelo` trabajan sobre la versión vigente, así que a partir del COMMIT el árbol
 * empieza a existir para el resto de la plataforma. Por eso publicar es un script aparte del que carga, se
 * pide la versión por id EXPLÍCITO (nunca «el último borrador»: eso publica lo que otro dejó a medio cargar)
 * y es dry-run por default.
 *
 * Lo que verifica antes de escribir, y que es el motivo de que exista en vez de un UPDATE a mano:
 *  - la versión es de esta empresa y está en borrador;
 *  - los nodos son alcanzables desde una raíz, o sea que no hay hijas colgadas de un padre archivado;
 *  - NINGÚN mapeo vigente apunta a un nodo que esta versión no tenga. `taxonomy_channel_map` apunta al NODO,
 *    que vive fuera de la versión, así que publicar una versión incompleta deja mapeos apuntando a la nada y
 *    los modelos de esas categorías se quedan sin clasificar en silencio. Es el único modo de romper algo acá.
 *  - toda categoría de canal vigente está decidida: mapeada a un nodo o marcada sin equivalencia.
 *
 * Molde: scripts/catalogo-arbol-cargar.mjs.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { publicarVersion } from '../plataforma/src/catalogo/taxonomia.ts';
import { crearPool } from '../plataforma/src/db/pool.ts';

function argumentos(argv) {
  const o = { ejecutar: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ejecutar') o.ejecutar = true;
    else if (a === '--empresa') o.empresa = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
  if (!o.empresa || !o.version) {
    console.error('uso: catalogo-arbol-publicar.mjs --empresa <uuid> --version <uuid> [--ejecutar]');
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
  const v = await pool.query(
    'SELECT numero, estado, company_id, notas FROM catalog.taxonomy_versions WHERE id = $1', [opciones.version]);
  if (!v.rows[0]) throw new Error(`no existe la versión ${opciones.version}`);
  if (v.rows[0].company_id !== opciones.empresa) {
    throw new Error(`la versión ${opciones.version} es de la empresa ${v.rows[0].company_id}, no de ${opciones.empresa}`);
  }
  if (v.rows[0].estado !== 'borrador') {
    throw new Error(`la versión ${v.rows[0].numero} está en estado ${v.rows[0].estado}: sólo se publica un borrador`);
  }

  // Alcanzables desde una raíz. Un `count(*)` no distingue 65 nodos bien colgados de 65 con una rama huérfana.
  const alcance = await pool.query(
    `WITH RECURSIVE arbol AS (
       SELECT node_id FROM catalog.taxonomy_node_versions
        WHERE version_id = $1 AND parent_id IS NULL AND NOT archivado
       UNION ALL
       SELECT h.node_id FROM catalog.taxonomy_node_versions h
         JOIN arbol a ON h.parent_id = a.node_id
        WHERE h.version_id = $1 AND NOT h.archivado)
     SELECT (SELECT count(*)::int FROM arbol) AS alcanzables,
            (SELECT count(*)::int FROM catalog.taxonomy_node_versions
              WHERE version_id = $1 AND NOT archivado) AS total,
            (SELECT count(*)::int FROM catalog.taxonomy_node_versions
              WHERE version_id = $1 AND parent_id IS NULL AND NOT archivado) AS raices`,
    [opciones.version]);
  const { alcanzables, total, raices } = alcance.rows[0];
  if (alcanzables !== total) {
    throw new Error(`la versión tiene ${total} nodos y sólo ${alcanzables} se alcanzan desde una raíz: `
      + 'hay una rama huérfana y no se publica');
  }

  // Mapeos que apuntan a un nodo que esta versión NO tiene: quedarían apuntando a la nada.
  const colgados = await pool.query(
    `SELECT m.canal, count(*)::int AS n FROM catalog.taxonomy_channel_map m
      WHERE m.company_id = $1 AND m.vigente_hasta IS NULL AND m.node_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM catalog.taxonomy_node_versions nv
                         WHERE nv.version_id = $2 AND nv.node_id = m.node_id AND NOT nv.archivado)
      GROUP BY 1`, [opciones.empresa, opciones.version]);
  if (colgados.rowCount) {
    throw new Error('hay mapeos vigentes que apuntan a nodos ausentes de esta versión ('
      + colgados.rows.map((r) => `${r.canal}: ${r.n}`).join(', ') + '): publicarla los deja apuntando a la nada');
  }

  // Categorías de canal vigentes sin decidir. NO frena: ML se mapea después y a propósito (decisión del 20/09,
  // 10 categorías cubren la mitad del catálogo). Se informa para que la decisión de publicar sea con el número
  // a la vista, no a ciegas.
  const decision = await pool.query(
    `SELECT cc.canal,
            count(*)::int AS vigentes,
            count(*) FILTER (WHERE m.id IS NOT NULL)::int AS decididas
       FROM catalog.channel_categories cc
       LEFT JOIN catalog.taxonomy_channel_map m
              ON m.channel_account_id = cc.channel_account_id AND m.id_externo = cc.id_externo
             AND m.vigente_hasta IS NULL
      WHERE cc.company_id = $1 AND cc.vigente_hasta IS NULL
      GROUP BY 1 ORDER BY 1`, [opciones.empresa]);

  const resumen = {
    version: opciones.version, numero: v.rows[0].numero, notas: v.rows[0].notas,
    nodos: total, raices, canales: decision.rows,
  };
  if (!opciones.ejecutar) {
    const vigente = await pool.query(
      `SELECT numero FROM catalog.taxonomy_versions WHERE company_id = $1 AND estado = 'vigente'`, [opciones.empresa]);
    console.log(JSON.stringify({ dryRun: true, ...resumen,
      reemplazaria: vigente.rows[0]?.numero ?? null,
      nota: 'todas las verificaciones pasaron; no se escribió nada. Con --ejecutar el árbol pasa a vigente.',
    }, null, 2));
  } else {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await publicarVersion(cliente, opciones.empresa, opciones.version);
      const puesta = await cliente.query(
        `SELECT numero FROM catalog.taxonomy_versions WHERE company_id = $1 AND estado = 'vigente'`, [opciones.empresa]);
      if (puesta.rowCount !== 1 || puesta.rows[0].numero !== v.rows[0].numero) {
        throw new Error(`después de publicar la vigente no es la ${v.rows[0].numero}: se deshace`);
      }
      await cliente.query('COMMIT');
      console.log(JSON.stringify({ dryRun: false, ...resumen, estado: 'vigente' }, null, 2));
    } catch (e) {
      await cliente.query('ROLLBACK');
      throw e;
    } finally {
      cliente.release();
    }
  }
} catch (e) {
  console.error(`no se publicó: ${e.message}`);
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
