# Plan maestro vigente — FusionBikes Herramientas + App operativa

Actualizado: 2026-08-29.

Este es el **único plan activo** del repositorio. Reemplaza planes, trackers y documentos de
implementación anteriores. Git conserva la historia; este archivo conserva solamente el estado
actual, las decisiones vigentes y el trabajo pendiente.

## Fuente de verdad y reglas operativas

- Producción sirve la rama `conteo-confiable`; `master` todavía es una línea distinta.
- Todo cambio se desarrolla en un worktree aislado y pasa por `hard-worker → revisor → tester →
  probador-e2e` cuando haya UI → `auditor-despliegue`.
- No se despliega, reinicia PM2 ni modifica configuración real automáticamente sin haber aprobado todo el pipeline, si está todo ok se despliega, git push y reinicia pm2 segun sea necesario.
- No se ejecutan suites globales concurrentes ni servidores contra `data/fusion.sqlite`.
- El contrato HTTP vive en `docs/api-contrato.md`; el contrato móvil en
  `openapi/mobile-v1.yaml`.
- `docs/memory/` conserva hechos durables, no planes paralelos ni cronologías.

## Base ya disponible

No reimplementar estos bloques salvo bug comprobado:

- Conteo confiable: ajuste por delta, cierre seguro, GTIN/EAN, ubicaciones, etiquetas, rotación,
  criticidad, planificador de ciclos, diferencias y auditoría de publicaciones.
- Preparación: provincia/dirección, nota del pedido, auditoría, concurrencia, GTIN y vínculos entre
  pedidos del mismo comprador.
- Sync ML↔Woo: cola inmediata de Preparación, push puntual de stock con feedback, sync puntual por
  orden y reconciliación de respaldo.
- Novedades ML: preguntas, mensajes y reclamos en la bandeja web.
- Hito 7 base: dispositivos, preferencias, notificaciones por usuario, intentos push, JWT de acceso,
  refresh rotativo y revocación asociada al dispositivo.
- Incidentes operativos, métricas de ciclos y dashboard de alertas.

La presencia del código no sustituye los gates pendientes que se enumeran abajo.

## Prioridad 0 — Cerrar riesgos operativos antes de ampliar

### P0.1 Claims de MercadoLibre reales

El bloque P0.1 debe mantener soporte para `topic='claims'` y agregar el envelope vigente
`post_purchase`. Antes de dar A.4 por cerrada se debe verificar contra notificaciones reales y
conservar estos contratos:

- topic legado `claims` y, si la cuenta lo entrega, `post_purchase` con acción `claims`;
- recursos `/v1/claims/{id}` y `/post-purchase/v1/claims/{id}`;
- GET autoritativo `/post-purchase/v1/claims/{id}`;
- estados reales `opened`/`closed`; `stage` no reemplaza a `status`;
- persistir campos reales (`type`, `reason_id`, `resource_id`) y obtener `/detail` solo si aporta
  datos necesarios, siempre fail-open después de conservar el aviso durable.

Aceptación: tests del handler HTTP con payloads representativos, assert del path enviado a ML,
duplicado idempotente, actualización `opened→closed`, ML caído y recurso desconocido.

### P0.2 Configuración y permisos

- Configurar `MOBILE_JWT_SECRET` distinto por entorno, mínimo 32 caracteres; nunca versionarlo.
- Configurar y verificar `WOO_WEBHOOK_SECRET` para validar HMAC.
- Confirmar topics y URL de notificaciones en ML Developers.
- Asignar `notificaciones-ml` únicamente a usuarios que deban ver ese trabajo.
- Definir proveedor push real y credenciales mediante configuración segura; mantenerlo detrás de
  feature flag hasta completar la entrega vertical.

### P0.3 Evidencia operativa

- Verificar PM2, health y migraciones aplicadas después de cada deploy manual.
- No usar como aprobación global suites previas con fallos en inventario, sync, matcher,
  reactivación o reconciliación: aislar la causa y obtener una suite final verde sin concurrencia.
- Mantener trazabilidad entre commit, revisión, tests, E2E y auditoría.

## Prioridad 1 — Columna vertebral de la app operativa

La app nunca consume ni interpreta payloads directos de ML, Woo o chat. Cada canal entra por un
adaptador, se convierte en un evento canónico durable y proyecta modelos internos estables. La
bandeja es la fuente de verdad; el push es solo una señal.

### P1.1 Modelo interno

- `integration_events`: evento canónico, durable, inmutable e idempotente.
- `integration_jobs`: cola persistente de procesamiento y reintentos.
- `integration_event_history`: etapas, transiciones y decisiones auditables.
- `inbox_items`: trabajo visible para usuario/equipo; lectura, asignación y resolución.
- `conversations` y `conversation_messages`: canales conversacionales.
- `user_notifications`: notificación lógica por usuario.
- `notification_deliveries`: intento push por dispositivo y proveedor.

El evento y su primer job se insertan en la misma transacción. Un fallo de push nunca revierte ni
oculta el evento, la conversación o el inbox.

### P1.2 Evento canónico

Campos mínimos:

```text
event_id
event_type
channel
source
external_event_id
resource_id
thread_id
actor_id
payload_version
occurred_at
received_at
correlation_id
dedupe_key
priority
metadata
status
```

La clave de deduplicación combina proveedor, tipo, identificador externo y versión/acción. No se
deduplica solo por recurso porque una orden o conversación puede cambiar varias veces.

### P1.3 Autenticidad y ACK

Orden obligatorio: validar envelope y cuenta/firma → normalizar identificadores mínimos → insertar
evento y job en una transacción → responder.

- Woo: validar HMAC.
- Chat: validar firma o secreto acordado.
- ML: validar `user_id`/cuenta y consultar el recurso con el token propio; el webhook es aviso, no
  fuente completa del contenido.
- App: JWT corto, refresh revocable y permisos resueltos en servidor.

Respuestas: `202` para evento nuevo durable y encolado, `200` para duplicado conocido, `400` para
payload inválido, `401/403` para autenticidad/cuenta incorrecta y `503` si no se pudo conservar el
evento y se necesita reintento. Nunca confirmar éxito antes de persistir.

### P1.4 Estados y diagnóstico

- Evento: `pending`, `processing`, `completed`, `failed`, `dead_lettered`.
- Inbox: `unread`, `read`, `resolved`, `archived`.
- Push: `pending`, `sent`, `failed`, `expired`.
- Conversación: `open`, `assigned`, `resolved`, `archived`.

Las etapas técnicas viven en el historial como `stage`: `webhook.validate`, `event.normalize`,
`event.persist`, `inbox.project`, `notification.create`, `push.dispatch`. Duplicados o eventos viejos
se registran como `ignored_duplicate`/`ignored_stale` sin repetir efectos.

Cada fallo registra únicamente información segura:

```text
error_code
source
stage
resource_id
correlation_id
retryable
attempts
first_failed_at
last_failed_at
next_retry_at
safe_message
event_id
user_id
device_id
provider_status
```

Los últimos cuatro pueden ser nulos. Nunca guardar tokens, secretos ni texto privado en errores.

### P1.5 Cola SQLite, orden y DLQ

La cola usa `available_at`, `locked_at`, `locked_by`, lease con vencimiento, `attempts` y lotes
pequeños. No usar `worker_threads` para trabajo de red. Un lease abandonado vuelve a estar
disponible. Los reintentos usan backoff creciente y límite explícito; al agotarse terminan en DLQ
con reproceso manual.

Estado implementado para Claims: `integration_jobs` ya tiene worker durable con lease/backoff/DLQ;
`notification_deliveries` tiene worker separado con lease, backoff y límite de cinco intentos.
El worker de entregas no comparte candado ni estado con el worker legacy de incidentes.

Eventos fuera de orden se conservan, se comparan por `occurred_at`/versión y nunca retroceden un
estado confirmado. Si no se puede decidir, quedan pendientes de reconciliación.

### P1.6 Destinatarios, privacidad y deep links

- Resolver destinatario por usuario asignado, equipo, rol o permiso; nunca enviar a todos por
  defecto.
- Estado implementado: la API móvil exige el permiso `notificaciones-ml` y vuelve a comprobar la
  asignación antes de leer o modificar un ítem. La toma manual crea entregas solo para dispositivos
  activos del usuario que tomó el trabajo. La resolución automática por equipo/rol sigue pendiente.
- Definir retención por tipo de contenido y PII antes de implementar cada adaptador.
- Revocar tokens inválidos y auditar accesos.
- Los deep links usan IDs internos y vuelven a validar permisos en el backend.

### P1.7 API de lectura operativa

- `GET /api/v1/inbox?status=&channel=&cursor=`.
- `GET /api/v1/inbox/:id`.
- `POST /api/v1/inbox/:id/read`.
- `POST /api/v1/inbox/:id/resolve` con control de versión y `409`.
- `GET /api/v1/conversations/:id`.
- `POST /api/v1/conversations/:id/read`.
- `GET /api/v1/integration-notifications` paginado para notificaciones lógicas del backbone;
  `/api/v1/notifications` queda reservado al feed Hito 7.
- `GET /api/v1/operations/:correlation_id` con etapas seguras según permisos.

Estado implementado: las rutas anteriores están montadas y cubiertas por pruebas dirigidas; el
contrato vigente está en `openapi/mobile-v1.yaml`.

### P1.8 Primera entrega vertical

Estado backend implementado para Claims: webhook → persistencia legacy y evento durable atómicos →
inbox → toma manual → notificación lógica → entrega push durable → deep link → lectura/resolución.
La prueba E2E de navegador cubre Home y la API dirigida cubre autenticación, deduplicación, fallos,
reintentos y aislamiento. Falta completar el cliente móvil y la prueba en dispositivo real.

Implementar primero un único flujo completo:

```text
ML question → evento durable → inbox → notificación por usuario → push simulado
→ deep link interno → lectura/resolución → auditoría
```

Debe cubrir duplicados, replay, evento desordenado, usuario sin permiso, caída de push, lease
abandonado, DLQ y reconciliación. Luego incorporar adaptadores separados para claims, messages,
órdenes ML y órdenes Woo. Implementar conversaciones antes del chat; integrar chat inicialmente en
modo solo lectura. Activar push real al final, detrás de feature flag.

## Prioridad 2 — App móvil por entregas verticales

El backend base de acceso y dispositivos ya existe; el cliente móvil sigue pendiente.

1. **Setup:** repo de app, Expo/TypeScript, navegación, sistema visual, cliente generado desde
   OpenAPI, mock server y fixtures.
2. **Acceso:** login, refresh, logout, `/me`, almacenamiento seguro, biometría y estados offline.
3. **Stock:** escáner SKU/EAN, búsqueda, detalle, ajuste idempotente con `expected_stock`, operación
   consultable y conflicto `409`.
4. **Pedidos:** lectura paginada de `pedidos_cache`, filtros, permisos e indicador de novedad.
5. **Hoy:** agregador de pedidos, stock, inbox y tareas priorizadas.
6. **Notificaciones:** preferencias, registro/revocación de dispositivo, push real y deep links.

Validar temprano cámara, biometría, background y push en dispositivos reales. La app no modifica
stock ni resuelve trabajo offline sin idempotency key y control de versión.

### Ruta específica Claims P0.1 → P2

Esta ruta desglosa el objetivo de Claims sin ampliar el alcance de Hito 7 ni autorizar
despliegues. Estado verificado al 2026-08-29: P0.1 y P1 backend están integrados; P0.2/P0.3
requieren configuración y verificación manual del entorno; P2 móvil se implementa en otro
chat sobre el handoff `docs/superpowers/specs/claims-p2-mobile-ux.md`.

1. **P0.1 — Ingesta real y fail-open:** conservar el webhook legado y `post_purchase`, validar
   cuenta, consultar el recurso autoritativo, persistir `opened`/`closed`, deduplicar y dejar
   diagnóstico durable cuando ML falle. Gate: contrato HTTP, migración, 27 tests Claims, suite
   global verde y auditoría.
2. **P1 — Backbone durable para Claims:** crear `integration_events`, `integration_jobs`,
   `integration_event_history`, `inbox_items`, `conversations`, `conversation_messages`,
   `user_notifications` y `notification_deliveries` con migraciones idempotentes. Adaptar Claims
   para insertar evento y primer job en una transacción, proyectar un inbox interno y registrar
   cada etapa/error con `correlation_id`, lease, backoff, DLQ y orden de eventos. Gate: replay,
   duplicado, evento fuera de orden, cuenta no autorizada, caída de push, lease vencido y
   reconciliación.
3. **P1 — API operativa:** exponer lectura paginada de inbox, detalle, marcar leído, resolver con
   control de versión, conversación de solo lectura, notificaciones y operación por correlación.
   Todos los endpoints deben revalidar permisos y usar IDs internos en deep links. Gate: contrato
   OpenAPI/API, aislamiento por usuario/equipo, `409` por versión vieja y auditoría segura.
4. **P1 — Entrega vertical Claims:** `claim webhook → evento → inbox → notificación lógica →
   push simulado → deep link → lectura/resolución → auditoría`, incluyendo fail-open y DLQ. No
   activar proveedor push real en esta fase.
5. **P2 — Cliente móvil Claims (otro chat):** incorporar el prototipo Expo existente o crear su
   setup solo si no existe, generar cliente desde OpenAPI, autenticación segura, inbox paginado,
   detalle de Claim, marcar leído/resolver, estados offline y deep links con permisos. Validar
   push y background en dispositivo real antes de activar proveedor. No se declara cerrado desde
   este repositorio hasta recibir commit, tests y E2E móvil del otro chat.
6. **P2 — Gate final:** el otro chat entrega commit y E2E móvil; luego este repositorio ejecuta
   revisor independiente, suite completa serial sin DB abandonadas, auditoría final y rollback
   documentado. El deploy queda manual; nunca tocar Hito 7 ni reiniciar procesos durante esta
   ruta.

## Prioridad 3 — Conteo e inventario pendiente

- Implementar el aviso Home de control diario usando `/api/inventario/plan-hoy`, con estimación de
  tiempo honesta y estado vacío.
- Corregir auditoría de publicaciones: nombre/semántica de `sin_clip`, logging de errores en
  `ensureAuditoriaTable` y assert real de rotación de cursor.
- E2E de etiquetas: marcar → cola → imprimir → desaparecer.
- E2E de ubicaciones: crear → mapear → escanear → cerrar en cero seguro.
- Agregar acción “descartar” en UI del historial de diferencias.
- Corregir `/aprobar` dual-EAN que marca `ajustado_en` de más.
- Evitar alerta duplicada al reintentar `/confirmar` después de fallo Woo.
- Revisar manualmente `FB-1419` como `no_contable` o mejorar la sugerencia sin hardcode riesgoso.
- Mostrar sobrantes pendientes en naranja con instrucción clara, no como error rojo.

## Prioridad 4 — Preparación pendiente

Ya están integradas las fases de provincia, dirección, nota y vínculos de comprador.

- Cerrar revisión formal, tests dirigidos, E2E móvil y auditoría del flujo para asociar un
  GTIN/EAN válido desconocido durante la preparación antes de integrarlo o desplegarlo. Verificar
  candidatos pendientes, conflicto y reemplazo explícito del código, conservación local cuando
  Woo falla, reintento operativo y títulos largos en 390 px.
- Cerrar auditoría/E2E pendiente de las fases desplegadas, incluida dirección con campos largos en
  390 px y flujo real de vínculos.
- Integrar **Horarios de corte y fecha de despacho** desde `prep-horarios-corte` solo después de
  repetir revisor, tests, E2E y auditoría sobre la base actual.
- Después implementar **Etiqueta interna 50×25 mm + Control de despacho**, usando
  `fecha_despacho` y vínculos; incluir escaneo, agrupación, estados y auditoría.
- Corregir en Recepción el proveedor completado después de agregar ítems, que hoy puede dejar los
  botones deshabilitados.
- Verificar responsive de la tabla/modal de stock en 390 px.

## Prioridad 5 — Deuda de sync y pruebas

- En Recepciones, obtener el SKU vigente desde `catalogo_cache` antes del push puntual a ML.
- Anclar con test que la recepción queda `confirmada` antes del push fail-open.
- Documentar que `/api/woo/stock/aplicar` devuelve el SKU de `catalogo_cache`.
- Extraer el componente visual de estado ML cuando exista un tercer consumidor.
- Eliminar asserts de timing frágiles en `recepciones.test.js` y el timeout intermitente de
  `matcherPush.test.js` mediante pruebas deterministas, no subiendo límites sin diagnóstico.

## Prioridad 6 — Consolidar `master` y `conteo-confiable`

Objetivo: una sola línea de desarrollo y producción, sin perder funciones exclusivas.

1. Confirmar que no haya agentes, worktrees o despliegues activos sobre ambas ramas.
2. Congelar una base y respaldar referencias remotas.
3. Integrar `conteo-confiable` en `master`, resolviendo contratos y migraciones explícitamente.
4. Verificar rutas, permisos, crons, migraciones, frontend y funciones exclusivas.
5. Ejecutar una única suite global serial y tests dirigidos de módulos críticos.
6. E2E en instancia aislada: login, Home, inventario, Preparación, Matcher, auditoría y API móvil.
7. Auditoría final y corte manual de PM2.
8. Mantener rollback al commit anterior; no borrar ramas hasta comprobar operación real.

Este proyecto no bloquea la API/app, pero debe ejecutarse cuando no haya sesiones trabajando en
vivo. Tras consolidar, `master` será la única rama permanente y este plan seguirá siendo la única
fuente de trabajo pendiente.

## Criterios globales de aceptación

- Contrato y migración numerada para todo cambio de esquema/API.
- Permisos y aislamiento por usuario cubiertos.
- Ningún webhook confirma éxito antes de persistencia durable.
- Ningún fallo de push pierde inbox/evento.
- Replays no producen efectos funcionales duplicados.
- Errores identifican canal, etapa, recurso y correlación sin exponer PII o secretos.
- Tests dirigidos y suite global final verdes, sin procesos ni DB temporales abandonados.
- UI responsive y accesible cuando corresponda.
- Revisor sin hallazgos bloqueantes y auditor con luz verde.
- Deploy manual con health, logs, migraciones y rollback verificados.

## Fuera de alcance hasta decisión explícita

- Respuestas automáticas o IA sobre mensajes/reclamos.
- Chat bidireccional antes de validar lectura, permisos y conversaciones.
- CRM, taller, compras o analítica avanzada dentro del bloque móvil.
- Credenciales reales versionadas.
- Deploy automático a producción.
