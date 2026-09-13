# E20 — Bandeja, alertas, turnos y reemplazos en App

**Estado:** borrador

**Dependencias:** E9, E19

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- App opera bandeja, alertas, claims, turnos y reemplazos con paridad web.
- **Incluye:** Push, deep links, asignación, acuse, escalamiento, turnos y ausencia.
- **No incluye:** No incluye offline común de depósito.
- **Evidencia histórica absorbida:** E6, E7 históricos. Es evidencia, no aceptación automática.

## Línea base verificada

- Inbox y push se usan; asignaciones/turnos no tienen adopción verificada.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Push es señal, nunca fuente de verdad; polling/SSE recuperan pérdidas.

## Diseño, datos e interfaces

- **Modelo:** Assignments, acknowledgements, escalation events y shifts sobre el núcleo.
- **Interfaces:** API v2 y fachada v1 durante migración; acciones idempotentes y permisos comunes.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Migrar pantalla por OTA conservando deep links y preferencias.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e20 más suite App; push perdido, doble claim, ausencia y deep links.
- El comando `npm run test:e20` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Equipo interno canario, métricas de acuse y rollback OTA.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Paridad web/App y turno observado con reemplazo.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Medir uso real de inbox y definir matriz de routing desde decisiones existentes.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** PM-017
- **Consumidora:** PM-015, PM-016, PM-020, PM-022, PM-023, PM-034, PM-037, PM-052, PM-068, PM-097, PM-109, PM-137, PM-146, PM-157, PM-158, PM-162
