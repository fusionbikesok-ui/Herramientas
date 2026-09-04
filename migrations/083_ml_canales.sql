-- Canal de la publicación ML. Un ítem con `channels` sin "marketplace" (típicamente
-- ["mp-merchants","mp-link"]) es un link de pago de Mercado Pago: existe en la API, está
-- `active`, pero nunca estuvo publicado en el marketplace y no se puede encontrar buscando
-- en MercadoLibre. Suelen traer available_quantity 99999.
-- Medido el 2026-09-04: 70 de las 1202 claves activas con stock, y 68 de los 85 casos
-- urgentes abiertos, eran links de pago. Sin distinguirlos, el 80% de la cola es ruido.
ALTER TABLE ml_publicaciones_cache ADD COLUMN canales_json TEXT;
