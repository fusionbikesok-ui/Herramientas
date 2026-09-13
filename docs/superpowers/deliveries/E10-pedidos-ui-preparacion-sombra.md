# E10 — UI, preparación y simulación de pedidos

**Estado:** planificada

**Dependencias:** E9

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Gestión, picking, empaque y despacho operan sobre API v2 en sombra y pasan simulación/campaña correctiva.
- **Incluye:** Web responsive, fachada App, selección/lotes, checklist, fotos, faltantes, tracking, retenciones y campaña de trabados.
- **No incluye:** No corta escritores legacy.
- **Evidencia histórica absorbida:** P4.4–P4.7, E1, E2, E4, E12, GP1–GP12. Es evidencia, no aceptación automática.

## Línea base verificada

- Preparación productiva tiene 294 casos y 540 fotos en medición previa; lote de despacho carecía de adopción.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Recarga, doble toque, lease vencido, tracking incierto y pedido urgente durante preparación.

## Diseño, datos e interfaces

- **Modelo:** Claims/leases, evidencias, lotes y snapshots inmutables de líneas/paquetes.
- **Interfaces:** API v2 para gestión/preparación/despacho; /api/v1/meta y fachadas compatibles; SSE con polling fallback.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Comparar estados y acciones; fotos históricas permanecen referenciadas y protegidas por hash/retención.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e10; E2E 390/768/1440, axe, fotos lentas/tardías, faltantes, lotes, tracking y simulación remota.
- El comando `npm run test:e10` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Canario por tipo de envío y operadores; campaña de pedidos trabados antes del corte.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Paridad funcional, accesibilidad, 0 pérdida de evidencia y práctica guiada completada.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Levantar matriz UI/API desde código productivo y cerrar diferencias contra el dominio v2.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.
