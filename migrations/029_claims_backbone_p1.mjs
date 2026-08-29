import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function migrateClaimsBackbone(db) {
  if (db.pragma('user_version', { simple: true }) >= 29) return false;
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(here, '029_claims_backbone_p1.sql'), 'utf8'));
    // Bases que ya tenían la tabla antes de formalizar 029 necesitan ambos ALTER.
    for (const statement of [
      'ALTER TABLE notification_deliveries ADD COLUMN lease_until TEXT',
      'ALTER TABLE notification_deliveries ADD COLUMN last_attempt_at TEXT',
    ]) {
      try { db.exec(statement); } catch (err) {
        if (!String(err.message).includes('duplicate column name')) throw err;
      }
    }
    db.pragma('user_version = 29');
  })();
  return true;
}

if (process.argv[1]?.endsWith('029_claims_backbone_p1.mjs')) {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error('Uso: node migrations/029_claims_backbone_p1.mjs <db.sqlite>');
  const db = new Database(dbPath);
  migrateClaimsBackbone(db);
  db.close();
}
