# E15 — Compatibilidad y retiro físico autorizado

**Estado:** borrador

**Dependencias:** E14, E23, E24

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** `docs/superpowers/plan-maestro.md`

## Resultado y límites

- Pantallas/rutas sin uso completan deprecación y retiro; fachadas v1 usadas pueden sobrevivir sin lógica legacy.
- **Incluye:** 30 días GET read-only, advertencia, métricas cero, 410 y borrado autorizado tras restauración probada.
- **No incluye:** No retira /api/v1 mientras la App lo use.
- **Evidencia histórica absorbida:** P6.5–P6.6, E24 retiro. Es evidencia, no aceptación automática.

## Línea base verificada

- La App llama auth, meta, inbox, preparación, hoy y workshop mediante v1.
- Fotografía común: `docs/superpowers/audit-baseline-2026-09-13.md`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- Borrado sólo por targets explícitos y backup restaurado; nada destructivo por glob.

## Diseño, datos e interfaces

- **Modelo:** Manifiesto firmado de cada objeto retirado y ubicación recuperable.
- **Interfaces:** 410 Gone estable para rutas retiradas; fachadas v1 delegan exclusivamente a v2.
- Los endpoints nuevos viven bajo `/api/v2`, usan errores `{code,message,correlation_id,details?}`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren `Idempotency-Key`; las actualizaciones concurrentes requieren `expected_version` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** Exportación, crosswalk, reconciliación, plazo cumplido y aprobación de José son cuatro precondiciones acumulativas.
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún `pending` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** npm run test:e15; métricas 30 días, 410, contratos App, restore B2 y consulta histórica.
- El comando `npm run test:e15` debe existir antes de pasar a `desarrollo`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** Retiro individual con revisión previa; recuperación desde Git/archivo documentada.
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** Sin lógica duplicada; todo borrado recuperable y ninguna llamada App rota.
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** Crear checklist por vertical y calendario de deprecación.
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.

## Decisiones PM asignadas

- **Dueña:** ninguna
- **Consumidora:** ninguna
