# E9 — Dominio de pedidos y efectos remotos

**Estado:** borrador

**Dependencias:** E5, E8

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Pedidos canónicos procesan webhooks, prioridad ML, espejo Woo, cancelaciones, devoluciones y cálculo económico sin efectos dobles.
- **Incluye:** Webhooks durables, espejo sin segunda reserva, desplazamiento retenido, cancelación verificada, cuarentena y eventos packed_verified/dispatch_confirmed.
- **No incluye:** No sincroniza precios de catálogo ni precios ML.
- **Evidencia histórica absorbida:** P4.3, GP4–GP8, GP13–GP15, ventas retenidas. Es evidencia, no aceptación automática.

## Línea base verificada

- Dominio legacy y línea GP existen parcialmente; deben validarse contra invariantes nuevos.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Pedido desplazado no se cancela ni reintegra; devolución no aumenta disponible hasta clasificación.

## Diseño, datos e interfaces

- **Modelo:** Order events y comandos durables; GP13 datos, GP14 productos y GP15 cuotas/reintegros/total.
- **Interfaces:** Mutaciones v2 con idempotencia/expected_version; estado de espejo, retención, cancelación y economía; permisos por capacidad.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Adaptar eventos importados; nunca crear espejo durante replay histórico.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e9; duplicados, desorden, venta simultánea, efecto incierto, cancelación remota y cálculos GP15.
- El comando `npm run test:e9` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Simulador sin credenciales reales y sombra sin espejos; DLQ visible.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** 0 espejos duplicados, 0 segundas reservas y todas las transiciones inválidas rechazadas por base.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Especificar comandos, compensaciones y OpenAPI de mutaciones.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** PM-127
- **Consumidora:** PM-004, PM-005, PM-006, PM-018, PM-024, PM-026, PM-028, PM-030, PM-104, PM-115, PM-144, PM-154, PM-157, PM-159
