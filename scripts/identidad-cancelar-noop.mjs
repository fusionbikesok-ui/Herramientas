#!/usr/bin/env node
/**
 * Cancela operaciones de identidad que no deben ejecutarse. Dos modos:
 *
 *  - Sin --ids: las no-op de SKU (mismo SKU anterior y objetivo). Por defecto solo las "puras"
 *    (piden el stock que ML ya tiene); --incluir-stock-obsoleto suma las que piden un stock viejo.
 *  - Con --ids 104,128,...: cancelación explícita de esas operaciones, con --motivo "...".
 *
 * Por defecto es DRY-RUN: lista qué haría y no escribe nada. Para ejecutar de verdad hacen falta
 * --apply y --backup-ok (confirma que existe un backup hecho con better-sqlite3; el VPS no tiene
 * el binario sqlite3). Quien lo corra en producción necesita el OK de José.
 *
 * --db es OBLIGATORIO y debe ser una ruta absoluta: un data/fusion.sqlite relativo depende del cwd
 * y ya nos mordió (DB_PATH relativo de pm2).
 *
 * Uso: node scripts/identidad-cancelar-noop.mjs --db /ruta/absoluta/fusion.sqlite
 *        [--incluir-stock-obsoleto | --ids 104,128 --motivo "texto"] [--apply --backup-ok]
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { cancelarOperacionesIdentidadPorIds, cancelarOperacionesNoOpIdentidad } from '../lib/identidadLimpieza.js';

const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const salir = (msg) => { console.error(`${msg} No se hizo nada.`); process.exit(2); };
const aplicar = args.includes('--apply');

const ruta = valor('--db');
if (!ruta) salir('--db es obligatorio (ruta absoluta de la base).');
if (!path.isAbsolute(ruta)) salir(`--db debe ser una ruta absoluta (recibí "${ruta}"): una relativa depende del cwd.`);
if (aplicar && !args.includes('--backup-ok')) salir('--apply exige --backup-ok (backup previo confirmado).');
const idsTexto = valor('--ids');
if (args.includes('--ids') && !idsTexto) salir('--ids necesita una lista, por ejemplo --ids 104,128.');

const db = new Database(ruta, { readonly: !aplicar });
console.log(aplicar ? 'APLICADO' : 'DRY-RUN (no se escribió nada)');
if (idsTexto) {
  const ids = idsTexto.split(',').map((x) => Number(x.trim()));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) salir(`--ids inválido: "${idsTexto}".`);
  const r = cancelarOperacionesIdentidadPorIds(db, { ids, motivo: valor('--motivo'), simular: !aplicar });
  for (const o of r.operaciones) console.log(`  op ${o.id}  ${o.ml_key}  ${o.sku_anterior ?? '(sin dato)'} -> ${o.sku_objetivo}  stock pedido=${o.stock_objetivo}  [${o.estado}]`);
  for (const o of r.omitidas) console.log(`  omitida op ${o.id}: ${o.motivo}`);
  console.log(aplicar ? `canceladas: ${r.canceladas.length} (${r.canceladas.join(', ')})` : `cancelaría: ${r.cancelaria.length}`);
} else {
  const r = cancelarOperacionesNoOpIdentidad(db, { simular: !aplicar, incluirStockObsoleto: args.includes('--incluir-stock-obsoleto') });
  for (const c of r.candidatas) {
    console.log(`  op ${c.id}  ${c.ml_key}  ${c.sku_objetivo}  stock pedido=${c.stock_objetivo} ML=${c.stock_ml}${c.stock_obsoleto ? ' (stock obsoleto)' : ''}  [${c.estado}]`);
  }
  console.log(aplicar ? `canceladas: ${r.canceladas.length} (${r.canceladas.join(', ')})` : `cancelaría: ${r.cancelaria.length}`);
}
db.close();
