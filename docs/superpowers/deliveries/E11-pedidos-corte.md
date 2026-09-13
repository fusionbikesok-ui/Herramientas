# E11 — Corte de pedidos, preparación y despacho

**Estado:** borrador

**Dependencias:** E7, E10

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- El núcleo asume pedidos/preparación/despacho con un único ejecutor y compatibilidad App.
- **Incluye:** Congelamiento, delta final, conciliación, canario, espejo Woo real, preparación y despacho.
- **No incluye:** No retira todavía fachadas v1 ni archivos legacy.
- **Evidencia histórica absorbida:** P4.8, GP9–GP12 corte. Es evidencia, no aceptación automática.

## Línea base verificada

- Los escritores legacy siguen activos hasta esta entrega.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Efectos remotos confirmados no se revierten; se compensan. Respuesta incierta bloquea ampliación.

## Diseño, datos e interfaces

- **Modelo:** Acta de corte firmada, posiciones de cursor, hashes y comandos pendientes clasificados.
- **Interfaces:** v2 autoridad; v1 fachada delgada compatible, sin lógica duplicada.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Ventana <15 min; pausar consumidores, delta, verificar, activar único ejecutor y reanudar.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e11; ensayo completo de corte/rollback, contratos App y jornada con ventas reales acotadas.
- El comando `npm run test:e11` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Canario por cuenta/envío, métricas en tiempo real y abortar ante discrepancia crítica, writer duplicado o DLQ invisible.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Un único escritor, conciliación exacta y aceptación operativa de José.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Preparar runbook minuto a minuto y ensayo en QA sanitaria.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** ninguna
- **Consumidora:** PM-004, PM-005, PM-006, PM-018, PM-024, PM-026, PM-028, PM-030, PM-104, PM-115, PM-127, PM-144, PM-154, PM-157, PM-159
