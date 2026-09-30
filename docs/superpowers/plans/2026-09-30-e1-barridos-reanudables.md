# E1 — Barridos ML reanudables (`ml.items`, `ml.messages`, `ml.shipments`): plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development o superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Objetivo:** que los barridos de reconciliación en sombra de `ml.items`, `ml.messages` y `ml.shipments` terminen bajo el cupo por corriente de E1 T5, sin perder progreso cuando el gateway responde `CUPO_SOMBRA_AGOTADO`, y sin dejar sin cupo a las señales ni a `missed_feeds` de la misma corriente.

**Origen:** investigación del 2026-09-30 (`/tmp/claude-0/cupo-*`) y docs oficiales de ML capturadas en `/tmp/claude-0/mldocs/`. Las decisiones D1–D8 son de opt-c1 y están fijas; lo que este plan agrega está marcado **[propuesta]** y va a confirmación.

## Por qué hoy no terminan (evidencia)

| Corriente | Cupo (rpm) | Trabajo de una vuelta | Qué pasa hoy |
|---|---|---|---|
| `ml.items` | 15 | 43 scans (limit=100, ~4,3 k ids) + 213 bulks de 20 = **256 llamadas** ≈ 17 min al 100 % del cupo | `posicion` vive sólo en memoria (motor.ts, `let posicion`). Un `CUPO_SOMBRA_AGOTADO` a mitad tira la corrida a `pending`; al reclamarla vuelve a la página 1 con un `scroll_id` nuevo. La última vuelta de la corrida 9371 quedó en `enumerated=200` y murió a los 30 min. Además el scroll (5 min) se intercala con 5 bulks por página. |
| `ml.messages` | 10 | 360 packs de los últimos 30 días, 10 GET en `Promise.all` por página ≥ 36 min | La ráfaga de 10 vacía el bucket de golpe; el resto espera. La vuelta necesita más de los 30 min del tope de diferimiento (corridas 9199/9323/9438: `enumerated=0`, 8 intentos). |
| `ml.shipments` | 15 | 211 candidatos, 20 GET por página con 300 ms de pausa | 15 tokens salen en ~5 s del minuto; los otros 55 s el bucket está vacío. Sin posición persistida, cada diferimiento reinicia (corridas 9198/9322/9441). |

Y en la misma corriente: `missed_feeds` de `shipments` y `messages` vive con `!CUPO_SOMBRA_AGOTADO` casi todas las rondas (`cupo-cobertura.txt`), porque el barrido gana la carrera por los tokens al comienzo de cada minuto.

**Hallazgo adicional (bloqueante para D6):** en `worker/main.ts` los barridos y las señales comparten UN solo `setInterval` con guardia `enVuelta`, y `unaVuelta` de `crearWorkerBarridos` hace `await procesador(corrida)` por cada corrida reclamada. Hoy las corridas fallan rápido, así que nadie lo nota. En cuanto un barrido dure 20–25 min (como va a pasar, correctamente, con el cupo respetado), **toda** la vuelta —señales de todas las corrientes y los barridos de `ml.orders`/`questions`/`claims`— queda bloqueada tras él. Por eso la Tarea 4 separa los bucles.

## Decisiones y cómo se cumplen

### D1 — Posición reanudable en `sweep_runs`
Columnas nuevas `position jsonb` (objeto, nullable) y `pages_done integer`. El motor lee `position` en el mismo `UPDATE … RETURNING` que congela la ventana y la escribe dentro de la transacción de cada página (la misma que ya verifica el lease), de modo que "página persistida" y "posición avanzada" son atómicos. Al terminar la última página `position` queda `NULL`. Ventana congelada (`window_from/window_to`) + posición ⇒ un reintento o una reclamación tras diferimiento continúa exactamente donde quedó. Una corrida nueva (siguiente materialización) siempre arranca de cero.

### D2 — Reloj de diferimiento
`deferred_since` (corridas.ts, `diferirCorridaPorCupo`, tope 30 min) se pone en `NULL` en la misma transacción que confirma una página con progreso. Una corrida muere sólo si pasa 30 min **sin avanzar una página**. La corrida "avanza" también cuando la página no trae recursos pero sí cambia la posición (p. ej. fin de la fase de enumeración).
**[propuesta D2b]** Por la misma razón, la página confirmada lleva `attempts = LEAST(attempts, 1)`: `max_attempts=8` pasa a contar intentos consecutivos **sin progreso**. Sin esto una vuelta larga que tenga 8 fallos transitorios repartidos en 25 min (backoff 30 s→900 s) muere pese a estar avanzando. Reversible: una línea del UPDATE. **[aprobado por opt-c1] Tope de edad total:** el motor, antes de cada página, verifica `now() − started_at > 6 h` y lanza un error **no reintentable** (`EDAD_MAXIMA`) ⇒ `fallarCorrida(..., reintentable=false)` ⇒ `failed`. Cierra el caso de un defecto que «avance» sin avanzar de verdad (zombi), ya que D2 y D2b por sí solos podrían mantener viva una corrida indefinidamente.

### D3 — `ml.items` en dos fases
**(a) Enumerar** `search_type=scan&limit=100`: sólo llamadas scan, seguidas, dentro de la vida del scroll. **(b) Detalle** `/items/bulk?ids=` de a 20 desde un cursor persistido sobre la lista de ids, sin límite de tiempo.
- **Vida del scroll:** ML dice que `scroll_id` expira a los 5 min y que hay que consumirlo completo antes (mldocs `items_y_busquedas`, `rate_limit_error_429`). No dice si el reloj corre desde la creación o desde el último uso: se trata como **desde la creación**, con tope propio de **240 s** (`SCROLL_VIDA_MAX_MS`). La posición de la fase (a) guarda `scroll_desde`; al reanudar, si `ahora − scroll_desde > 240 s` no se reutiliza: se descarta la lista parcial y se vuelve a empezar (a). Nunca se envía un `scroll_id` vencido.
- **Presupuesto de tiempo de (a):** 43 scans. Con reserva de 2 rpm para señales durante esta fase (13 rpm ⇒ un scan cada 4,85 s) son **≈ 209 s**; margen ≈ 30 s sobre 240 s. Un `CUPO_SOMBRA_AGOTADO` dentro de (a) no se propaga al worker (diferir con el scroll vivo es tirarlo): se espera `retry-after` en el lugar si cabe antes de los 240 s; si no cabe, se reinicia (a). Tope de 3 reinicios por corrida ⇒ `ErrorBarridoReintentable('SCROLL_VENCIDO')` visible en logs.
- **Almacenamiento: tabla de trabajo, no columna jsonb** **[propuesta, la justificación pedida]**. `integrations.sweep_work_items(run_id, seq identity, resource_id)`, `UNIQUE(run_id, resource_id)`, FK `ON DELETE CASCADE` a `sweep_runs`. Razones: (1) el cursor de (b) es un entero (`seq`) y cada lote sale con `WHERE seq > $cursor ORDER BY seq LIMIT 21`, sin cargar ni reescribir 4,3 k ids (~55 KB) en cada una de las 213 páginas; una columna jsonb en la fila caliente de `sweep_runs` (que además recibe latidos de lease cada 20 s) obliga a leer el arreglo completo por página y a reescribirlo si se agrega por lotes; (2) el append de cada scan y el avance de posición van en la misma transacción, y reiniciar (a) es un `DELETE … WHERE run_id` limpio; (3) sirve igual para la lista de packs con mensajes sin leer de `ml.messages` (D4), que sale de la red y no se puede rederivar; (4) es consultable para observabilidad (`count(*)`). Costo: una tabla y una migración más; ~4,3 k filas por día, insignificante. **Permiso:** `plataforma_app` sólo tiene SELECT/INSERT/UPDATE por defecto en `integrations` (0002); la migración debe agregar `GRANT DELETE` explícito sobre esta tabla.
- **Bajas:** la vuelta completa da de baja lo no visto (`declararBajas`). Una enumeración a medias **jamás** debe cerrarse: la corrida sólo finaliza cuando (b) consume toda la lista, y (a) sólo pasa a (b) cuando el scroll devuelve vacío/`null`. **[propuesta, quitable]** guarda adicional en la transición (a)→(b): si el total enumerado es < 50 % de los `ml.items` abiertos en `resource_observations`, la corrida falla con `ENUMERACION_SOSPECHOSA` en vez de dar de baja masivamente.

### D4 — `ml.messages` sólo con los packs sin leer
Flujo documentado (mldocs `mensajes_pendientes`): `GET /messages/unread?role=seller&tag=post_sale` → lista de `resource` → `GET /messages/packs/{p}/sellers/{s}?tag=post_sale&mark_as_read=false`, **secuencial** (se elimina el `Promise.all`), reanudable. Se elimina la enumeración "todos los `order_pack` de 30 días" y la consulta a `resource_relations`.
- El `unread` no está paginado en la doc; su lista se guarda en `sweep_work_items` (D3) y se lee de a 5 packs con cursor `seq`.
- **`last_unread_at` por página:** el instante del `unread` se guarda en `position.unread_en` dentro de la primera página y viaja en cada posición siguiente; `cursorAfter.last_unread_at` sale de ahí. Una reanudación no repite el `unread` (usa la lista persistida) y el valor sobrevive al reintento en vez de existir sólo al cierre.
- **Se elimina la compuerta de 6 h (`INTERVALO_UNREAD_MS`):** existía porque el `unread` era un "respaldo" junto a la enumeración de 360 packs. Ahora es el flujo entero: 1 llamada cada 20 min (0,05 rpm). **[propuesta, a confirmar]**.
- **Cobertura que se pierde** (evaluación pedida). La enumeración vieja veía todos los packs de 30 días, leídos o no, con mensajes en ambos sentidos. La nueva sólo ve packs con mensajes **sin leer por el vendedor**. Se pierde: (i) mensajes que el vendedor ya leyó en la app de ML antes de que llegaran por notificación o `missed_feeds`; (ii) mensajes salientes del vendedor hechos fuera de la plataforma; (iii) reparar una copia vieja de un pack ya leído. Cubierto por lo que queda: notificaciones `messages` (reintentos de ML durante 1 h) + `missed_feeds` de `messages` (2 días, ronda cada 30 min) + el `unread` cada 20 min. El hueco residual es: notificación perdida **y** más de 2 días **y** mensaje ya leído. La copia es de sombra (no se actúa sobre ella), y ML documenta las notificaciones como el flujo principal y `unread` como validación redundante. Si más adelante se quiere cerrar (iii), una pasada completa semanal de baja velocidad (≤ 2 rpm) es una tarea aparte; no se incluye. Con 82 observaciones de mensajes contra 360 packs de 30 días, el volumen de `unread` esperado es de decenas de packs.
- Las señales de mensajes ya devuelven `{ tipo: 'barrido' }` (relectura.ts) y adelantan este barrido: pasa a costar 1 llamada + los packs sin leer.

### D5 — `ml.shipments`
Se mantiene el `GET /shipments/{id}` individual con `x-format-new: true` (no hay bulk en ML), secuencial. La lista de candidatos ya se deriva de la base con un cursor por clave (`id COLLATE "C" > despuesDe`); **no necesita tabla de trabajo**: alcanza con persistir `despuesDe` en `position` (la posición que hoy se pierde). Regla de diseño: una lista que se puede rederivar de la base se reanuda por cursor de clave; una que sale de la red (scan, `unread`) se persiste en `sweep_work_items`. Páginas de **5 ids** (antes 20) para que cada commit sea progreso frecuente y una página no dure más que ~30 s pacada. La unidad de commit es la página: un corte a mitad de página repite como máximo 4 GET (el motor persiste recién cuando `listar` devuelve); es el costo aceptado por no llevar una transacción por GET. Se elimina la pausa fija de 300 ms: el ritmo lo da el ritmador (D6).

### D6 — Sin inanición de señales ni `missed_feeds`
Dos mecanismos que se suman **[propuesta]**:

**(A) Reserva de cupo por corriente, en la plataforma.** Un ritmador por corriente separa las llamadas del barrido con un intervalo `≥ 60 / (rpm − reserva)` segundos (+250 ms de holgura). Con el bucket del gateway de ventana fija por minuto (`crearBucket`, lib/gatewayCanal.js), eso garantiza ≤ `rpm − reserva` llamadas del barrido en **cualquier** ventana, así que quedan `reserva` tokens por minuto para señales y `missed_feeds` **aunque el barrido esté corriendo sin parar**. No requiere tocar el legado ni `.env`.

| Corriente | rpm | Reserva N | Barrido S = rpm−N | Intervalo | Duración estimada de la vuelta |
|---|---|---|---|---|---|
| `ml.items` (a: scan) | 15 | 2 (sólo esta fase, ≈3,5 min) | 13 | 4,87 s | 43 scans ≈ 209 s |
| `ml.items` (b: bulk) | 15 | 4 | 11 | 5,70 s | 213 bulks ≈ 20 min |
| `ml.shipments` | 15 | 4 | 11 | 5,70 s | 211–300 GET ≈ 20–29 min |
| `ml.messages` | 10 | 3 | 7 | 8,82 s | `unread` + decenas de packs ≈ 1–5 min |

Reserva de 4 = 240 señales/h por corriente (26 % del cupo); de 3 en mensajes = 180/h (30 %). `missed_feeds` gasta ≤ 1 llamada por tópico cada 30 min (0,03 rpm; 2–3 si hay avisos). Cada señal es 1 GET (`/items/bulk?ids=1`, `/shipments/{id}`…). Los presupuestos suman 60 rpm = techo global (`GATEWAY_ML_SHADOW_RPM=60`): el global nunca aprieta mientras cada barrido respete su S. **Sin dato medido de la demanda de señales por minuto**: si excede la reserva, las señales se difieren (`retry-after` ≤ 60 s, no consumen intento) y el sistema se degrada con elegancia; el dato real (señales/min por tópico en 7 días) se pide a opt-c1 como consulta de sólo lectura antes de fijar las constantes (pregunta 1). La reserva es un saldo **compartido** entre señales y `missed_feeds`; una ráfaga de señales podría vaciarlo justo antes de una ronda de `missed_feeds`. Por eso la Tarea 9 agrega a `missed_feeds` un reintento único tras el `retry-after` cuando choca con el cupo (hoy cada tópico que choca espera 30 min), y el criterio global 3 mide exactamente esa competencia. Las constantes viven en un solo módulo (`ritmo.ts`) y su relación con `GATEWAY_ML_SHADOW_RPM_*` se documenta ahí; se agrega un test que falla si `rpm − reserva < 1`.

**(B) Bucles independientes en el worker.** Barridos y señales dejan de compartir `setInterval` y guardia (Tarea 4), las corridas reclamadas corren en paralelo entre corrientes (una por corriente por el índice único `sweep_runs_un_activa`, con cupos separados) y las señales corren **antes** del reclamo de barridos en cada tick. Sin esto (A) no alcanza: la reserva de tokens no sirve si el bucle que las consume está bloqueado por un barrido de 25 min.

### D7 — `missed_feeds` de `items`: verificado, sin cambio de código
- `site_id`: `lib/gatewayCanal.js` (op `ml.missed_feeds`) agrega `site_id=ctx.mlSiteId` sólo cuando `topic==='items'` y falla cerrado (`ErrorOperacionInvalida`) si falta o no cumple `^M[A-Z]{2}$`; `server.js:274` lo toma de `ML_SITE_ID`, presente en `.env` (`MLA`, validada el 2026-09-16, SOP sombra). La doc de ML lo exige textualmente: "para consultar notificaciones perdidas del tópico items, informe obligatoriamente el parámetro site_id". Test existente: `test/gatewayCanal.test.js:70-75` (con sitio y sin sitio).
- Retención: la doc dice "La API de missed_feeds solo guarda las notificaciones perdidas de hasta 2 días atrás" y que se consideran perdidas tras 8 intentos (1 h). La ronda de 30 min (`MISSED_FEEDS_MS`) deja ≥ 90 rondas de margen; una caída del worker de más de ~47 h pierde avisos, ya documentado en el diseño §10.
- Lo único que se agrega es una **prueba de fijación** del lado de la plataforma (Tarea 9) y el comentario con la retención, para que un cambio futuro sea deliberado.

### D8 — Observabilidad
Un log por página de barrido, más eventos de ciclo de vida, todos sin PII (sin ids de recurso, packs, scroll_id, rutas con ids ni payloads): ver Tarea 8.

## Arquitectura

- `migrations/0032_barridos_reanudables.sql`: `sweep_runs.position`, `sweep_runs.pages_done`, tabla `sweep_work_items`.
- `src/reconciliacion/trabajo.ts`: acceso a la tabla de trabajo (agregar, reiniciar, leer lote, contar, purgar).
- `src/reconciliacion/motor.ts`: posición y trabajo dentro de la transacción de página; reset de `deferred_since`/`attempts`; log por página.
- `src/reconciliacion/ritmo.ts`: ritmador por corriente (uno por proceso) y `ritmar(transporte, ritmo)`; tabla de reservas.
- `src/reconciliacion/adaptadores/ml.ts`: `adaptadorItemsMl` (dos fases), `adaptadorMensajesMl`, `adaptadorEnviosMl`.
- `src/worker/barridos.ts`: `lanzarVuelta` (no bloqueante) y corridas concurrentes; log de ciclo de vida.
- `src/worker/bucles.ts` (nuevo, extraído de `main.ts` para poder probarlo) y `src/worker/main.ts`.

## Convenciones para el ejecutor

- TDD: test rojo primero, ver que falla por la razón correcta, implementar, verde. Nunca `git add -A`; rutas explícitas. No tocar los archivos de otras sesiones (`git status`).
- Por tarea sólo los tests afectados + `npm run typecheck` (en `plataforma/`), salida cruda a `/tmp/claude-0/e1br-tN-*.txt`. La suite completa la corre quien pide opt-c1, al final, con nada más corriendo (`pgrep -af "vitest|node.*server"`).
- Después de cada tarea: `codex exec --sandbox read-only` sobre el diff (prompt en inglés, salida a `/tmp/claude-0/codex-e1br-tN.txt`), responder cada hallazgo, reportar a opt-c1 y esperar su OK.
- Nada contra producción: ni lecturas de ML, ni migraciones, ni despliegue, ni `.env`. Los datos de clientes no salen a ningún servicio externo.

---

### Tarea 1: Migración 0032 — posición y tabla de trabajo

**Archivos:**
- Crear: `plataforma/migrations/0032_barridos_reanudables.sql`
- Modificar: `plataforma/test/migraciones.test.ts` (lista de migraciones esperada: agregar `0032_barridos_reanudables.sql`)
- Test: `plataforma/test/reconciliacion/esquema.test.ts` (casos nuevos)

**Contenido:** `SET lock_timeout='5s'`; `ALTER TABLE integrations.sweep_runs ADD COLUMN position jsonb, ADD COLUMN pages_done integer NOT NULL DEFAULT 0, ADD CONSTRAINT sweep_runs_position_check CHECK (position IS NULL OR (jsonb_typeof(position)='object' AND pg_column_size(position) < 8192))`; `CREATE TABLE integrations.sweep_work_items (run_id bigint NOT NULL REFERENCES integrations.sweep_runs(id) ON DELETE CASCADE, seq bigint GENERATED ALWAYS AS IDENTITY, resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512), PRIMARY KEY (run_id, seq), UNIQUE (run_id, resource_id))`; `GRANT DELETE ON integrations.sweep_work_items TO plataforma_app`. Numeración: **0032**. La rama sin fusionar `fix/e3c3-segunda-opinion` ya usa 0028 (`atributos_sin_modelo`), 0029 (`validar_atributos_sin_modelo`), 0030 (`e3_canario_leases`) y 0031 (`e3_canario_cuenta`); 0025–0027 existen en esta rama y no se renumeran (24 aplicadas en prod). **Precondición:** `leerArchivos` (`src/db/migrar.ts`) exige que los archivos del directorio sean contiguos desde 0001 (`a.numero !== i + 1` ⇒ `ErrorMigracion` «hueco o repetición»); un 0032 sin 0028–0031 presentes hace fallar **toda** migración y toda base de prueba (`crearBaseVacia` migra el directorio). Por lo tanto esta tarea sólo puede implementarse sobre un árbol donde 0028–0031 ya estén (fusión previa de esa rama). Ver el riesgo R1: el migrador aplica todas las pendientes en orden.

**Tests (rojo primero):**
- [ ] `esquema.test.ts`: `position` acepta objeto y rechaza array/escalar; rechaza un objeto ≥ 8 KB; `pages_done` default 0.
- [ ] `sweep_work_items`: `UNIQUE(run_id, resource_id)` rechaza duplicado; `seq` crece; borrar la corrida borra sus filas (cascade); `plataforma_app` puede `DELETE` sobre la tabla (conexión de la app), y sigue **sin** poder sobre `sweep_runs`.
- [ ] `migraciones.test.ts`: la lista esperada incluye `0032…`; dos bases migradas dan el mismo esquema (test existente E1-SCH-02).

**Criterios de aceptación:** migrar una base vacía y una base en el estado de prod (0001–0024) hasta 0028 funciona; los tests de esquema y `migraciones.test.ts` verdes; `npm run typecheck` limpio.

---

### Tarea 2: Motor — posición persistida, reset del reloj (D1, D2)

**Archivos:**
- Crear: `plataforma/src/reconciliacion/trabajo.ts`
- Modificar: `plataforma/src/reconciliacion/tipos.ts` (`PaginaRemota` suma `trabajo?: { reiniciar?: boolean; agregar?: readonly string[] }` y `telemetria?: TelemetriaPagina`), `plataforma/src/reconciliacion/motor.ts`, `plataforma/src/reconciliacion/corridas.ts` (`completarCorrida` y la ruta terminal de `fallarCorrida`/`liberarCorridasVencidas` purgan el trabajo; ver abajo)
- Test: `plataforma/test/reconciliacion/motor-reanudable.test.ts` (nuevo), `plataforma/test/reconciliacion/corridas.test.ts` (casos de purga)

**Interfaces:**
- `trabajo.ts`: `agregarTrabajo(tx, runId, ids)` (`INSERT … SELECT unnest($2::text[]) ON CONFLICT DO NOTHING`), `reiniciarTrabajo(tx, runId)`, `leerLote(db, runId, despuesDeSeq, limite): {seq:string, id:string}[]`, `contarTrabajo(db, runId)`, `purgarTrabajoTerminal(pool)`.
- Motor: el `UPDATE … RETURNING window_from, window_to` que congela la ventana devuelve además `position`; `let posicion = fila.position` (con validación de objeto). En la transacción de cada página, tras verificar el lease: aplicar `pagina.trabajo` (reiniciar antes de agregar) y un solo `UPDATE sweep_runs SET enumerated=…, missing_enqueued=…, duplicates=…, position=$nextPosition, pages_done=pages_done+1, deferred_since=NULL, attempts=LEAST(attempts,1) WHERE id=$1`.
- Purga: `completarCorrida` borra las filas de trabajo de la corrida en su transacción; `fallarCorrida` con estado `failed` y `liberarCorridasVencidas` con `failed` las borran; una purga de respaldo (`purgarTrabajoTerminal`, corridas en estado terminal con filas) se llama desde el mismo temporizador que `materializarCorridas`.
- `enumerated`: hoy se reasigna desde contadores en memoria; al reanudar desde `position` deben **continuar acumulando** desde el valor persistido (leer `enumerated/missing_enqueued/duplicates` en el mismo `RETURNING`), no reiniciarse en 0.

**Tests (rojo primero):**
- [ ] Adaptador de 3 páginas que lanza en la 2.ª: `position` queda con la posición de la 1.ª; una segunda reclamación llama a `listar` con esa posición (no `null`) y sólo pide la 2.ª y 3.ª. `enumerated` acumula entre intentos.
- [ ] Tras completar, `position IS NULL`, `pages_done = 3`, la ventana no cambió entre intentos.
- [ ] D2: corrida con `deferred_since` de hace 40 min que confirma una página ⇒ `deferred_since IS NULL`; un diferimiento inmediato posterior **no** cae a `CUPO_SOMBRA_AGOTADO`/`fallarCorrida`. Control: sin páginas confirmadas por > 30 min sigue cayendo (test existente en `corridas.test.ts`, se mantiene).
- [ ] D2b: corrida con `attempts=7` que confirma una página vuelve a `attempts=1`; un fallo sin progreso sigue consumiéndolos hasta `failed`.
- [ ] **Tope de edad:** una corrida con `started_at` de hace 6 h 1 min que reclama y va a leer una página termina `failed` con `EDAD_MAXIMA` sin llamar a `listar`; con 5 h 59 min sigue normal; una corrida que avanza páginas cada minuto pero supera las 6 h también muere (el reset de `deferred_since`/`attempts` no lo evita).
- [ ] Lease perdido antes de la transacción de página ⇒ rollback completo: ni `position`, ni filas de trabajo, ni observaciones (mismo criterio que el test actual de lease ajeno).
- [ ] `trabajo.reiniciar` + `agregar` en la misma página: las filas viejas desaparecen y las nuevas quedan, atómico.
- [ ] Purga: corrida `succeeded`/`failed` sin filas de trabajo; `pending`/`retryable` las conserva.
- [ ] `soltarCorridaPorApagado` conserva `position` (apagado del worker no pierde progreso).

**Criterios de aceptación:** los tests nuevos y `motor.test.ts`, `corridas.test.ts`, `multicuenta.test.ts` verdes sin cambios de aserciones previas (salvo las que fijaban "sin posición persistida", si existen: se reportan a opt-c1); typecheck limpio.

---

### Tarea 3: Ritmador (D6-A)

**Archivos:**
- Crear: `plataforma/src/reconciliacion/ritmo.ts`
- Test: `plataforma/test/reconciliacion/ritmo.test.ts`

**Interfaces:** `RITMO_BARRIDO_ML = { items_scan: {rpm:15, reserva:2}, items: {rpm:15, reserva:4}, shipments: {rpm:15, reserva:4}, messages: {rpm:10, reserva:3} }`; `crearRitmo({ rpm, reserva, holguraMs = 250, reloj?, esperar? })` con `intervaloMs = ceil(60000/(rpm−reserva)) + holguraMs` (lanza si `rpm − reserva < 1`); `ritmar(transporte, ritmo): TransporteCanal & { tomarTelemetria(): { esperaMs: number; llamadas: number } }` que **serializa** las llamadas (cadena de promesas, una en vuelo) y espera `intervaloMs` desde el inicio de la anterior. Un error de `get` no rompe la cadena. El ritmador es **uno por corriente en todo el proceso** (registro `ritmoDe(clave)` a nivel de módulo, con clave por corriente y fase: `items_scan` e `items` son fases secuenciales de la misma corriente, nunca simultáneas): el bucket del gateway es uno por corriente para todo el legado (`crearPresupuestoShadow`), así que dos cuentas ML con ritmadores propios sumarían por encima del cupo. **Sólo** lo usan los adaptadores de barrido; el transporte de señales y `missed_feeds` queda sin ritmar.

**Tests (rojo primero, reloj y `esperar` falsos):**
- [ ] En 10 minutos simulados, ninguna ventana de 60 s contiene más de `rpm − reserva` llamadas, tampoco cruzando el borde del minuto (fijar una ventana de reloj de pared arbitraria).
- [ ] Llamadas concurrentes se ejecutan de a una y en orden.
- [ ] Un `get` que lanza no deja la cadena colgada; la siguiente llamada respeta el intervalo.
- [ ] `tomarTelemetria()` devuelve espera acumulada y llamadas desde la última lectura y la reinicia.
- [ ] `rpm − reserva < 1` lanza; la tabla `RITMO_BARRIDO_ML` cumple `S ≥ 1` en todas las filas.
- [ ] Dos adaptadores de la misma corriente pero de cuentas distintas comparten el mismo ritmador: entre ambos no superan `S` llamadas por ventana de 60 s.

**Criterios de aceptación:** tests verdes; typecheck limpio. Las constantes de la tabla coinciden con la del plan (items 13/11, shipments 11, messages 7).

---

### Tarea 4: Worker — bucles independientes y corridas concurrentes (D6-B)

**Archivos:**
- Crear: `plataforma/src/worker/bucles.ts`
- Modificar: `plataforma/src/worker/barridos.ts`, `plataforma/src/worker/main.ts`
- Test: `plataforma/test/reconciliacion/corridas.test.ts` (worker de barridos), `plataforma/test/worker/bucles.test.ts` (nuevo)

**Interfaces:**
- `crearWorkerBarridos` suma `lanzarVuelta(cantidad?)`: reclama hasta `cantidad − activas.size` corridas y las procesa **en segundo plano y en paralelo** (cada una con su `try/catch/finally` actual, mismos manejos de `ErrorCupoSombraAgotado`/`ErrorBarridoReintentable`); devuelve enseguida cuántas lanzó. `unaVuelta(cantidad)` conserva su contrato (espera a que terminen las lanzadas) para no romper los tests ni el uso actual; `detener()` espera a las activas tras soltarlas.
- `bucles.ts`: `iniciarBucles({ barridos, senales, logger, tickMs = 1000 })` con **dos** temporizadores, cada uno con su guardia; el de señales corre `senales.unaVuelta()` y el de barridos `barridos.lanzarVuelta()`. Devuelve `detener()`. `main.ts` reemplaza el `setInterval` único por `iniciarBucles`. El orden dentro de un tick ya no importa porque los bucles son independientes; la reserva (Tarea 3) es la que garantiza tokens.

**Tests (rojo primero):**
- [ ] Una corrida de `ml.items` colgada (promesa sin resolver) no impide que en el mismo worker se reclame y complete una de `ml.orders` (corrientes distintas).
- [ ] `lanzarVuelta` vuelve sin esperar a la corrida; `unaVuelta` sí espera.
- [ ] No se reclaman más de `cantidad` corridas en total entre lanzadas y en curso; no se reclama la misma corrida dos veces.
- [ ] `detener()` con una corrida en curso la deja `pending` con `position` intacta y `attempts−1`.
- [ ] `bucles.test.ts` (timers falsos): con `barridos.lanzarVuelta` que tarda "20 min", `senales.unaVuelta` se sigue invocando cada tick; un rechazo de un bucle se registra y no frena al otro; `detener()` cancela ambos.

**Criterios de aceptación:** tests verdes; el resto de `corridas.test.ts` sin cambios de aserciones; typecheck limpio. Revisar que el tamaño de pool (`crearPool`) soporta las corridas concurrentes (una conexión sólo mientras hay consulta; se reporta el máximo simultáneo observado en el test).

---

### Tarea 5: `ml.shipments` reanudable y ritmado (D5)

**Archivos:**
- Modificar: `plataforma/src/reconciliacion/adaptadores/ml.ts` (`adaptadorEnviosMl`), `crearAdaptadoresMl` (recibe el ritmo)
- Test: `plataforma/test/reconciliacion/adaptadores.test.ts` (o `envios-ml-reanudable.test.ts` nuevo)

**Cambios:** `LOTE_ENVIOS = 5`; sin pausa fija de 300 ms (la da el ritmador, inyectado vía `DependenciasMl.ritmo?` para no cambiar los tests que no lo pasan); la posición `{ despuesDe }` ya es persistible por el motor. Los GET siguen secuenciales.

**Tests (rojo primero):**
- [ ] Corrida que se corta tras 2 páginas: la reanudación arranca en `despuesDe` de la posición persistida y no repite GET de ids ya leídos (contar llamadas por id).
- [ ] Concurrencia máxima de llamadas en vuelo = 1.
- [ ] 404 se omite; fin de lista ⇒ `nextPosition = null`.
- [ ] Con `CUPO_SOMBRA_AGOTADO` en la llamada 3 de una página de 5, **la página entera no se persiste** (el adaptador acumula los recursos y el motor los escribe después de que `listar` devuelve): el motor difiere, la posición sigue en el cursor anterior y la reanudación repite esos ≤ 4 GET. El test lo fija explícitamente (desperdicio acotado a `LOTE_ENVIOS − 1` llamadas por corte) y verifica con el motor real que la corrida completa sin duplicar observaciones.

**Criterios de aceptación:** tests verdes; una vuelta simulada de 300 candidatos con el ritmador (reloj falso) termina y respeta S=11; typecheck limpio.

---

### Tarea 6: `ml.messages` sólo con packs sin leer (D4)

**Archivos:**
- Modificar: `plataforma/src/reconciliacion/adaptadores/ml.ts` (`adaptadorMensajesMl`; se eliminan `INTERVALO_UNREAD_MS`, la consulta a `resource_relations` y el `Promise.all`)
- Test: `plataforma/test/reconciliacion/adaptadores.test.ts` (reescribir los casos de mensajes) o `mensajes-ml-reanudable.test.ts` nuevo

**Comportamiento:** página 1 (`position` nula): `GET /messages/unread?role=seller&tag=post_sale` (ritmado), filtra `resource` con `RECURSO_PACK`, `trabajo:{reiniciar:true, agregar: recursos}`, `nextPosition: { v:1, fase:'packs', seq:'0', unread_en: <ISO> }`; sin pendientes ⇒ `nextPosition: null`. Páginas siguientes: `leerLote(db, corrida.id, seq, 6)` (5 + 1 para saber si hay más), un GET por pack **en secuencia** con `mark_as_read=false`, 404 omitido; `cursorAfter = { …generación, last_unread_at: position.unread_en }`.

**Tests (rojo primero):**
- [ ] Sin `Promise.all`: concurrencia máxima 1.
- [ ] Sólo se piden los packs devueltos por `unread`; con `unread` vacío no hay ninguna otra llamada; **no** se consulta `resource_relations`.
- [ ] Corte en la página 2 ⇒ reanudación no vuelve a llamar a `unread` y sigue por `seq`; `unread_en` se conserva en la posición y en `cursorAfter.last_unread_at`.
- [ ] Toda GET de pack lleva `mark_as_read=false` (nunca marca leídos).
- [ ] **Se endurece `RECURSO_PACK`** a `^/packs/\d{1,20}/sellers/\d{1,20}$` (hoy acepta cualquier segmento no vacío, p. ej. `/packs/abc/sellers/xyz`, que después el gateway rechaza y que una ruta larguísima haría fallar el `CHECK` de 512 caracteres de la tabla de trabajo). Tests: `abc`, vendedor de otra cuenta, segmento vacío, > 512 caracteres y `..` se descartan **antes** de tocar la tabla o la red; el vendedor debe coincidir con `dep.sellerId`.

**Criterios de aceptación:** tests verdes; la sección "cobertura perdida" de este plan sigue vigente y se cita en el mensaje de commit; typecheck limpio.

---

### Tarea 7: `ml.items` en dos fases (D3)

**Archivos:**
- Modificar: `plataforma/src/reconciliacion/adaptadores/ml.ts` (`adaptadorItemsMl`, `conReintento`), `crearAdaptadoresMl`
- Test: `plataforma/test/reconciliacion/items-ml-reintentos.test.ts` (adaptar), `plataforma/test/reconciliacion/items-ml-dos-fases.test.ts` (nuevo)

**Posición:** `{ v:1, fase:'enumerar', scroll_id?, scroll_desde, reinicios }` → `{ v:1, fase:'detalle', seq, total }`. **Algoritmo:** ver D3. Detalle: `leerLote(db, corrida.id, seq, 21)`, un bulk por página (≤ 20 ids), `status_code` 200 ⇒ recurso, 404 ⇒ no se observa, otro ⇒ `presentes`, igual que hoy. El presupuesto de reintentos de `conReintento` (90 s) deja de ser "de la página del scroll" y pasa a ser por llamada. Un `ErrorCupoSombraAgotado` en (b) propaga (el motor difiere; la posición ya está persistida).

**Tests (rojo primero, transporte falso, reloj falso, base real):**
- [ ] **Orden (D3a):** en toda la fase de enumeración sólo hay llamadas `items/search`; el primer `/items/bulk` ocurre después del último scan (registro de llamadas en orden).
- [ ] La lista completa queda en `sweep_work_items` (250 ids en 3 páginas, sin duplicados) antes del primer bulk.
- [ ] **Reanudación de (b):** cortar tras el 3.er bulk ⇒ la reanudación no hace ningún scan y continúa en el 4.º lote, sin repetir ids.
- [ ] **Scroll vencido:** reanudar (a) con `scroll_desde` de hace 241 s ⇒ se borra la lista parcial, la primera llamada no lleva `scroll_id`, y el `scroll_id` viejo no vuelve a enviarse jamás (aserción sobre todas las rutas).
- [ ] **Cupo dentro de (a):** `CUPO_SOMBRA_AGOTADO` con `retry-after: 20` a los 100 s ⇒ espera 20 s y continúa con el mismo scroll; con `retry-after: 60` a los 200 s ⇒ reinicia (a) sin error; tercer reinicio ⇒ `SCROLL_VENCIDO`.
- [ ] **Bajas seguras:** una corrida interrumpida en (a) o (b) nunca ejecuta `declararBajas` (los abiertos siguen abiertos); una completa da de baja lo no visto; la guarda del 50 % falla con `ENUMERACION_SOSPECHOSA` sin dar de baja nada.
- [ ] **De punta a punta con el motor real:** 4.300 ids sintéticos (43 páginas scan + 215 bulks), ritmador con reloj falso ⇒ la corrida termina `succeeded`, con ≤ 13 scans/min en (a), ≤ 11 bulks/min en (b), y ningún scroll usado más de 240 s.

**Criterios de aceptación:** tests verdes; los casos previos de `items-ml-reintentos.test.ts` migrados sin perder cobertura (429 con `retry-after`, 5xx, límite de reintentos); typecheck limpio.

---

### Tarea 8: Observabilidad sin PII (D8)

**Archivos:**
- Modificar: `plataforma/src/reconciliacion/motor.ts` (opción `log?`), `plataforma/src/worker/barridos.ts` (opción `log?`), `plataforma/src/worker/main.ts` (pasa `logger`), los adaptadores (devuelven `telemetria`)
- Test: `plataforma/test/reconciliacion/motor-log.test.ts` (nuevo)

**Eventos (nivel info; msg fijo, campos planos):**
- `barrido: página` → `{ topic, corrida, pagina, fase, enumerados, esperaMs, llamadas, ms }` — `pagina` es el acumulado persistido (`pages_done`), `enumerados` el acumulado de la corrida, `esperaMs` los tokens esperados (ritmador + esperas de `retry-after`) desde la página anterior.
- `barrido: reanudado` → `{ topic, corrida, fase, pagina, intento }` al arrancar con `position` no nula.
- `barrido: diferido por cupo` → `{ topic, corrida, retryAfterS, sinProgresoMin }` (minutos desde el último avance = `deferred_since`).
- `barrido: scroll reiniciado` → `{ topic, corrida, motivo: 'vencido'|'cupo', reinicios }`.
- `barrido: completo` → `{ topic, corrida, paginas, enumerados, duracionMs, esperaMs }` y `barrido: falló` → `{ topic, corrida, codigo }` con `codigo = codigoSaneado(error)`: `error.name` + el mensaje con toda racha de ≥ 5 dígitos reemplazada por `#` y todo id de publicación `[A-Z]{3}#` por `ITEM#`. Hoy el worker arma `codigo` con el mensaje original (`barridos.ts`, `${error.name}: ${error.message}`) y el motor interpola ids remotos en `ErrorPaginaInvalida` (`recurso remoto sin identidad…`, `versión temporal inválida para ${r.id}`): el saneamiento se aplica **sólo al log**; `error_detail` de la base no cambia.

**Tests (rojo primero):**
- [ ] Una corrida de 3 páginas emite 3 `barrido: página` con `pagina` 1..3 y `enumerados` creciente.
- [ ] Una corrida reanudada emite `barrido: reanudado` con `pagina` ≠ 0.
- [ ] **Sin PII:** con recursos que contienen emails, ids de `MLA…`, ids de pack/envío y un `scroll_id`, el JSON serializado de **todos** los logs no contiene ninguna de esas cadenas ni rutas con ids (aserción por `includes` sobre el volcado).
- [ ] Todos los eventos tienen `topic` y `corrida` numéricos/textuales planos (no objetos anidados con datos).
- [ ] **Ruta de error:** un `ErrorPaginaInvalida` cuyo mensaje contiene un id de recurso (`versión temporal inválida para MLA123456789`) y un `ErrorBarridoReintentable` con ruta con id producen `barrido: falló` sin esos ids; `codigoSaneado` con tabla de casos.

**Criterios de aceptación:** con esos eventos se puede responder desde logs, sin tocar la base: cuántas páginas y cuánto tiempo tardó cada barrido, cuánto esperó por cupo, cuántas veces se reanudó y si murió por falta de progreso.

---

### Tarea 9: `missed_feeds` — fijación de site_id, retención y reintento por cupo (D7, D6)

**Archivos:**
- Modificar: `plataforma/src/reconciliacion/missed-feeds.ts` (comentario de retención de 2 días, sin cambio de lógica) y, si hace falta, exportar `MISSED_FEEDS_MS` desde `worker/bucles.ts` o un módulo común
- Test: `plataforma/test/reconciliacion/gateway.test.ts` (caso nuevo), `plataforma/test/reconciliacion/missed-feeds.test.ts` (reintento por cupo)

- [ ] Test: la ruta del adaptador para `topic=items` no lleva `site_id` (lo agrega el legado) y aun así `rutaAOperacion` produce `ml.missed_feeds` con `topic:'items'`; la construcción en el legado (`test/gatewayCanal.test.js:70`) sigue exigiendo `site_id` para `items` y no lo agrega para otros tópicos (agregar la aserción negativa que falta si no existe).
- [ ] Test: `MISSED_FEEDS_MS × 90 < 2 días` (la ronda deja margen de sobra sobre la retención documentada).
- [ ] **Reintento por cupo (D6):** en `enumerarMissedFeeds`, un `ErrorCupoSombraAgotado` en una página espera `min(retryAfter, 60) s` (`esperar` inyectable) y reintenta esa página **una sola vez**; si vuelve a chocar, el tópico queda con `error: CUPO_SOMBRA_AGOTADO` como hoy y los demás siguen. Tests con transporte falso: choca una vez y luego responde ⇒ cobertura sin error; choca dos veces ⇒ error registrado y el siguiente tópico se enumera igual. (Hoy el catch de `missed-feeds.ts` convierte el error en `c.error` sin reintento.)

**Criterios de aceptación:** el único cambio de comportamiento es el reintento por cupo; el comentario cita la doc (2 días; 8 intentos/1 h); tests verdes. Si al verificar aparece que `ML_SITE_ID` falta en el entorno del legado, se **reporta a opt-c1** (no se toca `.env`).

---

### Tarea 10: Cierre de la entrega

- [ ] Suite completa de `plataforma/` (sólo cuando opt-c1 lo pida y con nada más corriendo) y `npm run typecheck`; pruebas del legado afectadas (`test/gatewayCanal.test.js`) sólo si se tocó algo allí (no se prevé).
- [ ] Revisión con Codex sobre el diff completo y respuesta a cada hallazgo; auditoría de opt-c1.
- [ ] Actualizar `docs/superpowers/INDEX.md` **sólo si opt-c1 lo pide** (hay cambios ajenos sin commitear en ese archivo).

---

## Criterio de aceptación global (espejo de la Tarea 0)

Medido sobre las 24 h posteriores al despliegue, con consultas de sólo lectura que corre opt-c1/José (no el worker de desarrollo):

1. **Cada una de las 6 corrientes ML** (`ml.orders`, `ml.shipments`, `ml.questions`, `ml.messages`, `ml.claims`, `ml.items`) tiene **≥ 1 corrida `succeeded` en 24 h**: `SELECT topic, count(*) FILTER (WHERE status='succeeded' AND finished_at > now() - interval '24 hours') FROM integrations.sweep_runs WHERE topic LIKE 'ml.%' GROUP BY 1`. `ml.items` es `full_scan` diario (`interval_seconds` 86400): su primera corrida posterior al despliegue puede caer hasta 24 h después; si opt-c1/José quieren cerrar antes, adelantar `next_run_at` es una escritura en producción que decide José, no este plan.
2. **El backlog no crece:** (a) corridas `pending`/`retryable` por tópico ≤ 1 (lo impone el índice único) y con `now() − scheduled_for` menor que 2 intervalos del tópico; (b) señales pendientes/reintentables por tópico (`reconciliation_signals`) muestreadas cada hora no crecen a lo largo de las 24 h; (c) `deferred_since` de ninguna corrida supera 30 min.
3. **`missed_feeds` deja de sufrir cupo:** en el log `missed_feeds enumerado` de las 24 h no hay 3 rondas consecutivas con `error: CUPO_SOMBRA_AGOTADO` en `shipments` ni `messages` (hoy: casi todas).
4. **Sin `failed` por cupo:** 0 corridas nuevas `failed` con `error_detail` `CUPO_SOMBRA_AGOTADO` ni `HTTP_429` en las tres corrientes.
5. **Logs de la Tarea 8** presentes y suficientes para juzgar 1–4 sin PII.

## Despliegue y reversa

Nada de esto se ejecuta sin la autorización de José pasando por opt-c1.

1. **Compuerta previa:** suite verde, auditoría de opt-c1 y auditoría con Codex (regla vigente de deploy de Recepción/E1).
2. **Migración 0032 aplicada por José** (`npm run migrar` con el usuario migrador) **antes** de reemplazar el worker. Es aditiva (columnas nulables + tabla nueva): el worker viejo sigue funcionando con ella (ignora `position`), así que migrar primero es seguro. **Ojo (R1):** el migrador aplica *todas* las pendientes en orden y exige numeración contigua: aplicará también 0025, 0026 y 0027 (E3, con sus flags en 0). El migrador NO compara con el orden de lo aplicado: itera los archivos en orden y aplica los que no están en `core.schema_migrations` (verifica el sha256 de los ya aplicados y falla si una aplicada desapareció del directorio). Consecuencias: (i) con 0001–0032 presentes y prod en 0024, aplica **0025–0031 y 0032 juntas**, no sólo la nuestra (es decisión de José, que opt-c1 le presenta); (ii) un archivo de número menor que aparezca después de haberse aplicado uno mayor **se aplica sin quejas** (no hay chequeo de orden), y (iii) el directorio con 0032 pero sin 0028–0031 se rechaza por hueco; por eso el worker no puede construirse desde una rama que tenga 0032 y no tenga 0028–0031. Además 0028–0031 de la rama E3 quedan aplicadas con el mismo comando. José debe saberlo y aceptarlo, o esas se aplican antes por separado. Efectos reales (leídos del SQL, no hay flags en SQL; los flags `E3_*` están en la config del código): 0025 reemplaza el CHECK de `identity_decisions` que hoy prohíbe `auto_sku`+`aplicar` (sólo cambia qué se permite insertar), 0026 crea `catalog.e3_canario_corridas` y `e3_canario_casos`, 0027 reemplaza `identity_cases_tipo_check` (amplía los tipos permitidos) y crea `catalog.identity_commands` con su índice único.
3. **Sólo la imagen del worker.** No se reconstruyen `api` ni el legado. `fusion-plataforma:local` es compartido entre contenedores: **antes de reconstruir, taggear la imagen que usa cada contenedor** (`docker tag <imagen-actual-del-worker> fusion-plataforma:rollback-worker-<fecha>`, y lo mismo para cualquier otro contenedor que la use) y **verificar con `docker image inspect`** que cada tag resuelve al mismo ID que el contenedor en ejecución (`docker inspect --format '{{.Image}}'`).
4. **Construir desde un worktree limpio** del commit final (`git worktree add`), no desde este árbol de trabajo (tiene cambios ajenos sin commitear); verificar el hash del commit dentro de la imagen.
5. Reemplazar el contenedor `worker` únicamente. Observar los logs de la Tarea 8 durante la primera vuelta de `ml.shipments` (≈ 20 min) y confirmar el ritmo (≤ 11 llamadas/min) y que `missed_feeds` deja de dar cupo agotado en la siguiente ronda.
6. **Reversa:** `docker tag` del tag de rollback de vuelta a `fusion-plataforma:local` y recrear sólo el worker. Las columnas y la tabla nuevas quedan (inertes para el código viejo); las corridas en curso con `position` se reinician desde la página 1 con el código viejo (comportamiento actual). No hace falta revertir la migración.
7. `.env`: **sin cambios** en este plan (las reservas viven en `ritmo.ts`).

## Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | El migrador aplica 0025–0027 junto con 0032 (numeración contigua, sin aplicar por número). Esas tres tocan `catalog`: dos reemplazos de CHECK (`identity_decisions`, `identity_cases`) y tablas nuevas de canario/comandos. | Avisar a José con los efectos reales (ver Despliegue, paso 2); revisar los tres SQL antes de migrar; backup habitual; el código E3 no los usa con los flags `E3_*` en 0. |
| R2 | La vida real del scroll de ML no está precisada (¿desde la creación o desde el último uso?). | Se asume la peor (creación) con tope de 240 s; si ML lo vence antes, hay reinicios con tope de 3 y evento `scroll reiniciado` en logs. |
| R3 | La demanda de señales por minuto supera la reserva (4/3 rpm). | Las señales se difieren sin consumir intento; el dato se mide (pregunta 1) y las constantes son un solo archivo. |
| R4 | Las constantes de reserva (`ritmo.ts`) se desincronizan de `GATEWAY_ML_SHADOW_RPM_*` (`.env` del legado) si José cambia un cupo. | Comentario y test de consistencia interna; a futuro el gateway podría devolver el cupo restante en un header. |
| R5 | Enumeración truncada del scan da bajas masivas. | La corrida sólo cierra si (b) consume toda la lista; guarda del 50 % en (a)→(b); las bajas ya son sólo sombra. |
| R6 | Cobertura de mensajes: se pierden los ya leídos o salientes (D4). | Evaluado arriba; cubierto por notificaciones + `missed_feeds` (2 días); pasada semanal opcional fuera de este plan. |
| R7 | Más concurrencia en el worker (corridas paralelas entre corrientes) y más conexiones de pool. | Un solo worker; una corrida activa por corriente; se mide el máximo simultáneo en la Tarea 4. |
| R8 | El ritmador es por proceso (compartido entre cuentas de la corriente): dos workers duplicarían el ritmo. | Hoy hay uno; documentado en `ritmo.ts`; para más de uno haría falta ritmo en el gateway. |
| R9 | Reset de `attempts` (D2b) esconde una corrida que falla y avanza de a una página. | Cada avance confirma datos reales; el tope de 30 min sin progreso y los eventos `diferido por cupo` la hacen visible. |
| R10 | Tabla de trabajo huérfana si una corrida termina fuera de los caminos que purgan. | `ON DELETE CASCADE` + purga de respaldo periódica; test de purga. |
| R11 | Un `ErrorPaginaInvalida` persistente en una página congela la corrida en esa posición hasta agotar intentos. | Igual que hoy (reintenta la misma ventana); ahora además queda `position` y `pages_done` para diagnosticar. |

## Decisiones de opt-c1 (2026-09-30)

1. Demanda de señales medida en 48 h: items 2626 (~0,9/min), shipments 300 (~0,1/min), messages 16, orders 104; con 2–3 llamadas por señal las reservas 4/4/3 alcanzan con margen: **ratificadas**.
2. D2b aprobado, más el tope de edad de 6 h (`EDAD_MAXIMA`).
3. Se elimina la compuerta de 6 h y la enumeración de 30 días; la pérdida de cobertura descrita queda aceptada.
4. La guarda del 50 % se mantiene.
5. `ml.items` espera su `full_scan` natural; **no se toca `next_run_at`**.
6. Migración: número **0032** (0028–0031 pertenecen a `fix/e3c3-segunda-opinion`).
