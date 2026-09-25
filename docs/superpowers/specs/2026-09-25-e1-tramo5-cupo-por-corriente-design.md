# E1 tramo 5 — Cupo sombra de ML por corriente

**Estado:** diseño (PM-188, decisión de José 2026-09-25). **Entrega:** E1. **Reglas:** todo lo que toque ML sigue `specs/ml-api-guia.md`. **Revisión Codex:** primera pasada con 2 críticos/5 altos/2 medios/1 bajo (`/root/.claude/jobs/6c6b3b28/tmp/codex-rev-t5-informe.md`); esta versión los corrige uno por uno (ver §6).

## 1. Problema

`crearPresupuestoShadow` (`lib/gatewayCanal.js`) es un único bucket por minuto de `GATEWAY_ML_SHADOW_RPM=30`
compartido por las 6 corrientes ML de la sombra. `ml.shipments` (1 GET por envío abierto) y `ml.messages`
(1 + 1 por pack) lo vacían solos: 0 barridos OK en 24 h y señales de `ml.items` en dead letter con
`retryable: HTTP_429`. Además, el 429 sintético es indistinguible de un 429 real de ML (guía §4). Con esto
la campaña de 7 días verdes (PM-186) no puede salir nunca.

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
para `ml.missed_feeds` resuelve la corriente con `params.topic` (mismo mapeo que `TOPICOS_MISSED` en
`gatewayCanal.js`), para el resto con una tabla estática operación→corriente. Una operación ML sin corriente
asignable (ni por tabla ni por `topic`) es un error de programación: falla el test que recorre `OPERACIONES`.

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
- **Tope por edad, para no ciclar indefinidamente:** si la corrida/señal lleva diferida más de
  `CUPO_SOMBRA_DIFERIDO_MAX_MIN` (config, default 30 min) sin lograr ejecutar, la siguiente vez que choque
  con `ErrorCupoSombraAgotado` cae a la ruta normal de `fallarCorrida`/`dead_lettered` **con el código
  `CUPO_SOMBRA_AGOTADO`** (para diferenciarlo en observabilidad de un `HTTP_429` real), consumiendo intento
  como cualquier otro fallo. Esto evita inanición: una corrida que nunca consigue cupo termina fallando
  visiblemente en vez de reintentar para siempre.
- Métrica nueva en observabilidad (`sombra.ts:50-77`, que hoy cuenta `r429` con `LIKE '%HTTP_429%'`):
  contar `CUPO_SOMBRA_AGOTADO` por separado de `HTTP_429`, tanto en diferimientos (esperado, no alarma) como
  en los que agotaron el tope de edad (si esto ocurre con frecuencia, el reparto de §2.5 está mal calibrado
  y hay que revisarlo, no subir el tope).

### 2.5 Efecto sobre PM-186 (corrige el hallazgo crítico 2)

No se introduce una categoría nueva de día en el reporte. `plataforma/src/informes/reporte.ts:97-134` ya
resuelve esto con las reglas existentes: un tópico sin barrido OK en el día queda con convergencia `null` →
el día es amarillo; cobertura `<1` → amarillo. Una corriente que se diferió toda la ventana del día y no
llegó a completar su barrido cae en uno de esos dos casos por construcción — no hace falta lógica nueva de
reporte, sólo declararlo: **un diferimiento que impide completar la cobertura o convergencia de una corriente
en el día hace ese día amarillo y no cuenta para los 7 días verdes de PM-186**, igual que cualquier otro
motivo de cobertura incompleta hoy. Un diferimiento que sí llega a completarse dentro de la ventana del día
(la corrida se reprogramó y terminó a tiempo) no distingue el día de uno sin diferimientos.

### 2.6 Relación con el presupuesto legado (corrige el hallazgo alto 7 — el "alto 7" original de Codex es incorrecto, según verificación de código)

`ejecutarMl` del gateway (inyectado en `server.js:256`) usa `mlFetch` del legado, que pasa por
`reservarCupo` de `lib/mlRateLimiter.js` (`lib/mlClient.js:13`) igual que cualquier llamada legado. Es decir:
**la sombra ya consume del mismo presupuesto por cuenta que el legado** (lectura 500 rpm y global 1500 rpm,
ambos ×0.85 de margen, `lib/mlLimites.js:49-79`) — no son buckets independientes sin relación, como decía la
primera revisión. Los RPM de la sombra (60 global, repartidos por corriente en §2.7) son un **subtecho**
dentro de ese presupuesto compartido, no una asignación adicional. La spec documenta esto explícitamente en
vez de proponer coordinación nueva: no hace falta reservar capacidad aparte para el legado porque ambos ya
comparten el mismo limitador de fondo; el riesgo real es que el legado, en un pico propio, consuma tanto que
dentro del presupuesto compartido no quede margen para los 60 rpm de la sombra — en ese caso el legado gana
(su código ya está en producción) y la sombra ve más `HTTP_429` reales de `mlRateLimiter`, correctamente
distinguidos de `CUPO_SOMBRA_AGOTADO` por no traer `x-fusion-cupo`.

### 2.7 Reparto inicial y evidencia de capacidad (corrige el hallazgo alto 6)

No hay en este momento una medición de volúmenes reales de producción disponible para esta spec: leer
`sweep_runs`/`reconciliation_signals` de PostgreSQL de producción requiere permisos que este agente no tiene
(clasificador lo denegó en la sesión que preparó esta corrección); esa consulta la corre José con `!` cuando
quiera calibrar el reparto. Por eso el tramo se divide en dos pasos, no uno solo:

- **Tarea 0 — medición** (antes de fijar el reparto final): con el cupo por corriente ya desplegado pero con
  valores conservadores (ver reparto provisional abajo), correr 24–48 h y registrar en `evidence/e1/` por
  corriente: llamadas permitidas/min, llamadas diferidas/min, tamaño de la corrida más grande atendida y
  cuánto tardó en completarse dentro de su `interval_seconds`. El criterio de aceptación de la tarea 0 no es
  un número fijo: es que **cada corriente complete su barrido dentro de su propio `interval_seconds`** sin
  backlog creciente (la cola de esa corriente no queda más larga al final del período que al principio).
- **Reparto inicial provisional** (arranca conservador, no es el reparto final): sobre el techo global actual
  de 60 rpm (el documentado el 2026-09-17): orders 10, shipments 15, items 15, questions 5, messages 10,
  claims 5. Se ajusta con la medición de la tarea 0 y el OK de José — no antes.
- El techo global nunca supera lo que el legado deja libre del presupuesto compartido (§2.6); si la
  medición muestra que 60 rpm de sombra generan `HTTP_429` reales frecuentes (no `CUPO_SOMBRA_AGOTADO`), el
  techo baja, no el reparto entre corrientes.

### 2.8 Otros consumidores del mismo transporte (corrige el hallazgo medio 9)

`bootstrap.ts:77-84` (`/items/search`, `/items/bulk`) y `identidad/relectura-auto-sku.ts` (E3) usan el mismo
`ejecutarMl`/gateway que los barridos de E1, y por lo tanto el mismo cupo por corriente de `items`. Durante
la campaña de 7 días verdes (PM-186), **bootstrap y la relectura de E3 comparten el bucket `items` sin
prioridad especial** — no quedan prohibidos ni tienen bucket propio en este tramo: son tráfico adicional
dentro del mismo cupo, y si consumen lo suficiente para que `ml.items.scan`/`multiget` no complete su
barrido en la ventana, eso es exactamente el caso que la tarea 0 (§2.7) tiene que detectar (backlog
creciente en `items`). Las métricas de §2.2 incluyen qué operación generó cada consumo, así que un consumo
alto de bootstrap/E3 es visible y distinguible del propio barrido de E1 sin trabajo adicional. Si la tarea 0
muestra que esto bloquea la campaña, la decisión de excluir o priorizar bootstrap/E3 queda para José, no
implícita en esta spec.

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
- Tarea 0 (§2.7) completada con evidencia en `evidence/e1/` antes de fijar el reparto final.
- En producción, 24 h con las 6 corrientes con al menos un barrido OK, backlog no creciente por corriente, y
  **cero** casos de `CUPO_SOMBRA_AGOTADO` que hayan agotado el tope de edad (2.4) — diferimientos que sí se
  resuelven dentro de su ventana no cuentan como falla.
- Rollback: quitar las variables por corriente y volver al build anterior del legado; el techo global sigue
  funcionando igual que hoy (sin distinción de corriente, un solo bucket).
- Despliegue de T5 = día 0 de la campaña de 7 días verdes (PM-186); un día amarillo por diferimiento
  incompleto (§2.5) reinicia el contador de 7 días, igual que cualquier otro motivo de día amarillo.

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

| # | Hallazgo (informe original) | Sección de esta corrección |
|---|---|---|
| Crítico 1 | Reintento sin consumir intentos no implementado | §2.4 |
| Crítico 2 | Efecto de "diferido" sobre PM-186 sin definir | §2.5 |
| Alto 3 | `ml.missed_feeds` mal asignado sólo a `orders` | §2.1 |
| Alto 4 | Firma del gateway no soporta reparto por corriente | §2.2 |
| Alto 5 | 429 sintético y real siguen confluyendo | §2.3 |
| Alto 6 | Reparto sin volúmenes ni garantía de terminación | §2.7 |
| Alto 7 | Techo global no coordinado con el legado | §2.6 (verificado: ya comparten presupuesto de fondo; no hacía falta coordinación nueva, sólo documentarlo) |
| Medio 8 | "Sin variable = cerrada" sin validación de arranque | §2.1 (párrafo de validación) |
| Medio 9 | Consumidores fuera del barrido (bootstrap, E3) sin modelar | §2.8 |
| Bajo 10 | Integración documental incompleta (ficha, programa, crosswalk) | §5 |
