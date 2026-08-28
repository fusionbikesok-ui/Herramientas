-- Fase 5 de Preparación: días y hora de corte para la cola de despacho.
CREATE TABLE IF NOT EXISTS despacho_horarios (
  dia INTEGER PRIMARY KEY CHECK (dia BETWEEN 1 AND 7),
  habilitado INTEGER NOT NULL DEFAULT 0 CHECK (habilitado IN (0, 1)),
  hora_corte TEXT NOT NULL DEFAULT '16:00',
  actualizado_en TEXT NOT NULL
);

INSERT OR IGNORE INTO despacho_horarios (dia, habilitado, hora_corte, actualizado_en)
VALUES (1,1,'16:00',CURRENT_TIMESTAMP),(2,1,'16:00',CURRENT_TIMESTAMP),
       (3,1,'16:00',CURRENT_TIMESTAMP),(4,1,'16:00',CURRENT_TIMESTAMP),
       (5,1,'16:00',CURRENT_TIMESTAMP),(6,0,'16:00',CURRENT_TIMESTAMP),
       (7,0,'16:00',CURRENT_TIMESTAMP);

ALTER TABLE pedidos_cache ADD COLUMN fecha_despacho TEXT;
