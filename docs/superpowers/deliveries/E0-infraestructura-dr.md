# E0 — Infraestructura, DR y PITR

**Estado:** borrador

**Dependencias:** ninguna

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- PostgreSQL 18 vacío y aislado, WAL continuo, backup base verificable y restauración PITR medida con RPO ≤ 5 min y RTO ≤ 1 h.
- **Incluye:** PostgreSQL por digest, volumen propio, archive_command no bloqueante, B2 Object Lock, pg_verifybackup, QA aislado, capacidad, alertas y SOP de restauración.
- **No incluye:** No crea tablas de aplicación ni migra datos operativos.
- **Evidencia histórica absorbida:** P0, E23 recuperación. Es evidencia, no aceptación automática.

## Línea base verificada

- Backups SQLite/B2, monitoreo, disco, Node 24 y QA bajo demanda existen; falta PostgreSQL y PITR probado.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Una caída de B2 no puede bloquear PostgreSQL: spool local acotado, alertas al 70 % de disco y procedimiento de emergencia sin borrar WAL no archivado.

## Diseño, datos e interfaces

- **Modelo:** Instancia vacía; catálogo de backups y WAL con hash, fecha, rango LSN, retención y resultado de verificación.
- **Interfaces:** Healthcheck interno de PostgreSQL y métricas de backup/WAL; ninguna API de negocio.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** No aplica a datos de negocio. Restaurar en QA desde backup base más WAL hasta un instante elegido.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** pg_isready; pg_verifybackup sobre cada base backup; restauración PITR mensual; prueba de pérdida del uploader y medición de RPO/RTO.
- El comando `npm run test:e0` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Desplegar sin conexiones de aplicación, observar 24 h de WAL, ejecutar restore QA y aceptar sólo con vigías verdes.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Backup y restore repetibles; RPO/RTO medidos; ninguna degradación del servicio legacy.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Escribir y aprobar el procedimiento PostgreSQL+PITR, ejecutarlo y adjuntar evidencia literal.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** ninguna
- **Consumidora:** ninguna
