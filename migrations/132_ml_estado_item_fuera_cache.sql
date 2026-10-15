-- Status de publicaciones ML que NO están en ml_publicaciones_cache (el escaneo del matcher solo trae active/paused: cerradas, en revisión,
-- etc. quedan fuera por diseño). El barrido wc_a_ml las consultaba con un GET por corrida (~3.000 GET/día en prod). Acá se recuerda el status
-- resuelto con un TTL de 24 h (lib/mlEstadoItemFueraCache.js). ml_publicaciones_cache manda siempre; un aviso de items de ML invalida la fila.
CREATE TABLE IF NOT EXISTS ml_estado_item_fuera_cache (
  item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
