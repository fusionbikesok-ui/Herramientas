-- E2: impide purgar evidencia vinculada a un caso activo.
CREATE TABLE IF NOT EXISTS preparacion_fotos_holds (
  preparacion_id INTEGER PRIMARY KEY,
  motivo TEXT NOT NULL,
  creado_por TEXT,
  creado_en TEXT NOT NULL
);
