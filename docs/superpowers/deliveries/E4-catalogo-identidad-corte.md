# E4 — Campaña SKU y corte de catálogo/identidad

**Estado:** planificada

**Dependencias:** E3

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Catálogo e identidad pasan al núcleo con un único ejecutor remoto y rollback probado.
- **Incluye:** Campaña de 39 SKU, duplicados, contradicciones, passkeys reales probadas, canario y apagado de escritores legacy de identidad.
- **No incluye:** Los GTIN sin riesgo comercial migran como casos abiertos y no bloquean.
- **Evidencia histórica absorbida:** P2.7, P2.8, UM1.6. Es evidencia, no aceptación automática.

## Línea base verificada

- 39 vendibles fuera de FB-{ID_WOO}: 5 simples y 34 variaciones al snapshot.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Respuesta remota incierta queda bloqueada hasta GET; nunca repetir una escritura sin reconciliar.

## Diseño, datos e interfaces

- **Modelo:** Crosswalk final, comandos de migración y verificaciones remotas append-only; ningún SKU se reutiliza.
- **Interfaces:** Comandos v2 aprobar/pausar/corregir/reanudar con estado consultable; fachada v1 sólo lectura donde sea necesaria.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Pausar, cambiar Woo/ML, verificar, reanudar por lotes pequeños; delta final bajo congelamiento de escritores.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e4; simulación completa, passkeys en dispositivos reales, canario y rollback a shadow/read-only.
- El comando `npm run test:e4` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Ventana <15 min, lote inicial de 10, ampliación por métricas; abortar ante escritor duplicado o discrepancia crítica.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Un solo ejecutor, 39 SKU reconciliados, GTIN riesgosos resueltos y jornada observada aceptada.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Crear runbook de campaña y seleccionar canario sin ventas activas conflictivas.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.
