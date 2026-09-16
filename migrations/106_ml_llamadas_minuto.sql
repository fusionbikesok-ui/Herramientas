-- E1 T3 (decisión de José 2026-09-16): medir siete días de llamadas del legado a Mercado Libre antes de fijar
-- el techo del bucket `shadow` del gateway. Una fila por minuto y recurso; sin rutas, ids ni cuerpos.
CREATE TABLE IF NOT EXISTS ml_llamadas_minuto (
  minuto     TEXT NOT NULL,              -- YYYY-MM-DDTHH:MMZ
  recurso    TEXT NOT NULL,              -- lectura | escritura | oauth (lib/mlLimites.js)
  reales     INTEGER NOT NULL DEFAULT 0, -- salieron a red
  status_429 INTEGER NOT NULL DEFAULT 0, -- 429 real de ML
  sinteticas INTEGER NOT NULL DEFAULT 0, -- frenadas por cooldown o cupo propio, sin red
  PRIMARY KEY (minuto, recurso)
);
