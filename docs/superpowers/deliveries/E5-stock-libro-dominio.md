# E5 — Libro de stock, apertura y reservas

**Estado:** planificada

**Dependencias:** E4

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Libro append-only importado en sombra con disponible calculado, reservas, retenciones, packs y agrupación user_product.
- **Incluye:** Existencia, ubicaciones, movimientos, reservas sólo con pago, retenciones, asignaciones, salidas, doble descuento y proyección remota.
- **No incluye:** No reemplaza todavía recepción/conteos ni escribe stock remoto.
- **Evidencia histórica absorbida:** P3.1–P3.3, E8–E11 dominio. Es evidencia, no aceptación automática.

## Línea base verificada

- stock_movements legacy tiene 0 filas; Woo continúa siendo autoridad provisional.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Aumentos fail-closed; disminuciones prioritarias; bolsa user_product tiene una sola proyección remota.

## Diseño, datos e interfaces

- **Modelo:** inventory_ledgers, stock_movements, balances, reservations, holds, allocations, locations y remote_stock_resources; cantidades derivadas, nunca sobrescritas.
- **Interfaces:** GET /api/v2/inventory y movimientos; POST de reserva/liberación idempotentes con versión esperada y causal obligatoria.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Woo como apertura provisional más pedidos pagos abiertos; hashes y crosswalk; impedir descontar dos veces pedidos ya reflejados.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e5; invariantes SQL, carreras de reserva, packs, doble descuento, reapertura y replay.
- El comando `npm run test:e5` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Sombra sin credenciales remotas; conciliación diaria contra Woo/ML y rollback eliminando consumidores nuevos.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Cada diferencia tiene movimiento causal o caso; disponible reproducible y 0 saldos mutables fuera del libro.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Fijar esquema y algoritmo de apertura con fixture de pedidos abiertos.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.
