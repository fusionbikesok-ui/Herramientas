-- Matcher unificado, entrega 1: la herramienta `cobertura` deja de existir como permiso
-- propio y pasa a estar cubierta por `matcher` (decisión del usuario: un solo permiso para
-- toda la herramienta).
--
-- Sin esta migración, cualquier usuario que tuviera SOLO `cobertura` quedaría sin acceso al
-- desplegar, en silencio, hasta que alguien se lo reasignara a mano desde Usuarios. En la
-- base de staging del 2026-08-14 eso no le pasa a nadie (el único con `cobertura` es Santi,
-- que además tiene `matcher=write`), pero **producción es una base distinta que se pasa a
-- mano**: no se puede verificar desde acá, así que la migración es defensiva.
--
-- **Se otorga `write`, no el nivel guardado.** `cobertura` era `niveles:false`: la pantalla de
-- Usuarios nunca mostró selector y grabó siempre `nivel='read'` (verificado sobre la base
-- real: `SELECT DISTINCT nivel ... WHERE herramienta='cobertura'` devuelve solo 'read'). Bajo
-- la regla vieja ese 'read' habilitaba TODA la herramienta; bajo la nueva el nivel se deriva
-- del método, así que copiar 'read' tal cual dejaría al usuario entrando al Matcher, viendo
-- la cola y recibiendo 403 en cada botón — confirmar, descartar, saltear, publicar, deshacer.
-- Sería cambiar una pérdida de acceso visible por una silenciosa, que es peor. `write` es el
-- acceso equivalente al que esa persona ya tenía. (Hallazgo del revisor sobre la primera
-- versión de esta migración.)
--
-- Si ya tiene `matcher`, ese gana: bajarlo sería quitarle acceso que hoy usa.

INSERT INTO user_permisos (user_id, herramienta, nivel)
SELECT c.user_id, 'matcher', 'write'
  FROM user_permisos c
 WHERE c.herramienta = 'cobertura'
   AND NOT EXISTS (
        SELECT 1 FROM user_permisos m
         WHERE m.user_id = c.user_id AND m.herramienta = 'matcher'
   );

DELETE FROM user_permisos WHERE herramienta = 'cobertura';
