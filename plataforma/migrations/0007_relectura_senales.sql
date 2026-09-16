-- E1 T3 · corte C6: el inbox distingue el resultado de una relectura puntual disparada por señal.
-- Sigue siendo resultado de un GET remoto (PM-179): la señal nunca escribe inbox por sí misma.
ALTER TABLE integrations.inbox_messages DROP CONSTRAINT inbox_messages_source_check;
ALTER TABLE integrations.inbox_messages ADD CONSTRAINT inbox_messages_source_check
  CHECK (source IN ('webhook_copy', 'sweep', 'signal_reread'));
