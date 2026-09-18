# Plan de implementación — E2 tramo 1 (modelos, variantes y claves externas)

**Objetivo:** que la base canónica sepa qué se vende, dónde y con qué SKU, y qué falta decidir: modelos, variantes
vendibles, sus representaciones en Woo y ML, y el cruce Woo↔ML que hoy vive sólo en el matcher del legado.

**Arquitectura:** un proyector de catálogo en el worker de la plataforma consume de la cola de E1 los temas
`woo.products` y `ml.items` (hoy nadie los consume), los descifra y los proyecta en un esquema `catalog`. Una lectura
completa inicial (bootstrap) cubre lo que la cola no tiene. Las decisiones del matcher llegan desde el legado por una
API interna firmada: una copia consistente al arrancar y un evento por cada cambio después.

**Stack:** Node 24.21, TypeScript strict, Fastify 5, pg 8, PostgreSQL 18, Vitest 5; legado Node/Express con SQLite.

**Diseño:** `docs/superpowers/specs/2026-09-18-e2-tramo1-modelos-variantes-design.md` (commit `ef4e72e`).
Revisión externa del diseño: `docs/superpowers/evidence/e2/2026-09-18-E2-T1-revision-codex.md`.

## Restricciones globales

- **Sólo lectura hacia los canales.** Nada escribe en Woo ni en ML. El único efecto remoto es leer, y siempre por el
  gateway del legado, que aplica el tope de la sombra (`GATEWAY_ML_SHADOW_RPM`).
- **Producción real.** Ninguna tarea despliega, reinicia PM2, toca `.env` ni `plataforma.env`, ni abre
  `data/fusion.sqlite` con el helper que aplica migraciones. La tarea 11 es la única que toca producción y **necesita
  autorización explícita de José en el momento**.
- **Español** en código, comentarios y commits; cada commit termina con
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Ninguna identidad por nombre ni por GTIN.** Nulos, duplicados y dudas se convierten en casos, nunca se descartan.
- **El SKU canónico es `FB-{ID_WOO}`**, obligatorio para cerrar el caso de una variante, no para que exista, e
  inmutable una vez puesto.
- **Cada migración nueva actualiza `plataforma/test/migraciones.test.ts`** (lista literal) y
  `docs/superpowers/specs/e1/schema.sql`, que desde E2 es el esquema de referencia de toda la plataforma.
- **Un cambio que toca el arranque de un servicio se prueba en un contenedor aparte antes de desplegarlo**
  (`docker compose run --rm --no-deps -T <servicio>`): el 2026-09-18 un cambio así tiró la API un minuto.
- **Tests:** `test/soporte/base.ts` (`crearBaseDePrueba()`) y `test/soporte/fixtures.ts` (`sembrar`, `limpiar` con el
  pool administrador). Cada caso limpia lo suyo y recibe la hora como parámetro.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `plataforma/migrations/0013_catalogo.sql` | esquema `catalog`, sus cinco tablas, el trigger de SKU inmutable, `source='bootstrap'` en la cola |
| `plataforma/src/catalogo/woo.ts` | puro: payload de un producto de Woo → modelo, variantes, representaciones y casos |
| `plataforma/src/catalogo/ml.ts` | puro: payload de un ítem de ML → lo mismo, para simples, clásicos con variaciones y familias `user_product` |
| `plataforma/src/catalogo/proyector.ts` | consume la cola, descifra y aplica lo anterior en una transacción, idempotente |
| `plataforma/src/catalogo/decisiones.ts` | vigencia de las decisiones del matcher y su efecto sobre las representaciones |
| `plataforma/src/catalogo/fusion.ts` | la resolución de una variante con SKU pendiente (§6 del diseño) |
| `plataforma/src/catalogo/conciliacion.ts` | denominadores, cruce por conjunto y hash (§8 del diseño) |
| `plataforma/src/catalogo/bootstrap.ts` | la lectura completa inicial con checkpoint por página |
| `plataforma/src/api/catalogo.ts` | `GET /api/v2/catalog/{models,variants,reconciliation}` y la API interna del matcher |
| `lib/matcherSombra.js` (legado) | emite cada cambio del matcher y hace la copia consistente de arranque |

---

## Tareas

Cada tarea es un commit, empieza por el test que falla y termina con el test verde y el typecheck limpio.

### Tarea 1: Esquema `catalog` (migración 0013)

**Archivos:** crear `plataforma/migrations/0013_catalogo.sql` y `plataforma/test/catalogo/esquema.test.ts`; modificar
`plataforma/test/migraciones.test.ts` y `docs/superpowers/specs/e1/schema.sql`.

**Qué fija la base** (del §5.1 del diseño):
- `catalog.product_models`: `id`, `company_id`, `origen` en (`woo_padre`, `woo_simple`, `ml_familia`, `ml_clasico`,
  `ml_simple`), `clave_origen` (el id de Woo, el `user_product_id` o el id del ítem clásico) única por `(company_id,
  origen, clave_origen)`, `version`, `archivado_en`, `motivo_archivo`.
- `catalog.sellable_variants`: `model_id` **NOT NULL**, `sku` nulo o `^FB-[0-9]+$`, **índice único parcial** donde
  `sku IS NOT NULL`, `version`, `archivado_en`, `motivo_archivo`. Trigger `BEFORE UPDATE` que rechaza cambiar un `sku`
  que ya no era nulo.
- `catalog.external_representations`: `canal`, `cuenta`, `recurso`, `variacion_normalizada` **NOT NULL DEFAULT ''**,
  `tipo` en (`contenedor`, `vendible`), `model_id` y `variant_id` con `CHECK` de que un `contenedor` tiene modelo y no
  variante y un `vendible` tiene variante; `sku_observado`, `user_product_id`, `modelo_ml` en (`clasico`,
  `user_product`) o nulo, `estado_remoto`, `version_remota`, `observado_en`, `origen_mensaje` (id de la cola),
  `omitida_por_decision` boolean, `archivado_en`; **único por `(canal, cuenta, recurso, variacion_normalizada)`**.
- `catalog.matcher_decisions`: append-only (sin `UPDATE` ni `DELETE` para la app, salvo cerrar la vigencia),
  `clave_legado`, `accion`, `sku`, `origen`, `confirmado_por`, `actualizado_en_legado`, `vigente_desde`,
  `vigente_hasta`, `motivo_cierre`, `procedencia` en (`copia`, `evento`, `conciliacion`), `corte_en`.
- `catalog.identity_cases`: `tipo` en los ocho del §5.3 del diseño, `prioridad` en (`normal`, `baja`), referencia a
  representación o variante, `abierto_en`, `cerrado_en`, `motivo_cierre`; **un solo caso abierto por
  `(tipo, referencia)`**.
- `integrations.inbox_messages.source` acepta además `bootstrap`.
- `GRANT` propios para el esquema nuevo (los de `0002_permisos.sql` no lo cubren); sin `DELETE` para la app.

**Tests que tienen que pasar:** SKU con formato inválido rechazado; dos variantes con el mismo SKU rechazadas; dos con
SKU nulo aceptadas; cambiar un SKU ya puesto rechazado por el trigger; ponerle SKU a una pendiente aceptado; una
representación `contenedor` con variante rechazada; **dos representaciones del mismo recurso sin variación rechazadas**
(el caso que un `UNIQUE` con `NULL` dejaba pasar); dos casos abiertos iguales rechazados; la app no puede borrar.

### Tarea 2: Proyección pura de Woo

**Archivos:** crear `plataforma/src/catalogo/woo.ts` y `plataforma/test/catalogo/woo.test.ts`.

**Interfaz:** `proyectarWoo(payload, cuenta): Proyeccion`, con `Proyeccion = { modelos, variantes, representaciones,
casos }` en forma de intenciones, sin tocar la base.

**Reglas** (§5.2 y §5.3 del diseño): simple → modelo `woo_simple` + variante + representación `vendible`; variable →
modelo `woo_padre` + representación `contenedor` + una variante y una representación `vendible` por variación. El SKU
canónico se asigna **sólo** si `sku_observado === 'FB-' + id` y no está repetido dentro del payload; si no, variante con
SKU pendiente y caso `woo_sin_sku`, `woo_sku_no_canonico` o `woo_sku_duplicado`.

**Tests:** simple con SKU canónico; simple sin SKU; simple con SKU no canónico; variable con tres variaciones; variable
con dos variaciones de SKU repetido; el padre nunca produce variante; el mismo payload produce siempre la misma
proyección.

### Tarea 3: Proyección pura de ML

**Archivos:** crear `plataforma/src/catalogo/ml.ts` y `plataforma/test/catalogo/ml.test.ts`.

**Reglas:** ítem simple → representación `vendible`; ítem clásico con variaciones → modelo `ml_clasico` +
representación `contenedor` + una `vendible` por variación con `modelo_ml='clasico'`; ítem con `user_product_id` →
modelo `ml_familia` con esa clave (dos ítems de la misma familia comparten el modelo) y `modelo_ml='user_product'`.
La variante de cada representación la decide el matcher (tarea 6); hasta entonces es una variante con SKU pendiente y
caso `sku_pendiente`.

**Tests:** ítem simple; clásico con dos variaciones; dos ítems de la misma familia `user_product` comparten modelo;
ítem cerrado queda con `estado_remoto='closed'`; payload sin `variations` no rompe.

### Tarea 4: El proyector

**Archivos:** crear `plataforma/src/catalogo/proyector.ts`, `plataforma/test/catalogo/proyector.test.ts`; modificar
`plataforma/src/worker/main.ts` para registrarlo detrás de un flag de configuración (`CATALOGO_PROYECTOR=true`),
apagado por omisión.

**Comportamiento:** reclama `woo.products` y `ml.items` con `reclamar` de `colas.ts`, descifra con `descifrarSobre` y
el keyring de sobres, aplica la proyección en **una transacción** con upserts por clave natural, y llama a `completar`
en la misma. Si la proyección falla, la transacción entera se deshace y el mensaje vuelve a la cola con backoff; tras
el máximo de intentos va a la DLQ visible. Un payload vencido (sin `payload_ciphertext`) no se proyecta: se marca para
relectura de ese recurso.

**Tests:** proyecta y completa un mensaje de Woo; el mismo mensaje dos veces no duplica nada; un mensaje con versión
más vieja que la ya proyectada no pisa; una falla a mitad deja todo sin efecto y el mensaje reintentable; un recurso
que desaparece en el canal se archiva, no se borra, y si reaparece se desarchiva; un payload vencido se marca para
relectura; los temas que no son de catálogo no se tocan.

### Tarea 5: API interna del matcher

**Archivos:** crear `plataforma/src/api/catalogo.ts` (la parte interna) y `plataforma/test/catalogo/matcher-api.test.ts`;
modificar `plataforma/src/api/app.ts`.

**Rutas**, firmadas con HMAC como `/internal/v1/reconciliation-signals` y reusando su verificación:
- `POST /internal/v1/matcher/copia`: tanda de decisiones con `corte_en`, conteo total y hash de la copia.
- `POST /internal/v1/matcher/evento`: una decisión que cambió o se borró.
- `POST /internal/v1/matcher/conciliacion`: el conteo y el hash de la tabla completa del legado, para comparar.

**Tests:** una copia cierra las decisiones vigentes que ya no aparecen, con motivo `revocada_en_legado`; un evento
nuevo cierra la vigente anterior de esa clave; un borrado cierra sin abrir otra; la misma copia dos veces no duplica;
una conciliación con hash distinto abre caso `decision_en_conflicto`; sin firma válida, 401.

### Tarea 6: Aplicar las decisiones y la fusión

**Archivos:** crear `plataforma/src/catalogo/decisiones.ts`, `plataforma/src/catalogo/fusion.ts` y sus tests.

**Comportamiento** (§5.2 y §6 del diseño): una decisión `confirmar`/`asignar` vigente vincula la representación a la
variante del SKU; si esa variante no existe, **se le pone el SKU a la provisoria** (válido sólo si el SKU no existe);
si existe, **se fusiona**: bloqueo con `version` esperada de las dos variantes y la representación, se mueven
representaciones y casos, la provisoria se archiva con `fusionada_en`, se cierra el caso y queda el evento. `omitir`
marca la representación como omitida, sin variante, y abre `omitida_revisar` de baja prioridad. Un SKU que no existe
en Woo abre `sku_inexistente_en_woo`.

**Tests:** asignar un SKU nuevo a una pendiente; fusionar cuando el SKU ya existe (la provisoria queda archivada y su id
no se reusa); **dos resoluciones concurrentes: una gana y la otra recibe 409 sin efecto parcial**; revocar una decisión
en el legado desvincula con evento compensatorio y deja la representación pendiente; omitir y des-omitir; SKU
inexistente en Woo.

### Tarea 7: Emisor del legado

**Archivos:** crear `lib/matcherSombra.js` y `test/matcherSombra.test.js`; modificar `routes/cobertura.js` en el
upsert (~línea 876) y el borrado (~línea 922), y agregar `scripts/matcher-copia.mjs`.

**Comportamiento:** después de cada escritura del matcher, **fail-open** (nunca frena la operación del legado), encola
un evento firmado hacia la plataforma con la misma cola acotada que la copia de sombra. `scripts/matcher-copia.mjs`
hace la copia consistente con la API de backup de SQLite (no una lectura en caliente), calcula conteo y hash, y la
manda en tandas. La conciliación diaria corre con el cron que ya existe.

**Tests:** confirmar, asignar, omitir y borrar emiten cada uno su evento; una plataforma caída no frena al matcher y
el evento queda para reintentar; la copia de una base que se escribe durante la lectura da el mismo hash que su backup.

### Tarea 8: Bootstrap

**Archivos:** crear `plataforma/src/catalogo/bootstrap.ts` y su test; modificar el adaptador de ML para que las
multigets de una página vayan **en serie** cuando corre el bootstrap.

**Comportamiento** (§4.2 del diseño): una corrida por cuenta que recorre Woo (productos y variaciones con todos sus
campos) y ML (scan + multiget de 20) y encola **todo** con `source='bootstrap'`, sin importar si cambió. Checkpoint
durable por página: tras una caída o un 429, retoma desde la última página confirmada.

**Tests:** recorre las páginas y encola con `bootstrap`; un 429 en la página 30 retoma desde la 30, no desde la 1; una
segunda corrida sobre la misma versión no duplica mensajes; las multigets de una página salen de a una.

### Tarea 9: API de lectura del catálogo

**Archivos:** completar `plataforma/src/api/catalogo.ts`; agregar las rutas a `openapi/platform-v2.yaml`; test
`plataforma/test/catalogo/api.test.ts`.

**Rutas:** `GET /api/v2/catalog/models`, `/variants` y `/reconciliation`, paginadas por cursor, con errores
`{code,message,correlation_id,details?}` y autorización por capacidad.

**Tests:** paginación estable por cursor; filtros por canal y por estado de SKU; 401 sin sesión y 403 sin capacidad;
las respuestas validan contra el OpenAPI.

### Tarea 10: Conciliación y contrato `test:e2`

**Archivos:** crear `plataforma/src/catalogo/conciliacion.ts` y su test; crear `scripts/test-e2.sh` y el script
`test:e2` en `package.json`; extender `scripts/qa/gate-e1.mjs` (o uno propio de E2) con los escenarios de E2 y sus
subcasos nombrados.

**Comportamiento** (§8 del diseño): denominadores por cuenta y tipo, cruce por conjunto, y el hash definido. El gate
exige los veinte escenarios del §8 del diseño, cada uno con sus subcasos nombrados, y falla si falta alguno.

### Tarea 11: Puesta en producción (requiere autorización de José)

1. Backup de la base `plataforma` y de `data/fusion.sqlite`.
2. Aplicar la migración 0013 y recrear worker y API con `CATALOGO_PROYECTOR=false`.
3. Encender el proyector: consume lo que ya está en la cola.
4. Correr la copia consistente del matcher y encender los eventos del legado (un reinicio del legado, avisado).
5. Correr el bootstrap en el horario de poca venta que decida José.
6. Conciliar y comparar conteos, relaciones y hashes durante 7 días.

## Autorrevisión

- **Cobertura del diseño:** §4.1 → tarea 4; §4.2 → tarea 8; §4.3 → tareas 5 y 7; §5 → tareas 1 a 3; §6 → tarea 6;
  §7 → tarea 9; §8 → tarea 10; §9 → tarea 11.
- **Lo que queda abierto para decidir en la tarea 11:** el horario del bootstrap.
