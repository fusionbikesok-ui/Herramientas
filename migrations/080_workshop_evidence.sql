CREATE TABLE IF NOT EXISTS workshop_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trabajo_id INTEGER NOT NULL REFERENCES workshop_jobs(id),
  referencia TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'foto',
  operation_id TEXT NOT NULL UNIQUE, creado_por TEXT NOT NULL, creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workshop_evidence_job ON workshop_evidence(trabajo_id, id);
