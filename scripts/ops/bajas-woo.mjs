#!/usr/bin/env node
// E-1c: lista o levanta a mano las bajas de Woo confirmadas (tabla `woo_bajas_confirmadas`). Una baja vigente hace que
// `stock.bolsa` lleve a 0 las publicaciones de ML de ese SKU; se levanta sola si el SKU reaparece en el catálogo, pero a veces
// hay que levantarla a mano (producto recreado con otro SKU, baja confirmada por error).
//
// USO (DB_PATH ABSOLUTO: un path relativo apunta a otra base según el cwd):
//   DB_PATH=/opt/fusionbikes/herramientas/data/fusion.sqlite node scripts/ops/bajas-woo.mjs listar
//   DB_PATH=... node scripts/ops/bajas-woo.mjs levantar SKU1 SKU2 [--dry-run]
//   DB_PATH=... node scripts/ops/bajas-woo.mjs levantar --todas [--dry-run]
// Al levantar encola la bolsa del SKU para que ML vuelva al stock de Woo. No escribe en Woo ni en ML.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listarBajasWoo, levantarBajasWoo } from '../../lib/wooBajas.js';

/** @returns {{bajas?: object[], levantadas?: string[], inexistentes?: string[]}} */
export function gestionarBajasWoo(db, { accion, skus = null, dryRun = false, encolar = null, log = console.log } = {}) {
  if (accion === 'listar') {
    const bajas = listarBajasWoo(db);
    if (!bajas.length) log('no hay bajas vigentes');
    for (const b of bajas) log(`${b.sku}\tid_woo=${b.id_woo ?? '-'}\t${b.motivo}\t${b.confirmada_en}`);
    return { bajas };
  }
  if (accion !== 'levantar') throw new Error(`acción desconocida: ${accion} (listar | levantar)`);
  const vigentes = new Set(listarBajasWoo(db).map((b) => b.sku));
  const pedidas = skus ?? [...vigentes];
  const inexistentes = pedidas.filter((s) => !vigentes.has(s));
  const aLevantar = pedidas.filter((s) => vigentes.has(s));
  for (const s of inexistentes) log(`${s}: no tiene baja vigente`);
  if (dryRun) { for (const s of aLevantar) log(`[dry-run] se levantaría la baja de ${s}`); return { levantadas: [], inexistentes, dryRun: true }; }
  const levantadas = levantarBajasWoo(db, aLevantar);
  if (encolar && levantadas.length) encolar(db, levantadas);
  for (const s of levantadas) log(`baja levantada: ${s}`);
  return { levantadas, inexistentes };
}

async function main() {
  await import('dotenv/config');
  const [accion, ...resto] = process.argv.slice(2);
  const dryRun = resto.includes('--dry-run');
  const todas = resto.includes('--todas');
  const skus = resto.filter((x) => !x.startsWith('--'));
  const dbPath = process.env.DB_PATH || '';
  if (!dbPath || !path.isAbsolute(dbPath)) { console.error('DB_PATH debe estar definido y ser ABSOLUTO.'); process.exit(2); }
  if (accion === 'levantar' && !todas && !skus.length) { console.error('Indicá SKUs o --todas.'); process.exit(2); }
  const { openDb } = await import('../../db/index.js');
  const { encolarBolsasDeSkus } = await import('../../routes/sync.js');
  const db = openDb(dbPath);
  try { gestionarBajasWoo(db, { accion, skus: todas ? null : skus, dryRun, encolar: encolarBolsasDeSkus }); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
  finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
