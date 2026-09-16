-- E1 T3 · corte C5: nonces del plano de control interno del legado (gateway GET).
-- Viven en SQLite y no en memoria: un reinicio del legado no puede reabrir la ventana de replay de
-- cinco minutos. La clave primaria es la defensa; la purga por `seen_at` sólo acota el tamaño.
CREATE TABLE IF NOT EXISTS internal_nonces (
  key_id  TEXT NOT NULL,
  nonce   TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_internal_nonces_seen_at ON internal_nonces(seen_at);
