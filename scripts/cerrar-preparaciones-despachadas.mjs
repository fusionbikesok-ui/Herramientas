/*
 * scripts/cerrar-preparaciones-despachadas.mjs
 *
 * Cierra las preparaciones que quedaron abiertas después de que su pedido ya salió.
 *
 * Por qué existe: una preparación en curso sólo se podía reabrir desde su tarjeta en la cola,
 * y la cola muestra únicamente pedidos vigentes del canal. Cuando el pedido avanzaba, la
 * tarjeta desaparecía y la preparación quedaba sin puerta — ni en la cola, ni en el historial,
 * ni con URL propia. Al 2026-09-10 había 38 así, la más vieja del 13 de agosto, todas de
 * pedidos que ya habían salido. La puerta ya se agregó (vista de abiertas + `?pedido=`); esto
 * limpia las que quedaron de antes.
 *
 * No inventa un cierre nuevo: usa `marcarPreparacionEnviada`, la misma función que corre
 * cuando el envío se confirma por el camino normal. Eso decide 'completada' si la preparación
 * está verificada y 'despachada_sin_verificar' si no, y registra el evento de auditoría. Una
 * preparación verificada no se degrada, y una sin verificar no se declara verificada.
 *
 * Deja afuera a propósito:
 *   - las que tienen un claim vigente: alguien las está trabajando ahora mismo;
 *   - las de pedidos cancelados: "enviada" sería mentira. Se listan para decidir a mano.
 *
 * Uso:
 *   node scripts/cerrar-preparaciones-despachadas.mjs           (simulación, no escribe)
 *   node scripts/cerrar-preparaciones-despachadas.mjs --aplicar (escribe)
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { marcarPreparacionEnviada } from '../routes/preparacion.js';

const APLICAR = process.argv.includes('--aplicar');
const DB_PATH = process.env.DB_PATH || './data/fusion.sqlite';
const ACTOR = 'script:cerrar-preparaciones-despachadas';

const ESTADOS_CANAL_DESPACHADO = ['enviadoandreani', 'retiradoenfusion', 'completed', 'serviceterminado'];
const ENVIOS_ML_DESPACHADOS = ['shipped', 'delivered'];

const db = new Database(DB_PATH);
const ahora = new Date().toISOString();

const abiertas = db.prepare(`
  SELECT p.id, p.clave, p.canal, p.numero_pedido, p.wc_order_id, p.ml_order_id, p.creado_en,
    (SELECT COUNT(*) FROM preparacion_items WHERE preparacion_id=p.id) AS items,
    (SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id AND borrado_en IS NULL) AS fotos,
    (SELECT c.usuario FROM preparacion_claims c WHERE c.preparacion_id=p.id AND c.expires_at > ?) AS claim_vigente
  FROM preparaciones p WHERE p.estado='en_preparacion' ORDER BY p.creado_en
`).all(ahora);

const estadoDelCanal = (prep) => {
  const ext = prep.canal === 'ml' ? String(prep.ml_order_id || '') : String(prep.wc_order_id || '');
  if (!ext) return null;
  const g = db.prepare(`SELECT estado_canal, estado_comercial, ml_shipment_id FROM gestion_pedidos
    WHERE external_id=? AND fuente=? LIMIT 1`).get(ext, prep.canal === 'ml' ? 'mercadolibre' : 'woocommerce');
  if (!g) return null;
  const envio = g.ml_shipment_id
    ? db.prepare('SELECT status FROM ml_shipment_estado WHERE shipment_id=?').get(String(g.ml_shipment_id))?.status || null
    : null;
  return {
    cancelado: ['cancelado', 'fallido', 'reembolsado'].includes(String(g.estado_comercial || '')),
    despachado: ENVIOS_ML_DESPACHADOS.includes(envio)
      || ESTADOS_CANAL_DESPACHADO.includes(String(g.estado_canal || '').toLowerCase()),
    detalle: envio || g.estado_canal || '—',
  };
};

const cerrar = [], cancelados = [], enUso = [], sinDato = [];
for (const prep of abiertas) {
  if (prep.claim_vigente) { enUso.push(prep); continue; }
  const canal = estadoDelCanal(prep);
  if (!canal) { sinDato.push(prep); continue; }
  if (canal.cancelado) { cancelados.push({ ...prep, detalle: canal.detalle }); continue; }
  if (canal.despachado) { cerrar.push({ ...prep, detalle: canal.detalle }); continue; }
  sinDato.push(prep);
}

console.log(`Base: ${DB_PATH}`);
console.log(`Preparaciones abiertas: ${abiertas.length}\n`);
console.log(`A cerrar (el canal informa que el pedido salió): ${cerrar.length}`);
for (const p of cerrar) {
  console.log(`  #${p.numero_pedido} · ${p.canal} · abierta ${p.creado_en.slice(0, 10)} · ${p.items} ítems, ${p.fotos} fotos · canal: ${p.detalle}`);
}
if (cancelados.length) {
  console.log(`\nSe dejan a mano (pedido cancelado, "enviada" sería falso): ${cancelados.length}`);
  for (const p of cancelados) console.log(`  #${p.numero_pedido} · ${p.canal} · ${p.detalle}`);
}
if (enUso.length) console.log(`\nSe saltean (claim vigente, alguien las está trabajando): ${enUso.length}`);
if (sinDato.length) console.log(`\nSe saltean (el canal no informa salida): ${sinDato.length}`);

if (!APLICAR) {
  console.log('\nSimulación. Nada se escribió. Agregá --aplicar para ejecutar.');
  process.exit(0);
}

let completadas = 0, sinVerificar = 0, sinCambio = 0;
const tx = db.transaction(() => {
  for (const p of cerrar) {
    const estado = marcarPreparacionEnviada(db, p.clave, { usuario: ACTOR });
    if (estado === 'completada') completadas++;
    else if (estado === 'despachada_sin_verificar') sinVerificar++;
    else sinCambio++;
  }
});
tx();

console.log(`\nAplicado: ${completadas} completadas (estaban verificadas), ${sinVerificar} despachadas sin verificar, ${sinCambio} sin cambio.`);
console.log(`Quedan abiertas: ${db.prepare("SELECT COUNT(*) AS n FROM preparaciones WHERE estado='en_preparacion'").get().n}`);
db.close();
