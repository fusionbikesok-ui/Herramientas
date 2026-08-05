-- 003_ml_sku_push_fallos.sql
--
-- Push automático de SKU del matcher a MercadoLibre (lib/matcherPush.js): fallos por
-- publicación, con backoff exponencial (tope 24h) para no reintentar en cada ciclo de cron
-- una publicación que sigue fallando (ej. 400/403 de ML por restricciones del ítem).
--
-- 429 (rate limit) NO genera fila acá: no es un fallo de la publicación, se corta la corrida
-- entera y se reintenta en el próximo ciclo sin penalizar publicaciones no intentadas (ver
-- pushSkusPendientes en lib/matcherPush.js).
--
-- Aplicación: igual convención que 001_*.sql — este proyecto no usa runner de migraciones ni
-- PRAGMA user_version; todas son idempotentes y corren al arrancar (db/index.js, CREATE TABLE
-- IF NOT EXISTS). Este .sql queda como registro auditable y para aplicarlo a mano si hiciera
-- falta.

CREATE TABLE IF NOT EXISTS ml_sku_push_fallos (
  clave              TEXT PRIMARY KEY,
  sku                TEXT NOT NULL,
  intentos           INTEGER NOT NULL DEFAULT 0,
  ultimo_error       TEXT,
  ultimo_status      INTEGER,
  proximo_intento_en TEXT,
  actualizado_en     TEXT NOT NULL
);
