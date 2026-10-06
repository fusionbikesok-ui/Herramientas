-- E4: un control de despacho no puede congelarse en dos lotes no anulados.
CREATE UNIQUE INDEX IF NOT EXISTS uq_despacho_lote_control_activo
  ON despacho_lote_items(control_id) WHERE estado <> 'anulado';
