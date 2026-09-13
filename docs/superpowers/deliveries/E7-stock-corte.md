# E7 — Sombra y corte de autoridad de stock

**Estado:** planificada

**Dependencias:** E6

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Fusion pasa a ser autoridad de stock y Woo/ML quedan como proyecciones verificadas.
- **Incluye:** Sombra, simulación, campaña de apertura, proyección completa por publicación, user_product y alerta de sobreventa <2 min.
- **No incluye:** No cambia la política aprobada de exponer stock completo por publicación.
- **Evidencia histórica absorbida:** P3.5–P3.8, E8–E11 corte. Es evidencia, no aceptación automática.

## Línea base verificada

- Woo es autoridad y existe riesgo declarado de sobreventa entre publicaciones independientes.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Ante duda bajar o pausar; jamás aumentar sin identidad, saldo, reservas y lectura fresca.

## Diseño, datos e interfaces

- **Modelo:** Comandos remotos, intentos, evidencias, DLQ y conciliaciones por variante/recurso remoto.
- **Interfaces:** Estado de proyección y bloqueos; comandos internos idempotentes, sin endpoint libre de cantidad.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Congelar sync/recepción/conteo legacy, delta final, reconciliar y transferir autoridad en ventana <15 min.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e7; ventas simultáneas, user_product, packs, 403/408/429/5xx, caída después del efecto y alerta <2 min.
- El comando `npm run test:e7` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Canario por SKU/cuenta, ampliación por lotes; rollback a shadow sin deshacer efectos confirmados, usando compensación.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Un escritor remoto, proyección conciliada, sin doble descuento y piloto físico aceptado.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Definir simulador y conjunto canario de variantes certificadas por conteo.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.
