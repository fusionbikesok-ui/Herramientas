-- 0021 — E3 corte 1 punto B (revisión de opt-16 sobre 5cb02ef5): título observado de ML sin crear modelo.
--
-- El primer intento (commit 5cb02ef5, revertido) hacía que un ítem de ML sin variaciones ya vinculado a una
-- variante de Woo creara su propio product_models `ml_simple` sólo para no perder el título del payload. El
-- costo era demasiado grande para el corte: ~3.600 modelos nuevos que entran en la clasificación D26/D27, en
-- los conteos de catálogo y, sobre todo, en `hashCatalogo` (conciliacion.ts) — cambiar el hash de miles de
-- filas en medio de la ventana de aceptación de E2 (cierra 27/09) es justo el tipo de deriva que ese hash
-- audita. Además contradice la decisión explícita de aplicar.ts:78-79: un `ml_simple` vacío es ruido.
--
-- Esta columna resuelve lo mismo sin ninguno de esos efectos: el título queda en la representación misma,
-- nunca en product_models. `hashCatalogo` no la lee (no está en su SELECT), así que el hash no se mueve.
SET lock_timeout = '5s';

ALTER TABLE catalog.external_representations
  ADD COLUMN titulo_observado text;

COMMENT ON COLUMN catalog.external_representations.titulo_observado IS
  'Título que trae el payload del canal para ESTA representación, cuando no hay modelo propio que lo guarde '
  '(ítem de ML sin variaciones ya vinculado a una variante de Woo). Sólo lectura para modeloMlSql como último '
  'fallback; nunca se usa para decidir identidad ni entra en hashCatalogo.';
