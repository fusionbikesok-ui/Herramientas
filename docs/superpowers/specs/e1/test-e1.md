# E1 — Escenarios de `npm run test:e1`

`npm run test:e1` levanta PostgreSQL 18.6 de ensayo (misma imagen que E0, proyecto temporal), aplica las
migraciones de `plataforma/migrations/` generadas desde `specs/e1/schema.sql`, corre la suite de
`plataforma/` y el simulador de canales de QA, y **falla si falta cualquier escenario exigido para
el tramo vigente** (mismo patrón que `test:e0`). Ningún escenario usa credenciales reales ni escribe
en ML/Woo. Diseño del tramo 1: [2026-09-15-e1-tramo1-fundacion-design.md](../2026-09-15-e1-tramo1-fundacion-design.md).
El tramo se selecciona con `E1_TRAMO=1|2`; omitirlo conserva tramo 1.
Diseño T2: [2026-09-15-e1-tramo2-barridos-design.md](../2026-09-15-e1-tramo2-barridos-design.md).

**Cómo se exigen los IDs.** La suite de `plataforma/` se corre con el reporte JSON de vitest y
`scripts/qa/gate-e1.mjs` verifica que cada ID del tramo esté en el título de una prueba que pasó; los IDs
que el arnés comprueba por sí mismo (hoy `E1-SVC-01`) se le pasan con `--verificado`. El gate falla si
falta un ID o si alguna prueba falló, así que un escenario no puede desaparecer sin romper el comando.
`E1_SKIP_UNIT=1` saltea la suite y, con ella, el gate: esa corrida no es contractual y lo declara.

**Qué agrega `E1_TRAMO=2`.** Un contenedor `simulator` con el fixture en memoria de
`scripts/qa/fixtures/e1-t2.json` (sin SQLite ni credenciales), un keyring de sobres efímero de 32 bytes
montado como carpeta read-only, una cuenta de canal de ensayo sembrada con
`integrations.sembrar_corrientes` y el **worker real** barriendo esas diez corrientes contra el
simulador. El arnés comprueba después, sobre la base: diez corrientes con corrida exitosa y ninguna
corrida no exitosa, los ocho tópicos con inbox, todo payload cifrado (y ningún rastro del dominio del
fixture en el ciphertext), todos los cursores avanzados, observaciones y relaciones creadas, y que
ninguna llamada atribuida al transporte de canal use un método distinto de GET (`/__qa/*` es plano de
control y no cuenta). Al terminar, baja el proyecto y falla si queda un contenedor.

Los ocho barridos por tópico se numeran así: `E1-SWP-01` ml.orders, `E1-SWP-02` ml.shipments (junto con
`E1-CONV-01`), `E1-SWP-03` ml.questions, `E1-SWP-04` ml.messages, `E1-SWP-05` ml.claims, `E1-SWP-06`
ml.items, `E1-SWP-07` woo.orders y `E1-SWP-08` woo.products (junto con `E1-DEL-01`). Las vueltas
completas de Woo son de sólo presencia: enumeran IDs para declarar bajas y no reescriben contenido.

## Escenarios exigidos por tramo (PM-174)

| Tramo | Exigidos (acumulativo) |
|---|---|
| 1. Fundación | E1-SCH-01, E1-SCH-02, E1-AUD-01, E1-AUD-02, E1-AUD-03, E1-Q-01..06, E1-DUP-01, E1-CAP-01, E1-API-01, E1-SVC-01 |
| 2. Barridos | tramo 1 + E1-SWP-01..09, E1-CONV-01, E1-DEL-01 |
| 3. Sombra en vivo | tramo 2 + E1-LAT-01, E1-PGDOWN-01, E1-RCP-01..02, E1-QUE-01, E1-SIG-01..02, E1-ACC-01, E1-GW-01..02, E1-RER-01, E1-MFD-01, E1-BLK-01, E1-SOAK-01 |
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
| E1-RCP-01 | recibo de sombra | avisos ML y Woo products con el ciclo de sombra en `integration_events` | el ciclo no agrega PII, la identidad y la deduplicación siguen siendo las del evento, y la purga de 400 días sólo toca filas con sombra terminal y trabajo legacy cerrado | guarda body/PII, duplica identidad o purga un evento en curso |
| E1-RCP-02 | Woo orders antes del ACK | webhook de pedido con SQLite sano y con SQLite caído | sano: evento persistido antes del ACK y 200; caído: 503 y ningún ACK falso. Una ráfaga de `user_id` ajenos queda `excluded/foreign_account` sin hacer crecer la base más allá del límite por IP/ventana | responde 200 sin persistir o la ráfaga infla la base |
| E1-QUE-01 | cola posterior al ACK | cola llena, plataforma lenta y plataforma caída | capacidad 256, concurrencia 2, timeout 250 ms y un solo intento; `queue_full`, `platform_timeout` y `platform_unavailable` quedan registrados y el ACK nunca cambia | reintenta, retiene payload o el ACK se degrada |
| E1-SIG-01 | señal ≠ observación | señal repetida y varias señales del mismo recurso | una sola señal activa coalescida; `inbox_messages` y `resource_observations` sólo reciben el resultado de un GET remoto | una señal se proyecta como observación o se duplica |
| E1-SIG-02 | API interna de señales | envelope inválido, HMAC vencido, nonce repetido, cuerpo >16 KiB, canal/tópico ajeno y PostgreSQL caído | 202/400/401/409/413/503 según el contrato; el replay no crea una segunda señal | acepta un replay o filtra otro código |
| E1-ACC-01 | multi-cuenta | dos cuentas (ML y Woo) simultáneas | ninguna señal, cursor, observación ni inbox cruza de cuenta; la siembra respeta el canal y falla ante canal ambiguo | hay cruce o siembra corrientes incompatibles |
| E1-GW-01 | gateway sólo lectura | operaciones tipadas y intentos de método, host, path o query libres | sólo GET tipado sale a la red; toda escritura o URL libre falla antes de red y sin credenciales expuestas en el error | ejecuta algo no tipado o filtra credenciales |
| E1-GW-02 | exposición pública | peticiones desde Internet a `/internal/` y a `/herramientas/internal/` | Nginx rechaza ambas antes del proxy; el segundo prefijo importa porque se reescribe a la misma ruta interna | alguna de las dos llega a Express |
| E1-RER-01 | relectura puntual | señal de orden, envío, pregunta, reclamo y producto; 404 y versión atrasada | el resultado remoto observa y encola; un 404 sólo da baja donde el contrato lo permite; una versión vieja nunca reemplaza una nueva; mensajes se resuelven por pack con `mark_as_read=false` | proyecta el aviso, retrocede una versión o resuelve el id del aviso |
| E1-MFD-01 | `missed_feeds` | ventana de dos días con avisos repetidos | enumera desde offset cero sin cursor, deduplica por notification id, exige `site_id` en items, crea señales y nunca observaciones | usa cursor, duplica o genera observaciones |
| E1-BLK-01 | multiget de items | lote con ids válidos e inválidos | cada elemento informa su propio estado y un fallo parcial no invalida el lote; el endpoint es el verificado por sonda autenticada y registrado con fecha | un elemento fallido tira el lote o el endpoint no tiene fuente |
| E1-SOAK-01 | soak de 24 horas | sombra encendida al 100 % durante 24 h | sin cambios de ACK, sin cola saturada, sin señal vieja, cobertura y convergencia sostenidas y rollback ensayado | cualquier umbral del diseño excedido |

> **E1-SOAK-01 — dispensado por José el 2026-09-17.** No se corrieron las 24 h: José aprobó el comportamiento observado en la prueba de ~3,5 h con Woo al 100 % (0 abortos, 0 incidentes) y dio el criterio por aceptado tal como está. Evidencia: `docs/superpowers/evidence/e1/2026-09-17-E1-C10-canario-woo.md`. No es un soak de 24 h cumplido.
| E1-REC-01 | reporte diario | día simulado | reporte con paridad/cobertura/convergencia por tópico, firmado, en S3 simulado con retención governance 365 d y email con adjuntos (JSON + firma) | falta firma, retención o adjuntos |
| E1-WA-01 | passkeys virtuales | autenticador virtual | registro, login, reautenticación y recuperación con código; flag `passkeys.real` apagado impide uso real | alguna etapa falla o el flag no bloquea |
| E1-CAP-01 | autorización | sesiones de fixture con y sin `operations.read` | 401 sin sesión, 403 sin capacidad, 200 con capacidad | responde datos sin permiso |
| E1-API-01 | contrato | respuestas reales de `/health` e `/incidents` | validan contra `openapi/platform-v2.yaml`; errores con `code`, `message`, `correlation_id` | no validan |
| E1-SVC-01 | servicios separados | API, worker y scheduler en contenedores distintos | caída de uno no detiene a los otros; `/health` refleja el componente caído con 503 | se arrastran o `/health` miente |
