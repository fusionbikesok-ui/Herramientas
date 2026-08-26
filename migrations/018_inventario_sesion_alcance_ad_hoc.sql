-- Distingue las filas de inventario_sesion_alcance congeladas al abrir la sesión
-- (ad_hoc=0, nunca se borran mientras la sesión esté abierta) de las creadas al
-- vuelo por /escanear o /asociar cuando el SKU no estaba en el alcance original
-- (ad_hoc=1, se borran si ningún conteo vivo sigue referenciando ese SKU).
ALTER TABLE inventario_sesion_alcance ADD COLUMN ad_hoc INTEGER NOT NULL DEFAULT 0;
