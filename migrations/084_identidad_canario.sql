-- Rollout controlado de las escrituras remotas de UM1. El plan exige canario designado y
-- lotes chicos antes de habilitar el modo `enforced`: sin esto, habilitar el modo largaría
-- de una todas las operaciones encoladas (39 al momento de escribir esto), y cada una pone
-- el stock de la publicación en 0 antes de escribir el SKU.
ALTER TABLE identidad_config ADD COLUMN canario_ml_key TEXT;
ALTER TABLE identidad_config ADD COLUMN lote_max INTEGER NOT NULL DEFAULT 1;
