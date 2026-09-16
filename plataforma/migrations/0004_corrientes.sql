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

-- La siembra vive en una función porque una cuenta de canal puede nacer después de esta migración
-- (el ensayo de T2 crea la suya, y T3 dará de alta cuentas reales): el alta llama a esta función en
-- vez de repetir el calendario. Es idempotente y devuelve cuántas corrientes creó.
CREATE FUNCTION integrations.sembrar_corrientes(cuenta uuid) RETURNS integer LANGUAGE sql AS $$
  WITH nuevas AS (
    INSERT INTO integrations.reconciliation_cursors
      (channel_account_id, topic, cursor_kind, strategy, overlap_seconds, interval_seconds, next_run_at)
    SELECT cuenta, v.topic, v.cursor_kind, v.strategy, 600, v.interval_seconds, v.next_run_at
      FROM (VALUES
        -- Corrientes incrementales: cadencia de la matriz de barridos.
        ('ml.orders',    'state_sweep', 'enumerable',    600, now()),
        ('ml.shipments', 'state_sweep', 'convergence',   900, now()),
        ('ml.questions', 'state_sweep', 'enumerable',   1200, now()),
        ('ml.messages',  'state_sweep', 'enumerable',   1200, now()),
        ('ml.claims',    'state_sweep', 'enumerable',   1200, now()),
        ('woo.orders',   'state_sweep', 'enumerable',    600, now()),
        ('woo.products', 'state_sweep', 'enumerable',    600, now()),
        -- Vueltas completas escalonadas en hora de Argentina: items 04:00, productos 04:15 y
        -- pedidos los domingos 04:30. date_trunc('week') cae en lunes: el domingo está seis días después.
        ('ml.items',     'full_scan',   'enumerable',  86400,
          ((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
            + interval '1 day 4 hours') AT TIME ZONE 'America/Argentina/Buenos_Aires')),
        ('woo.products', 'full_scan',   'enumerable',  86400,
          ((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
            + interval '1 day 4 hours 15 minutes') AT TIME ZONE 'America/Argentina/Buenos_Aires')),
        ('woo.orders',   'full_scan',   'enumerable', 604800,
          (SELECT CASE WHEN b > now() THEN b ELSE b + interval '7 days' END
             FROM (SELECT ((date_trunc('week', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                            + interval '6 days 4 hours 30 minutes')
                           AT TIME ZONE 'America/Argentina/Buenos_Aires') AS b) t))
      ) AS v(topic, cursor_kind, strategy, interval_seconds, next_run_at)
    ON CONFLICT (channel_account_id, topic, cursor_kind) DO NOTHING
    RETURNING 1)
  SELECT count(*)::integer FROM nuevas;
$$;

SELECT integrations.sembrar_corrientes(a.id) FROM core.channel_accounts a;
