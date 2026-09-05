#!/usr/bin/env node
/**
 * Destraba las operaciones de UM1 que quedaron sin poder ejecutarse:
 *
 *  a) `intervencion` — quedaron encoladas más de 15 minutos y el umbral las descartó ANTES
 *     de intentarlas (`intentos = 0`). El reintento reinicia esa ventana.
 *  b) `bloqueada_impacto` — la saga detectó variaciones hermanas y esperaba confirmación
 *     humana. Se marca `impacto_confirmado` y vuelven a la cola.
 *
 * No habilita nada: si `identidad_config` no está en `enforced` con escrituras habilitadas,
 * las operaciones quedan en `shadow` y el worker no toca MercadoLibre.
 *
 * Uso: node scripts/destrabar-um11.mjs [--intervencion] [--impacto] [--aplicar]
 */
import Database from 'better-sqlite3';
import { reintentarOperacionIdentidad } from '../lib/identidadProductos.js';

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const hacerIntervencion = args.includes('--intervencion') || !args.some((a) => a.startsWith('--i') || a === '--impacto');
const hacerImpacto = args.includes('--impacto');

const db = new Database('data/fusion.sqlite');
const cfg = db.prepare('SELECT modo, escrituras_remotas_habilitadas, canario_ml_key, lote_max FROM identidad_config WHERE id=1').get();
console.log('configuración:', JSON.stringify(cfg));

const resumen = (filas) => {
  let escriben = 0;
  for (const f of filas) if (String(f.seller_sku || '').trim() !== String(f.sku_objetivo || '').trim()) escriben += 1;
  console.log(`   sin escritura (SKU ya correcto): ${filas.length - escriben}`);
  console.log(`   con escritura real            : ${escriben}`);
};

const sql = `SELECT o.id, o.ml_key, o.sku_objetivo, o.caso_id, m.seller_sku
  FROM identidad_operaciones o LEFT JOIN ml_publicaciones_cache m ON m.clave = o.ml_key
  WHERE o.estado = ? ORDER BY o.id`;

const enIntervencion = hacerIntervencion ? db.prepare(sql).all('intervencion') : [];
const bloqueadas = hacerImpacto ? db.prepare(sql).all('bloqueada_impacto') : [];

if (hacerIntervencion) { console.log(`\nen intervención: ${enIntervencion.length}`); resumen(enIntervencion); }
if (hacerImpacto) { console.log(`\nbloqueadas por impacto en hermanas: ${bloqueadas.length}`); resumen(bloqueadas); }

if (!aplicar) { console.log('\nSIMULACIÓN. Nada se modificó. Repetí con --aplicar.'); db.close(); process.exit(0); }

let ok = 0; const fallos = [];
for (const o of enIntervencion) {
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(o.caso_id);
  const r = reintentarOperacionIdentidad(db, o.id, {
    operation_id: `destrabar-${o.id}-${Date.now()}`,
    expected_version: caso.expected_version,
    evidence_fingerprint: caso.evidencia_fingerprint,
  }, 'destrabar');
  if (r.ok) ok += 1; else fallos.push({ id: o.id, ...r });
}

// El impacto en hermanas es una confirmación humana explícita: se deja constancia de quién y
// por qué, y recién entonces la operación vuelve a la cola.
const ts = new Date().toISOString();
let confirmadas = 0;
const tx = db.transaction((filas) => {
  const upd = db.prepare(`UPDATE identidad_operaciones SET impacto_confirmado=1, estado='pendiente',
    intentos=0, ultimo_error=NULL, iniciada_en=?, proximo_intento_en=?, claim_hasta=NULL, actualizada_en=? WHERE id=?`);
  const hist = db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
    VALUES ('operacion',?,'impacto_hermanas_confirmado','operador',?,?)`);
  for (const o of filas) {
    upd.run(ts, ts, ts, o.id);
    hist.run(o.id, JSON.stringify({ motivo: 'confirmado explícitamente por el responsable operativo' }), ts);
    confirmadas += 1;
  }
});
if (bloqueadas.length) tx(bloqueadas);

console.log(`\nreintentadas    : ${ok}${fallos.length ? ` (fallaron ${fallos.length})` : ''}`);
if (fallos.length) console.log('   ', JSON.stringify(fallos.slice(0, 3)));
console.log(`impacto confirmado: ${confirmadas}`);
db.close();
