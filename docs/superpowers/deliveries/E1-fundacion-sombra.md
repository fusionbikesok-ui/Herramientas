# E1 — Fundación PostgreSQL en sombra

**Estado:** planificada

**Dependencias:** E0

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Esquema base, auditoría encadenada, inbox/outbox/DLQ, API, worker y scheduler separados, passkeys desactivadas y reporte diario firmado de sombra.
- **Incluye:** Node 24/TypeScript estricto en plataforma/, PostgreSQL, roles, WebAuthn virtual, cifrado de PII, colas durables y barridos ML/Woo por tópico.
- **No incluye:** No entrega catálogo, stock, pedidos, pantallas operativas ni escritores remotos.
- **Evidencia histórica absorbida:** P1. Es evidencia, no aceptación automática.

## Línea base verificada

- El legado Node/Express/SQLite sigue atendiendo producción; existe plan P1 auditado archivado.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- La sombra jamás condiciona el ACK legacy. Estados sin historial enumerables se validan por convergencia; envíos usan cursor shipment.last_updated propio.

## Diseño, datos e interfaces

- **Modelo:** companies, channel_accounts, users, roles, capabilities, audit_events, audit_daily_manifests, inbox_messages, outbox_commands, command_attempts y dead_letters.
- **Interfaces:** GET /api/v2/health y GET /api/v2/incidents; reporte firmado en B2 y email. No hay UI ni login real en P1.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Usuarios sin contraseñas; importación idempotente de metadatos, sin datos de negocio.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm test; tests de restricciones, hash, concurrencia, leases, DLQ y WebAuthn virtual; tres corridas de ≥500 webhooks con presupuestos p95/p99.
- El comando `npm run test:e1` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** API/worker/scheduler sin credenciales de escritura; 7 días de sombra; aborto ante impacto en códigos HTTP, errores o latencia.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** 0 faltantes inexplicados por tópico, cobertura declarada, reportes firmados verificados y revisión de José.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Confirmar el plan P1 archivado después de aceptar E0 y ejecutar su primer paso.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.
