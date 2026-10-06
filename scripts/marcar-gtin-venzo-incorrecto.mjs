#!/usr/bin/env node
/**
 * Marca como `incorrecto` el GTIN de las bicicletas Venzo pausadas o sin stock.
 *
 * Por qué: esas bicicletas no tienen código universal posible, y sin embargo
 * están publicadas con un GTIN que no les corresponde —el caso testigo es
 * `4550170140663`, cuyo prefijo `455017` es de Shimano: un código de componente
 * pegado a una bicicleta, compartido por 126 publicaciones Venzo distintas—.
 *
 * Alcance (decisión del usuario, 2026-09-06): SÓLO registro local, ninguna
 * escritura a ML. Vaciar el atributo en ML serían ~818 llamadas contra una API
 * que ya nos bloqueó, y mientras la publicación esté pausada o sin stock nadie
 * compra contra ese código.
 *
 * El filtro de estado es deliberadamente conservador: una publicación activa y
 * con stock se está vendiendo ahora, y quitarle la identidad mientras vende es
 * exactamente lo que no queremos hacer sin mirarla una por una.
 *
 * Uso:
 *   node scripts/marcar-gtin-venzo-incorrecto.mjs            # simula, no escribe
 *   node scripts/marcar-gtin-venzo-incorrecto.mjs --aplicar  # escribe
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marcarIdentificadorIncorrecto } from '../lib/identidadProductos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aplicar = process.argv.includes('--aplicar');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'fusion.sqlite');
const db = new Database(dbPath, { readonly: !aplicar });

// El título es la única señal disponible: `catalogo_cache.marca` está poblada
// para una fracción del catálogo, y estas publicaciones se identifican por cómo
// las escribió ML.
const ES_BICI = "(m.titulo LIKE '%bicicleta%' OR m.titulo LIKE '%bici %' OR m.titulo LIKE '%mtb r%' OR m.titulo LIKE '%rodado%')";

const candidatos = db.prepare(`
  SELECT DISTINCT i.producto_id, i.valor_normalizado, p.fusion_sku, i.estado
    FROM ml_publicaciones_cache m
    JOIN catalogo_cache c ON c.sku = m.seller_sku
    JOIN productos_fusion p ON p.primary_woo_id = c.id_woo
    JOIN identificadores_producto i
      ON i.producto_id = p.id AND i.tipo = 'gtin'
     AND i.valor_normalizado = substr('00000000000000' || m.gtin, -14, 14)
   WHERE m.titulo LIKE '%venzo%' AND ${ES_BICI}
     AND TRIM(COALESCE(m.gtin, '')) <> ''
     AND (m.status <> 'active' OR COALESCE(m.available_quantity, 0) = 0)
     AND i.estado IN ('activo', 'conflicto')
   ORDER BY p.fusion_sku
`).all();

console.log(`candidatos: ${candidatos.length} identificadores en ${new Set(candidatos.map((c) => c.producto_id)).size} productos`);
console.log(`  en conflicto: ${candidatos.filter((c) => c.estado === 'conflicto').length} | activos: ${candidatos.filter((c) => c.estado === 'activo').length}`);

if (!aplicar) {
  for (const c of candidatos.slice(0, 10)) console.log(`  ${c.fusion_sku} ${c.valor_normalizado} (${c.estado})`);
  if (candidatos.length > 10) console.log(`  ... y ${candidatos.length - 10} más`);
  console.log('\nsimulación: no se escribió nada. Volvé a correr con --aplicar para hacerlo.');
  db.close();
  process.exit(0);
}

const motivo = 'bicicleta Venzo sin código universal posible; GTIN ajeno al producto';
let ok = 0;
const rechazos = {};
for (const c of candidatos) {
  // `permitirUnico` va en true a propósito: el sentido de esta corrida es que
  // estas bicicletas queden SIN GTIN, porque no hay uno que les corresponda.
  const r = marcarIdentificadorIncorrecto(db, c.producto_id, c.valor_normalizado, 'script:venzo', motivo, { permitirUnico: true });
  if (r.ok) ok += 1;
  else rechazos[r.code] = (rechazos[r.code] || 0) + 1;
}
console.log(`marcados: ${ok}`);
if (Object.keys(rechazos).length) console.log('rechazos:', rechazos);
db.close();
