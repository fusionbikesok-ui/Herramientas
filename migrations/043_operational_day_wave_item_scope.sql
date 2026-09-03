-- E1: un pedido puede reaparecer en otra jornada, pero no en dos olas de la misma.
-- La columna se agrega con una guarda en db/index.js porque SQLite no admite
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Este archivo queda compuesto solo
-- por operaciones idempotentes una vez que la columna existe.
UPDATE pick_wave_items
SET operational_day_id = (SELECT operational_day_id FROM pick_waves WHERE pick_waves.id = pick_wave_items.pick_wave_id)
WHERE operational_day_id IS NULL;

DROP INDEX IF EXISTS uq_pick_wave_items_pedido;
DROP INDEX IF EXISTS uq_pick_wave_items_wave_pedido;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_wave_items_day_pedido
  ON pick_wave_items(operational_day_id, pedido_clave);

CREATE TRIGGER IF NOT EXISTS trg_pick_wave_items_day_insert
BEFORE INSERT ON pick_wave_items
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM pick_wave_items pi
  JOIN pick_waves pw ON pw.id = pi.pick_wave_id
  JOIN pick_waves nw ON nw.id = NEW.pick_wave_id
  WHERE pi.pedido_clave = NEW.pedido_clave
    AND pw.operational_day_id = nw.operational_day_id
)
BEGIN
  SELECT RAISE(ABORT, 'pedido ya asignado en otra ola de la jornada');
END;

CREATE TRIGGER IF NOT EXISTS trg_pick_wave_items_day_fill
AFTER INSERT ON pick_wave_items
FOR EACH ROW
WHEN NEW.operational_day_id IS NULL
BEGIN
  UPDATE pick_wave_items SET operational_day_id =
    (SELECT operational_day_id FROM pick_waves WHERE id = NEW.pick_wave_id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_pick_wave_items_day_update
BEFORE UPDATE OF pick_wave_id, pedido_clave, operational_day_id ON pick_wave_items
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM pick_wave_items pi
  JOIN pick_waves pw ON pw.id = pi.pick_wave_id
  JOIN pick_waves nw ON nw.id = NEW.pick_wave_id
  WHERE pi.id <> OLD.id
    AND pi.pedido_clave = NEW.pedido_clave
    AND pw.operational_day_id = nw.operational_day_id
)
BEGIN
  SELECT RAISE(ABORT, 'pedido ya asignado en otra ola de la jornada');
END;
