# E1 tramo 5 — Cupo sombra de ML por corriente

**Estado:** diseño (PM-188, decisión de José 2026-09-25). **Entrega:** E1. **Reglas:** todo lo que toque ML sigue `specs/ml-api-guia.md`. **Revisión Codex:** 1ª pasada, 2 críticos/5 altos/2 medios/1 bajo (`/root/.claude/jobs/6c6b3b28/tmp/codex-rev-t5-informe.md`); 2ª pasada, 1 crítico/3 altos/2 medios/1 bajo (`.../e656f951/tmp/codex-rev-t5-informe-v2.md`); 3ª pasada, 1 crítico/1 alto/1 medio — resueltos con una aclaración de alcance (spec de diseño, no cambio de código) y un hecho de wiring corregido en `main.ts` (`.../e656f951/tmp/codex-rev-t5-informe-v3.md`). Ver §6.

## 1. Problema

`crearPresupuestoShadow` (`lib/gatewayCanal.js`) es un único bucket por minuto de `GATEWAY_ML_SHADOW_RPM=30`
compartido por las 6 corrientes ML de la sombra. `ml.shipments` (1 GET por envío abierto) y `ml.messages`
(1 + 1 por pack) lo vacían solos: 0 barridos OK en 24 h y señales de `ml.items` en dead letter con
`retryable: HTTP_429`. Además, el 429 sintético es indistinguible de un 429 real de ML (guía §4). Con esto
la campaña de 7 días verdes (PM-186) no puede salir nunca.

**Nota de alcance (aclarada tras la tercera revisión de Codex):** este documento es una **spec de diseño**,
no un cambio de código. Describe el contrato que la implementación de T5 tiene que cumplir — incluidas las
correcciones de `reporte.ts` (§2.5), el módulo único de mapeo tópico→corriente (§2.1) y la columna
`deferred_since` (§2.4) — para que las tareas de implementación no repitan los hallazgos de las revisiones de
Codex. Ninguno de esos cambios de código existe todavía en este commit; existen como requisito explícito de
la tarea de implementación, con su criterio de aceptación en tests dirigidos (§4). Una revisión que contraste
esta spec contra el código real y encuentre que el código *todavía* no tiene esos cambios no es un hallazgo
nuevo: es el estado esperado de una spec antes de implementarse. Sí son hallazgos válidos: que la spec
describa un contrato incorrecto, ambiguo, o que no coincida con el código que rodea el área a cambiar (como
el wiring real de `worker/main.ts` en §2.8, que si se documenta mal hace que la implementación arranque de
una base equivocada).

## 2. Alcance

### 2.1 Cupo por corriente

Cada operación del gateway pertenece a una corriente. `ml.missed_feeds` es la única operación que consulta
**varios** tópicos con un único parámetro `topic` (`missed-feeds.ts:21`, `gatewayCanal.js` op `ml.missed_feeds`
recibe `p.topic`): su presupuesto se deriva de ese parámetro en tiempo de llamada, **no** de una entrada fija
en la tabla.

| Corriente | Operaciones del gateway | `missed_feeds` (`topic=`) |
|---|---|---|
| `orders` | `ml.orders.search`, `ml.order` | `orders_v2` |
| `shipments` | `ml.shipment` | `shipments` |
| `items` | `ml.items.scan`, `ml.items.multiget` | `items` |
| `questions` | `ml.questions.search`, `ml.question` | `questions` |
| `messages` | `ml.messages.unread`, `ml.messages.pack` | `messages` |
| `claims` | `ml.claims.search`, `ml.claim` | `claims` |

Regla de asignación: `presupuestoMl.reservar(op, params, ahora)` recibe la operación **y** sus parámetros;
para `ml.missed_feeds` resuelve la corriente con `params.topic`, para el resto con una tabla estática
operación→corriente. **Fuente única del mapeo de tópicos (corrige hallazgo medio 5 de la segunda revisión):**
hoy `TOPICOS_MISSED` vive en `gatewayCanal.js` y la validación de tópicos aceptados se repite en
`transporte-gateway.ts`; el mapeo tópico→corriente de esta spec (tabla de arriba) es una tercera lista. Para
no divergir, la tabla tópico→corriente se define como la única fuente y las otras dos listas (`TOPICOS_MISSED`,
la validación del transporte) se generan a partir de sus claves (`Object.keys(...)`) en vez de mantenerse por
separado; un test de igualdad entre las tres verifica que ningún tópico quede aceptado en un lado y no en
otro. Una operación ML sin corriente asignable (ni por tabla ni por `topic`) es un error de programación:
falla el test que recorre `OPERACIONES`.

Cada corriente tiene su bucket por minuto (`GATEWAY_ML_SHADOW_RPM_<CORRIENTE>`), y `GATEWAY_ML_SHADOW_RPM`
sigue como **techo global** encima de todas: una llamada sale sólo si hay lugar en su corriente **y** en el
global. Sin variable por corriente, la corriente no recibe cupo propio (cero = cerrado), igual que hoy la
sombra arranca cerrada por defecto — pero con **validación de arranque**: si el gateway sombra está
habilitado (`GATEWAY_ML_SHADOW_RPM > 0`) y falta o es inválida alguna de las 6 variables por corriente, el
arranque falla con un error explícito que nombra la corriente faltante (no un cierre silencioso). Con el
gateway deshabilitado (`GATEWAY_ML_SHADOW_RPM=0`, el default de hoy) no se exige ninguna variable por
corriente.

### 2.2 Contrato interno del gateway (nueva firma)

Hoy `presupuestoMl()` no recibe la operación (`crearGatewayCanal` en `gatewayCanal.js:152` la inyecta sin
parámetros) y `crearPresupuestoShadow(rpm)` mantiene un único bucket (`gatewayCanal.js:136-145`). Cambia a:

- `crearPresupuestoShadow(configuracionPorCorriente, rpmGlobal, ahora)` devuelve un objeto con
  `reservar(op, params, ahora)` que:
  1. resuelve la corriente de `op`/`params.topic` (§2.1);
  2. intenta consumir 1 del bucket de esa corriente **y** del bucket global (orden: corriente primero,
     para no descontar el global si la corriente ya está cerrada);
  3. si ambos tienen lugar, devuelve `{ ok: true }`;
  4. si no, devuelve `{ ok: false, corriente, segundosParaRefill }` — `segundosParaRefill` es el resto real
     hasta el próximo minuto del bucket que bloqueó (no un valor fijo).
- `crearGatewayCanal` pasa `op` y `params` a `presupuestoMl.reservar(...)` en el punto donde hoy sólo llama
  `presupuestoMl()` sin argumentos.
- El rechazo (hoy `{status:429, headers:{'retry-after':'60'}, body:null}` fijo en `gatewayCanal.js:161`) pasa
  a `{status:429, headers:{'retry-after':String(segundosParaRefill), 'x-fusion-cupo':'sombra-agotado'}, body:null}`.
  `HEADERS_DEVUELTOS` (`gatewayCanal.js:128`) agrega `'x-fusion-cupo'` a la lista blanca que se reenvía.
- `metricas` (ya inyectable en `crearGatewayCanal`) registra por llamada: `corriente`, `permitida: boolean`,
  y en denegadas el `segundosParaRefill`. Antes/después de cada minuto se puede derivar permitidas/diferidas
  por corriente sin tabla nueva.

### 2.3 Distinción 429 sintético vs. 429 real en la plataforma

El transporte de la plataforma mapea **todo** 429 a `ErrorBarridoReintentable("HTTP_429 ...")`
(`transporte-gateway.ts:180-183`, y lo mismo hace `relectura.ts:60` para bulk). Cambia a: antes del mapeo
genérico, si `status === 429 && headers['x-fusion-cupo'] === 'sombra-agotado'`, se construye un error
`ErrorCupoSombraAgotado` (nueva clase, mismo módulo que `ErrorBarridoReintentable`) con el `retry-after`
recibido. Un 429 sin ese header sigue siendo `HTTP_429` (429 real de ML o de un tercero, sin cambios).

### 2.4 Reintento sin consumir intentos (corrige el hallazgo crítico 1)

`ErrorCupoSombraAgotado` **no** llega a `fallarCorrida` (que sólo entiende `retryable`/`failed` según
`attempts < maxAttempts`, `corridas.ts:143-155`; no existe ni se crea un estado `diferido` en
`integrations.sweep_runs` — el `CHECK` de `0003_reconciliacion.sql:64` no cambia). En cambio:

- **Corridas (`sweep_runs`):** nueva función hermana de `soltarCorridaPorApagado`
  (`corridas.ts:161`, que ya hace `attempts=greatest(attempts-1,0)`), p. ej.
  `diferirCorridaPorCupo(pool, corrida, segundosParaRefill)`: dispara sólo con `ErrorCupoSombraAgotado`,
  deja `status='pending'`, `attempts=greatest(attempts-1,0)` (intento devuelto, no consumido) y
  `available_at=now()+segundosParaRefill` (en vez de "próximo minuto" fijo, usa el valor real recibido).
- **Señales (`reconciliation_signals`):** mismo patrón sobre la función que hoy manda a `dead_lettered` en
  `senales-cola.ts:73`: con `ErrorCupoSombraAgotado` el estado vuelve a `'retryable'` (no `dead_lettered`),
  intento devuelto, `available_at` = el mismo cálculo.
- **Tope por edad, para no ciclar indefinidamente (base temporal precisada tras la segunda revisión — alto 4):**
  ambas tablas necesitan una columna nueva `deferred_since timestamptz` (nulable; se fija la **primera** vez
  que la corrida/señal choca con `ErrorCupoSombraAgotado` y no se vuelve a tocar en diferimientos
  posteriores de la misma corrida/señal — así una corrida reprogramada varias veces no "reinicia" su
  reloj). Si `now() - deferred_since > CUPO_SOMBRA_DIFERIDO_MAX_MIN` (config, default 30 min) en un nuevo
  choque con `ErrorCupoSombraAgotado`, cae a la ruta normal de `fallarCorrida`/`dead_lettered` **con el
  código `CUPO_SOMBRA_AGOTADO`** (para diferenciarlo en observabilidad de un `HTTP_429` real), consumiendo
  intento como cualquier otro fallo, y `deferred_since` se limpia. Si la corrida sale del diferimiento por
  éxito antes del tope, `deferred_since` también se limpia. Esto evita inanición: una corrida que nunca
  consigue cupo termina fallando visiblemente en vez de reintentar para siempre. Tests exigidos en §4:
  29/30/31 minutos alrededor del tope, y una corrida reprogramada dos veces que no reinicia el reloj.
- Métrica nueva en observabilidad (`sombra.ts:50-77`, que hoy cuenta `r429` con `LIKE '%HTTP_429%'`):
  contar `CUPO_SOMBRA_AGOTADO` por separado de `HTTP_429`, tanto en diferimientos (esperado, no alarma) como
  en los que agotaron el tope de edad (si esto ocurre con frecuencia, el reparto de §2.5 está mal calibrado
  y hay que revisarlo, no subir el tope).

### 2.5 Efecto sobre PM-186 (corrige el hallazgo crítico 2; corrección adicional tras la segunda revisión — crítico 1 de esa pasada)

**El razonamiento original de esta sección era incompleto y quedó corregido tras verificar `reporte.ts` en
detalle.** `plataforma/src/informes/reporte.ts:102-108` consulta `sweep_runs` filtrando **sólo**
`status = 'succeeded'` para calcular cobertura/convergencia de un tópico, y si hay varios `succeeded` en el
día toma el peor (`Math.min`). El problema: una corrida que quedó `pending`/`retryable` por diferimiento (o
que agotó el tope de edad y terminó `failed`) **no aparece en esa consulta en absoluto** — no sólo no cuenta
como éxito, directamente no se mira. Si esa misma corriente tuvo un `succeeded` anterior en el día con
cobertura/convergencia 100 %, el reporte queda con esa foto vieja y puede marcar el día verde aunque la
corrida más reciente nunca haya llegado a ejecutarse. Esto sí requiere un cambio de código, no sólo una
declaración:

- `reporte.ts` debe considerar, por tópico y por día, si hubo alguna corrida `pending`/`retryable`/`failed`
  (por cualquier motivo, incluido `CUPO_SOMBRA_AGOTADO`) cuya `scheduled_for`/ventana esperada haya vencido
  sin una `succeeded` posterior que la cubra — no basta con mirar la última `succeeded`. Concretamente:
  agregar a la consulta de cobertura/convergencia una comprobación de que el número de `succeeded` en la
  ventana coincide con el número de corridas **esperadas** según `interval_seconds` de esa corriente
  (`reconciliation_cursors`), y si faltan, tratar el tópico como sin convergencia declarada (mismo camino que
  hoy usa "tópico sin barrido en el día", `reporte.ts:117-120`), igual que si nunca se hubiera barrido.
- Con ese cambio: **un diferimiento que impide completar la cantidad de barridos esperada de una corriente en
  el día hace ese día amarillo y no cuenta para los 7 días verdes de PM-186**, aunque haya habido un
  `succeeded` anterior en el mismo día. Un diferimiento que sí se resuelve a tiempo (la corrida reprogramada
  ejecuta y cuenta como una más de las esperadas) no distingue el día de uno sin diferimientos.
- Test nuevo exigido en §4: un tópico con un `succeeded` de cobertura 100 % seguido de un diferimiento que no
  llega a resolverse en el día debe dar día amarillo, no verde.

### 2.6 Relación con el presupuesto legado (corrige el hallazgo alto 7; matizado tras la segunda revisión — ver alto 3 de esa pasada)

`ejecutarMl` del gateway (inyectado en `server.js:256`) usa `mlFetch` del legado, que pasa por
`reservarCupo` de `lib/mlRateLimiter.js` (`lib/mlClient.js:13`) igual que cualquier llamada legado. Es decir:
**la sombra ya consume del mismo presupuesto por cuenta que el legado** (lectura 500 rpm y global 1500 rpm,
ambos ×0.85 de margen, `lib/mlLimites.js:49-79`) — no son buckets independientes sin relación, como decía la
primera revisión. Los RPM de la sombra (60 global, repartidos por corriente en §2.7) son un **subtecho**
dentro de ese presupuesto compartido, no una asignación adicional.

**Matiz importante (segunda revisión):** que compartan el mismo limitador de fondo no significa que la
convivencia esté garantizada — sigue sin haber una reserva explícita para la sombra ni una consulta de
capacidad libre antes de cada llamada. El límite es un **subtecho conservador, no una garantía**: si el
legado tiene un pico propio de tráfico, puede consumir la mayor parte del presupuesto compartido y dejar
poco o nada para los 60 rpm de la sombra, generando `HTTP_429` reales frecuentes durante ese pico (no
`CUPO_SOMBRA_AGOTADO`, que sólo ocurre por el bucket propio de la sombra). Esto no se previene con este
diseño, sólo se detecta después vía la medición de §2.7 y la observabilidad de §2.4. Implementar coordinación
activa (consulta de capacidad libre en tiempo real) queda fuera de alcance de este tramo (§3) — la aceptación
de §4 agrega una métrica de impacto sobre el legado (429 reales, latencia) para poder ver si el subtecho
resultó insuficiente en la práctica, sin bloquear el tramo a resolver la coordinación activa primero.

### 2.7 Reparto inicial y evidencia de capacidad (corrige el hallazgo alto 6)

No hay en este momento una medición de volúmenes reales de producción disponible para esta spec: leer
`sweep_runs`/`reconciliation_signals` de PostgreSQL de producción requiere permisos que este agente no tiene
(clasificador lo denegó en la sesión que preparó esta corrección); esa consulta la corre José con `!` cuando
quiera calibrar el reparto. Por eso el tramo se divide en dos pasos, no uno solo:

- **Tarea 0 — medición, gate obligatorio antes del día 0 de PM-186 (endurecido tras la segunda revisión —
  medio 6):** con el cupo por corriente ya desplegado pero con valores conservadores (ver reparto provisional
  abajo), correr 24–48 h y registrar en `evidence/e1/` por corriente: llamadas permitidas/min, llamadas
  diferidas/min, tamaño de la corrida más grande atendida y cuánto tardó en completarse dentro de su
  `interval_seconds`. **La campaña de 7 días verdes de PM-186 no arranca (no cuenta día 0) hasta que la
  tarea 0 tenga evidencia registrada y el criterio se cumpla** — no es una medición informativa en paralelo,
  es un gate previo. El criterio de aceptación de la tarea 0 no es un número fijo: es que **cada corriente
  complete su barrido dentro de su propio `interval_seconds`** sin backlog creciente (la cola de esa corriente
  no queda más larga al final del período que al principio).
- **Reparto inicial provisional** (arranca conservador, no es el reparto final): sobre el techo global actual
  de 60 rpm (el documentado el 2026-09-17): orders 10, shipments 15, items 15, questions 5, messages 10,
  claims 5. Se ajusta con la medición de la tarea 0 y el OK de José — no antes.
- El techo global nunca supera lo que el legado deja libre del presupuesto compartido (§2.6); si la
  medición muestra que 60 rpm de sombra generan `HTTP_429` reales frecuentes (no `CUPO_SOMBRA_AGOTADO`), el
  techo baja, no el reparto entre corrientes.

### 2.8 Otros consumidores del mismo transporte (corrige el hallazgo medio 9; hecho verificado y corregido de nuevo en la tercera revisión — la versión de la segunda revisión ya estaba desactualizada frente al wiring real)

**Hecho verificado en código (tercera revisión, `worker/main.ts:52-66`):** por cada cuenta configurada en el
registro de barridos, `main.ts` crea **un** `transporte` (`crearTransporteGateway` si `cuenta.transporte ===
'gateway'`, o un cliente directo si no) y ese mismo objeto se pasa a los adaptadores de barrido
(`crearAdaptadoresMl`/`Woo`), a los relectores por señal (`crearRelectoresMl`/`Woo`, `main.ts:60`) **y** a
`cuentasBootstrap` (`main.ts:61-63`). No hay tres transportes por cuenta, hay uno solo. `crearTransporteGateway`
es el cliente de plataforma para `lib/gatewayCanal.js` del legado (`transporte-gateway.ts:9-16`).

**Consecuencia directa, sin decisión pendiente:** para toda cuenta cuyo `transporte` esté configurado como
`'gateway'`, **bootstrap y la relectura de E3 SÍ comparten el gateway sombra y por lo tanto el cupo por
corriente de `items` de este tramo** con los barridos de E1 — no es una posibilidad a decidir en el futuro,
es el comportamiento actual del wiring para esa cuenta. Para una cuenta con `transporte` distinto de
`'gateway'` (cliente directo), ninguno de los tres pasa por el gateway sombra ni por su cupo.

Durante la campaña de 7 días verdes (PM-186), esto significa que bootstrap y la relectura de E3 son tráfico
adicional real sobre el bucket `items`, sin prioridad especial y sin bucket propio en este tramo — la tarea 0
(§2.7) tiene que medir el consumo de `items` **con bootstrap y relectura corriendo**, no sólo con los
barridos de E1, porque ambos consumen del mismo cupo hoy. Las métricas de §2.2 (operación → corriente por
llamada) ya distinguen qué operación generó cada consumo, así que un consumo alto de bootstrap/E3 es visible
sin trabajo adicional. ~~Si la tarea 0 muestra que esto bloquea la campaña, excluir bootstrap/E3 [...] queda para José.~~

**Decisión de José (2026-09-25, opción b): E2/E3 no comparten cupo con E1; se separan en este tramo, antes de la
campaña.** Coherente con PM-187 (E2/E3 no deben afectar a E1). Contrato:

- **Consumidor explícito en la petición al gateway.** La petición pasa de `{op, params}` a
  `{op, params, consumidor?}` con `consumidor ∈ {'e1', 'catalogo', 'identidad'}`; ausente = `'e1'`
  (compatibilidad). `construirOperacion` lo valida con la misma lista cerrada; cualquier otro valor es
  `ErrorOperacionInvalida`.
- **Quién es quién** (el wiring de `main.ts` fija el consumidor por instancia de transporte, no el llamador):
  barridos de E1, relectores por señal C6 (`crearRelectoresMl/Woo`, `main.ts:60`; son E1, no E3) y
  `missed_feeds` → `'e1'`; bootstrap del catálogo (`cuentasBootstrap`, E2) → `'catalogo'`; relectura del
  auto-SKU de E3 (`identidad/relectura-auto-sku.ts`, cuando se wiree) → `'identidad'`. En `main.ts` se crea
  un transporte por (cuenta, consumidor) con el mismo cliente HTTP subyacente.
- **Buckets:** `'e1'` usa los cupos por corriente de §2.1; `'catalogo'` e `'identidad'` comparten un bucket
  único propio `GATEWAY_ML_SHADOW_RPM_E2E3` (default 0 = cerrado; misma validación de arranque de §2.3).
  Todos siguen bajo el techo global `GATEWAY_ML_SHADOW_RPM`, que **reserva** la suma de los cupos de E1: el
  bucket E2/E3 sólo toma lo que sobra del global, nunca el cupo de una corriente de E1.
- **Métricas y reporte:** cada llamada se registra con (consumidor, corriente); el reporte de la campaña
  cuenta sólo `'e1'`, y un 429 sintético de `'catalogo'`/`'identidad'` no afecta cobertura ni convergencia
  de E1.
- **Tarea 0 (§2.7):** mide los tres consumidores por separado, con bootstrap y relectura activos.
- **Tests:** agotar `'catalogo'` no reduce el cupo de ninguna corriente de E1; consumidor inválido rechazado;
  petición sin consumidor se trata como `'e1'`.

## 3. Fuera de alcance (backlog, guía §7)

- Shipments y messages por evento con reconciliación horaria (punto 2).
- Lectura única compartida legado↔plataforma (punto 4, territorio de E9).
- Coordinación activa (no sólo documental) entre el limiter legado y el gateway sombra — hoy comparten
  presupuesto de hecho (§2.6) pero ninguno consulta al otro su capacidad libre en tiempo real.

## 4. Aceptación del tramo

- Tests dirigidos: buckets independientes por corriente (vaciar `shipments` no afecta a `items`), techo
  global, derivación de corriente desde `missed_feeds.topic`, header `x-fusion-cupo` y `retry-after` real
  (no fijo), mapeo a `ErrorCupoSombraAgotado` sin consumir intento (ni en `sweep_runs` ni en
  `reconciliation_signals`), tope de edad que sí consume intento y usa el código `CUPO_SOMBRA_AGOTADO`,
  validación de arranque con variable de corriente faltante y gateway habilitado, cobertura de la tabla de
  corrientes incluyendo el caso `missed_feeds`.
- Tarea 0 (§2.7) completada con evidencia en `evidence/e1/` antes de fijar el reparto final — **gate
  obligatorio**, no informativo (§2.7).
- `reporte.ts` corregido y con el test de §2.5 verde (día amarillo cuando faltan barridos esperados aunque
  haya un `succeeded` previo).
- En producción, 24 h con las 6 corrientes con al menos un barrido OK, backlog no creciente por corriente, y
  **cero** casos de `CUPO_SOMBRA_AGOTADO` que hayan agotado el tope de edad (§2.4) — diferimientos que sí se
  resuelven dentro de su ventana no cuentan como falla.
- Rollback: **no alcanza con quitar las variables por corriente** — con `GATEWAY_ML_SHADOW_RPM` (el techo
  global) en su valor de hoy (30) y sin las 6 variables por corriente, la validación de arranque falla y
  (implementado como fail-closed sólo de la sombra, nunca del legado) deja la sombra cerrada — todas las
  corrientes ML dan 429 sintético con `x-fusion-cupo`, no el bucket único de antes. El rollback real es
  volver al build anterior del legado (antes de este tramo), o cargar las 6 variables por corriente antes de
  reiniciar. Bajar `GATEWAY_ML_SHADOW_RPM` a 0 si desactiva la sombra por completo (sin exigir las 6
  variables) es una alternativa válida si el objetivo es sólo apagarla, no volver al comportamiento previo.
- **Secuencia de despliegue (corregida tras la segunda revisión):** T5 se despliega → corre la tarea 0 (§2.7,
  24–48 h, gate) → si cumple el criterio de capacidad, el día siguiente es el día 0 de la campaña de 7 días
  verdes (PM-186); el despliegue de T5 en sí **no** es automáticamente el día 0. Un día amarillo por
  diferimiento incompleto (§2.5) reinicia el contador de 7 días, igual que cualquier otro motivo de día
  amarillo.

## 5. Documentación e integración con el programa (corrige el hallazgo bajo 10)

- `docs/superpowers/deliveries/E1-fundacion-sombra.md`: agregar el tramo 5 (T5) a la lista de tramos de E1,
  reemplazando la frase "No queda nada por desplegar de E1" (línea 76 antes de esta corrección) por el
  estado real: T5 diseñado, pendiente de implementación y campaña.
  con la sombra funcionando y confluencia real/sintética corregida.
- `delivery-program.json`, entrada E1: agregar T5 a `next`, y actualizar `rollout`/`acceptance` con los
  criterios de §4.
- `decision-crosswalk.json`, PM-188: `consumers` pasa de `[]` a `["E1", "E2", "E3"]` — E2 y E3 dependen de
  que la campaña de 7 días verdes cierre para poder avanzar sus propios gates, y E3 además comparte
  directamente el bucket `items` (§2.8).
- Validar con `npm run docs:validate-deliveries` tras cada cambio de estos archivos.

## 6. Trazabilidad de la revisión de Codex

### Primera pasada (commit 2c3b8c8f → e915d1bd)

| # | Hallazgo (informe original) | Sección de esta corrección |
|---|---|---|
| Crítico 1 | Reintento sin consumir intentos no implementado | §2.4 |
| Crítico 2 | Efecto de "diferido" sobre PM-186 sin definir | §2.5 |
| Alto 3 | `ml.missed_feeds` mal asignado sólo a `orders` | §2.1 |
| Alto 4 | Firma del gateway no soporta reparto por corriente | §2.2 |
| Alto 5 | 429 sintético y real siguen confluyendo | §2.3 |
| Alto 6 | Reparto sin volúmenes ni garantía de terminación | §2.7 |
| Alto 7 | Techo global no coordinado con el legado | §2.6 (verificado: ya comparten presupuesto de fondo; matizado en la segunda pasada — ver abajo) |
| Medio 8 | "Sin variable = cerrada" sin validación de arranque | §2.1 (párrafo de validación) |
| Medio 9 | Consumidores fuera del barrido (bootstrap, E3) sin modelar | §2.8 (corregido de hecho en la segunda pasada — ver abajo) |
| Bajo 10 | Integración documental incompleta (ficha, programa, crosswalk) | §5 |

### Segunda pasada (sobre e915d1bd, informe en `codex-rev-t5-informe-v2.md`)

| # | Hallazgo | Sección de esta corrección |
|---|---|---|
| Crítico 1 (v2) | `reporte.ts` sólo mira `succeeded`; un diferimiento posterior a un `succeeded` del mismo día puede quedar invisible y el día salir verde igual | §2.5 (reescrita) |
| Alto 2 (v2) | §2.8 afirmaba que `bootstrap.ts` usa el mismo gateway que los barridos; el código lo contradice (`TransporteCanal` inyectado propio, sin wiring todavía) | §2.8 (reescrita como decisión pendiente, no como hecho) |
| Alto 3 (v2) | Compatibilidad con el limiter legado no garantizada, sólo compartida de hecho | §2.6 (matizada: subtecho conservador, no garantía) |
| Alto 4 (v2) | Tope de edad sin base temporal definida (desde cuándo se cuenta) | §2.4 (agrega `deferred_since` persistente) |
| Medio 5 (v2) | Mapeo tópico→corriente duplicado en 3 lugares, riesgo de divergencia | §2.1 (fuente única) |
| Medio 6 (v2) | Tarea 0 debía ser gate previo a la campaña, no medición en paralelo | §2.7 y §4 (gate obligatorio, secuencia de despliegue corregida) |
| Bajo 7 (v2) | §6 marcaba el medio 9 original como "corregido" sin serlo realmente | Esta tabla, fila Medio 9 arriba |

### Tercera pasada (sobre ef40f5c9, informe en `codex-rev-t5-informe-v3.md`)

| # | Hallazgo | Resolución |
|---|---|---|
| Crítico (v3) | §2.5 sólo documenta el fix de `reporte.ts`; el código no cambió | No es un hallazgo nuevo de diseño: `reporte.ts` se corrige como parte de la implementación de T5, no en esta spec. Aclarado en la nota de alcance al inicio del §2. |
| Alto (v3) | §2.8 (versión de la 2ª pasada) quedó desactualizada: `worker/main.ts` SÍ wirea un único `transporte` por cuenta compartido entre barridos, relectores y `cuentasBootstrap` | §2.8 reescrita con el hecho verificado: si `cuenta.transporte==='gateway'`, bootstrap y relectura de E3 comparten el cupo `items` hoy, sin decisión pendiente. |
| Medio (v3) | §2.1 declara "fuente única" pero no existe ese módulo en el código | Mismo caso que el crítico: la fuente única es un requisito de implementación de T5 (tarea concreta con test de igualdad), no un módulo ya escrito. Aclarado en la nota de alcance. |
| Decisión José (b) | Bootstrap/relectura E3 compartían cupo `items` con E1 | §2.8: consumidor explícito en la petición, bucket `GATEWAY_ML_SHADOW_RPM_E2E3` separado bajo el techo global |
