#!/usr/bin/env node
/**
 * Reparación puntual: restaura el estado de los casos cuyo trabajo borró el bug de la huella
 * de evidencia (la huella incluía `observado_en`, que cambia en cada refresco, así que todo
 * caso decidido volvía a `urgente` cada 15 minutos).
 *
 * Sólo toca casos que tienen una decisión registrada y su operación encolada: los devuelve a
 * `pendiente`, que es el estado que les corresponde en la máquina de estados. No inventa
 * decisiones ni cierra nada.
 *
 * Uso: node scripts/reparar-estados-um11.mjs <ruta.sqlite> [--aplicar]
 */
import Database from 'better-sqlite3';

const ruta = process.argv[2];
const aplicar = process.argv.includes('--aplicar');
if (!ruta) { console.error('falta la ruta de la base'); process.exit(1); }

const db = new Database(ruta);
const candidatos = db.prepare(`
  SELECT c.id, c.ml_key, c.estado, o.estado AS op_estado, o.sku_objetivo
  FROM identidad_casos c
  JOIN identidad_operaciones o ON o.caso_id = c.id
  WHERE c.estado IN ('urgente','tomado')
    AND o.estado IN ('shadow','pendiente','procesando','verificando')
  ORDER BY c.id`).all();

console.log(`casos con decisión y operación encolada que quedaron en la cola: ${candidatos.length}`);
for (const c of candidatos.slice(0, 5)) console.log(`   caso ${c.id}  ${c.ml_key}  ${c.estado} -> pendiente  (op ${c.op_estado}, ${c.sku_objetivo})`);
if (candidatos.length > 5) console.log(`   … y ${candidatos.length - 5} más`);

if (!aplicar) { console.log('\nSIMULACIÓN. Nada se modificó. Volvé a correr con --aplicar para aplicar.'); db.close(); process.exit(0); }

const ts = new Date().toISOString();
const tx = db.transaction((ids) => {
  const upd = db.prepare("UPDATE identidad_casos SET estado='pendiente', ultima_deteccion_en=? WHERE id=?");
  const hist = db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
    VALUES ('caso',?,'estado_restaurado_tras_bug_huella','sistema',?,?)`);
  for (const id of ids) { upd.run(ts, id); hist.run(id, JSON.stringify({ motivo: 'la huella incluía observado_en y reseteaba casos decididos' }), ts); }
});
tx(candidatos.map((c) => c.id));
console.log(`\nrestaurados a 'pendiente': ${candidatos.length}`);
db.close();
