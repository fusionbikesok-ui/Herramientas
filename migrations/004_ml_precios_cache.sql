-- 004_ml_precios_cache.sql
--
-- Caché persistente de comisión (sale_fee) y costo de envío gratis de ML, para no repetir
-- llamadas a listing_prices / shipping_options/free que devuelven siempre lo mismo dentro
-- de la ventana de vigencia (plan docs/superpowers/plans/2026-08-05-ahorro-llamadas-ml.md).
--
-- clave:
--   fee:{price}:{category_id}:{listing_type_id}   → sale_fee_amount
--   envio:{item_id}:{price}                       → list_cost (el envío depende del precio,
--                                                    por eso la clave lo incluye; NO alcanza
--                                                    con item_id solo, sería un bug si el
--                                                    precio de la publicación cambia)
--
-- Vencimiento: 7 días (aplicado en código, lib/mlPrecios.js), no en el esquema. Invalidar a
-- mano (ej. si ML cambia comisiones antes del vencimiento) con:
--   DELETE FROM ml_precios_cache;
-- o por prefijo de clave (ej. DELETE FROM ml_precios_cache WHERE clave LIKE 'fee:%').
--
-- Solo se escribe una fila ante status 200 de ML con valor numérico — nunca ante error, para
-- no envenenar la caché con un dato inválido que enmascare un margen real.
--
-- Aplicación: igual convención que 001_*.sql — este proyecto no usa runner de migraciones ni
-- PRAGMA user_version; todas son idempotentes y corren al arrancar (db/index.js, CREATE TABLE
-- IF NOT EXISTS). Este .sql queda como registro auditable y para aplicarlo a mano si hiciera
-- falta.

CREATE TABLE IF NOT EXISTS ml_precios_cache (
  clave          TEXT PRIMARY KEY,
  valor          REAL NOT NULL,
  actualizado_en TEXT NOT NULL
);
