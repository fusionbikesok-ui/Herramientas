-- E1 T3 · corte C1: señales de reconciliación y siembra de corrientes por canal.
-- Una señal es un aviso, no una verdad remota (PM-179): nunca se proyecta ni se presenta como
-- observación. `inbox_messages` y `resource_observations` sólo reciben el resultado de una relectura
-- GET o de un barrido. Los permisos de plataforma_app los hereda de ALTER DEFAULT PRIVILEGES (0002).

CREATE TABLE integrations.reconciliation_signals (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  topic              text NOT NULL CHECK (topic IN (
                       'ml.orders', 'ml.shipments', 'ml.questions', 'ml.messages', 'ml.claims', 'ml.items',
                       'woo.orders', 'woo.products')),
  resource_id        text NOT NULL CHECK (length(resource_id) > 0),
  notification_id    text,
  fingerprint        text NOT NULL CHECK (length(fingerprint) > 0),
  source             text NOT NULL CHECK (source IN ('webhook_copy', 'ml_missed_feed')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'claimed', 'succeeded', 'retryable', 'dead_lettered', 'excluded')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at       timestamptz NOT NULL DEFAULT now(),
  lease_token        uuid,
  lease_until        timestamptz,
  worker_id          text,
  error_detail       text,
  correlation_id     uuid NOT NULL DEFAULT uuidv7(),
  received_at        timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  -- Mismo contrato de lease que colas y corridas: reclamada si y sólo si hay token, vencimiento y worker.
  CONSTRAINT reconciliation_signals_lease_check CHECK (
    (status = 'claimed') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)),
  -- Unicidad por aviso: un webhook repetido o un missed_feed redundante no crea una segunda señal.
  CONSTRAINT reconciliation_signals_un_aviso UNIQUE (channel_account_id, topic, fingerprint)
);

-- Coalescencia: una sola señal activa por recurso, aunque lleguen veinte avisos del mismo pedido.
CREATE UNIQUE INDEX reconciliation_signals_un_activa
  ON integrations.reconciliation_signals(channel_account_id, topic, resource_id)
  WHERE status IN ('pending', 'claimed', 'retryable');
CREATE INDEX reconciliation_signals_reclamables
  ON integrations.reconciliation_signals(status, available_at, id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX reconciliation_signals_lease
  ON integrations.reconciliation_signals(lease_until) WHERE status = 'claimed';
CREATE INDEX reconciliation_signals_cuenta
  ON integrations.reconciliation_signals(channel_account_id, topic, received_at DESC);

-- La siembra de 0004 creaba las diez corrientes sin mirar el canal: una cuenta de Woo recibía las de
-- ML y al revés. Ahora consulta el canal y falla si la cuenta no existe o no tiene corrientes
-- definidas; por eso pasa a plpgsql, que es lo único que puede levantar la excepción.
CREATE OR REPLACE FUNCTION integrations.sembrar_corrientes(cuenta uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  canal text;
  creadas integer;
BEGIN
  SELECT channel INTO canal FROM core.channel_accounts WHERE id = cuenta;
  IF canal IS NULL THEN
    RAISE EXCEPTION 'cuenta de canal inexistente: %', cuenta;
  END IF;
  IF canal NOT IN ('mercadolibre', 'woocommerce') THEN
    RAISE EXCEPTION 'canal sin corrientes definidas: %', canal;
  END IF;

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
   WHERE (canal = 'mercadolibre' AND v.topic LIKE 'ml.%')
      OR (canal = 'woocommerce'  AND v.topic LIKE 'woo.%')
  ON CONFLICT (channel_account_id, topic, cursor_kind) DO NOTHING;

  GET DIAGNOSTICS creadas = ROW_COUNT;
  RETURN creadas;
END;
$$;

-- Corrientes que 0004 sembró para el canal equivocado: se deshabilitan, no se borran, y sólo si no
-- tienen corrida activa ni historial de éxito. Forward-only: conservan posición y quedan auditables.
UPDATE integrations.reconciliation_cursors c
   SET enabled = false
  FROM core.channel_accounts a
 WHERE a.id = c.channel_account_id
   AND c.enabled
   AND ((a.channel = 'mercadolibre' AND c.topic LIKE 'woo.%')
     OR (a.channel = 'woocommerce'  AND c.topic LIKE 'ml.%'))
   AND c.last_success_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM integrations.sweep_runs s
      WHERE s.channel_account_id = c.channel_account_id AND s.topic = c.topic
        AND s.cursor_kind = c.cursor_kind AND s.status IN ('pending', 'claimed', 'retryable'));
