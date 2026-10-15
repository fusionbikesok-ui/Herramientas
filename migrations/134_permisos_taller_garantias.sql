-- Taller y Garantías pasan a tener permiso propio ('taller' y 'garantias'). Hasta ahora sus rutas
-- (/api/workshop, /api/warranties) pedían 'pedidos' o 'stock-exceptions' y las tarjetas del home
-- usaban ids que no existían en HERRAMIENTAS, así que solo las veía un admin.
--
-- Que nadie pierda acceso: quien hoy tenga 'pedidos' o 'stock-exceptions' recibe 'taller' y
-- 'garantias' con el nivel más alto que tenga entre ambos (write gana). Si ya tiene el permiso
-- nuevo, ese gana (no se pisa). Idempotente por el NOT EXISTS.

INSERT INTO user_permisos (user_id, herramienta, nivel)
SELECT p.user_id, h.herramienta,
       CASE WHEN MAX(CASE WHEN p.nivel = 'write' THEN 1 ELSE 0 END) = 1 THEN 'write' ELSE 'read' END
  FROM user_permisos p
 CROSS JOIN (SELECT 'taller' AS herramienta UNION ALL SELECT 'garantias') h
 WHERE p.herramienta IN ('pedidos', 'stock-exceptions')
   AND NOT EXISTS (
        SELECT 1 FROM user_permisos x
         WHERE x.user_id = p.user_id AND x.herramienta = h.herramienta
   )
 GROUP BY p.user_id, h.herramienta;
