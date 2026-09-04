#!/usr/bin/env node
/**
 * Arranque del canario de UM1: reinicia la operación de UNA clave ML para que el worker
 * pueda ejecutarla.
 *
 * Hace falta porque el umbral de intervención (15 minutos) se mide contra `iniciada_en`, y
 * las operaciones encoladas hace horas irían a `intervencion` sin intentarlo. `reintentar`
 * reinicia esa ventana.
 *
 * No habilita nada por su cuenta: si `identidad_config` no está en `enforced` con escrituras
 * habilitadas, el reintento deja la operación en `shadow` y el worker sigue sin tocar ML.
 *
 * Uso: node scripts/canario-um11.mjs <clave_ml> [--aplicar]
 */
import Database from 'better-sqlite3';
import { reintentarOperacionIdentidad } from '../lib/identidadProductos.js';

const clave = process.argv[2];
const aplicar = process.argv.includes('--aplicar');
if (!clave) { console.error('uso: node scripts/canario-um11.mjs <clave_ml> [--aplicar]'); process.exit(1); }

const db = new Database('data/fusion.sqlite');
const cfg = db.prepare('SELECT modo, escrituras_remotas_habilitadas, canario_ml_key, lote_max FROM identidad_config WHERE id=1').get();
const op = db.prepare('SELECT * FROM identidad_operaciones WHERE ml_key=?').get(clave);
if (!op) { console.error(`no hay operación encolada para ${clave}`); process.exit(1); }
const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(op.caso_id);
const pub = db.prepare('SELECT titulo, seller_sku, available_quantity FROM ml_publicaciones_cache WHERE clave=?').get(clave);

console.log('configuración :', JSON.stringify(cfg));
console.log('publicación   :', pub?.titulo);
console.log('SKU en ML     :', pub?.seller_sku || '(vacío)', '  stock:', pub?.available_quantity);
console.log('SKU objetivo  :', op.sku_objetivo, '  stock objetivo:', op.stock_objetivo);
console.log('operación     : id', op.id, '| estado', op.estado, '| paso', op.paso_actual);
const sinEscritura = String(pub?.seller_sku || '').trim() === String(op.sku_objetivo || '').trim();
console.log('previsión     :', sinEscritura
  ? 'el SKU ya coincide: la saga debería completar SIN escribir en ML'
  : 'requiere escritura real: stock 0 → limpiar SKU → escribir SKU → restaurar stock');

if (!aplicar) { console.log('\nSIMULACIÓN. Nada se modificó. Repetí con --aplicar.'); db.close(); process.exit(0); }

const r = reintentarOperacionIdentidad(db, op.id, {
  operation_id: `canario-${Date.now()}`,
  expected_version: caso.expected_version,
  evidence_fingerprint: caso.evidencia_fingerprint,
}, 'canario');
console.log('\nreintento:', r.ok ? 'aceptado' : JSON.stringify(r));
console.log('operación :', JSON.stringify(db.prepare('SELECT estado,paso_actual,intentos,iniciada_en FROM identidad_operaciones WHERE id=?').get(op.id)));
db.close();
