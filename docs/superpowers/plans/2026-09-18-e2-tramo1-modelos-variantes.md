# Plan de implementación — E2 tramo 1 (modelos, variantes y claves externas)

**Objetivo:** que la base canónica sepa qué se vende, dónde y con qué SKU, y qué falta decidir: modelos, variantes
vendibles, sus representaciones en Woo y ML, y el cruce Woo↔ML que hoy vive sólo en el legado.

**Arquitectura:** un consumidor de la cola de E1 (hoy no existe ninguno) proyecta `woo.products` y `ml.items` en un
esquema `catalog`. Una lectura completa inicial con su propio checkpoint cubre lo que la cola no tiene. Las decisiones
del matcher y los casos de identidad llegan desde el legado por una outbox durable y una API interna firmada.

**Stack:** Node 24.21, TypeScript strict, Fastify 5, pg 8, PostgreSQL 18, Vitest 5; legado Node/Express con SQLite.

**Diseño:** `docs/superpowers/specs/2026-09-18-e2-tramo1-modelos-variantes-design.md` (commit `ef4e72e`).
**Revisiones externas:** del diseño, `evidence/e2/2026-09-18-E2-T1-revision-codex.md`; de la primera versión de este
plan (commit `b51d224`), `evidence/e2/2026-09-18-E2-T1-revision-plan-codex.md`, con 26 hallazgos. Esta versión los
incorpora; la tabla final dice dónde.

## Decisiones de José para el plan (2026-09-18)

| Tema | Decisión |
|---|---|
| Cuentas | **Una por canal, sin cerrar la puerta**: todas las claves incluyen la cuenta, pero no se construye ni se prueba el caso de varias |
| Escrituras automáticas del matcher | **Entran como decisiones del sistema**, con actor `sistema` y su motivo (coincidencia de SKU, corrección de Guardia) |
| Arranque del proyector | **Canario de 100 mensajes y revisión**; con el OK de José, el resto a ritmo controlado |
| Cuota del bootstrap de ML | **10 lecturas por minuto desde que se encienda**; si de madrugada no terminó, se sube |
| Casos de identidad del legado | **Igual que el matcher: copia y eventos** |
| Dónde se ven los casos | **En el reporte diario firmado**, en una sección de catálogo |

## Restricciones globales

- **Sólo lectura hacia los canales.** Nada escribe en Woo ni en ML; se lee siempre por el gateway del legado.
- **Producción real.** Ninguna tarea despliega, reinicia PM2, toca `.env` ni `plataforma.env`, ni abre
  `data/fusion.sqlite` con el helper que aplica migraciones. La tarea 14 es la única que toca producción y **necesita
  autorización explícita de José en el momento**.
- **Español** en código, comentarios y commits; cada commit termina con
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Ninguna identidad por nombre ni por GTIN.** Nulos, duplicados y dudas son casos, nunca se descartan.
- **SKU canónico `FB-{ID_WOO}`**: obligatorio para cerrar el caso, no para que la variante exista, e inmutable.
- **Toda clave incluye la cuenta del canal** (`channel_account_id`), aunque hoy haya una sola por canal.
- **Cada migración actualiza `plataforma/test/migraciones.test.ts`** (lista literal) y
  `docs/superpowers/specs/e1/schema.sql`.
- **Un cambio que toca el arranque de un servicio se prueba en un contenedor aparte antes de desplegarlo.**
- **Ninguna escritura del legado espera a la red.** Todo lo que el legado le manda a la plataforma pasa por una outbox
  local escrita en la misma transacción que el cambio; el envío ocurre después, fuera de la respuesta.
- **Tests:** `crearBaseDePrueba()`, `sembrar`, `limpiar` con el pool administrador; cada caso limpia lo suyo y recibe la
  hora como parámetro.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `plataforma/migrations/0013_catalogo.sql` | esquema `catalog`, `bootstrap_runs`, staging de copias, `source='bootstrap'` |
| `plataforma/src/colas/colas.ts` | se amplía: `reclamar` devuelve los datos del sobre; `completarEnTx` para cerrar dentro de otra transacción |
| `plataforma/src/comun/config.ts` | se amplía: configuración del catálogo, independiente de la de barridos |
| `plataforma/src/catalogo/woo.ts`, `ml.ts` | puros: payload → intenciones de proyección |
| `plataforma/src/catalogo/proyector.ts` | consumidor de la cola: lote, lease, transacción única, drenaje controlado, canario |
| `plataforma/src/catalogo/decisiones.ts`, `fusion.ts` | vigencia de decisiones del matcher y fusión de variantes |
| `plataforma/src/catalogo/copias.ts` | protocolo de copia en tandas con commit atómico |
| `plataforma/src/catalogo/bootstrap.ts` | lector propio, checkpoint durable, cuota y pausa |
| `plataforma/src/catalogo/conciliacion.ts` | denominadores, cruce por conjunto y hash |
| `plataforma/src/api/catalogo.ts` | lectura pública y API interna del legado |
| `plataforma/src/worker/catalogo.ts` | la vuelta del worker que corre proyector y bootstrap |
| `lib/outboxPlataforma.js` (legado) | outbox durable en SQLite y su despachador con reintentos |
| `lib/matcherEventos.js` (legado) | un único punto de escritura de decisiones del matcher que registra el evento |
| `scripts/catalogo-copia.mjs` (legado) | copia consistente del matcher y de los casos de identidad |
| `scripts/qa/gate-e2.mjs` | gate propio de E2, separado del de E1 |

---

## Tareas

Cada tarea es un commit, empieza por el test que falla y termina con el test verde y el typecheck limpio.

### Tarea 1: Esquema `catalog` y sus tablas de soporte (migración 0013)

Todo lo del §5.1 del diseño, con estas precisiones de la revisión:
- Las claves naturales incluyen la cuenta: modelos únicos por `(channel_account_id, origen, clave_origen)`;
  representaciones únicas por `(channel_account_id, recurso, variacion_normalizada)`.
- `sellable_variants` lleva `company_id`; el índice único parcial de `sku` es **por empresa**.
- `catalog.bootstrap_runs`: una fila por cuenta y canal, con `estado`, `pagina_confirmada`, `cursor`, `lease`, y
  conteos; es el checkpoint durable del bootstrap.
- `catalog.copias` y `catalog.copias_lotes`: el staging de una copia en tandas (`copy_id`, número de lote, total
  esperado, hash) para el protocolo de la tarea 7.
- `integrations.inbox_messages.source` acepta `bootstrap`, y `integrations.reconciliation_signals.source` acepta
  `payload_expired`. Antes de cambiar cada `CHECK`, la migración **verifica** que ninguna fila existente lo viole y usa
  `lock_timeout` para no quedar esperando un bloqueo en producción.
- Los tipos TypeScript que representan esos orígenes se amplían en el mismo commit (`MensajeEntrada.source`,
  `ContextoEscritura.source`), o no compila.

**Tests:** los de la versión anterior (SKU inválido, duplicado, inmutable, `contenedor` sin variante, duplicado con
variación vacía, casos abiertos únicos, la app no borra), más: el mismo SKU en dos empresas distintas se acepta; el
mismo id de Woo en dos cuentas distintas no choca; la migración falla limpia si una fila existente viola el `CHECK`.

### Tarea 2: La cola entrega lo necesario para consumirla

**Archivos:** modificar `plataforma/src/colas/colas.ts` y su test.

- `reclamar` devuelve también `channel_account_id`, `resource_id`, `remote_version`, y los campos del sobre
  (`payload_ciphertext`, `payload_key_id`, `payload_nonce`, `payload_tag`), para poder armar el contexto de
  `descifrarSobre` (`seguridad/sobre.ts:3`).
- `completarEnTx(tx, reclamo)`: la misma transición que `completar`, pero dentro de una transacción ajena y exigiendo
  el lease vigente. `completar` pasa a usarla.

**Tests:** `reclamar` trae los datos del sobre y descifra; `completarEnTx` falla con lease vencido o ajeno; si la
transacción externa se deshace, el mensaje sigue reclamado y vuelve a la cola al vencer el lease.

### Tarea 3: Configuración del catálogo

**Archivos:** `plataforma/src/comun/config.ts`, `plataforma/src/worker/main.ts` y sus tests.

Variables propias (`CATALOGO_PROYECTOR`, `CATALOGO_LOTE`, `CATALOGO_PAUSA_MS`, `CATALOGO_CANARIO`,
`CATALOGO_BOOTSTRAP_RPM`) y el keyring de sobres cargado **aunque no haya barridos**, porque hoy sólo se carga dentro
de `if (config.barridos)` (`worker/main.ts:29`). Todo apagado por omisión.

**Tests:** sin las variables, el worker arranca igual y no consume; con el proyector encendido pero sin keyring, no
arranca y dice por qué.

### Tareas 4 y 5: Proyección pura de Woo y de ML

Igual que las tareas 2 y 3 de la versión anterior (reglas del §5.2 y §5.3 del diseño), con las intenciones incluyendo
la cuenta en todas las claves. Sin base: sólo entrada y salida.

### Tarea 6: El proyector

**Archivos:** `plataforma/src/catalogo/proyector.ts`, `plataforma/src/worker/catalogo.ts` y sus tests.

- Una vuelta reclama un lote (`CATALOGO_LOTE`, por omisión 20) de `woo.products` y `ml.items`, y por cada mensaje abre
  **una** transacción donde descifra, proyecta y llama a `completarEnTx`. Una falla deshace todo y el mensaje vuelve a
  la cola con backoff; al superar los intentos, a la DLQ.
- Entre lotes, pausa (`CATALOGO_PAUSA_MS`). Si la tasa de errores del lote supera el 10 %, se detiene y abre incidente.
- **Canario:** con `CATALOGO_CANARIO=100`, se detiene después de 100 mensajes y deja un resumen para revisar. Sigue
  sólo cuando se quita el límite.
- Renueva el lease en mensajes lentos y lo libera al apagar el proceso.
- Un mensaje sin payload (vencido) crea una señal `payload_expired` para ese recurso y se completa.

**Tests:** el de atomicidad **inyecta una falla entre la proyección y `completarEnTx`** y verifica en la misma conexión
que ni el catálogo ni la cola cambiaron; el canario se detiene exactamente en 100; el umbral de errores detiene la
vuelta; un payload vencido genera su señal; más los de la versión anterior (idempotencia, versión vieja no pisa,
archivo y desarchivo).

### Tarea 7: Copias en tandas y API interna

**Archivos:** `plataforma/src/catalogo/copias.ts`, la parte interna de `plataforma/src/api/catalogo.ts` y sus tests.

Protocolo: `POST /internal/v1/catalogo/copias` abre una copia con `copy_id`, tipo (`matcher` o `identidad`), total
esperado y hash; `.../copias/{copy_id}/lotes` recibe cada tanda numerada al staging; `.../copias/{copy_id}/confirmar`
verifica conteo y hash y **recién ahí**, en una transacción, cierra las vigencias de lo ausente y abre lo nuevo. Una
copia sin confirmar no cambia nada. `POST /internal/v1/catalogo/eventos` recibe un cambio suelto. Firmado con HMAC,
reusando la verificación de `api/senales.ts` extraída a una función.

**Tests:** una tanda intermedia no cierra nada; confirmar con un lote faltante falla sin efecto; confirmar con hash
distinto falla sin efecto; la misma copia confirmada dos veces no duplica; un evento cierra la vigencia anterior de su
clave; sin firma válida, 401.

### Tarea 8: Aplicar decisiones y fusión

Igual que la tarea 6 anterior, con dos correcciones: el conflicto concurrente se prueba **a nivel de base**
(versión esperada; la segunda transacción no aplica nada y se reintenta), porque en T1 no hay un endpoint de
resolución que devuelva 409; y las decisiones del sistema entran con actor `sistema` y su motivo.

### Tarea 9: Outbox durable del legado

**Archivos:** `lib/outboxPlataforma.js`, una migración SQLite del legado para la tabla `outbox_plataforma`,
el cableado del despachador en `server.js`, y sus tests.

La cola de la copia de sombra no sirve: hace un solo intento y trabaja sobre `integration_events`. Ésta es propia:
filas escritas en la misma transacción que el cambio, un despachador fuera de la respuesta con reintento y backoff,
y un contador de pendientes viejos que alimenta una alerta.

**Cableado operativo, que la revisión pidió explicitar** (sin esto "encender la outbox" no es implementable):

| Qué | Cómo |
|---|---|
| Quién lo corre | un `setInterval` en `server.js`, en el mismo proceso del legado, igual que el vigilante de informes |
| Cada cuánto | `OUTBOX_PLATAFORMA_INTERVALO_MS` (10 s por omisión), lote de `OUTBOX_PLATAFORMA_LOTE` (50) |
| Firma | HMAC con `OUTBOX_PLATAFORMA_SECRETO`, el mismo mecanismo que usa la copia de sombra contra la API de señales |
| Apagado | `OUTBOX_PLATAFORMA_ENABLED`, apagado por omisión; al apagarse el proceso, termina el lote en curso y no toma otro |
| Recuperación tras reinicio | nada se pierde: las filas son durables y el despachador retoma por `estado='pendiente'` ordenado por id |
| Una sola instancia | el despachador reclama con `UPDATE ... SET estado='enviando', lease_hasta=...` y sólo toma lo vencido, para que dos procesos no manden lo mismo |

**Tests:** escribir un cambio y su evento es atómico; con la plataforma caída el cambio se hace igual y el evento queda
pendiente; al volver, sale una sola vez; la respuesta HTTP del legado no espera al envío; el despachador apagado no
manda nada; un lease vencido se vuelve a tomar; dos despachadores simultáneos no duplican el envío.

### Tarea 10: Un único punto de escritura del matcher

> **Cómo se implementó (2026-09-19):** con triggers de SQLite en vez de una función única. Al ir a hacerlo había
> 14 escrituras de `sku_matcher_decisiones` (no 7) y unas 20 de `identidad_casos`. Los triggers de la migración
> 108 escriben la fila de la outbox en la misma transacción que el cambio, cubren a todos los escritores de hoy y
> de mañana sin tocar ninguna ruta, y reemplazan al test de guardia que buscaba texto. El interruptor de captura
> vive en `outbox_config` (un trigger no lee el entorno). La traducción al formato de la plataforma la hace el
> despachador (`traducirEvento`), y un test de contrato en la plataforma la valida contra la API real. Los casos
> de identidad viajan como eventos propios (`/internal/v1/catalogo/eventos-identidad`), como decidió José.


**Archivos:** `lib/matcherEventos.js`; modificar **todos** los escritores de `sku_matcher_decisiones`:
`routes/cobertura.js` (confirmación ~264, borrados ~704 y ~722, upsert ~876, borrado ~922), `lib/mlMapeo.js`
(autoasignación ~113) y `lib/guardiaMl.js` (~367). Los escritores de `identidad_casos` igual.

Cada escritor pasa a llamar a una función única que escribe la decisión y su fila de outbox en la misma transacción.

**Tests:** un test por escritor, que verifica que su cambio deja su evento; y un test de guardia que **busca en el código
cualquier `INSERT`/`UPDATE`/`DELETE` sobre `sku_matcher_decisiones` o `identidad_casos` fuera de la función única** y
falla si aparece uno, para que un escritor nuevo no se escape en silencio.

### Tarea 11: Copia consistente y conciliación diaria

**Archivos:** `scripts/catalogo-copia.mjs` y el cableado del cron en `server.js`.

Copia con la API de backup de SQLite, conteo y hash, enviada por el protocolo de la tarea 7. La conciliación diaria
compara conteo y hash del legado contra lo vigente en E2 y abre `decision_en_conflicto` por diferencia.

**Tests:** la copia llega completa y se confirma; una copia que se corta a mitad no cambia nada en E2.

### Tarea 12: Bootstrap

**Archivos:** `plataforma/src/catalogo/bootstrap.ts`, su vuelta en `worker/catalogo.ts` y sus tests. **No se toca** el
adaptador productivo de ML: el bootstrap tiene su lector propio.

- Recorre Woo y ML, encola todo con `source='bootstrap'`, y guarda `pagina_confirmada` en `catalog.bootstrap_runs`
  después de cada página.
- Tope propio de `CATALOGO_BOOTSTRAP_RPM` (10 por omisión), **debajo** del tope de la sombra del legado, y multigets en
  serie.
- **Cede, con una señal observable.** "Si hay órdenes esperando" no sirve como criterio: el bootstrap corre en la
  plataforma y el presupuesto vive en el gateway del legado, y los mensajes `ml.orders` del inbox **hoy no tienen
  consumidor**, así que esperar a que se vacíen dejaría el bootstrap pausado para siempre. Lo que se mira, en este
  orden, antes de cada página:
  1. **`integrations.reconciliation_signals` reclamables de ML** (`status in ('pending','retryable')` y
     `available_at <= now()`): son relecturas que sí tienen consumidor y compiten por el mismo cupo. Si hay más de
     `CATALOGO_BOOTSTRAP_CEDE_SENALES` (20), se pausa una vuelta.
  2. **Un 429 del gateway**: se pausa y se retoma con backoff, sin gastar intentos del checkpoint.
  El conteo del inbox **no** se usa como criterio, justamente porque nadie lo drena todavía.

**Tests:** el de retoma **mata el proceso y lo vuelve a crear** y verifica en PostgreSQL que sigue en la página 30;
respeta el tope por minuto con un reloj simulado; se pausa si hay señales esperando; una segunda corrida sobre la misma
versión no duplica mensajes.

### Tarea 13: Lectura, conciliación, reporte y contrato

- `GET /api/v2/catalog/{models,variants,reconciliation}` con su OpenAPI.
- `catalogo/conciliacion.ts` con denominadores, cruce y hash del §8 del diseño.
- **Sección de catálogo en el reporte diario firmado**: casos por tipo, y cuáles son nuevos del día.
- `npm run test:e2` y `scripts/qa/gate-e2.mjs`, **propio**, con los escenarios del §8 del diseño y sus subcasos
  nombrados, más los que agregó la revisión: payload vencido, copia incompleta, escritor del matcher no registrado.

### Tarea 14: Puesta en producción (requiere autorización de José)

En este orden, que la revisión corrigió dos veces: las decisiones antes que el proyector, para no crear miles de
variantes provisorias que después haya que fusionar; y la **captura** de eventos antes de la copia, para que no haya
ventana de pérdida.

**Paso 0 — gate de dependencia con E1, que la revisión pidió agregar.** E1 todavía **no está aceptada**: le falta la
campaña de 7 días verdes. E2 se apoya en su inbox, su gateway, su worker y sus secretos, así que nada de lo que sigue
arranca sin verificar y anotar, en el momento:

| Qué se verifica | Cómo |
|---|---|
| Los cuatro componentes de la plataforma | `/api/v2/health` en verde |
| Los productores del inbox | hay filas nuevas de `woo.products` y `ml.items` en las últimas 24 h |
| El gateway y su cupo | el tope de la sombra vigente y cuánto margen real queda por minuto |
| El worker | `cuentas` y `corrientes` que registra al arrancar, contrastadas con `SENALES_CUENTAS` |
| Los secretos | los siete archivos que lee node, uid 1000 y 0400 |
| El estado de E1 | día de campaña y último reporte diario firmado en verde |

Si algo de eso está en rojo, **se para acá** y se le cuenta a José, en vez de apilar E2 sobre una base que todavía se
está probando.

1. **Ensayo** de la migración 0013 sobre una copia de la base de producción: medir el tiempo y los bloqueos, y ensayar
   la restauración del backup.
2. Backup de `plataforma` y de `data/fusion.sqlite`.
3. Migración, con todo el catálogo apagado.
4. **Encender la escritura de la outbox en el legado, con el despachador todavía apagado** (un reinicio del legado,
   **avisado**). Desde acá, todo cambio del matcher y de los casos de identidad queda guardado, aunque no se mande.
5. **Recién ahora**, la copia consistente del matcher y de los casos de identidad, con su corte, confirmada.
6. Encender el despachador: manda lo que se acumuló desde el paso 4, que es exactamente lo que la copia no vio.
7. Encender el proyector con **canario de 100**; revisión conjunta; con el OK de José, el resto.
8. Encender el bootstrap a 10 por minuto; si de madrugada no terminó, subir el tope.
9. Conciliar y comparar conteos, relaciones y hashes durante 7 días.

El orden de los pasos 4 a 6 es lo que cierra la ventana: si la copia fuera antes de la captura, un cambio hecho entre
las dos no estaría ni en la copia ni en los eventos, y nadie se enteraría. Al revés, un cambio que esté en las dos se
deduplica por su clave natural y la vigencia no se abre dos veces.

## Cómo se resolvió cada hallazgo de la revisión del plan

| # | Hallazgo | Dónde |
|---|---|---|
| 1 | `completar` abre su propia transacción | Tarea 2, `completarEnTx` |
| 2 | `reclamar` no trae el sobre | Tarea 2 |
| 3 | No hay worker de inbox | Tareas 3 y 6 |
| 4 | No existe la configuración del catálogo | Tarea 3 |
| 5 | El bootstrap no tiene checkpoint | Tarea 1 `bootstrap_runs`, tarea 12 |
| 6 | `source='bootstrap'` no compila | Tarea 1 |
| 7 | La copia en tandas no tiene fin | Tareas 1 y 7 |
| 8 | La cola de sombra no sirve para el matcher | Tarea 9 |
| 9 | El matcher se escribe desde siete lugares | Tarea 10 |
| 10 | Claves sin cuenta ni empresa | Tarea 1 |
| 11 | Proyector antes que las decisiones | Tarea 14, orden corregido |
| 12 | Bootstrap sin infraestructura | Tareas 1 y 12 |
| 13 | Conciliación diaria sin cableado | Tarea 11 |
| 14 | El proyector suelta todo de golpe | Tarea 6, lote, pausa, umbral y canario |
| 15 | Bootstrap y barridos compiten por la cuota | Tarea 12, tope propio y cede |
| 16 | El hook puede frenar el matcher | Tareas 9 y 10, outbox fuera de la respuesta |
| 17 | Migración sin ensayo | Tareas 1 y 14 |
| 18 | Atomicidad no probada | Tarea 6 |
| 19 | 409 sin endpoint | Tarea 8 |
| 20 | Checkpoint no demostrado | Tarea 12 |
| 21 | Payload vencido sin mecanismo | Tareas 1 y 6 |
| 22 | Casos de identidad sin tarea | Tareas 10 y 11 |
| 23 | Copia sin prueba de punta a punta | Tareas 7 y 11 |
| 24 | Multicuenta | Decisión de José: una por canal; claves con cuenta (tarea 1) |
| 25 | Sobra tocar el adaptador de ML | Tarea 12, lector propio |
| 26 | Sobra extender el gate de E1 | Tarea 13, `gate-e2.mjs` |

## Segunda revisión del plan (Codex, sobre el commit `0d2aad8`)

Los 26 de arriba quedaron bien resueltos, sin regresiones. Aparecieron cuatro más, los cuatro ciertos y los cuatro
incorporados:

| # | Hallazgo | Dónde se resolvió |
|---|---|---|
| 27 | La outbox no tiene cableado operativo: quién corre el despachador, su firma, cada cuánto, apagado y recuperación | Tarea 9, tabla de cableado y sus tres tests nuevos |
| 28 | Ventana de pérdida entre copiar el matcher y empezar a capturar eventos | Tarea 14, pasos 4 a 6 invertidos: capturar primero, copiar después |
| 29 | Falta un gate de dependencia con E1, que todavía no está aceptada | Tarea 14, paso 0 |
| 30 | "Cede si hay órdenes esperando" no es una señal observable, y el inbox no tiene consumidor | Tarea 12, cede por señales reclamables y por 429, nunca por el inbox |
