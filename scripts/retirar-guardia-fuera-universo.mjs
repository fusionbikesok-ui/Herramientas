#!/usr/bin/env node
/**
 * Cierra los casos de Guardia ML que nunca debieron abrirse y desarma el riesgo que traían.
 *
 * Guardia mira las publicaciones activas con stock sin filtrar canal, así que levanta los links
 * de pago de Mercado Pago como si fueran publicaciones del marketplace. Medido el 2026-09-06:
 * universo de Guardia 1180, universo de UM1 1072, y esas 108 de diferencia son todas links de
 * pago. Los 67 casos abiertos que quedaban eran, uno por uno, de ese tipo.
 *
 * El riesgo no era teórico: las 26 operaciones en conflicto eran de tipo `pausar` sobre esos
 * links, y quedaron ahí porque falló el chequeo de responsable. Si alguien tomaba uno de esos
 * casos, Guardia pausaba un link de pago activo.
 *
 * Este script NO retira Guardia ni cambia su modo: sólo cierra lo que está fuera de universo.
 * Bajar el modo a `lectura` es una decisión de operación aparte.
 *
 * Uso:
 *   node scripts/retirar-guardia-fuera-universo.mjs            # simula
 *   node scripts/retirar-guardia-fuera-universo.mjs --aplicar  # escribe
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cerrarCasosFueraDeUniverso } from '../lib/guardiaMl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aplicar = process.argv.includes('--aplicar');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'fusion.sqlite');
const db = new Database(dbPath, { readonly: !aplicar });

const candidatos = db.prepare(`SELECT c.id, c.clave, c.estado, m.seller_sku, substr(m.titulo,1,44) titulo,
    (SELECT COUNT(*) FROM guardia_ml_operaciones o WHERE o.caso_id=c.id AND o.estado IN ('pendiente','conflicto','procesando')) ops
  FROM guardia_ml_casos c JOIN ml_publicaciones_cache m ON m.clave=c.clave
  WHERE c.estado IN ('abierto','tomado','excepcion')
    AND m.canales_json IS NOT NULL AND m.canales_json NOT LIKE '%marketplace%'
  ORDER BY c.id`).all();

console.log(`casos fuera de universo: ${candidatos.length}`);
console.log(`operaciones vivas sobre ellos: ${candidatos.reduce((a, c) => a + c.ops, 0)}`);
for (const c of candidatos.slice(0, 6)) {
  console.log(`  #${c.id} ${c.estado} ${c.clave} | ${c.seller_sku || '(sin sku)'} | ${c.titulo}${c.ops ? ` | ${c.ops} op` : ''}`);
}
if (candidatos.length > 6) console.log(`  ... y ${candidatos.length - 6} más`);

if (!aplicar) {
  console.log('\nsimulación: no se escribió nada. Volvé a correr con --aplicar para hacerlo.');
  db.close();
  process.exit(0);
}

const r = cerrarCasosFueraDeUniverso(db, 'script:retiro-guardia');
console.log(`\ncerrados: ${r.casos} casos | canceladas: ${r.operaciones} operaciones`);
db.close();
