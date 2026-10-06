-- E1 T3 · corte C8: resumen diario de la sombra, sin firma. La firma, el email y Object Lock son de T4
-- (`integrations.daily_shadow_reports`). Un resumen por día: regenerarlo lo reemplaza.
CREATE TABLE integrations.shadow_daily_summaries (
  summary_date date PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
