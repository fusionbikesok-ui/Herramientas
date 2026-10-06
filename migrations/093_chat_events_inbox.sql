ALTER TABLE inbox_items ADD COLUMN kind TEXT
  CHECK (kind IS NULL OR kind IN ('mensaje','pregunta','reclamo','pedido','otro'));
ALTER TABLE inbox_items ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('normal','high','urgent'));
CREATE INDEX IF NOT EXISTS idx_inbox_items_priority
  ON inbox_items(priority, status, updated_at DESC);
