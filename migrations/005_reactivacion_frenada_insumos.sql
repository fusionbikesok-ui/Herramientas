-- 005_reactivacion_frenada_insumos.sql
--
-- Agrega a ml_reactivacion_frenada los insumos con los que se tomó el veredicto de la
-- frenada: precio_ml_evaluado y precio_web_evaluado (además de detectado_en, que ya
-- existía). Permiten a reactivarAutomatico decidir LOCALMENTE, sin pegarle a ML, si una
-- publicación frenada sigue frenada: si ninguno de los dos precios cambió desde la última
-- evaluación, se saltea sin llamada. Red de seguridad: igual se re-evalúa contra ML si pasaron
-- más de 24h desde
-- detectado_en, por si cambió algo que no está en estas dos columnas (comisión, envío).
--
-- Aplicación: igual convención que 001_*.sql — este proyecto no usa runner de migraciones ni
-- PRAGMA user_version; todas son idempotentes y corren al arrancar (db/index.js, ALTER TABLE
-- envuelto en try/catch). Este .sql queda como registro auditable y para aplicarlo a mano si
-- hiciera falta.

ALTER TABLE ml_reactivacion_frenada ADD COLUMN precio_ml_evaluado REAL;
ALTER TABLE ml_reactivacion_frenada ADD COLUMN precio_web_evaluado REAL;
