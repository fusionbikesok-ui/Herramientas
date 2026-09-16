# SOP — sombra de E1 (tramo 3)

- **Alcance:** copia de sombra del legado, API interna de señales, gateway GET, relecturas, barridos y
  `missed_feeds`. No cubre T4 (firma, email, Object Lock).
- **Regla de oro:** la sombra nunca puede cambiar un ACK del legado. Ante la duda se apaga la sombra; el
  legado sigue funcionando sin ella.
- **Dónde mirar:** incidentes operativos del legado (integración `sombra`), `GET /api/v2/shadow/status` de
  la plataforma (capacidad `operations.read`), logs `alerta de sombra` del scheduler y
  `integrations.shadow_daily_summaries`.

Cada alerta de abajo está probada con un fixture: `test/metricasSombra.test.js` (legado) y
`plataforma/test/observabilidad.test.ts` (plataforma). Los umbrales viven en `lib/metricasSombra.js`
(`UMBRALES_LEGADO`) y `plataforma/src/observabilidad/sombra.ts` (`UMBRALES`).

## Apagado de emergencia (aborto)

1. En el legado: `SOMBRA_COPIA_ENABLED=false` y reiniciar la app. Los recibos siguen creándose, sin ciclo
   de sombra. Los intentos que quedaron activos pasan a `abandoned/process_stopped` al arrancar.
2. Detener worker y scheduler de la plataforma (`docker compose stop worker scheduler`).
3. Conservar evidencia: `integration_events` (columnas `shadow_*`), `integrations.reconciliation_signals`,
   `integrations.shadow_daily_summaries` y los logs.
4. **No revertir migraciones** (104/105 del legado, 0005–0008 de la plataforma): son aditivas y el legado
   no depende de ellas para operar.

<a id="rollback"></a>
## Rollback ensayado

Igual que el aborto, más: quitar `GATEWAY_KEYRING_FILE` y `GATEWAY_ORIGENES` (la ruta interna del legado
vuelve a responder 404) y borrar `SENALES_*` de la API. El deny de Nginx **se deja**: no molesta y protege.
Verificación: `scripts/qa/deny-interno.sh herramientas.fusionbikes.com.ar <ip>` en verde y
`curl /herramientas/healthz` 200.

<a id="cola"></a>
## Cola saturada o llena (`cola_saturada`, `cola_llena`)

- **Umbral:** ocupación > 75 % en todas las muestras de 5 min; o cualquier `queue_full` en la última hora.
- **Responsable:** operaciones.
- **Qué significa:** la plataforma responde lento o no responde; la cola de 256 descarta en vez de crecer.
- **Acción:** mirar `platform_timeout`/`platform_unavailable` en las métricas del legado. Si la plataforma
  está caída, seguir [PostgreSQL caído](#pg-caido). Si está viva pero lenta, bajar tráfico apagando la copia:
  lo descartado lo reparan los barridos. Nunca subir la capacidad para "aguantar".

<a id="respuesta-cortada"></a>
## Respuesta de webhook cortada (`respuesta_no_terminada`)

- **Umbral:** cualquier `abandoned/response_not_finished` en la última hora. **Responsable:** desarrollo.
- **Qué significa:** el cliente (ML o Woo) cortó antes de recibir el ACK. El recibo existe y el remitente
  reintenta; el barrido cubre el resto. Investigar si coincide con latencia alta del legado.

<a id="webhook-woo-desactivado"></a>
## Webhook de Woo desactivado (`webhook_woo_inactivo`)

- **Umbral:** un webhook propio de `woo_webhooks_estado` con estado distinto de `active`. **Responsable:** operaciones.
- **Acción:** reactivarlo en WooCommerce (Ajustes → Avanzado → Webhooks). Woo lo desactiva tras entregas
  fallidas: revisar primero por qué fallaban (503 del legado, firma). Mientras tanto los barridos de
  `woo.orders`/`woo.products` siguen reparando.

<a id="pg-caido"></a>
## PostgreSQL caído y pérdidas sin importar (`perdidas_sin_importar`)

- **Umbral:** hay descartes `platform_unavailable`/`platform_timeout` sin importar hace más de 1 h.
- **Responsable:** operaciones.
- **Durante la caída:** nada que hacer en el legado: los ACK no cambian y cada descarte queda contado en
  SQLite. Recuperar PostgreSQL (E0: restauración y archivado de WAL).
- **Al volver:** el legado importa solo cada 5 min (`importarPerdidas`), con auditoría encadenada
  `shadow.loss_imported` una vez por recibo. Si la alerta persiste con la plataforma sana, revisar el log
  `[sombra] importación de pérdidas` y la configuración `SOMBRA_*`.

<a id="senal-vieja"></a>
## Señal vieja (`senal_vieja`)

- **Umbral:** una señal activa hace más de 15 min. **Responsable:** operaciones.
- **Acción:** verificar que el worker esté vivo (`/api/v2/health`) y que el registro de cuentas incluya la
  cuenta y el tópico. El scheduler libera leases vencidos; si la señal está `retryable`, mirar su
  `error_detail` (429 → [429 sostenido](#http-429)).

<a id="barrido-vencido"></a>
## Barrido vencido (`barrido_vencido`)

- **Umbral:** una corriente habilitada sin éxito durante dos intervalos. **Responsable:** operaciones.
- **Acción:** mirar el `error_detail` de las últimas `sweep_runs` de esa corriente. `terminal:` es
  configuración o contrato (gateway 401, forma remota inesperada); `retryable:` se resuelve solo o es 429.

<a id="corriente-incompatible"></a>
## Corriente incompatible (`corriente_incompatible`)

- **Umbral:** una corriente habilitada de un canal distinto al de su cuenta. **Responsable:** desarrollo.
- **Acción:** deshabilitarla (`enabled=false`, nunca borrar) y averiguar quién la creó: la siembra por
  canal (0005) no puede producirla.

<a id="http-429"></a>
## 429 sostenido (`http_429_sostenido`)

- **Umbral:** ≥ 10 respuestas 429 en 30 min entre señales y barridos. **Responsable:** operaciones.
- **Qué significa:** con `GATEWAY_ML_SHADOW_RPM=0` es esperable y **correcto** (429 sintético sin red).
  Con techo > 0, la sombra está compitiendo por cuota: bajar `GATEWAY_ML_SHADOW_RPM` o apagar la copia.
  El bucket shadow nunca toma capacidad del legado, pero ML cuenta las llamadas igual.

<a id="senal-sin-observacion"></a>
## Señal con resultado sin observación (`senal_sin_observacion`)

- **Umbral:** cualquier señal cerrada `enqueued/duplicate/stale` sin observación del recurso. **Responsable:** desarrollo.
- **Qué significa:** un defecto: el resultado del GET se perdió o la señal se cerró sin explicación.
  Conservar la fila de la señal y abrir un incidente de desarrollo.

<a id="senal-dead-letter"></a>
## Señal en dead letter (`senal_dead_letter`)

- **Umbral:** cualquier señal `dead_lettered` en 24 h. **Responsable:** desarrollo.
- **Acción:** leer `error_detail` (`terminal:ErrorCanalTerminal`, `lease_vencido`, intentos agotados). El
  recurso lo sigue cubriendo el barrido; la señal sólo explica el hueco.

<a id="gateway"></a>
## Gateway interno (401 / 400 / 502)

- 401 constantes: clave o reloj desalineados entre plataforma y legado, o el origen no está en
  `GATEWAY_ORIGENES` (tiene que ser la red de Docker; nunca `0.0.0.0/0`).
- 400: la plataforma pidió una operación fuera del catálogo; es un defecto de contrato.
- 502: el canal falló sin detalle expuesto; mirar el log `[gateway] fallo de ejecución` por correlación.

<a id="requisitos-canario"></a>
## Requisitos antes del canario (C10, con autorización propia)

1. Sonda autenticada de sólo lectura de `missed_feeds` que confirme la forma de la respuesta (hoy el parser
   falla cerrado con `FORMA_MISSED_FEEDS`).
2. `ML_SITE_ID` cargada y validada contra `ML_USER_ID` (sitio del usuario en `/users/{id}`).
3. Siete días de medición de llamadas del legado para fijar `GATEWAY_ML_SHADOW_RPM`.
4. Decisión operativa sobre el puerto 3001 del legado, hoy alcanzable desde Internet sin Nginx.
5. Fotografía previa de producción y `E1-LAT-01`/`E1-PGDOWN-01` en verde (C9).
