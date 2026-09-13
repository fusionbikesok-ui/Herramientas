# E14 — Inventario, archivo y apagado reversible del legado

**Estado:** borrador

**Dependencias:** E11, E13

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Cada componente legacy queda clasificado y archivado; sólo se apagan por flag los escritores de verticales ya reemplazadas.
- **Incluye:** Workers, crons, tablas, pantallas, rutas y /api/v1 clasificados como fachada v2, lógica legacy o sin uso; apagado limitado a catálogo, identidad, stock, pedidos y estandarización ya cortados.
- **No incluye:** No borra tablas, archivos ni fachadas usadas.
- **Evidencia histórica absorbida:** P6.1–P6.4. Es evidencia, no aceptación automática.

## Línea base verificada

- 10 montajes /api/v1 y múltiples routers legacy; el inventario exacto se refresca al iniciar.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- No apagar cron oculto ni perder evidencia de disputa; owner y uso medido obligatorios.

## Diseño, datos e interfaces

- **Modelo:** Exportación SQLite completa firmada, Object Lock, crosswalk y reconciliación por vertical.
- **Interfaces:** Métricas por ruta y flags de apagado; fachadas conservan contrato.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Apagar escritores por vertical después de exportar/reconciliar; lectura histórica permanece.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e14; inventario automatizado, restauración del archivo, flags y regresión de contratos.
- El comando `npm run test:e14` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Orden inverso de riesgo, un componente por vez, reversión inmediata disponible.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** 0 escritores legacy activos en las verticales E2–E13 ya reemplazadas; el resto queda clasificado, conservado y con dependencia explícita.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Generar inventario de procesos/rutas/tablas y asignar vertical/dueño.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** PM-160
- **Consumidora:** ninguna
