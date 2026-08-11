-- Distingue las decisiones que escribe Cobertura (matcher inverso WC → ML) de las que
-- escribe el Matcher ML→WC (routes/matcher.js) sobre la MISMA tabla sku_matcher_decisiones.
-- Sin esto, "resueltos hoy" (progresoHoy) y el historial de Cobertura se inflaban con
-- trabajo hecho desde la otra herramienta (hallazgo del revisor). NULL para las filas
-- existentes/futuras que escriba el Matcher ML→WC (no las toca, no las etiqueta).
ALTER TABLE sku_matcher_decisiones ADD COLUMN origen TEXT;
