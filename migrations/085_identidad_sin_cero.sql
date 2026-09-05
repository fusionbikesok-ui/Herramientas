-- Marca de camino directo: la operación escribió el SKU sin poner el stock en 0.
-- Importa para el final de la saga: una operación que NUNCA bajó el stock no debe
-- "restaurarlo", porque escribiría el valor capturado al decidir —posiblemente viejo— sobre
-- un stock que el sync normal ya mantiene al día. Sólo se restaura lo que uno mismo rompió.
ALTER TABLE identidad_operaciones ADD COLUMN sin_cero INTEGER NOT NULL DEFAULT 0;
