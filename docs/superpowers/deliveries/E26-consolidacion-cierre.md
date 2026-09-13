# E26 — Consolidación y cierre del programa

**Estado:** borrador

**Dependencias:** E13, E15, E16, E17, E18, E20, E22, E23, E24, E25

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Repositorios, migraciones, contratos, DR, documentación y operación quedan consolidados y aceptados.
- **Incluye:** Ancestry/diffs, suite global, migraciones, contratos App/backend, restore integral, SOP y archivo definitivo.
- **No incluye:** No incorpora funcionalidades nuevas.
- **Evidencia histórica absorbida:** E24 histórico, resto de E23. Es evidencia, no aceptación automática.

## Línea base verificada

- Sólo puede iniciar cuando E0–E25 estén aceptadas o excluidas explícitamente por José.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- No merge ciego, no borrar historia y no aceptar con tests omitidos sin justificación.

## Diseño, datos e interfaces

- **Modelo:** Manifiesto final de esquemas, archivos, hashes, decisiones y evidencia.
- **Interfaces:** Versiones finales v2/v1 compatible documentadas; ninguna ruta sin dueño.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Ensayo acumulado desde cero y restore productivo sanitario completo.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e26; suite global serial, E2E web/App/hardware, restore y auditoría de seguridad.
- El comando `npm run test:e26` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Congelamiento documental/código, ensayo final, publicación y ventana de observación.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Git limpio, DR probado, contratos fijados, 100 % del crosswalk cerrado y aceptación de responsables.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Preparar checklist final cuando E25 sea aceptada.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** PM-001, PM-002, PM-021, PM-034, PM-035, PM-041, PM-047, PM-056, PM-079, PM-084, PM-088, PM-090, PM-102, PM-109, PM-121, PM-148, PM-149, PM-159
- **Consumidora:** ninguna
