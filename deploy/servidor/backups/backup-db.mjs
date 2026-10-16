// Snapshot consistente de la SQLite usando la API de backup online de better-sqlite3.
// Uso: node backup-db.mjs <origen.sqlite> <destino.sqlite>
// A diferencia de `cp`, esto es seguro aunque la app esté escribiendo en la base.
// Import por ruta absoluta: este script vive fuera del dir de la app, y en ESM
// el especificador "bare" se resuelve según la ubicación del archivo (sin node_modules acá).
import Database from '/opt/fusionbikes/herramientas/node_modules/better-sqlite3/lib/index.js';

const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error('Uso: node backup-db.mjs <origen> <destino>');
  process.exit(1);
}

const db = new Database(src, { readonly: true });
try {
  await db.backup(dest);
  console.log(`OK backup base -> ${dest}`);
} catch (e) {
  console.error(`ERROR backup base: ${e.message}`);
  process.exit(1);
} finally {
  db.close();
}
