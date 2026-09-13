# E6 — Recepción y conteos sobre el libro

**Estado:** borrador

**Dependencias:** E5

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Recepción, ubicaciones, conteos y correcciones auditadas escriben exclusivamente movimientos del nuevo libro.
- **Incluye:** Recepción parcial, putaway, conteo ciego, aprobación de diferencias, concurrencia y evidencia.
- **No incluye:** No activa proyección remota ni App offline.
- **Evidencia histórica absorbida:** P3.4, E14, E16, corrección conteos 2026-09-11. Es evidencia, no aceptación automática.

## Línea base verificada

- 16 recepciones, 39 sesiones de inventario y 1 producto_ubicacion al snapshot; flujos legacy en uso.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Movimiento posterior invalida aprobación; cero requiere confirmación explícita; foto fallida no pierde borrador.

## Diseño, datos e interfaces

- **Modelo:** receipts, receipt_lines, count_sessions, count_lines, count_approvals y location_assignments vinculados a movimientos causales.
- **Interfaces:** API v2 de recepción/conteo con leases, expected_version, upload idempotente y estados explícitos.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Importar abiertos; cerrados quedan en archivo mediante crosswalk. Nuevos movimientos se comparan en sombra con escrituras legacy.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e6; parcial, dos operadores, movimiento posterior, omisión, cero, ajuste de alto riesgo y E2E responsive.
- El comando `npm run test:e6` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Canario por ubicación, doble lectura sin doble escritura; rollback devuelve UI al legado preservando movimientos nuevos.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Todas las acciones generan movimientos auditados y jornada de recepción/conteo observada.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Mapear contratos actuales a estados v2 y seleccionar una ubicación canaria.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** PM-013, PM-014, PM-161
- **Consumidora:** PM-011, PM-012, PM-018, PM-030, PM-032, PM-040, PM-043, PM-046, PM-054, PM-059, PM-068, PM-073, PM-076, PM-081, PM-082, PM-083, PM-089, PM-093, PM-094, PM-095, PM-098, PM-101, PM-104, PM-105, PM-106, PM-111, PM-113, PM-115, PM-120, PM-123, PM-125, PM-128, PM-132, PM-133, PM-134, PM-135, PM-140, PM-141, PM-142, PM-143, PM-144, PM-145, PM-153, PM-154, PM-156, PM-158, PM-159, PM-160
