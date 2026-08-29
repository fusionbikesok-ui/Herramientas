import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function migrateClaimsBackbone(db) {
  const versionAntes = db.pragma('user_version', { simple: true });
  // `user_version` es global: Hito 7 puede haberlo llevado a 30 antes de que
  // Claims P1 se instalara. El esquema real es la fuente de verdad.
  const tablasClaims = [
    'integration_events', 'integration_jobs', 'integration_event_history',
    'inbox_items', 'conversations', 'conversation_messages',
    'user_notifications', 'notification_deliveries',
  ];
  const faltantes = tablasClaims.filter((tabla) => !db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tabla));
  if (faltantes.length === 0) return false;
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
    // Nunca rebajar una versión escrita por otra migración (p.ej. Hito 7=30).
    const version = Math.max(versionAntes, 29);
    db.pragma(`user_version = ${version}`);
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
