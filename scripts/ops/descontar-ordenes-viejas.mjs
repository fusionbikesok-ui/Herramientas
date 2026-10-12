#!/usr/bin/env node
// Una sola vez: descuenta en Woo el stock vendido de órdenes ML pagadas viejas que nunca tuvieron pedido, SIN crear el
// pedido. Usa EXACTAMENTE la misma función idempotente que el job (`descontarOrdenViejaSinPedido`): correrlo dos veces o
// que después llegue un aviso de la misma orden no descuenta de nuevo. Avisa (incidente crítico → mail + push) salvo en --dry-run.
//
//   node scripts/ops/descontar-ordenes-viejas.mjs --dry-run 2000018274075296 2000018414706684 2000018562885820
//   node scripts/ops/descontar-ordenes-viejas.mjs            2000018274075296 2000018414706684 2000018562885820
import 'dotenv/config';
import { openDb } from '../../db/index.js';
import { mlFetch } from '../../lib/mlClient.js';
import { descontarOrdenViejaSinPedido } from '../../routes/sync.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ids = args.filter((a) => !a.startsWith('--'));
const malos = ids.filter((i) => !/^\d+$/.test(i));
if (malos.length) {
  console.error(`ids inválidos (deben ser numéricos): ${malos.join(', ')}`);
  process.exit(2);
}
if (!ids.length) {
  console.error('Uso: descontar-ordenes-viejas.mjs [--dry-run] <ml_order_id> [...]');
  process.exit(2);
}

const db = openDb(process.env.DB_PATH || 'data/fusion.sqlite');
const cfg = {
  woo: { url: process.env.WOO_URL, ck: process.env.WOO_CK, cs: process.env.WOO_CS },
  ml: { clientId: process.env.ML_CLIENT_ID, clientSecret: process.env.ML_CLIENT_SECRET, userId: process.env.ML_USER_ID },
};

console.log(`descontar-ordenes-viejas: ${dryRun ? 'DRY-RUN (no escribe nada)' : 'APLICANDO'} · ${ids.length} orden(es)`);
let fallos = 0;
for (const id of ids) {
  try {
    const resp = await mlFetch(db, cfg.ml, 'get', `/orders/${id}`);
    if (resp.status !== 200 || !resp.data) { console.log(`${id}: ML respondió ${resp.status}, se omite`); fallos++; continue; }
    if (!dryRun && resp.data.status === 'cancelled') {
      console.log(`${id}: está CANCELADA, no se procesa en modo real (no se descuenta ni se avisa). Revisala a mano.`);
      fallos++;
      continue;
    }
    const r = await descontarOrdenViejaSinPedido(db, cfg, resp.data, { dryRun, actor: 'script:descontar-ordenes-viejas', origen: 'script' });
    console.log(`${id} (${String(resp.data.date_created).slice(0, 10)}, ${resp.data.status}): ${r.estado}${r.motivo ? ` — ${r.motivo}` : ''}`);
    for (const l of r.lineas) {
      const cambio = l.antes != null ? `stock ${l.antes} → ${l.despues}` : '';
      console.log(`   ${l.sku || '(sin SKU)'} x${l.cantidad} ${l.nombre || ''} ${cambio} [${l.estado}${l.motivo ? `: ${l.motivo}` : ''}]`);
    }
    if (r.estado === 'reintentar') fallos++;
  } catch (e) {
    console.log(`${id}: ERROR ${e.message}`);
    fallos++;
  }
}
process.exit(fallos ? 1 : 0);
