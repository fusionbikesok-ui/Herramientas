-- 0016 — un nodo del árbol propio puede absorber VARIAS categorías del canal.
--
-- `taxonomy_channel_map_un_vigente` exigía UNIQUE (node_id, channel_account_id): un nodo, una sola categoría.
-- Está al revés. La dirección que tiene que ser única es categoría → nodo: una categoría del canal no puede
-- significar dos nodos, porque entonces clasificar un modelo por su categoría es ambiguo y el resultado
-- depende del orden de lectura. Eso ya lo garantiza `taxonomy_channel_map_un_externo` sobre
-- (channel_account_id, id_externo), que se queda.
--
-- La dirección nodo → categoría es muchos a uno A PROPÓSITO (decisión D7): el árbol propio tiene dos niveles
-- y absorbe el tercer nivel de Woo, así que `Cubiertas y Cámaras` mapea CUBIERTAS, CAMARAS e INSUMOS TUBELESS
-- a la vez. Con la restricción vieja, cargar la segunda cerraba la vigencia de la primera y quedaba una sola
-- por nodo — sin un solo error, y con los modelos de las otras sin clasificar.
--
-- Lo que NO se pierde al soltarla: «este nodo no tiene equivalente en el canal» sigue siendo representable y
-- sigue siendo único, porque una fila con id_externo NULL no entra en `un_externo`; para que no se acumulen
-- varias de esas por nodo se agrega un índice parcial propio.
DROP INDEX catalog.taxonomy_channel_map_un_vigente;

CREATE UNIQUE INDEX taxonomy_channel_map_un_sin_equivalencia
  ON catalog.taxonomy_channel_map (node_id, channel_account_id)
  WHERE vigente_hasta IS NULL AND id_externo IS NULL;
