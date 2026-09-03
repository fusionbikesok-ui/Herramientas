-- Estado durable del primer PUT de Seguimientos.
ALTER TABLE preparaciones ADD COLUMN woo_paso1_incierto INTEGER NOT NULL DEFAULT 0;
