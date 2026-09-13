# E3 — Identidad y matcher único en sombra

**Estado:** planificada

**Dependencias:** E2

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Un solo motor explica y registra identidades y casos, con UI v2, simulación y decisiones en sombra.
- **Incluye:** Auto-vínculo sólo por seller_sku exacto único; sugerencias explicables; decisiones humanas versionadas; alerta SKU y pausa por cambio de producto/formato/pack.
- **No incluye:** No ejecuta comandos reales ni corrige los 39 SKU.
- **Evidencia histórica absorbida:** P2.3–P2.6, UM1.1–UM1.5, Matcher, Cobertura, Guardia ML, vigía de formato. Es evidencia, no aceptación automática.

## Línea base verificada

- 1.055 verificadas, 11 esperando operación, 0 urgentes y 0 conflictos user_product al snapshot; el código legacy es evidencia, no aceptación.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- GTIN nunca auto-vincula. Un cambio de seller_sku confirmado alerta sin reasignar; un cambio estructural pausa de forma durable.

## Diseño, datos e interfaces

- **Modelo:** identity_cases, identity_decisions, identity_evidence, identity_candidates, format_observations y comandos parked; una decisión vigente por clave.
- **Interfaces:** API v2 de casos, candidatos, decisión, historial y simulación; mutaciones con expected_version, idempotency-key, roles catálogo/administración y 409 en conflicto.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Importar sólo SKU exacto único o decisión humana unívoca; contradicciones y objetivos cambiantes vuelven a revisión.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e3; calibración ≥200 casos, concurrencia de dos operadores, duplicados/desorden, 403/408/429/5xx y E2E 390/768/1440 WCAG 2.2 AA.
- El comando `npm run test:e3` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Sombra ≥7 días, comandos contra simulador, canario por cuenta preparado pero sin escritor real.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Decisiones iguales al comportamiento aprobado o diferencia explicada; 0 decisiones contradictorias; UI y auditoría completas.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Congelar fixture de calibración y redactar OpenAPI/máquinas de estado antes de implementar.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.
