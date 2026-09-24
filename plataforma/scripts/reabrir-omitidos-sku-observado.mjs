#!/usr/bin/env node
/*
 * scripts/reabrir-omitidos-sku-observado.mjs — E3 corte 1: reapertura de publicaciones que José
 * omitió sin ver la opción correcta (bug reportado por opt-16, 2026-09-24: el motor resolvía
 * sku_observado a una variante única pero la bandeja no la mostraba cuando faltaba título ML;
 * fix en src/api/identidad-interna.ts, commit 1e88498e).
 *
 * Lista fija y revisada a mano por opt-16 y por José (NO se recalcula sola acá: correr
 * scripts/../c-listado-19-a-reabrir.sql aparte para volver a verificar antes de ejecutar, y
 * confirmar que la lista de abajo sigue coincidiendo).
 *
 * Para cada publicación:
 *   1. Busca su decisión 'omitir'/'mantener_omision' humana vigente (superada_en IS NULL).
 *   2. Busca el caso abierto o cerrado por esa decisión, la versión actual y el expected_version.
 *   3. decidirCaso con { eleccion: 'vincular', variantId: <la variante del SKU>, revierte: <esa
 *      decisión>, motivo: 'reapertura: omitido sin opción visible', actor: 'admin-reapertura',
 *      esAdmin: true }.
 * Todo pasa por decidirCaso (mismo camino append-only/auditado que la bandeja humana) — no toca
 * las tablas directamente.
 *
 * Uso:
 *   node scripts/reabrir-omitidos-sku-observado.mjs             (dry-run: sólo imprime el plan)
 *   node scripts/reabrir-omitidos-sku-observado.mjs --ejecutar  (corre decidirCaso de verdad)
 *
 * NO CORRER --ejecutar sin el OK explícito de José sobre esta lista exacta.
 */
import { randomUUID } from 'node:crypto';
import { cargarConfig } from '../src/comun/config.ts';
import { crearPool } from '../src/db/pool.ts';
import { decidirCaso } from '../src/identidad/decidir.ts';

const dryRun = !process.argv.includes('--ejecutar');
const ACTOR = 'admin-reapertura';
const MOTIVO = 'reapertura: omitido sin opción visible';

// (recurso, sku que sku_observado resuelve a una variante viva única) — lista de opt-16, 2026-09-24.
// Nota suya: los SKU de Volta aparecen en 2 publicaciones cada uno (duplicado real en ML, vincular
// ambas a la misma variante es válido). Marcado explícito abajo con `duplicado: true`.
const LISTA = [
  { recurso: 'MLA1427169231', sku: 'FB-16704' },
  { recurso: 'MLA1427169233', sku: 'FB-16698' },
  { recurso: 'MLA1427182045', sku: 'FB-16705' },
  { recurso: 'MLA1427195187', sku: 'FB-16703' },
  { recurso: 'MLA1427195191', sku: 'FB-16700' },
  { recurso: 'MLA1920486368', sku: 'FB-16702' },
  { recurso: 'MLA1920512330', sku: 'FB-16699' },
  { recurso: 'MLA2107823468', sku: 'FB-16700', duplicado: true }, // mismo SKU que MLA1427195191
  { recurso: 'MLA2107848136', sku: 'FB-16705', duplicado: true }, // mismo SKU que MLA1427182045
  { recurso: 'MLA2107848140', sku: 'FB-16699', duplicado: true }, // mismo SKU que MLA1920512330
  { recurso: 'MLA2107861068', sku: 'FB-16698', duplicado: true }, // mismo SKU que MLA1427169233
  { recurso: 'MLA2107861070', sku: 'FB-16702', duplicado: true }, // mismo SKU que MLA1920486368
  { recurso: 'MLA2107900074', sku: 'FB-16704', duplicado: true }, // mismo SKU que MLA1427169231
  { recurso: 'MLA2108622524', sku: 'FB-16701' },
  { recurso: 'MLA2108648450', sku: 'FB-16703', duplicado: true }, // mismo SKU que MLA1427195187
  { recurso: 'MLA2086073043', sku: 'FB-51553' },
  { recurso: 'MLA2086076757', sku: 'FB-51550' },
  { recurso: 'MLA910523250', sku: 'FB-2654' },
];

const config = cargarConfig(process.env);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 10_000 });

console.log(`${dryRun ? 'DRY-RUN' : 'EJECUTANDO'} — ${LISTA.length} publicaciones a reabrir/revincular.`);
if (!dryRun) console.log('*** Escritura real. Confirmá que José aprobó esta lista exacta antes de seguir. ***');

let ok = 0; let fallos = 0; let advertencias = 0;
for (const item of LISTA) {
  try {
    const rep = (await pool.query(
      `SELECT r.id, r.channel_account_id, r.recurso, r.variacion_normalizada, r.company_id
         FROM catalog.external_representations r
        WHERE r.recurso = $1 AND r.canal = 'mercadolibre' AND r.archivado_en IS NULL`,
      [item.recurso])).rows[0];
    if (!rep) { console.error(`[${item.recurso}] SIN representación viva de ML — salteado.`); fallos++; continue; }

    const decision = (await pool.query(
      `SELECT id, case_id FROM catalog.identity_decisions
        WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3
          AND origen = 'humano' AND eleccion IN ('omitir', 'mantener_omision')
          AND efecto = 'aplicar' AND superada_en IS NULL`,
      [rep.channel_account_id, rep.recurso, rep.variacion_normalizada])).rows[0];
    if (!decision) { console.error(`[${item.recurso}] sin decisión omitir/mantener_omision vigente — salteado (¿ya se resolvió?).`); fallos++; continue; }

    const variante = (await pool.query(
      `SELECT id, archivado_en FROM catalog.sellable_variants WHERE company_id = $1 AND sku = $2`,
      [rep.company_id, item.sku])).rows[0];
    if (!variante) { console.error(`[${item.recurso}] SKU ${item.sku} ya no resuelve a ninguna variante — salteado.`); fallos++; continue; }
    if (variante.archivado_en) { console.error(`[${item.recurso}] la variante de ${item.sku} está archivada — salteado.`); fallos++; continue; }

    const caso = (await pool.query(
      'SELECT id, version FROM catalog.identity_cases WHERE id = $1', [decision.case_id])).rows[0];
    if (!caso) { console.error(`[${item.recurso}] no se encontró el caso ${decision.case_id} — salteado.`); fallos++; continue; }

    console.log(`[${item.recurso}] caso=${caso.id} version=${caso.version} decisión_a_revertir=${decision.id} → variante ${variante.id} (${item.sku})${item.duplicado ? ' [SKU duplicado en la lista, por diseño]' : ''}`);

    if (dryRun) { ok++; continue; }

    const r = await decidirCaso(pool, {
      caseId: caso.id, expectedVersion: caso.version, eleccion: 'vincular', variantId: variante.id,
      actor: ACTOR, esAdmin: true, motivo: MOTIVO, idempotencyKey: randomUUID(), revierte: decision.id,
    }, { bandeja: true });

    if (r.ok) { console.log(`  → OK, nueva versión ${r.version}, decisión ${r.decisionId}`); ok++; }
    else { console.error(`  → RECHAZADO: ${r.code} ${JSON.stringify(r.details ?? {})}`); fallos++; }
  } catch (e) {
    console.error(`[${item.recurso}] excepción: ${e.message}`);
    fallos++;
  }
}

console.log(`\nResumen: ${ok} ok, ${fallos} fallos/salteados, ${advertencias} advertencias, ${LISTA.length} total.`);
if (dryRun) console.log('Nada se escribió (dry-run). Correr con --ejecutar recién cuando José apruebe la lista.');
await pool.end();
process.exit(fallos ? 1 : 0);
