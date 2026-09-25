-- 0024 — E1 T5: cupo sombra por corriente, diferimiento sin consumir intento (spec §2.4).
-- `deferred_since` marca la PRIMERA vez que la corrida/señal choca con CUPO_SOMBRA_AGOTADO; no se toca en
-- diferimientos posteriores de la misma corrida/señal, así una reprogramada varias veces no reinicia su
-- reloj. Se limpia (NULL) al salir del diferimiento, por éxito o por agotar el tope de edad.
SET lock_timeout = '5s';
ALTER TABLE integrations.sweep_runs ADD COLUMN deferred_since timestamptz;
ALTER TABLE integrations.reconciliation_signals ADD COLUMN deferred_since timestamptz;
