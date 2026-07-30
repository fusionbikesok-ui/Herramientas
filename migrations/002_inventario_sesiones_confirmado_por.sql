-- 002_inventario_sesiones_confirmado_por.sql
--
-- inventario_sesiones: registra quién confirmó/reintentó el ajuste de stock en Woo
-- (distinto de `usuario`, que es quién ABRIÓ y contó la sesión). Se necesita para
-- mostrar en el historial "contado por X, confirmado por Y" cuando alguien reintenta
-- una sesión que quedó `confirmada_con_errores`.
--
-- ALTER TABLE ... ADD COLUMN es soportado directo por sqlite (no hace falta el
-- patrón crear-copiar-renombrar de la 001). El equivalente en código está en
-- routes/inventario.js:154 (mismo ALTER, dentro de un try/catch que ignora
-- "duplicate column name" en cada arranque). Ese try/catch es lo idempotente,
-- NO este archivo: si lo aplicás a mano sobre una base que ya tiene la columna,
-- corta con error "duplicate column name".
--
-- Aplicación: igual que la 001 — no hay runner de migraciones ni PRAGMA user_version;
-- este .sql queda como registro auditable. Antes de aplicarlo a mano, verificá con
-- `PRAGMA table_info(inventario_sesiones)` que la columna no exista todavía.

ALTER TABLE inventario_sesiones ADD COLUMN confirmado_por TEXT;
