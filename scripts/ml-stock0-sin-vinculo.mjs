#!/usr/bin/env node
// Uso: DB_PATH=<abs> node scripts/ml-stock0-sin-vinculo.mjs [--apply | --rollback <csv>]
// Deja en stock 0 en ML las publicaciones sin vínculo con Woo (sin seller_sku, sin decisión asignar/confirmar,
// sin ml_stock_estado, con available_quantity>0). Dry-run por defecto. Nunca manda el array variations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/index.js';
import { mlFetch } from '../lib/mlClient.js';
import { buildMlStockUpdate } from '../routes/sync.js';

export function seleccionar(db) {
  return db.prepare(`SELECT p.clave, p.item_id, p.variation_id, p.status, p.sub_status, p.available_quantity, p.titulo
    FROM ml_publicaciones_cache p
    WHERE COALESCE(TRIM(p.seller_sku),'') = '' AND p.available_quantity > 0
      AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave AND d.accion IN ('asignar','confirmar'))
      AND NOT EXISTS (SELECT 1 FROM ml_stock_estado e WHERE e.clave = p.clave)
    ORDER BY p.item_id, p.variation_id`).all();
}

const pausadaPorVendedor = (f) => String(f.sub_status || '').includes('paused_by_seller');
const rutaLectura = (f) => (f.variation_id ? `/items/${f.item_id}/variations/${f.variation_id}` : `/items/${f.item_id}?attributes=id,available_quantity`);

async function leerCantidad(db, cfg, f, fetcher) {
  const r = await fetcher(db, cfg, 'get', rutaLectura(f));
  if (r.status === 429) return { corte: true };
  if (r.status !== 200 || !Number.isInteger(r.data?.available_quantity)) return { resultado: `omitido_lectura_${r.status}` };
  return { cantidad: r.data.available_quantity };
}

export async function poner0(db, cfg, { apply = false, fetcher = mlFetch } = {}) {
  const seleccion = seleccionar(db);
  const pausadasVendedor = seleccion.filter(pausadaPorVendedor);
  const filas = [];
  let cortado = false;
  for (const f of seleccion.filter((x) => !pausadaPorVendedor(x))) {
    if (cortado) { filas.push({ ...f, previa: '', resultado: 'no_intentado_429' }); continue; }
    const l = await leerCantidad(db, cfg, f, fetcher);
    if (l.corte) { cortado = true; filas.push({ ...f, previa: '', resultado: 'no_intentado_429' }); continue; }
    if (l.resultado) { filas.push({ ...f, previa: '', resultado: l.resultado }); continue; }
    if (l.cantidad === 0) { filas.push({ ...f, previa: 0, resultado: 'omitido_ya_0' }); continue; }
    if (!apply) { filas.push({ ...f, previa: l.cantidad, resultado: 'dry_run' }); continue; }
    const { path: p, body } = buildMlStockUpdate(f.item_id, f.variation_id || '', 0);
    const w = await fetcher(db, cfg, 'put', p, body);
    if (w.status === 429) { cortado = true; filas.push({ ...f, previa: l.cantidad, resultado: 'no_intentado_429' }); continue; }
    filas.push({ ...f, previa: l.cantidad, resultado: w.status === 200 ? 'ok' : `error_${w.status}` });
  }
  return { filas, pausadasVendedor, cortado };
}

export function escribirCsv(filas, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `ml-stock0-sin-vinculo-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const lineas = ['clave,item_id,variation_id,cantidad_previa,resultado', ...filas.map((f) => [f.clave, f.item_id, f.variation_id || '', f.previa, f.resultado].join(','))];
  fs.writeFileSync(archivo, lineas.join('\n') + '\n');
  return archivo;
}

export async function rollback(db, cfg, csv, { fetcher = mlFetch } = {}) {
  const [, ...lineas] = fs.readFileSync(csv, 'utf8').trim().split('\n');
  const filas = [];
  let cortado = false;
  for (const l of lineas) {
    const [clave, item_id, variation_id, previa, resultado] = l.split(',');
    const f = { clave, item_id, variation_id, previa: Number(previa) };
    if (resultado !== 'ok') continue;
    if (cortado) { filas.push({ ...f, resultado: 'no_intentado_429' }); continue; }
    const cur = await leerCantidad(db, cfg, f, fetcher);
    if (cur.corte) { cortado = true; filas.push({ ...f, resultado: 'no_intentado_429' }); continue; }
    if (cur.resultado) { filas.push({ ...f, resultado: cur.resultado }); continue; }
    if (cur.cantidad !== 0) { filas.push({ ...f, resultado: `omitido_stock_actual_${cur.cantidad}` }); continue; }
    const { path: p, body } = buildMlStockUpdate(item_id, variation_id, f.previa);
    const w = await fetcher(db, cfg, 'put', p, body);
    if (w.status === 429) { cortado = true; filas.push({ ...f, resultado: 'no_intentado_429' }); continue; }
    filas.push({ ...f, resultado: w.status === 200 ? 'restaurado' : `error_${w.status}` });
  }
  return { filas, cortado };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  const args = process.argv.slice(2);
  const db = openDb(process.env.DB_PATH);
  const cfg = { clientId: process.env.ML_CLIENT_ID, clientSecret: process.env.ML_CLIENT_SECRET, userId: process.env.ML_USER_ID };
  const dir = process.env.BACKUPS_DIR || '/root/backups-worker';
  const iR = args.indexOf('--rollback');
  if (iR >= 0) {
    const r = await rollback(db, cfg, args[iR + 1]);
    for (const f of r.filas) console.log(`${f.clave}\t${f.previa}\t${f.resultado}`);
    if (r.cortado) console.log('CORTADO por 429: reintentar más tarde (idempotente).');
  } else {
    const apply = args.includes('--apply');
    const r = await poner0(db, cfg, { apply });
    for (const f of r.filas) console.log(`${f.clave}\t${f.previa}\t${f.resultado}`);
    console.log(`\nPausadas con paused_by_seller (NO se tocan; decide José): ${r.pausadasVendedor.length}`);
    for (const f of r.pausadasVendedor) console.log(`  ${f.clave}\t${f.available_quantity}\t${f.titulo}`);
    if (apply) console.log(`CSV: ${escribirCsv(r.filas, dir)}`);
    else console.log('DRY-RUN: sin escrituras a ML ni CSV.');
    if (r.cortado) console.log('CORTADO por 429: reintentar más tarde (idempotente).');
  }
  db.close();
}
