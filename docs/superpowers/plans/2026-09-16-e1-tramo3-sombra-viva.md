# Plan de implementación — E1 tramo 3

- **Estado:** revisado el 2026-09-16 con las correcciones aplicadas; no ejecutado.
- **Diseño rector:** `../specs/2026-09-16-e1-tramo3-sombra-viva-design.md`.
- **Prohibido por este plan:** desplegar, usar credenciales reales o habilitar tráfico sin aprobación separada.

## Gates de entrada

- `E1_TRAMO=2 npm run test:e1` verde.
- Revisión independiente T2 aprobada y registrada.
- Worktree limpio y hashes de backend/despliegue registrados.
- `ML_CLIENT_ID` ya existe; `ML_SITE_ID` hay que agregarla, y ella y las cuentas reales sólo se validan
  en el corte autorizado de canario.
- Presupuesto `shadow` permanece en cero hasta completar la medición exigida.

## Cortes revisables

### C1 — Contrato y migraciones

- Añadir a `integration_events` las columnas del ciclo de sombra (`shadow_status`, `shadow_reason`,
  `ack_at`, `enqueue_at`, `completed_at`, `boot_id`, `attempt_id`, `shadow_imported_at`) con sus checks
  e índices parciales; no se crea tabla nueva.
- Añadir `reconciliation_signals`, restricciones, leases e índices a PostgreSQL.
- Corregir la siembra por canal mediante migración forward-only.
- Actualizar schema ejecutable, OpenAPI interno y matriz de pruebas.
- Gate: tests de migración repetible, checks, FK, unicidad y permisos.

### C2 — Recibos y cola legacy

- Crear módulo aislado para transición del ciclo de sombra, watchdog, boot id y purga.
- Usar la transacción existente de ML y Woo products; el ciclo viaja en el mismo evento.
- Crear el evento de Woo orders antes del ACK, sin su body, con 503 ante fallo de SQLite.
- Persistir la cuenta ajena como `excluded/foreign_account` **con** límite por IP y ventana y purga
  propia; sin esa defensa el corte no pasa.
- Registrar `finish`/`close` y cola 256/concurrencia 2/timeout 250 ms/un intento.
- Gate: códigos legacy idénticos salvo el 503 deliberado de Woo orders ante SQLite caído; la defensa de
  cuenta ajena demostrada con una ráfaga de `user_id` al azar que no hace crecer la base.

### C3 — API interna de señales

- Implementar HMAC rotatorio, nonce, ventana temporal, límite de cuerpo y origen interno.
- Resolver cuenta desde el registro del servidor.
- Insertar/deduplicar/coalescer señales sin tocar inbox u observaciones.
- Gate: contrato de códigos, replay y PostgreSQL caído.

### C4 — Multi-cuenta

- Sustituir configuración T2 de cuenta única por registro validado.
- Registrar adaptadores por cuenta y canal.
- Reclamar exclusivamente corridas compatibles.
- Gate: dos cuentas simultáneas sin cruce de señal, cursor, observación ni inbox.

### C5 — Gateway GET

- Añadir operaciones simbólicas y esquemas cerrados al legado.
- Reutilizar clientes y OAuth existentes; sanear respuestas/errores.
- Añadir HMAC/origen, `host-gateway` y deny público de Nginx para `/internal/` **y**
  `/herramientas/internal/`: el segundo `location` proxea con barra final y quita el prefijo.
- Agregar `host.docker.internal` a la allowlist del transporte local, sin tocar el invariante de canal
  de T2 ni su prueba: el POST del gateway es plano de control, no una llamada de canal.
- Gate: ninguna entrada puede controlar método, host o path; toda escritura falla antes de red.

### C6 — Relecturas puntuales

- Adaptadores puntuales ML/Woo y procesador de señales con lease.
- Reutilizar el motor T2 para persistir únicamente el resultado remoto.
- Messages dispara el barrido por packs, nunca resuelve el id del aviso.
- Gate: deduplicación, coalescencia, 404, stale y reparación por barrido.

### C7 — Compatibilidad y recuperación ML

- Migrar items a `/items/bulk?ids=`, ya verificado por sonda el 2026-09-16: el adaptador pasa de leer
  `code` a leer `status_code` por elemento. `/items?ids=` sigue vigente, así que el corte no es urgente
  y puede ir después de C6 sin bloquear nada.
- Añadir `missed_feeds` cada 30 minutos, enumeración completa y deduplicación.
- Reusar `ML_CLIENT_ID`/`ML_CLIENT_SECRET`/`ML_USER_ID` (no existe `ML_APP_ID`), agregar `ML_SITE_ID` al
  entorno y validarla contra el `user_id`; definir la clase de cuota shadow.
- Gate: resultado parcial bulk con `status_code` por elemento, dos días, site requerido y ausencia de
  falsos cursores.

### C8 — Métricas, evidencia y SOP

- Métricas/alertas del diseño y resumen diario sin firma.
- Runbooks de cola, gateway, 429, webhook Woo desactivado, PG down y rollback.
- Gate: cada alerta tiene fixture, umbral, responsable y evidencia reproducible.

### C9 — QA contractual

- Extender `test:e1` para T3 acumulativo.
- Ejecutar simulador y 500 webhooks anonimizados en las tres corridas de 30 minutos.
- Demostrar reparación independiente, importación auditada de pérdidas y deny público de `/internal/`
  y `/herramientas/internal/` desde Internet.
- Gate: E1-LAT-01 y E1-PGDOWN-01 en verde con artefactos fechados.

### C10 — Canario y soak

- Requiere aprobación nueva y fotografía previa de producción.
- Migraciones con flags apagados; relectura, luego copia 1/10/50/100%.
- Esperar un intervalo de barrido entre ampliaciones; items al final.
- Soak 24 horas, revisión operativa y rollback ensayado.
- Gate: T3 aceptado; E1 continúa en desarrollo y T4 sigue pendiente.

## Decisiones de José para C9 y C10 (2026-09-16)

- **C9:** corridas de latencia y PostgreSQL detenido en el VPS, de madrugada (01:00–05:00 ART, fuera de los
  barridos de 04:00–04:30), en entorno aislado; nunca contra la app de producción. Los 500 webhooks salen de
  recibos reales **anonimizados** (ids, usuarios y textos reemplazados), sin salir del VPS ni commitearse.
  `E1-GW-02` desde Internet lo corre José con `scripts/qa/deny-interno.sh` y pega la salida.
- **Puerto 3001:** firewall que sólo permita loopback y la red de Docker, con respaldo previo y verificación de
  que la app siga respondiendo por Nginx.
- **Revisión independiente** de C2–C8 antes de C9; se corrigen hallazgos hasta "aprobado".
- **Autorizadas:** una sonda autenticada de sólo lectura a `/missed_feeds` (offset 0, limit 1 por tópico, sin
  rotar el token si le quedan > 30 min, sin guardar cuerpos) y validar `ML_SITE_ID` con `GET /users/{ML_USER_ID}`
  y cargarla en `.env` sin reiniciar.
- **Cuota shadow ML:** medir 7 días y proponer el techo; hasta entonces `GATEWAY_ML_SHADOW_RPM=0`.
- **C10:** reinicio de producción de madrugada con backup de `data/fusion.sqlite` y verificación de `/healthz`
  y de los tres webhooks. Woo primero; ML cuando exista el techo medido; items al final. Cada ampliación
  (relectura → copia 1/10/50/100 %) la aprueba José tras un intervalo de barrido con métricas. En el soak de
  24 h monitorea la sesión: ante alerta crítica se aplica el aborto del SOP automáticamente y se avisa; nada
  más se revierte sin José.

## Orden de commits

Un commit por corte. C1–C8 pueden implementarse sin conexión real. C9 genera evidencia QA. C10 nunca
se infiere del merge: necesita autorización explícita. Ningún commit cambia por sí solo flags del VPS.

## Criterio de cierre documental

- Diseño, ficha E1, plan maestro, decisiones, atlas, matriz y memoria dicen lo mismo.
- No se atribuyen a T3 passkeys, firma, email, Object Lock ni siete días.
- No se declara implementado un corte sin comando, salida, commit y fecha.
- Todo hallazgo queda como fallo explicado, decisión PM o gate bloqueante.
