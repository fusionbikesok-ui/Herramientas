-- "Confirmar igual": un administrador acepta vincular aunque el título de ML contradiga al producto Woo.
-- La marca vive en la decisión (no en la operación) para que quede ligada a quién, cuándo y por qué, y la
-- saga solo la respeta para la clave y el SKU de esa operación.
ALTER TABLE identidad_decisiones ADD COLUMN override_contradiccion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE identidad_decisiones ADD COLUMN override_motivo TEXT;
