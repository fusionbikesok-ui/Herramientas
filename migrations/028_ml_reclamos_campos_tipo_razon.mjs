import Database from 'better-sqlite3';

const columns = [
  ['type', 'TEXT'],
  ['reason_id', 'TEXT'],
  ['resource_id', 'TEXT'],
  ['consultado_en_ml', 'INTEGER NOT NULL DEFAULT 1'],
  ['ultimo_error_en', 'TEXT'],
  ['intentos', 'INTEGER NOT NULL DEFAULT 0'],
  ['proximo_intento_en', 'TEXT'],
];

export function migrateMlClaims(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ml_reclamos'").get();
  if (!table) return false;
  const existing = new Set(db.prepare('PRAGMA table_info(ml_reclamos)').all().map(column => column.name));
  for (const [name, definition] of columns) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ml_reclamos ADD COLUMN ${name} ${definition}`);
    existing.add(name);
  }
  return true;
}

if (process.argv[1]?.endsWith('028_ml_reclamos_campos_tipo_razon.mjs')) {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('Uso: node migrations/028_ml_reclamos_campos_tipo_razon.mjs <db.sqlite>');
  const db = new Database(dbPath);
  migrateMlClaims(db);
  db.close();
}
