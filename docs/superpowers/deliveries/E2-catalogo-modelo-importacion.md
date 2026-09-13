# E2 — Modelo e importación del catálogo canónico

**Estado:** borrador

**Dependencias:** E1

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Catálogo relacional completo importado y reconciliado sin escritores remotos.
- **Incluye:** Modelos, variantes vendibles, cuentas, claves externas, taxonomía, atributos, unidades, imágenes, overlays reservados, GTIN como evidencia y composiciones de packs/kits.
- **No incluye:** No activa matcher, UI ni cambios en Woo/ML.
- **Evidencia histórica absorbida:** P2.1, P2.2, UM1.3 modelo, E9 familias. Es evidencia, no aceptación automática.

## Línea base verificada

- catalogo_cache tiene 5.170 filas; Woo padre variable no es vendible; existen datos legacy parciales de familias e identidad.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- No inferir identidad por nombre o GTIN; nulos y duplicados se convierten en casos, nunca se descartan.

## Diseño, datos e interfaces

- **Modelo:** product_models, sellable_variants, external_representations, identifiers, categories, brands, collections, attributes, attribute_values, media_assets y bundle_versions con FKs, vigencia y archivo.
- **Interfaces:** GET /api/v2/catalog/models, /variants y /reconciliation; lectura paginada con filtros y errores estables.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Snapshot SQLite/Woo/ML, staging, hashes, crosswalk por entidad, rechazo explícito y repetición idempotente antes del delta final.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e2; restricciones SQL, importación repetida, padres no vendibles, SKU inmutable y snapshots de packs.
- El comando `npm run test:e2` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Sólo lectura; comparar conteos, relaciones y hashes durante 7 días; rollback deshabilitando API v2 y conservando esquema.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** 100 % del universo clasificado como importado o rechazado con causa; crosswalk íntegro y conciliación firmada.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Producir especificación SQL/OpenAPI y fixture sanitario desde el snapshot auditado.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** PM-029, PM-031, PM-033, PM-040, PM-044, PM-045, PM-054, PM-060, PM-062, PM-063, PM-064, PM-065, PM-066, PM-067, PM-068, PM-069, PM-070, PM-071, PM-072, PM-078, PM-080, PM-081, PM-082, PM-096, PM-103, PM-106, PM-107, PM-108, PM-110, PM-114, PM-119, PM-120, PM-122, PM-130, PM-132, PM-133, PM-144, PM-145, PM-150, PM-151, PM-164
- **Consumidora:** PM-004, PM-032, PM-034, PM-046, PM-048, PM-049, PM-055, PM-059, PM-073, PM-074, PM-075, PM-076, PM-083, PM-084, PM-087, PM-089, PM-090, PM-092, PM-093, PM-094, PM-095, PM-097, PM-098, PM-099, PM-101, PM-105, PM-111, PM-113, PM-115, PM-117, PM-121, PM-123, PM-124, PM-125, PM-126, PM-128, PM-129, PM-131, PM-134, PM-135, PM-136, PM-139, PM-140, PM-141, PM-142, PM-143, PM-148, PM-149, PM-153, PM-154, PM-156, PM-158, PM-159, PM-160
