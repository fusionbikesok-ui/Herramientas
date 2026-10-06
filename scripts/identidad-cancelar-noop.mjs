#!/usr/bin/env node
/**
 * Cancela las operaciones de identidad que son no-op puro (mismo SKU y sin cambio de stock).
 *
 * Por defecto es --dry-run: lista qué cancelaría y no escribe nada. Para ejecutar de verdad hacen
 * falta DOS cosas explícitas: --apply y --backup-ok (confirma que existe un backup de la base
 * hecho con better-sqlite3; el VPS no tiene el binario sqlite3). En producción lo corre quien
 * tenga el OK de José, nunca por defecto.
 *
 * Uso: node scripts/identidad-cancelar-noop.mjs [--db data/fusion.sqlite] [--incluir-stock-obsoleto] [--apply --backup-ok]
 */
import Database from 'better-sqlite3';
import { cancelarOperacionesNoOpIdentidad } from '../lib/identidadLimpieza.js';

const args = process.argv.slice(2);
const valor = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const aplicar = args.includes('--apply');
const incluirStockObsoleto = args.includes('--incluir-stock-obsoleto');

if (aplicar && !args.includes('--backup-ok')) {
  console.error('--apply exige --backup-ok (backup previo confirmado). No se hizo nada.');
  process.exit(2);
}

const db = new Database(valor('--db', 'data/fusion.sqlite'), { readonly: !aplicar });
const r = cancelarOperacionesNoOpIdentidad(db, { simular: !aplicar, incluirStockObsoleto });
console.log(aplicar ? 'APLICADO' : 'DRY-RUN (no se escribió nada)');
for (const c of r.candidatas) {
  console.log(`  op ${c.id}  ${c.ml_key}  ${c.sku_objetivo}  stock pedido=${c.stock_objetivo} ML=${c.stock_ml}${c.stock_obsoleto ? ' (stock obsoleto)' : ''}  [${c.estado}]`);
}
console.log(aplicar ? `canceladas: ${r.canceladas.length} (${r.canceladas.join(', ')})` : `cancelaría: ${r.cancelaria.length}`);
db.close();
