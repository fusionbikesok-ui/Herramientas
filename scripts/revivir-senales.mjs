#!/usr/bin/env node
/**
 * Revive señales de reconciliación `dead_lettered` por una causa ya arreglada (E2, ver 5543f91).
 *
 * Filtra por `error_detail LIKE <causa>`, revive UNA sola señal por recurso (DISTINCT ON) y sólo si ese
 * recurso no tiene ya una señal activa (pending/claimed/retryable) — evita el índice único parcial
 * `reconciliation_signals_un_activa`, que si se viola aborta la transacción entera y no cambia nada.
 * `available_at` queda escalonado (`--rpm` llamadas por minuto) para no golpear el canal de una sola vez.
 * `--topic` (opcional) acota a un solo tópico: sin él, `--limite` puede agotarse en un tópico distinto
 * al que se quiere revivir, porque el orden es `channel_account_id, topic, resource_id, id` y no hay forma
 * de saltar tópicos completos salvo filtrando (encontrado el 2026-09-20: 227 muertas por 429 en 5 tópicos,
 * `--limite 14` nunca llegaba a las 14 de `ml.orders` porque `ml.claims`+`ml.items` ya llenaban el límite).
 *
 * Conexión: igual que `plataforma/src/db/cli-migrar.ts` — lee PG_HOST/PG_PORT/PG_DATABASE/PG_USER/
 * PG_PASSWORD(_FILE) de process.env ya poblado. Este script no abre ni lee plataforma.env: expórtenlas
 * antes de correrlo (o `docker compose --env-file plataforma.env run --rm ...` desde plataforma-prod).
 *
 * Uso:
 *   node scripts/revivir-senales.mjs [--causa <patrón LIKE>] [--topic <tópico>] [--limite N] [--rpm N] [--dry-run|--ejecutar]
 *
 * Por defecto es dry-run (no escribe nada). Para escribir hay que pasar --ejecutar explícitamente.
 */
import { readFileSync } from 'node:fs';
import { crearPool } from '../plataforma/src/db/pool.ts';
import { revivirSenalesMuertas } from '../plataforma/src/reconciliacion/revivir-senales.ts';

const TOPE_RPM = 60; // cada señal revivida termina en una llamada al canal: un tope bajo a propósito.
// Lista cerrada, no un aviso ante 0 candidatas: un tópico mal escrito ('ml.order' en vez de 'ml.orders')
// falla ACÁ, alto y explícito, en vez de devolver 0 filas en silencio y parecer "no hay nada que revivir".
const TOPICOS_VALIDOS = ['ml.items', 'ml.orders', 'ml.shipments', 'ml.questions', 'ml.claims', 'woo.products', 'woo.orders'];

function leerArgs(argv) {
  const o = { causa: '%PaginaInvalida%', topic: undefined, limite: 100, rpm: 10, dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--causa') o.causa = argv[++i];
    else if (a === '--topic') o.topic = argv[++i];
    else if (a === '--limite') o.limite = Number(argv[++i]);
    else if (a === '--rpm') o.rpm = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--ejecutar') o.dryRun = false;
    else { console.error(`argumento desconocido: ${a}`); process.exit(2); }
  }
  if (!o.causa) { console.error('--causa no puede ser vacío'); process.exit(2); }
  if (o.topic !== undefined && !TOPICOS_VALIDOS.includes(o.topic)) {
    console.error(`--topic inválido: '${o.topic}'. Válidos: ${TOPICOS_VALIDOS.join(', ')}`);
    process.exit(2);
  }
  if (!Number.isInteger(o.limite) || o.limite < 1) { console.error('--limite debe ser un entero positivo'); process.exit(2); }
  if (!Number.isInteger(o.rpm) || o.rpm < 1 || o.rpm > TOPE_RPM) {
    console.error(`--rpm debe ser un entero entre 1 y ${TOPE_RPM}`);
    process.exit(2);
  }
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

const pool = crearPool(url, { max: 1 });
let codigoSalida = 0;
try {
  const filas = await revivirSenalesMuertas(pool, {
    causaLike: opciones.causa,
    ...(opciones.topic !== undefined ? { topic: opciones.topic } : {}),
    limite: opciones.limite,
    offsetBaseS: Math.ceil(60 / opciones.rpm),
    dryRun: opciones.dryRun,
  });
  console.log(JSON.stringify({
    dryRun: opciones.dryRun,
    causa: opciones.causa,
    ...(opciones.topic !== undefined ? { topic: opciones.topic } : {}),
    candidatas: filas.length,
    revividas: opciones.dryRun ? 0 : filas.length,
    senales: filas.map((f) => ({
      id: f.id, canal: f.channelAccountId, topic: f.topic, recurso: f.resourceId,
      intentosPrevios: f.attemptsPrevios,
    })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  codigoSalida = 1;
} finally {
  await pool.end();
}
process.exit(codigoSalida);
