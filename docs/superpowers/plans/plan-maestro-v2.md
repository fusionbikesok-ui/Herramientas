# Plan maestro vigente — FusionBikes Herramientas + App operativa

Actualizado: 2026-08-29. Reordenado para el compromiso operativo del 2026-09-04.

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
- Este archivo es canónico para este repositorio backend. La app móvil se desarrolla en otro chat
  y su repositorio/plan propio es la fuente de verdad del cliente; no se afirma aquí que exista una
  copia sincronizada local.
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

## Hito U0 — Cierre obligatorio de Inventario y Preparación

**Fecha límite: viernes 4 de septiembre de 2026.** Este hito tiene precedencia sobre las
prioridades numeradas posteriores. Claims, notificaciones y otros frentes pueden conservar su
estado, pero no desplazan recursos ni amplían alcance hasta cerrar U0.

“Cerrado esta semana” significa dos resultados simultáneos:

1. Conteo de Inventario y Preparación de Pedidos operativos y validados de punta a punta en el
   VPS.
2. Contratos, pantallas, reglas, estados y entregas de ambos módulos definidos para la app. La
   publicación de la app no bloquea el cierre del VPS.

Esta replanificación es documental. No autoriza por sí sola despliegues, migraciones, reinicios,
configuración ni cambios de código en producción.

### U0.A — Conteo de Inventario en VPS

Cerrar como una sola entrega usable:

1. Plan diario y selección de ubicación.
2. Lectura por EAN/GTIN y carga manual.
3. Conteo, corrección y cierre seguro, incluido el cierre en cero.
4. Detección de diferencias y sobrantes.
5. Motivos estructurados, aprobación/rechazo y auditoría.
6. Asociación controlada de códigos desconocidos, con aprobación elevada cuando corresponda.
7. Ubicaciones, etiquetas, historial y descarte explícito de diferencias.
8. Reintentos idempotentes: un fallo de WooCommerce no duplica ajustes, cierres ni alertas.

Pendientes concretos absorbidos por esta entrega:

- Home usa `/api/inventario/plan-hoy`, muestra estimación honesta y estado vacío.
- Auditoría de publicaciones corrige `sin_clip`, registra fallos de `ensureAuditoriaTable` y
  prueba la rotación real del cursor.
- E2E de etiquetas: marcar → cola → imprimir → desaparecer.
- E2E de ubicaciones: crear → mapear → escanear → cerrar en cero seguro.
- Historial de diferencias permite descartar; `/aprobar` no marca otros dual-EAN como ajustados.
- `/confirmar` no repite la alerta tras un fallo Woo; `FB-1419` se clasifica sin hardcode riesgoso.
- Los sobrantes pendientes se muestran en naranja, con instrucción operativa clara.

**Aceptación U0.A:** un operador puede comenzar, completar y auditar un conteo real sin
inconsistencias, pérdida silenciosa de datos ni efectos duplicados.

### U0.B — Preparación de Pedidos en VPS

Cerrar como una sola entrega usable:

1. Cola y toma exclusiva del pedido por un operador.
2. Dirección, provincia, observaciones y vínculos del comprador.
3. Escaneo y resolución explícita de EAN/GTIN desconocidos o conflictivos.
4. Evidencias fotográficas y conservación local cuando WooCommerce falla.
5. Finalización, etiqueta interna de 50×25 mm y estado de embalaje.
6. Despacho, `fecha_despacho`, seguimiento e incidencias.
7. Reintentos seguros, control de concurrencia y auditoría completa.
8. Revisión, tests, E2E y auditoría de horarios de corte antes de habilitarlos.

Pendientes concretos absorbidos por esta entrega:

- Cerrar revisión, pruebas y E2E del alta de GTIN/EAN durante Preparación: candidatos,
  conflicto, reemplazo explícito, conservación local, reintento y títulos largos a 390 px.
- Completar E2E de dirección con campos largos y vínculos del comprador.
- Integrar `prep-horarios-corte` únicamente después de repetir todos los gates sobre la base
  productiva actual.
- Implementar etiqueta interna y control de despacho con escaneo, agrupación, estados y
  auditoría.
- Corregir el bloqueo de botones cuando se completa el proveedor de Recepción después de agregar
  ítems y verificar tabla/modal de stock a 390 px.

**Aceptación U0.B:** un pedido recorre cola → preparación → evidencia → etiqueta → despacho con
trazabilidad completa y sin toma simultánea por dos operadores.

Quedan fuera de U0 pagos, reembolsos, cancelaciones y compras a proveedores.

### U0.C — Definición congelada para la app

Antes del cierre del 2026-09-04, `openapi/mobile-v1.yaml` debe definir recursos versionados
`/api/v1` para:

- **Inventario:** plan diario, sesiones, escaneos, ítems, cierre seguro, ubicaciones,
  diferencias, aprobar/rechazar/descartar, historial y trabajos de etiquetas.
- **Preparación:** cola, detalle, toma exclusiva, escaneos, evidencias, finalización, trabajos de
  etiqueta, despacho, seguimiento e incidencias.

Toda mutación reintentable declara UUID de idempotencia; toda edición concurrente declara
`expected_version` y devuelve `409` sin sobrescribir. El contrato documenta permisos, paginación
por cursor, auditoría, errores uniformes y ejemplos realistas. Web y `/api/v1` comparten servicios
de negocio; la app no llama rutas web autenticadas por cookies.

Pantallas mínimas congeladas:

- Preparación: cola, detalle/toma, escaneo, evidencia, cierre/etiqueta y despacho/incidencia.
- Inventario: Hoy/ubicación, sesión de conteo, diferencias, aprobación y historial/etiquetas.

Inventario admite cola offline controlada durante siete días, con reanudación visible y
resolución de conflictos sin sobrescribir al servidor. Preparación puede cachearse para consulta,
pero todas sus mutaciones requieren conexión. Los borradores locales vencen a los siete días.

**Gate U0.C:** OpenAPI validado, cliente TypeScript regenerable, fixtures derivados del contrato,
mapa de permisos, estados vacío/error/reintento/conflicto y criterios E2E firmados para ambos
módulos.

### U0.D — Validación y secuencia segura

La línea base dirigida verificada el 2026-08-29 queda como piso: Inventario principal 164/164,
ConteoCantidad 24/24, scanner gate 4/4, ubicaciones 13/13, etiquetas 11/11, etiquetas por categoría
10/10; Preparación principal 182/182, contrato 30/30, vínculos 13/13, fotos en cola 8/8 y cierre sin
evidencia 10/10. Estos resultados no sustituyen los tests del diff futuro.

Orden obligatorio de ejecución:

1. Comparar cualquier rama/worktree candidato contra `conteo-confiable`; no integrar por nombre ni
   antigüedad.
2. Trabajar cada entrega usable en worktree aislado y con base SQLite de prueba.
3. Ejecutar tests dirigidos, revisión, E2E real a 390 px y auditoría del diff final.
4. Ejecutar la suite global una sola vez, en serie y sin servidores de prueba activos.
5. Presentar al usuario impacto, rollback y evidencia antes de cualquier migración, deploy, push o
   reinicio de PM2.
6. Tras aprobación y despliegue manual, verificar health, logs, migraciones y el recorrido real sin
   alterar datos fuera de la prueba acordada.

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

Verificación local de configuración 2026-08-30: `.env` de producción contiene las variables de
JWT móvil, secreto HMAC de Woo, credenciales ML y FCM; `MOBILE_JWT_SECRET` tiene 64 caracteres.
Los valores no se registran en documentación. La existencia de topics y URL en ML Developers
fue confirmada operativamente por el responsable; la URL vigente es
`https://herramientas.fusionbikes.com.ar/api/ml/notificacion`.

### P0.3 Evidencia operativa

- Verificar PM2, health y migraciones aplicadas después de cada deploy manual.
- No usar como aprobación global suites previas con fallos en inventario, sync, matcher,
  reactivación o reconciliación: aislar la causa y obtener una suite final verde sin concurrencia.
- Mantener trazabilidad entre commit, revisión, tests, E2E y auditoría.
- La reconciliación read-only del catálogo tuvo inicialmente un `403`; el acceso fue corregido y
  `/system_status` y `/products?per_page=1` respondieron `200` el 2026-08-30. La consulta de los
  20 stocks negativos coincidieron exactamente con Woo en la reconciliación read-only final; los
  tres SKUs mapeados sin fila local devolvieron cero coincidencias. El `403`/`500` transitorio se
  resolvió sin cambiar Nginx ni el código. No ejecutar `PUT`, `DELETE` ni correcciones SQLite para
  esos registros: la evidencia confirma que son datos reales o mapeos ausentes en Woo.
- Post-despliegue 2026-08-30: `conteo-confiable` quedó en `d6a021a` (incluye `37107af`), PM2 está
  `online`, el webhook Woo rechaza firma inválida con `401` y el webhook ML responde `200`.
  El ciclo real posterior al reinicio, ejecutado a las 12:30 UTC, completó `barridoAuditoria`
  con `auditados:40` y persistió `sync_estado.cursor_auditoria.actualizado_en` en
  `2026-08-30T12:30:00.807Z`; por tanto, los mensajes anteriores de `ML_CLIENT_ID` y de
  `sync_estado.actualizado_en` quedan identificados como históricos, no como fallo del código
  actualmente desplegado.
- Los conteos de gates anteriores quedan invalidados por cambios posteriores. Deben regenerarse
  sobre el diff final actual mediante revisor, tester y auditor; no certifican cierre.
- El backbone exige un único camino durable: el webhook persiste evento+job, el worker consulta ML
  con configuración obligatoria y proyecta sobre ese mismo evento; no se crean eventos derivados.
- `PUSH_REAL_ENABLED` ausente o distinto de `true` pausa ambos workers sin incrementar intentos.

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

Respuestas: `202` para evento nuevo durable y encolado, `200` para duplicado conocido o cuenta ML
ajena descartada (`{ok:true, ignored:true}`; decisión explícita no reintentable), `400` para
  payload inválido, `200 {ignored:true}` para cuenta ajena (descartada sin persistir) y `503` si no se pudo conservar el
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

- Resolver destinatario por usuario asignado o por la lista explícita de usuarios con permiso
  `notificaciones-ml`; nunca enviar a todos por defecto. Los administradores gestionan esa lista
  desde el gestor de usuarios.
- Estado implementado para este corte: la API móvil exige `notificaciones-ml` y vuelve a comprobar
  la asignación antes de leer o modificar un ítem. La toma manual crea entregas solo para dispositivos
  activos del usuario que tomó el trabajo; no se afirma fan-out automático donde el código solo hace
  asignación manual. Equipos/roles son una extensión posterior del modelo de autorización y no
  constituyen un requisito para iniciar P2.
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

El backend también proyecta preguntas de MercadoLibre al backbone durable: evento idempotente,
job, historial e inbox se persisten junto con la pregunta. El push físico real y el cliente móvil
siguen deliberadamente fuera de este cierre previo a P2; el flujo lógico se prueba con entregas
simuladas y `PUSH_REAL_ENABLED` debe permanecer distinto de `true` hasta el gate posterior.

### P1.8 Primera entrega vertical

Estado backend implementado para Claims: webhook → evento/job durable atómicos → consulta autoritativa
ML → persistencia legacy e inbox idempotentes → toma manual → notificación lógica → entrega push
durable → deep link → lectura/resolución. La persistencia legacy ocurre en el worker, no antes del
ACK; un fallo conserva el evento/job para reintento.
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

El backend base de acceso y dispositivos ya existe; el cliente móvil sigue pendiente. El orden de
ejecución queda subordinado a U0 y reemplaza el tracker anterior de Stock/Pedidos genéricos:

| Entrega | Resultado usable | Gate de salida |
| --- | --- | --- |
| **App 0 — Base común** | Expo SDK 57, TypeScript, Expo Router, sistema visual, auth, almacenamiento seguro, cliente OpenAPI y observabilidad | Login/refresh/logout/`/me`, bloqueo biométrico opcional, fixtures contractuales y build iOS instalable |
| **App 1 — Preparación** | Cola, toma, detalle, escaneo, evidencia, cierre, etiqueta, despacho e incidencias | Integración real con `/api/v1`, concurrencia `409`, recuperación de red y E2E en iPhone |
| **App 2 — Inventario** | Plan diario, ubicaciones, conteo, diferencias, aprobaciones, historial y etiquetas | Integración real, cola offline segura, conflicto sin sobrescritura y E2E en iPhone |
| **App 3 — Consolidación** | Inbox, notificaciones, deep links, pantalla Hoy, soporte básico de iPad y posterior Android | Push real por feature flag, privacidad validada y piloto operativo aprobado |

Preparación se implementa primero por la solicitud operativa directa; Inventario comienza
inmediatamente después sobre la misma base común. Los contratos y UX de ambos se congelan juntos
en U0.C, por lo que el orden de implementación no posterga su definición.

**Estado App 0:** pertenece al desarrollo móvil del otro chat. Este repositorio solo conserva los
contratos backend y no declara como propio ningún shell, build, test o artefacto móvil.

La app usa arquitectura modular por features (`auth`, `orders/preparation`, `inventory`, `inbox`,
`notifications`, `settings` y `core`). TanStack Query conserva estado remoto; Zustand solo estado
local transversal; tokens viven en SecureStore y el cache offline sensible usa almacenamiento
cifrado. Validar cámara, biometría, background y push en dispositivos reales desde App 0.

### Ruta específica Claims P0.1 → App 3

Esta ruta desglosa el objetivo de Claims sin ampliar el alcance de Hito 7 ni autorizar
despliegues. Estado documental al 2026-08-30: P0.1 y P1 backend tienen un diff local pendiente
de revisión final; sus conteos y auditorías previos no certifican este estado. P0.2 está
configurado según la evidencia operativa disponible y P0.3 requiere repetir la verificación
tras integrar este diff; el cliente móvil queda subordinado a App 3 sobre el handoff
`docs/superpowers/specs/claims-p2-mobile-ux.md` para no desplazar U0.

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
   entrega push durable → deep link → lectura/resolución → auditoría`, incluyendo fail-open y DLQ.
   El proveedor real se habilita mediante la decisión/configuración operativa de P0.2.
5. **App 3 — Cliente móvil Claims:** incorporar el prototipo Expo existente o crear su
   setup solo si no existe, generar cliente desde OpenAPI, autenticación segura, inbox paginado,
   detalle de Claim, marcar leído/resolver, estados offline y deep links con permisos. Validar
   push y background en dispositivo real antes de activar proveedor. No se declara cerrado desde
   este repositorio hasta recibir commit, tests y E2E móvil del otro chat.
6. **App 3 — Gate final:** la app entrega commit y E2E móvil; luego este repositorio ejecuta
   revisor independiente, suite completa serial sin DB abandonadas, auditoría final y rollback
   documentado. El deploy queda manual; nunca tocar Hito 7 ni reiniciar procesos durante esta
   ruta.

## Prioridades 3 y 4 — Absorbidas por U0

Los backlogs anteriores de Conteo/Inventario y Preparación quedaron incorporados íntegramente en
U0.A y U0.B. No mantener listas paralelas: el estado semanal, las evidencias y cualquier bloqueo
se actualizan únicamente dentro de U0 hasta el cierre del 2026-09-04.

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
