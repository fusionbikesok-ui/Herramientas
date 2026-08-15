-- Matcher unificado, entrega 1: concurrencia optimista al confirmar. La cola está priorizada,
-- así que dos personas trabajando al mismo tiempo probablemente vean primero las mismas
-- publicaciones. Al confirmar se revalida que el ítem siga pendiente ANTES de escribir; si ya
-- lo resolvió otra persona, la respuesta necesita decir QUIÉN para que el frontend muestre
-- "Ya lo resolvió Fulano: vinculado a MLA123" en vez de un 409 mudo.
--
-- Username (no user_id): es solo para mostrar en pantalla, no hay FK a `users` y el usuario
-- puede borrarse después sin que esto se vuelva un dangling reference.

ALTER TABLE sku_matcher_decisiones ADD COLUMN confirmado_por TEXT;
