const columns = [
  ['external_type', 'TEXT'], ['question_id', 'TEXT'], ['pack_id', 'TEXT'], ['order_id', 'TEXT'],
  ['claim_id', 'TEXT'], ['item_id', 'TEXT'], ['last_synced_at', 'TEXT'], ['external_status', 'TEXT'],
];

export function migrateInboxExternalProjection(db) {
  const inbox = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_items'").get();
  if (!inbox) return false;
  return db.transaction(() => {
    const existing = new Set(db.prepare('PRAGMA table_info(inbox_items)').all().map((column) => column.name));
    let changed = false;
    for (const [name, type] of columns) {
      if (!existing.has(name)) { db.exec(`ALTER TABLE inbox_items ADD COLUMN ${name} ${type}`); changed = true; }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_items_external_ref ON inbox_items(external_type, external_status, last_synced_at DESC)');
    return changed;
  })();
}
