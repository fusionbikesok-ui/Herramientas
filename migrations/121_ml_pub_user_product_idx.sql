-- Fase C: hermanas por user_product (frenaIdentidad / sqlFrenaIdentidad). Sin este índice la CTE del sync
-- recorre ml_publicaciones_cache entera por cada decisión (~12 s sobre ~3000 filas). Aditiva e idempotente.
CREATE INDEX IF NOT EXISTS idx_ml_pub_user_product ON ml_publicaciones_cache(user_product_id);
