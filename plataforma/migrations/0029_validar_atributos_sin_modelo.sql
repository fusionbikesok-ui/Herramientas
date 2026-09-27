-- E2 T2 · valida los CHECK de atributos e imágenes después de la migración compatible.
SET lock_timeout = '5s';

ALTER TABLE catalog.model_attributes
  VALIDATE CONSTRAINT model_attributes_model_or_rep_check;
ALTER TABLE catalog.model_images
  VALIDATE CONSTRAINT model_images_model_or_rep_check;
