-- Cola de procesamiento de fotos de preparación (plan 2026-08-12-fotos-preparacion.md).
--
-- Antes: la subida convertía HEIC→JPEG de forma SINCRÓNICA dentro del request. heic-convert
-- (libheif compilado a JS puro, porque el sharp/libvips de este VPS no trae decoder HEIC por
-- la licencia HEVC) bloqueaba el único hilo de Node 3-7s enteros por foto (medido en el VPS
-- con fotos reales de iPhone) — mientras duraba, la app no respondía a nadie.
--
-- Ahora el request guarda el archivo TAL COMO LLEGÓ (columna `url`, ya existente — pasa a ser
-- el "original", nunca se toca ni se pierde) y responde al instante. Una cola en segundo plano
-- (lib/fotosPreparacionCola.js), corriendo la conversión en un worker thread aparte para no
-- bloquear el proceso principal, genera la versión liviana en `url_liviana`.
--
-- DEFAULT 'listo' en estado_proceso: las filas que ya existían antes de este cambio vienen del
-- pipeline viejo, que SÍ convertía de forma sincrónica — para ellas `url` YA es el jpeg final
-- (no hay nada pendiente que procesar) y `url_liviana` queda NULL para siempre; los consumidores
-- deben usar `url` como fallback cuando `url_liviana` es NULL.
ALTER TABLE preparacion_fotos ADD COLUMN estado_proceso TEXT NOT NULL DEFAULT 'listo'; -- pendiente | procesando | listo | error
ALTER TABLE preparacion_fotos ADD COLUMN url_liviana TEXT;
ALTER TABLE preparacion_fotos ADD COLUMN es_heic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preparacion_fotos ADD COLUMN intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preparacion_fotos ADD COLUMN ultimo_error TEXT;
ALTER TABLE preparacion_fotos ADD COLUMN proximo_intento_en TEXT;
ALTER TABLE preparacion_fotos ADD COLUMN procesado_en TEXT;
