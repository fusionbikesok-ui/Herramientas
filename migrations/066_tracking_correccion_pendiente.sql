-- Tracking nuevo queda pendiente localmente hasta confirmar la escritura remota.
ALTER TABLE preparaciones ADD COLUMN tracking_correccion_pendiente TEXT;
