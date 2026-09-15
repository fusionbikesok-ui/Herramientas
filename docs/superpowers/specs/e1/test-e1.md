# E1 — Escenarios de `npm run test:e1`

`npm run test:e1` levanta PostgreSQL 18.6 de ensayo (misma imagen que E0, proyecto temporal), aplica las
migraciones de `plataforma/migrations/` generadas desde `specs/e1/schema.sql`, corre la suite de
`plataforma/` y el simulador de canales de QA, y **falla si falta cualquier escenario exigido para
el tramo vigente** (mismo patrón que `test:e0`). Ningún escenario usa credenciales reales ni escribe
en ML/Woo. Diseño del tramo 1: [2026-09-15-e1-tramo1-fundacion-design.md](../2026-09-15-e1-tramo1-fundacion-design.md).
El tramo se selecciona con `E1_TRAMO=1|2`; omitirlo conserva tramo 1 hasta que T2 esté implementado.
Diseño T2: [2026-09-15-e1-tramo2-barridos-design.md](../2026-09-15-e1-tramo2-barridos-design.md).

## Escenarios exigidos por tramo (PM-174)

| Tramo | Exigidos (acumulativo) |
|---|---|
| 1. Fundación | E1-SCH-01, E1-SCH-02, E1-AUD-01, E1-AUD-02, E1-AUD-03, E1-Q-01..06, E1-DUP-01, E1-CAP-01, E1-API-01, E1-SVC-01 |
| 2. Barridos | tramo 1 + E1-SWP-01..09, E1-CONV-01, E1-DEL-01 |
| 3. Sombra en vivo | tramo 2 + E1-LAT-01, E1-PGDOWN-01 |
| 4. Seguridad y reporte | tramo 3 + E1-AUD-04, E1-REC-01, E1-WA-01 (los 24 de la tabla) |

## Escenarios

| ID | Cubre | Preparación | Verificación | Falla si |
|---|---|---|---|---|
| E1-SCH-01 | restricciones del esquema | migraciones desde cero | inserts inválidos rechazados: topic fuera de lista, `claimed` sin lease, `parked` sin motivo, segundo Woo primario, email sin índice ciego | alguno se acepta |
| E1-SCH-02 | migraciones sólo hacia adelante (PM-176) | migrar dos bases vacías; reaplicar sobre una; alterar una migración ya aplicada | mismo `pg_dump --schema-only`; reaplicar no cambia nada; la migración alterada frena el arranque | difiere, reaplica o arranca |
| E1-AUD-01 | cadena de auditoría | 1.000 eventos | `audit.verify_chain()` devuelve NULL; `chain_seq` continuo | rompe |
| E1-AUD-02 | append-only y detección | UPDATE/DELETE/TRUNCATE; luego alteración directa deshabilitando el trigger como superusuario | los tres rechazados; la alteración directa se detecta en el id exacto | se acepta o no se detecta |
| E1-AUD-03 | concurrencia de la cadena | 4 conexiones insertando 500 eventos cada una | cadena íntegra y 2.000 hashes únicos | bifurcación o hash duplicado |
| E1-AUD-04 | manifiesto diario | día con eventos | manifiesto firmado Ed25519, `retention_until` ≥ 365 días, subida al simulador S3 y verificación de firma | firma inválida o retención menor |
| E1-Q-01 | claim | mensaje `pending` | un worker lo reclama con lease; `status=claimed` | queda sin lease |
| E1-Q-02 | éxito | lease vigente | `succeeded` y evento auditado; token vencido → 409 sin efecto | acepta token vencido |
| E1-Q-03 | incierto | simulador corta la respuesta tras el efecto | `uncertain`, sin reintento ciego, relectura agendada | repite la operación |
| E1-Q-04 | DLQ | 403 persistente y 5xx hasta `max_attempts` | `dead_lettered` visible en `/api/v2/incidents` | queda invisible |
| E1-Q-05 | dos workers | 2 workers sobre 1.000 mensajes | cada mensaje procesado exactamente una vez (`FOR UPDATE SKIP LOCKED`) | doble proceso |
| E1-Q-06 | lease vencido | matar worker con lease tomado | el mensaje vuelve a estar disponible al vencer y se procesa una vez | queda colgado o se duplica |
| E1-DUP-01 | duplicados y desorden | misma señal 5 veces y versiones fuera de orden | 1 mensaje por versión; proyección final = versión remota más nueva | duplica o retrocede |
| E1-SWP-01..08 | barrido por tópico | simulador con fixture no vacío por tópico | enumerables: 0 faltantes; convergencia: cobertura y convergencia 100 %; payload cifrado | faltante, fixture vacío o payload plano |
| E1-SWP-09 | caída en medio de ventana | error en página 3 | cursor no avanza; la corrida siguiente repite con solape sin duplicar | avanza o duplica |
| E1-CONV-01 | envíos por convergencia | 20 relaciones orden→envío, 5 cambian `last_updated` | sólo los 5 se encolan; cobertura y convergencia 100 %; header `x-format-new` enviado | falta relación, encola todo o no envía el header |
| E1-DEL-01 | borrados Woo | producto borrado sin `product.deleted` | la vuelta diaria de IDs lo detecta | no se detecta |
| E1-LAT-01 | presupuesto del legado | ≥ 500 webhooks anonimizados, 30 min, 3 corridas (copia apagada / encendida / encendida con PostgreSQL detenido) | Δp95 ≤ 25 ms, Δp99 ≤ 100 ms, 0 cambios de código HTTP, 0 errores nuevos | cualquier umbral excedido |
| E1-PGDOWN-01 | reparación tras caída | PostgreSQL detenido 10 min con tráfico | pérdidas contadas por un contador durable **fuera** de PostgreSQL e importadas con auditoría al volver (contrato del tramo 3); barridos reparan el 100 % de lo enumerable; envíos convergen en un barrido | queda faltante |
| E1-REC-01 | reporte diario | día simulado | reporte con paridad/cobertura/convergencia por tópico, firmado, en S3 simulado con retención governance 365 d y email con adjuntos (JSON + firma) | falta firma, retención o adjuntos |
| E1-WA-01 | passkeys virtuales | autenticador virtual | registro, login, reautenticación y recuperación con código; flag `passkeys.real` apagado impide uso real | alguna etapa falla o el flag no bloquea |
| E1-CAP-01 | autorización | sesiones de fixture con y sin `operations.read` | 401 sin sesión, 403 sin capacidad, 200 con capacidad | responde datos sin permiso |
| E1-API-01 | contrato | respuestas reales de `/health` e `/incidents` | validan contra `openapi/platform-v2.yaml`; errores con `code`, `message`, `correlation_id` | no validan |
| E1-SVC-01 | servicios separados | API, worker y scheduler en contenedores distintos | caída de uno no detiene a los otros; `/health` refleja el componente caído con 503 | se arrastran o `/health` miente |
