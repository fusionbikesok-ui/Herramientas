-- Matcher unificado, entrega 1: "seguir donde quedé" pasa de singleton (id=1, compartido por
-- TODOS los usuarios) a estar por usuario y por dirección. Con Cobertura sola y un solo
-- operario no molestaba; con el permiso único `matcher` (Joaco gana acceso), dos personas
-- trabajando la cola al mismo tiempo se pisarían el progreso mutuamente.
--
-- `direccion` queda fija en 'wc_ml' en esta entrega (es la única dirección activa), pero la
-- columna ya existe pensando en la entrega 2 (ML→WC) para que cada dirección tenga su propio
-- "seguir donde quedé".
--
-- sqlite no soporta cambiar la PRIMARY KEY con ALTER: se recrea la tabla. Se pierde la marca
-- "en trabajo" que hubiera en el singleton viejo (dato de conveniencia, no de negocio).

CREATE TABLE IF NOT EXISTS cobertura_sesion_nueva (
  user_id INTEGER NOT NULL,
  direccion TEXT NOT NULL DEFAULT 'wc_ml',
  marca_actual TEXT,
  actualizado_en TEXT NOT NULL,
  PRIMARY KEY (user_id, direccion)
);

DROP TABLE IF EXISTS cobertura_sesion;

ALTER TABLE cobertura_sesion_nueva RENAME TO cobertura_sesion;
