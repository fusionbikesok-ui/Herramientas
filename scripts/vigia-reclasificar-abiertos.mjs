#!/usr/bin/env node
// Uso: DB_PATH=<abs> node scripts/vigia-reclasificar-abiertos.mjs [--apply]
// Reclasifica avisos del vigía abiertos bajo la regla vieja. Dry-run por defecto; cero escrituras a ML.
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/index.js';
import { esSinStock, parejasDeLote, detectarMigracion, MOTIVO_SIN_STOCK } from '../lib/vigiaPausado.js';

export async function reclasificar(db, mlCfg, { apply = false, ahora = new Date().toISOString() } = {}) {
  const filas = db.prepare('SELECT id, item_id, campo, valor_anterior, valor_nuevo FROM ml_publicacion_cambios WHERE revisado_en IS NULL ORDER BY id').all();
  const porItem = new Map();
  for (const f of filas) porItem.set(f.item_id, [...(porItem.get(f.item_id) || []), f]);
  const parejasEnLote = parejasDeLote(filas);
  const cache = new Map();
  const items = [];
  for (const [itemId, rows] of porItem) {
    if (esSinStock(db, itemId)) { items.push({ item_id: itemId, accion: 'cerrar_sin_stock', ids: rows.map((r) => r.id) }); continue; }
    let migracion = false;
    for (const r of rows) if (await detectarMigracion(db, mlCfg, r, { parejasEnLote, cache })) { migracion = true; break; }
    items.push({ item_id: itemId, accion: migracion ? 'dejar_abierto_migracion' : 'dejar_abierto', ids: rows.map((r) => r.id) });
  }
  if (apply) {
    const cerrar = db.prepare(`UPDATE ml_publicacion_cambios SET revisado_en=?, revisado_por='vigia-auto', bloquea_reactivador=1, pausa_error=? WHERE id=? AND revisado_en IS NULL`);
    db.transaction(() => { for (const it of items) if (it.accion === 'cerrar_sin_stock') for (const id of it.ids) cerrar.run(ahora, MOTIVO_SIN_STOCK, id); })();
  }
  return { apply, items };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  const apply = process.argv.includes('--apply');
  const db = openDb(process.env.DB_PATH);
  const mlCfg = { clientId: process.env.ML_CLIENT_ID, clientSecret: process.env.ML_CLIENT_SECRET, userId: process.env.ML_USER_ID };
  const r = await reclasificar(db, mlCfg, { apply });
  for (const it of r.items) console.log(`${it.item_id}\t${it.accion}\t${it.ids.length} fila(s)`);
  const n = r.items.filter((i) => i.accion === 'cerrar_sin_stock').length;
  console.log(`${apply ? 'APLICADO' : 'DRY-RUN (sin escrituras)'}: ${n} item(s) a cerrar, ${r.items.length - n} quedan abiertos.`);
  db.close();
}
