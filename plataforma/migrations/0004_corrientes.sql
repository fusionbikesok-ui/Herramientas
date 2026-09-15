-- E1 T2: alta de las diez corrientes de reconciliación por cuenta de canal.
-- `state_sweep` es siempre la ventana incremental; `full_scan` es la vuelta completa que declara bajas.
-- Calendario fijado por José el 2026-09-15: vueltas completas a las 04:00 de Argentina, escalonadas
-- 15 minutos para no competir por cuota, y la de IDs de pedidos Woo los domingos.

-- Una vuelta completa que quedó registrada como incremental antes de esta separación no tiene
-- procesador y nunca se reclamaría. Sólo se elimina si no dejó historial: forward-only, sin pisar datos.
DELETE FROM integrations.reconciliation_cursors c
 WHERE c.cursor_kind = 'state_sweep'
   AND c.topic IN ('ml.items')
   AND NOT EXISTS (
     SELECT 1 FROM integrations.sweep_runs s
      WHERE s.channel_account_id = c.channel_account_id AND s.topic = c.topic AND s.cursor_kind = c.cursor_kind);

-- Próximo instante local de Argentina para las vueltas completas.
CREATE OR REPLACE FUNCTION integrations.proxima_vuelta_diaria(desplazamiento interval)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT ((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
           + interval '1 day' + interval '4 hours' + desplazamiento)
          AT TIME ZONE 'America/Argentina/Buenos_Aires');
$$;

CREATE OR REPLACE FUNCTION integrations.proximo_domingo(desplazamiento interval)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  -- date_trunc('week') cae en lunes: el domingo de esa semana está seis días después.
  SELECT CASE WHEN base > now() THEN base ELSE base + interval '7 days' END
    FROM (SELECT ((date_trunc('week', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                   + interval '6 days' + interval '4 hours' + desplazamiento)
                  AT TIME ZONE 'America/Argentina/Buenos_Aires') AS base) t;
$$;

INSERT INTO integrations.reconciliation_cursors
  (channel_account_id, topic, cursor_kind, strategy, overlap_seconds, interval_seconds, next_run_at)
SELECT a.id, v.topic, v.cursor_kind, v.strategy, 600, v.interval_seconds, v.next_run_at
  FROM core.channel_accounts a
  CROSS JOIN (VALUES
    -- Corrientes incrementales: cadencia de la matriz de barridos.
    ('ml.orders',    'state_sweep', 'enumerable',    600, now()),
    ('ml.shipments', 'state_sweep', 'convergence',   900, now()),
    ('ml.questions', 'state_sweep', 'enumerable',   1200, now()),
    ('ml.messages',  'state_sweep', 'enumerable',   1200, now()),
    ('ml.claims',    'state_sweep', 'enumerable',   1200, now()),
    ('woo.orders',   'state_sweep', 'enumerable',    600, now()),
    ('woo.products', 'state_sweep', 'enumerable',    600, now()),
    -- Vueltas completas escalonadas: items 04:00, productos 04:15, pedidos (domingos) 04:30.
    ('ml.items',     'full_scan',   'enumerable',  86400, integrations.proxima_vuelta_diaria(interval '0 minutes')),
    ('woo.products', 'full_scan',   'enumerable',  86400, integrations.proxima_vuelta_diaria(interval '15 minutes')),
    ('woo.orders',   'full_scan',   'enumerable', 604800, integrations.proximo_domingo(interval '30 minutes'))
  ) AS v(topic, cursor_kind, strategy, interval_seconds, next_run_at)
ON CONFLICT (channel_account_id, topic, cursor_kind) DO NOTHING;

DROP FUNCTION integrations.proxima_vuelta_diaria(interval);
DROP FUNCTION integrations.proximo_domingo(interval);
