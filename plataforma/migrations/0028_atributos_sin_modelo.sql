-- E2 T2 · atributos e imágenes de representaciones ML omitidas por decisión.
--
-- Compatible hacia atrás: el worker y el scheduler de la imagen anterior nunca escriben NULL en
-- model_id, por lo que pueden seguir corriendo mientras esta migración ya está aplicada.
--
-- `model_id` deja de ser obligatorio porque una representación vendible omitida por decisión no tiene
-- modelo ni variante, pero sus atributos e imágenes siguen siendo evidencia útil para la bandeja.
-- `representation_id` continúa siendo la procedencia obligatoria. Los UNIQUE ya están definidos por
-- representación (no por model_id), y los índices por model_id aceptan NULL y siguen excluyendo esas
-- filas naturalmente de las consultas que parten de un modelo.
--
-- Rollback operativo: antes de volver a imponer NOT NULL hay que localizar y resolver todas las filas
-- con model_id IS NULL en ambas tablas; recién entonces se puede ejecutar ALTER COLUMN model_id SET NOT NULL
-- y, si corresponde, retirar estos CHECK. No se hace automáticamente porque perdería la evidencia omitida.
SET lock_timeout = '5s';

ALTER TABLE catalog.model_attributes
  ALTER COLUMN model_id DROP NOT NULL;

ALTER TABLE catalog.model_images
  ALTER COLUMN model_id DROP NOT NULL;

-- Es redundante hoy porque representation_id sigue siendo NOT NULL, pero deja explícita la invariante
-- para futuras modificaciones del esquema y documenta que nunca se admite una fila sin procedencia.
ALTER TABLE catalog.model_attributes
  ADD CONSTRAINT model_attributes_model_or_rep_check
  CHECK (model_id IS NOT NULL OR representation_id IS NOT NULL) NOT VALID;

ALTER TABLE catalog.model_images
  ADD CONSTRAINT model_images_model_or_rep_check
  CHECK (model_id IS NOT NULL OR representation_id IS NOT NULL) NOT VALID;
