#!/usr/bin/env node
/**
 * E1 T3 C9 — arma N webhooks anonimizados a partir de los recibos reales de los últimos 7 días.
 *
 * Lee la base de producción en SÓLO LECTURA (`better-sqlite3` readonly; nunca `openDb`, que migra al
 * abrir). Conserva la mezcla real de canales y tópicos y la forma de cada recurso; reemplaza todo
 * identificador (ids de recurso, usuario, notificación, entrega) por valores al azar. No copia textos,
 * títulos ni payloads. La salida queda en el directorio de trabajo (modo 600), nunca en el repo.
 *
 * Uso: node anonimizar.mjs <db_path> <salida.json> <n> <ml_user_id_de_prueba>
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';

const [dbPath, salida, nTexto, userQa] = process.argv.slice(2);
const n = Number(nTexto) || 500;
if (!dbPath || !salida || !userQa) { console.error('uso: anonimizar.mjs <db> <salida> <n> <user_qa>'); process.exit(2); }

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const desde = new Date(Date.now() - 7 * 86400_000).toISOString();
const filas = db.prepare(`SELECT channel, resource_id, metadata_json FROM integration_events
  WHERE event_type = 'webhook.received' AND received_at >= ? AND COALESCE(shadow_reason,'') <> 'foreign_account'`).all(desde);
db.close();
if (!filas.length) { console.error('sin recibos en 7 días'); process.exit(1); }

const digitos = (s) => s.replace(/\d+/g, (m) => String(crypto.randomInt(1, 9)) + Array.from({ length: m.length - 1 }, () => crypto.randomInt(0, 10)).join(''));
const azar = () => crypto.randomBytes(12).toString('hex');

const mezcla = {};
const peticiones = [];
for (let i = 0; i < n; i++) {
  const f = filas[crypto.randomInt(0, filas.length)];
  let meta = {};
  try { meta = JSON.parse(f.metadata_json || '{}'); } catch { /* sin metadatos: se usa sólo el canal */ }
  if (f.channel === 'ml') {
    const topic = String(meta.topic || 'orders_v2');
    // La forma del recurso se conserva (p. ej. /orders/N, /items/MLAN); los dígitos no.
    const resource = digitos(String(f.resource_id || '/orders/1'));
    peticiones.push({ tipo: 'ml', topic, body: { topic, resource, user_id: Number(userQa), application_id: 1, attempts: 1, _id: azar(), sent: new Date().toISOString() } });
    mezcla[`ml:${topic}`] = (mezcla[`ml:${topic}`] || 0) + 1;
  } else if (f.channel === 'woo' && String(f.resource_id).startsWith('/products/')) {
    const topic = String(meta.topic || 'product.updated');
    peticiones.push({ tipo: 'woo_product', topic, delivery: azar(), body: { id: crypto.randomInt(1000, 99999), parent_id: 0 } });
    mezcla[`woo:${topic}`] = (mezcla[`woo:${topic}`] || 0) + 1;
  } else if (f.channel === 'woo') {
    peticiones.push({ tipo: 'woo_order', topic: 'order.updated', delivery: azar(), body: { id: crypto.randomInt(1000, 99999), status: 'processing', line_items: [] } });
    mezcla['woo:order.updated'] = (mezcla['woo:order.updated'] || 0) + 1;
  }
}
fs.writeFileSync(salida, JSON.stringify(peticiones), { mode: 0o600 });
console.log(JSON.stringify({ recibos_reales: filas.length, generadas: peticiones.length, mezcla }));
