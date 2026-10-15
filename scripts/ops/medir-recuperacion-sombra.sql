-- Sólo lectura. Ejecutar con psql -X -v ON_ERROR_STOP=1 -f este_archivo.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';

SELECT now() AS medido_en;
SELECT topic,cursor_kind,interval_seconds,last_success_at,next_run_at,
       round(extract(epoch FROM now()-last_success_at)/60,1) AS minutos_sin_exito
FROM integrations.reconciliation_cursors WHERE enabled ORDER BY topic,cursor_kind;

SELECT topic,status,count(*) AS corridas,
       max(enumerated) AS max_enumerados,
       round(max(extract(epoch FROM finished_at-started_at))/60,1) AS max_minutos
FROM integrations.sweep_runs WHERE started_at>=now()-interval '24 hours'
GROUP BY topic,status ORDER BY topic,status;

-- Comparar dos fotografías para comprobar avance entre diferimientos por cupo.
SELECT id,topic,status,enumerated,attempts,started_at,available_at,
       cursor_after->>'enCurso' AS checkpoint_activo,
       cursor_after->>'paginas' AS paginas_confirmadas,
       cursor_after->'posicion'->>'fase' AS fase,error_detail
FROM integrations.sweep_runs WHERE status IN ('pending','claimed','retryable')
ORDER BY topic,id;

SELECT topic,status,count(*) AS senales,
       min(received_at) AS mas_antigua,max(finished_at) AS ultimo_cierre
FROM integrations.reconciliation_signals WHERE received_at>=now()-interval '24 hours'
GROUP BY topic,status ORDER BY topic,status;

-- La captura para entregas futuras permanece pendiente; no se considera procesada.
SELECT CASE WHEN topic IN ('ml.items','woo.products') THEN 'consumidor_catalogo'
            ELSE 'captura_para_entregas_futuras' END AS destino,
       topic,status,count(*) AS mensajes,min(received_at) AS mas_antiguo,max(attempts) AS max_intentos
FROM integrations.inbox_messages GROUP BY destino,topic,status ORDER BY destino,topic,status;

SELECT status,error_detail,count(*) AS relecturas_de_recuperacion
FROM integrations.reconciliation_signals
WHERE fingerprint LIKE 'sombra-recuperacion-20261015:%'
GROUP BY status,error_detail ORDER BY status,error_detail;
COMMIT;
