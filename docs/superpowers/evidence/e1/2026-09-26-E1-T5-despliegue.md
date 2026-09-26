# E1 T5 — despliegue del cupo sombra por corriente (2026-09-26)

## Qué se desplegó

T5 (PM-188, `specs/2026-09-25-e1-tramo5-cupo-por-corriente-design.md`): reparte el cupo del gateway
sombra de ML por corriente en vez de un bucket único, y difiere señales/corridas por
`CUPO_SOMBRA_AGOTADO` sin consumir intento. Implementado en `feature/e1-t5-cupo-por-corriente`
(merge `cf73453d` a `conteo-confiable`), con la corrección del incidente de importación en
`fix/e1-t5-import-plataforma` (`4d74f7ff`, merge `025c8219`).

## Datos del deploy (2026-09-26, ~00:55 UTC)

- **Migraciones aplicadas** con el servicio `migrate` de compose: `0022_casos_apartados.sql`,
  `0023_e3_canario.sql` (la commiteada, sin la parte 2) y `0024_cupo_sombra_diferido.sql`. Salida:
  `{"aplicadas":["0022_casos_apartados.sql","0023_e3_canario.sql","0024_cupo_sombra_diferido.sql"]}`.
  Producción queda en **24 migraciones aplicadas**.
- **Plataforma:** worker y scheduler recreados con la imagen `fusion-plataforma:e1t5-fix`, construida
  desde `025c8219` en el worktree limpio `/opt/fusionbikes/worktrees/deploy-e1t5`. La API **no se
  tocó**: sigue en la imagen `antes-scan-ml` (`bc23623d`).
- **Legado:** `.env` con `GATEWAY_ML_SHADOW_RPM` de 30 a 60 rpm (spec §2.7), y por corriente
  `ORDERS=10`, `SHIPMENTS=15`, `ITEMS=15`, `QUESTIONS=5`, `MESSAGES=10`, `CLAIMS=5`, `E2E3=0`.
  `pm2 restart`: online, sin errores de configuración (fail-closed sólo sobre la corriente sombra,
  nunca sobre el legado — ver `6c2928ef`).
- **Backup del `.env`:** `/root/backups-worker/env-backup-antes-e1t5-*`.
- **Rollback de la plataforma:** imágenes etiquetadas `fusion-plataforma:antes-e1t5` y
  `worker-antes-e1t5`. La imagen vieja del scheduler no se pudo etiquetar porque ya no existía.

## Incidente durante el primer intento

| Hora | Hecho |
|---|---|
| Primer intento | Worker levantado con la imagen de `cf73453d` entra en bucle: `ERR_MODULE_NOT_FOUND file:///lib/gatewayCanal.js` |
| — | Causa: `plataforma/src/reconciliacion/transporte-gateway.ts` y `missed-feeds.ts` importaban `lib/gatewayCanal.js` del legado, que no existe dentro de la imagen (se construye con `plataforma/` como build context, `plataforma/deploy/Dockerfile`) |
| — | Rollback del worker a `antes-e1t5` en unos minutos. El scheduler nuevo (que no tenía ese import) siguió sano |
| Arreglo | `fix/e1-t5-import-plataforma` (`4d74f7ff`, merge `025c8219`): tabla `TOPIC_A_CORRIENTE` extraída a `plataforma/src/reconciliacion/corrientes.ts` (copia deliberada, no reexportación), ambos consumidores repuntados, test de cruce agregado en el legado (`test/gatewayCanal.test.js`) para que ambas tablas no puedan divergir en silencio |
| Verificación | Revisor OK. Auditor-despliegue 🟢 con **prueba de humo real de la imagen**: build de Docker + `docker run --rm --entrypoint node <imagen> -e "await import('./src/worker/main.ts')"` para confirmar que `ERR_MODULE_NOT_FOUND` ya no ocurre — repetida de forma independiente por el propio auditor |
| Reintento | Worker y scheduler recreados con `fusion-plataforma:e1t5-fix` (desde `025c8219`). Sin errores |

### Lección

Ninguna revisión anterior (código, tests unitarios, revisor, ni la primera pasada del auditor) había
construido la imagen Docker real: todas corrían contra el checkout completo del repo, donde el import
cruzado resuelve sin problema. El bug sólo existe *dentro* del build context recortado de
`plataforma/`, así que sólo un build+run real lo expone.

**Propuesta:** este chequeo debe quedar escrito en el **checklist del auditor-despliegue**, no en un
delivery-contract por entrega — es una propiedad estructural de cualquier cambio que toque
`plataforma/src`, no algo específico de E1 T5. Concretamente: todo diff que modifique
`plataforma/src/**` es gate rojo automático si el auditor no construyó la imagen del
Dockerfile correspondiente y no ejecutó al menos una carga (`import`) de cada entrypoint tocado
(worker, scheduler, api) dentro del contenedor resultante. Queda pendiente de que el auditor lo
adopte; esta evidencia deja la recomendación por escrito para que se incorpore.

## Migraciones pendientes

Producción queda en 24 migraciones aplicadas. La migración `0025_e3_auto_sku_aplicar.sql` (E3,
auto-SKU aplicar) existe en la rama `feature/e3-auto-sku-aplicar` y **sigue sin mergear**: no forma
parte de este despliegue.

## Qué sigue: Tarea 0 (medición 24–48 h) y campaña de 7 días verdes

Con T5 desplegado arranca la **Tarea 0** de medición (24–48 h): confirmar que las 6 corrientes ML
barren sin quedar ahogadas por el cupo compartido de antes. El **día 0 de la campaña de 7 días
verdes seguidos (PM-186)** arranca **sólo si la Tarea 0 cumple** los criterios de aceptación de T5
(24 h con las 6 corrientes con al menos un barrido OK, backlog no creciente por corriente, cero
casos de `CUPO_SOMBRA_AGOTADO` que hayan agotado el tope de edad).

### Consulta SQL de la Tarea 0

Para que José la corra manualmente contra producción (con `!`), **no ejecutada por el asistente**.
Cubre, agrupado por corriente (canal + tópico): barridos OK / diferidos / fallidos, señales con
`CUPO_SOMBRA_AGOTADO` (diferimiento por cupo, no consume intento) contra `HTTP_429` real (backoff
normal), y señales muertas en dead letter.

```sql
-- Barridos por corriente en la ventana de medición (últimas 48 h)
SELECT
  ca.channel,
  sr.topic,
  count(*) FILTER (WHERE sr.status = 'succeeded')                                   AS barridos_ok,
  count(*) FILTER (WHERE sr.status IN ('pending', 'retryable')
                    AND sr.error_detail LIKE '%CUPO_SOMBRA_AGOTADO%')               AS barridos_diferidos_cupo,
  count(*) FILTER (WHERE sr.status = 'failed')                                      AS barridos_fallidos,
  count(*) FILTER (WHERE sr.error_detail LIKE '%HTTP_429%')                         AS barridos_http_429_real,
  max(sr.started_at)                                                                AS ultimo_barrido
FROM integrations.sweep_runs sr
JOIN core.channel_accounts ca ON ca.id = sr.channel_account_id
WHERE sr.started_at >= now() - interval '48 hours'
GROUP BY ca.channel, sr.topic
ORDER BY ca.channel, sr.topic;

-- Señales por corriente en la misma ventana: diferidas por cupo vs. 429 real vs. dead letter
SELECT
  ca.channel,
  s.topic,
  count(*) FILTER (WHERE s.status = 'succeeded')                                    AS senales_ok,
  count(*) FILTER (WHERE s.deferred_since IS NOT NULL)                              AS senales_diferidas_cupo,
  count(*) FILTER (WHERE s.error_detail LIKE '%HTTP_429%')                          AS senales_http_429_real,
  count(*) FILTER (WHERE s.status = 'dead_lettered')                                AS senales_dead_letter,
  max(s.received_at)                                                                AS ultima_senal
FROM integrations.reconciliation_signals s
JOIN core.channel_accounts ca ON ca.id = s.channel_account_id
WHERE s.received_at >= now() - interval '48 hours'
GROUP BY ca.channel, s.topic
ORDER BY ca.channel, s.topic;
```

Lectura esperada para que la Tarea 0 dé por cumplida su ventana: las 6 corrientes ML con
`barridos_ok` > 0, `barridos_diferidos_cupo` sin crecer corrida a corrida (backlog no creciente),
`senales_dead_letter` en cero para casos cuyo único motivo sea `CUPO_SOMBRA_AGOTADO` con tope de
edad agotado.
