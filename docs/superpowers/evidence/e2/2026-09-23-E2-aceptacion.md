# E2 — Evidencia de aceptación (2026-09-23)

Todo lo de este documento es de sólo lectura contra la base de producción (`plataforma`, contenedor
`fusion-pg-pg-1`), con un rol Postgres nuevo `auditor_e2_readonly` (SELECT en los esquemas `catalog`, `core`,
`audit`, `integrations`; creado en esta sesión con aprobación directa de José, ver nota al final). No se escribió
nada en `catalog`/`core`/`audit`/`integrations`, no se llamó a Woo ni a ML.

Commit de la 6b desplegado en el worker de prod (23:11 UTC, según opt-62): `870357fd`, `f5cd79ba`, `fc5614ff`.
`npm run test:e2` lo corrió opt-62 (0 fallos, 104 s, 16 IDs / 27 escenarios / 428 pruebas), salida en
`/tmp/claude-0/e2-gate.log` — no se re-corrió acá, sólo se referencia.

Criterio de aceptación: sección **"Rollout, rollback y aceptación"** de
`docs/superpowers/deliveries/E2-catalogo-modelo-importacion.md`:
> Sólo lectura; comparar conteos, relaciones y hashes durante 7 días … 100 % del universo clasificado como
> importado o rechazado con causa; crosswalk íntegro y conciliación firmada.

Cuentas: Woo `01a0ad82-de15-7a79-b935-dc665538cd05`, ML `01a0b28d-18e4-733b-b53f-64d1be288253`.

---

## 1. Universo 100 % clasificado

### 1a. Recursos que vio el bootstrap (por cuenta)

```sql
SELECT ca.channel, br.topic, br.estado, br.encolados AS vistos, br.leidos, br.pagina_confirmada, br.arrancada_en, br.terminada_en
  FROM catalog.bootstrap_runs br JOIN core.channel_accounts ca ON ca.id = br.channel_account_id
 WHERE br.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
 ORDER BY ca.channel, br.topic;
```
```
   channel    |    topic     |  estado   | vistos | leidos | pagina_confirmada |         arrancada_en         |         terminada_en
--------------+--------------+-----------+--------+--------+-------------------+------------------------------+-------------------------------
 mercadolibre | ml.items     | terminada |   3064 |   4050 |                42 | 2026-09-19 23:25:00.22528+00  | 2026-09-20 03:08:35.300353+00
 woocommerce  | woo.products | terminada |   2119 |   5235 |                21 | 2026-09-19 23:25:00.13881+00  | 2026-09-20 00:27:31.607753+00
(2 rows)
```
`vistos` (columna `encolados`) cuenta encolados al inbox durante el bootstrap; `leidos` es el total de recursos
leídos del canal (coincide con lo ya registrado en la ficha de entrega: "Woo 21 páginas / 5.235 recursos; ML 42
páginas / 4.050 ítems"). Para el cierre del punto se usa el universo real visto por el inbox (recursos
DISTINCT), más abajo.

### 1b. Representaciones importadas (por cuenta)

```sql
SELECT ca.channel, count(*) AS representaciones
  FROM catalog.external_representations r JOIN core.channel_accounts ca ON ca.id = r.channel_account_id
 WHERE r.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
   channel    | representaciones
--------------+------------------
 mercadolibre |             7774
 woocommerce  |             5300
(2 rows)
```
(Una publicación de Woo con variaciones genera más de una representación por recurso: contenedor + vendible por
variación — por eso conviene comparar por `recurso` DISTINCT, no por fila. Ver 1e.)

### 1c. Rechazados con causa (DLQ, `dead_lettered`, por cuenta y motivo)

```sql
SELECT ca.channel, dl.reason_code, count(*) AS n
  FROM integrations.dead_letters dl
  JOIN integrations.inbox_messages im ON im.id = dl.source_id AND dl.source_type = 'inbox'
  JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
 GROUP BY ca.channel, dl.reason_code ORDER BY ca.channel, dl.reason_code;
```
```
   channel   |  reason_code   | n
-------------+----------------+---
 woocommerce | error_terminal | 4
(1 row)
```

Detalle (motivo textual de cada uno):
```sql
SELECT ca.channel, im.resource_id, dl.reason_code, dl.detail, dl.dead_at
  FROM integrations.dead_letters dl
  JOIN integrations.inbox_messages im ON im.id = dl.source_id AND dl.source_type = 'inbox'
  JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
 ORDER BY ca.channel, im.resource_id;
```
```
   channel   | resource_id |  reason_code   |                    detail                     |            dead_at
-------------+-------------+----------------+-----------------------------------------------+-------------------------------
 woocommerce | 60736       | error_terminal | producto de Woo de tipo desconocido: sin tipo | 2026-09-22 07:15:42.97225+00
 woocommerce | 60778       | error_terminal | producto de Woo de tipo desconocido: sin tipo | 2026-09-22 07:15:42.988749+00
 woocommerce | 69528       | error_terminal | producto de Woo de tipo desconocido: sin tipo | 2026-09-19 23:28:34.327676+00
 woocommerce | 69809       | error_terminal | producto de Woo de tipo desconocido: sin tipo | 2026-09-22 07:15:42.993725+00
(4 rows)
```

### 1d. Omitidas por decisión (por cuenta)

```sql
SELECT ca.channel, count(*) AS omitidas
  FROM catalog.external_representations r JOIN core.channel_accounts ca ON ca.id = r.channel_account_id
 WHERE r.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND r.omitida_por_decision
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
   channel    | omitidas
--------------+----------
 mercadolibre |     2227
(1 row)
```

### 1e. ¿Cierra "vistos = importados + rechazados"? — por recurso DISTINCT

```sql
SELECT ca.channel, count(DISTINCT im.resource_id) AS recursos_distintos_en_inbox
  FROM integrations.inbox_messages im JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
   channel    | recursos_distintos_en_inbox
--------------+-----------------------------
 mercadolibre |                        4217
 woocommerce  |                        5300
(2 rows)
```

```sql
SELECT ca.channel, count(DISTINCT r.recurso) AS recursos_con_representacion
  FROM catalog.external_representations r JOIN core.channel_accounts ca ON ca.id = r.channel_account_id
 WHERE r.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
   channel    | recursos_con_representacion
--------------+-----------------------------
 mercadolibre |                        4217
 woocommerce  |                        2106
(2 rows)
```

```sql
SELECT ca.channel, count(DISTINCT im.resource_id) AS recursos_rechazados
  FROM integrations.dead_letters dl
  JOIN integrations.inbox_messages im ON im.id = dl.source_id AND dl.source_type = 'inbox'
  JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
   channel   | recursos_rechazados
-------------+---------------------
 woocommerce |                   4
(1 row)
```

**Corrección (2026-09-23, tras revisión de opt-62):** el primer intento de este punto comparaba
`im.resource_id` sólo contra `r.recurso`, sin contemplar que una VARIACIÓN de Woo llega al inbox con su propio
`resource_id` (el id de la variación) pero queda en `catalog.external_representations` con
`variacion_normalizada = resource_id` y `recurso` = el id del producto padre. Ejemplos verificados:

```sql
SELECT recurso, variacion_normalizada, tipo FROM catalog.external_representations
 WHERE channel_account_id = '01a0ad82-de15-7a79-b935-dc665538cd05' AND variacion_normalizada IN ('60769','60818','63074');
```
```
 recurso | variacion_normalizada |   tipo
---------+-----------------------+----------
 60765   | 60769                 | vendible
 60812   | 60818                 | vendible
 63058   | 63074                 | vendible
(3 rows)
```

Cierre correcto, comparando `im.resource_id` contra `r.recurso` **O** `r.variacion_normalizada`:

```sql
SELECT ca.channel,
       count(DISTINCT im.resource_id) FILTER (
         WHERE EXISTS (SELECT 1 FROM catalog.external_representations r
                         WHERE r.channel_account_id = im.channel_account_id
                           AND (r.recurso = im.resource_id OR r.variacion_normalizada = im.resource_id))
       ) AS con_representacion,
       count(DISTINCT im.resource_id) FILTER (
         WHERE EXISTS (SELECT 1 FROM integrations.dead_letters dl WHERE dl.source_id = im.id AND dl.source_type = 'inbox')
       ) AS rechazado
  FROM integrations.inbox_messages im JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
   channel    | con_representacion | rechazado
--------------+--------------------+-----------
 mercadolibre |               4217 |         0
 woocommerce  |               5300 |         4
(2 rows)
```

Diferencia (vistos, sin representación por recurso NI por variación, y sin DLQ):
```sql
SELECT ca.channel, count(DISTINCT im.resource_id) AS n
  FROM integrations.inbox_messages im JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
   AND NOT EXISTS (SELECT 1 FROM catalog.external_representations r
                     WHERE r.channel_account_id = im.channel_account_id
                       AND (r.recurso = im.resource_id OR r.variacion_normalizada = im.resource_id))
   AND NOT EXISTS (SELECT 1 FROM integrations.dead_letters dl WHERE dl.source_id = im.id AND dl.source_type = 'inbox')
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
 channel | n
---------+---
(0 rows)
```

**Resultado del cierre: 0 para ambas cuentas.**

- **ML: cierra exacto.** 4217 vistos = 4217 con representación + 0 rechazados.
- **Woo: cierra exacto.** 5300 vistos = 5300 con representación (los 4 rechazados también tienen match: la
  representación quedó igual creada aunque el mensaje terminó en DLQ) + 0 diferencia.

El resto de esta sección (1e original) queda como registro histórico del error de la primera consulta, no como
evidencia vigente:

<details>
<summary>Versión original (INCORRECTA: comparaba sólo contra <code>r.recurso</code>) — dejada por trazabilidad</summary>

No se explica esta diferencia por inferencia. Consulta de los recursos exactos (primeros 50 de un total de
4726 mensajes, sobre 3190 recursos distintos — ver más abajo por qué el conteo de mensajes no coincide con el
de recursos):

```sql
SELECT ca.channel, im.resource_id
  FROM integrations.inbox_messages im JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
   AND NOT EXISTS (SELECT 1 FROM catalog.external_representations r WHERE r.channel_account_id = im.channel_account_id AND r.recurso = im.resource_id)
   AND NOT EXISTS (SELECT 1 FROM integrations.dead_letters dl WHERE dl.source_id = im.id AND dl.source_type = 'inbox')
 ORDER BY ca.channel, im.resource_id LIMIT 50;

SELECT ca.channel, count(*) AS n
  FROM integrations.inbox_messages im JOIN core.channel_accounts ca ON ca.id = im.channel_account_id
 WHERE im.channel_account_id IN ('01a0ad82-de15-7a79-b935-dc665538cd05','01a0b28d-18e4-733b-b53f-64d1be288253')
   AND im.topic IN ('woo.products','ml.items')
   AND NOT EXISTS (SELECT 1 FROM catalog.external_representations r WHERE r.channel_account_id = im.channel_account_id AND r.recurso = im.resource_id)
   AND NOT EXISTS (SELECT 1 FROM integrations.dead_letters dl WHERE dl.source_id = im.id AND dl.source_type = 'inbox')
 GROUP BY ca.channel;
```
```
   channel   | resource_id
-------------+-------------
 woocommerce | 10044
 woocommerce | 10045
 ... (50 de 3190 recursos distintos)

   channel   |  n
-------------+------
 woocommerce | 4726    <- MENSAJES (no recursos distintos), status = 'succeeded' en todos
```

Dato crudo adicional (mensajes por recurso, para ver si son reintentos del mismo recurso):
```sql
SELECT im.status, count(*) AS n
  FROM integrations.inbox_messages im
 WHERE im.channel_account_id = '01a0ad82-de15-7a79-b935-dc665538cd05' AND im.topic = 'woo.products'
   AND NOT EXISTS (SELECT 1 FROM catalog.external_representations r WHERE r.channel_account_id = im.channel_account_id AND r.recurso = im.resource_id)
   AND NOT EXISTS (SELECT 1 FROM integrations.dead_letters dl WHERE dl.source_id = im.id AND dl.source_type = 'inbox')
 GROUP BY im.status;
```
```
  status   |  n
-----------+------
 succeeded | 4726
```
```sql
SELECT resource_id, count(*) AS mensajes
  FROM integrations.inbox_messages im
 WHERE im.channel_account_id = '01a0ad82-de15-7a79-b935-dc665538cd05' AND im.topic = 'woo.products'
   AND NOT EXISTS (SELECT 1 FROM catalog.external_representations r WHERE r.channel_account_id = im.channel_account_id AND r.recurso = im.resource_id)
   AND NOT EXISTS (SELECT 1 FROM integrations.dead_letters dl WHERE dl.source_id = im.id AND dl.source_type = 'inbox')
 GROUP BY resource_id ORDER BY mensajes DESC LIMIT 10;
```
```
 resource_id | mensajes
-------------+----------
 63074       |       10
 60769       |        8
 60771       |        8
 63077       |        8
 60776       |        8
 60774       |        8
 60818       |        7
 60815       |        7
 60827       |        7
 60822       |        7
```
Estado crudo (con la consulta que comparaba sólo `r.recurso`): 3190 recursos "sin representación". **Esto
estaba mal** — ver la corrección arriba: esos 3190 son variaciones de Woo, con representación bajo
`variacion_normalizada`, no bajo `recurso`. El universo de Woo cierra exacto (0 de diferencia) con la consulta
corregida.

</details>

---

## 2. Crosswalk

```sql
SELECT count(*) AS variantes_con_sku FROM catalog.sellable_variants WHERE sku IS NOT NULL AND archivado_en IS NULL;
```
```
 variantes_con_sku
-------------------
              4659
```

```sql
SELECT accion, count(*) AS n FROM catalog.matcher_decisions WHERE vigente_hasta IS NULL GROUP BY accion ORDER BY accion;
```
```
  accion   |  n
-----------+------
 asignar   | 1053
 confirmar | 1832
 omitir    | 2376
(total vigentes: 5261; confirmar+asignar: 2885)
```

Cruce oficial (`conciliarCatalogo` → `decisiones_vinculadas`, mismo SQL que corre el sistema):
```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE r.id IS NULL OR v.sku IS DISTINCT FROM d.sku) AS discrepan
  FROM catalog.matcher_decisions d
  LEFT JOIN catalog.external_representations r ON r.channel_account_id = d.channel_account_id
   AND r.recurso = d.recurso AND r.variacion_normalizada = d.variacion_normalizada AND r.tipo = 'vendible'
  LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id
 WHERE d.vigente_hasta IS NULL AND d.accion IN ('confirmar', 'asignar')
   AND EXISTS (SELECT 1 FROM catalog.sellable_variants x WHERE x.company_id = d.company_id AND x.sku = d.sku);
```
```
 total | discrepan
-------+-----------
  2868 |         7
```
Detalle de las 7 discrepancias:
```sql
SELECT d.recurso, d.variacion_normalizada, d.sku AS sku_decidido, v.sku AS sku_variante, r.id IS NULL AS sin_representacion
  FROM catalog.matcher_decisions d
  LEFT JOIN catalog.external_representations r ON r.channel_account_id = d.channel_account_id
   AND r.recurso = d.recurso AND r.variacion_normalizada = d.variacion_normalizada AND r.tipo = 'vendible'
  LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id
 WHERE d.vigente_hasta IS NULL AND d.accion IN ('confirmar', 'asignar')
   AND EXISTS (SELECT 1 FROM catalog.sellable_variants x WHERE x.company_id = d.company_id AND x.sku = d.sku)
   AND (r.id IS NULL OR v.sku IS DISTINCT FROM d.sku)
 ORDER BY d.recurso;
```
```
    recurso    | variacion_normalizada | sku_decidido | sku_variante | sin_representacion
---------------+-----------------------+--------------+--------------+--------------------
 MLA1122871051 |                       | FB-2296      |              | t
 MLA1236152518 | 175747904992          | FB-26704     |              | t
 MLA2073769465 |                       | FB-68884     |              | t
 MLA2472219644 |                       | FB-1805      |              | t
 MLA3983872654 |                       | FB-49929     |              | t
 MLA789558473  |                       | FB-1045      |              | t
 MLA820716362  | 45101314000           | FB-7180      |              | t
(7 rows)
```
Las 7 son decisiones del matcher a un SKU que existe en `sellable_variants`, pero **sin ninguna representación**
de esa publicación de ML todavía en `external_representations` (`sin_representacion = t` en las 7).

### Detalle de las 7: ¿las vio el bootstrap? ¿en qué estado quedó la decisión en el legado?

```sql
SELECT d.recurso AS item_id, d.variacion_normalizada, d.sku, d.accion, d.actor, d.origen, d.creado_en
  FROM catalog.matcher_decisions d
 WHERE d.channel_account_id = '01a0b28d-18e4-733b-b53f-64d1be288253'
   AND d.vigente_hasta IS NULL AND d.accion IN ('confirmar','asignar')
   AND d.recurso IN ('MLA1122871051','MLA1236152518','MLA2073769465','MLA2472219644','MLA3983872654','MLA789558473','MLA820716362')
 ORDER BY d.recurso;
```
```
    item_id    | variacion_normalizada |   sku    |  accion   |  actor  | origen |           creado_en
---------------+-----------------------+----------+-----------+---------+--------+-------------------------------
 MLA1122871051 |                       | FB-2296  | asignar   | persona | copia  | 2026-09-19 23:09:47.900929+00
 MLA1236152518 | 175747904992          | FB-26704 | asignar   | sistema | copia  | 2026-09-19 23:09:47.900929+00
 MLA2073769465 |                       | FB-68884 | confirmar | sistema | copia  | 2026-09-19 23:09:47.900929+00
 MLA2472219644 |                       | FB-1805  | confirmar | sistema | copia  | 2026-09-19 23:09:47.900929+00
 MLA3983872654 |                       | FB-49929 | confirmar | sistema | evento | 2026-09-23 18:03:24.396646+00
 MLA789558473  |                       | FB-1045  | asignar   | persona | copia  | 2026-09-19 23:09:47.900929+00
 MLA820716362  | 45101314000           | FB-7180  | asignar   | persona | copia  | 2026-09-19 23:09:47.900929+00
(7 rows)
```

```sql
SELECT im.resource_id, im.status, count(*) AS mensajes
  FROM integrations.inbox_messages im
 WHERE im.channel_account_id = '01a0b28d-18e4-733b-b53f-64d1be288253' AND im.topic = 'ml.items'
   AND im.resource_id IN ('MLA1122871051','MLA1236152518','MLA2073769465','MLA2472219644','MLA3983872654','MLA789558473','MLA820716362')
 GROUP BY im.resource_id, im.status;

SELECT x.item_id FROM (VALUES ('MLA1122871051'),('MLA1236152518'),('MLA2073769465'),('MLA2472219644'),('MLA3983872654'),('MLA789558473'),('MLA820716362')) AS x(item_id)
 WHERE NOT EXISTS (SELECT 1 FROM integrations.inbox_messages im WHERE im.channel_account_id = '01a0b28d-18e4-733b-b53f-64d1be288253' AND im.resource_id = x.item_id);
```
```
 resource_id | status | mensajes
-------------+--------+----------
(0 rows)

    item_id
---------------
 MLA1122871051
 MLA1236152518
 MLA2073769465
 MLA2472219644
 MLA3983872654
 MLA789558473
 MLA820716362
(7 rows)
```

**Las 7 nunca las vio el bootstrap ni ningún barrido: cero mensajes en `integrations.inbox_messages` para esos
`item_id`.** 6 de las 7 (`MLA1122871051`, `MLA1236152518`, `MLA2073769465`, `MLA2472219644`, `MLA789558473`,
`MLA820716362`) tienen `origen = 'copia'` con `creado_en = 2026-09-19 23:09:47` — la copia inicial de 5.207
decisiones del matcher desde el legado, el mismo instante para las 6. La séptima (`MLA3983872654`) tiene
`origen = 'evento'`, creada hoy `2026-09-23 18:03:24` — una decisión nueva del matcher legado, copiada por el
outbox, para un ítem que la plataforma tampoco vio nunca en su inbox.

### Resultado de cada conciliación diaria del matcher desde el 2026-09-20 (`plataforma/src/catalogo/conciliacion.ts` + `catalog.copias`, confirmadas por el scheduler)

```sql
SELECT corte::date AS dia, confirmada_en, resultado->>'sinCambios' AS sin_cambios,
       resultado->>'abiertas' AS abiertas, resultado->>'cerradas' AS cerradas,
       resultado->>'sinRepresentacion' AS sin_representacion, resultado->>'masNuevasQueLaCopia' AS mas_nuevas
  FROM catalog.copias
 WHERE tipo = 'matcher' AND estado = 'confirmada' AND corte >= '2026-09-20T00:00:00Z'
 ORDER BY corte;
```
```
    dia     |         confirmada_en         | sin_cambios | abiertas | cerradas | sin_representacion | mas_nuevas
------------+-------------------------------+-------------+----------+----------+--------------------+------------
 2026-09-20 | 2026-09-20 01:52:29.384563+00 | 5207        | 0        | 0        | 0                  | 0
 2026-09-20 | 2026-09-20 06:30:10.011562+00 | 5207        | 0        | 0        | 0                  | 0
 2026-09-21 | 2026-09-21 06:30:10.016333+00 | 5207        | 0        | 0        | 0                  | 0
 2026-09-22 | 2026-09-22 06:30:10.595776+00 | 5207        | 0        | 0        | 0                  | 0
 2026-09-23 | 2026-09-23 06:30:06.704412+00 | 5208        | 0        | 0        | 0                  | 0
(5 rows)
```
5 corridas confirmadas (una extra el día 20, corte manual + la diaria 06:30 UTC), todas con `abiertas: 0,
cerradas: 0` — cero deriva entre legado y plataforma en cada conciliación desde el arranque de la ventana.

---

## 3. Conciliación firmada de E1 T4 que incluye el catálogo

`plataforma/src/informes/reporte.ts` arma `Reporte` con `catalogo: await seccionCatalogo(pool, desde, hasta,
corte)` (línea 179), y `seccionCatalogo` (en `plataforma/src/catalogo/conciliacion.ts`) es la que lee
`catalog.identity_cases` y `catalog.copias`. Ese `Reporte` es el mismo que se firma y sube a B2 como el reporte
diario de E1 T4 (`integrations.daily_shadow_reports`), con su manifiesto de auditoría en
`audit.audit_daily_manifests`.

### Manifiestos de auditoría firmados (`audit.audit_daily_manifests`)

```sql
SELECT manifest_date, event_count, encode(last_hash,'hex') AS last_hash, signing_key_id, b2_object_key, retention_mode, created_at
  FROM audit.audit_daily_manifests
 WHERE manifest_date >= '2026-09-17'
 ORDER BY manifest_date;
```
```
 manifest_date | event_count |                            last_hash                             | signing_key_id |         b2_object_key          | retention_mode |          created_at
---------------+-------------+------------------------------------------------------------------+----------------+---------------------------------+----------------+-------------------------------
 2026-09-17    |           3 | c812ce6f3a69f8bf4c49a58f2fb43e9d17e5d977aecfb0ed481a09d27fed0ab0 | e1-2026-09     | e1/manifiestos/2026-09-17.json | compliance     | 2026-09-18 12:30:00.786179+00
 2026-09-18    |         361 | fb71a3f383bd8e34a42fc92db5e73bde98d0df686491dab830b0f27cd4e82365 | e1-2026-09     | e1/manifiestos/2026-09-18.json | compliance     | 2026-09-19 10:00:12.746795+00
 2026-09-19    |       10801 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3 | e1-2026-09     | e1/manifiestos/2026-09-19.json | compliance     | 2026-09-20 10:00:11.283502+00
 2026-09-20    |         816 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3 | e1-2026-09     | e1/manifiestos/2026-09-20.json | compliance     | 2026-09-21 10:00:26.640232+00
 2026-09-21    |        1316 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3 | e1-2026-09     | e1/manifiestos/2026-09-21.json | compliance     | 2026-09-22 10:00:26.6861+00
 2026-09-22    |        1288 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3 | e1-2026-09     | e1/manifiestos/2026-09-22.json | compliance     | 2026-09-23 10:00:07.525051+00
(6 rows)
```
### `last_hash` idéntico del 19 al 22: qué hashea y por qué no debería repetirse

**Qué hashea el campo.** `audit.audit_daily_manifests.last_hash` se llena con `m.ultimo_hash`, un campo de
`Manifiesto` (`plataforma/src/informes/manifiesto.ts:14-22`). No es un hash de la sección de catálogo ni del
contenido del reporte: es el `hash` (bytea) de `audit.audit_events` — la cadena de auditoría encadenada, hash
por hash — correspondiente al **último evento ocurrido antes del corte del día** (medianoche ART siguiente):

```ts
// plataforma/src/informes/manifiesto.ts:34-46
const dia = await cliente.query<{ primero: string | null; ultimo: string | null; n: string }>(
  `SELECT MIN(chain_seq)::text AS primero, MAX(chain_seq)::text AS ultimo, COUNT(*)::text AS n
     FROM audit.audit_events WHERE occurred_at >= $1 AND occurred_at < $2`,
  [desde, hasta],
);
const { primero, ultimo, n } = dia.rows[0]!;
// Sin eventos en el día, el extremo que se fija es el último hash conocido hasta el fin del día.
const hash = await cliente.query<{ hash: string | null; chain_seq: string | null }>(
  `SELECT encode(hash, 'hex') AS hash, chain_seq::text AS chain_seq FROM audit.audit_events
    WHERE occurred_at < $1 ORDER BY chain_seq DESC LIMIT 1`,
  [hasta],
);
```
y se escribe en `registrarCanonico` (`plataforma/src/informes/vuelta.ts:311-329`) directo desde `m.ultimo_hash`,
sin transformación.

**Por qué NO debería repetirse en estos 4 días**: el manifiesto de cada día SÍ tuvo eventos nuevos
(`event_count`: 10801, 816, 1316, 1288 — nunca cero) y `last_chain_seq` SÍ avanzó cada día (11165 → 11981 →
13297 → 14585). Si `event_count > 0` para el día, el `hash` guardado debería ser el de `audit_events` en ese
`chain_seq`, y ese hash cambia con cada evento nuevo (es una cadena). No es el caso de "día sin eventos" que
el comentario del código contempla.

**Verificación contra la cadena real de `audit_events`:**
```sql
SELECT manifest_date, first_chain_seq, last_chain_seq, event_count, encode(last_hash,'hex') AS last_hash_hex
  FROM audit.audit_daily_manifests WHERE manifest_date BETWEEN '2026-09-19' AND '2026-09-22' ORDER BY manifest_date;
```
```
 manifest_date | first_chain_seq | last_chain_seq | event_count |                          last_hash_hex
---------------+-----------------+----------------+-------------+------------------------------------------------------------------
 2026-09-19    |             365 |          11165 |       10801 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3
 2026-09-20    |           11166 |          11981 |         816 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3
 2026-09-21    |           11982 |          13297 |        1316 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3
 2026-09-22    |           13298 |          14585 |        1288 | 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3
(4 rows)
```
```sql
SELECT m.manifest_date, m.last_chain_seq, e.chain_seq, encode(e.hash,'hex') AS hash_evento, e.occurred_at
  FROM audit.audit_daily_manifests m
  LEFT JOIN audit.audit_events e ON e.chain_seq = m.last_chain_seq
 WHERE m.manifest_date BETWEEN '2026-09-19' AND '2026-09-22'
 ORDER BY m.manifest_date;
```
```
 manifest_date | last_chain_seq | chain_seq |                           hash_evento                            |          occurred_at
---------------+----------------+-----------+------------------------------------------------------------------+-------------------------------
 2026-09-19    |          11165 |     11165 | 1934a97d69b5c28ba6624f49a7922a4ab18be695ef91de1b26794ee3a96f2093 | 2026-09-20 02:57:48.303301+00
 2026-09-20    |          11981 |     11981 | 30102a9aab0d1ada3e1e75c9ddfeaab273093fbb25567ae5528a2f6ba89d0c31 | 2026-09-21 02:59:29.198041+00
 2026-09-21    |          13297 |     13297 | f14c50e2e0594a7ccb4633bca9e834f2516046eb3782e815d08b30052c322f99 | 2026-09-22 02:59:16.820354+00
 2026-09-22    |          14585 |     14585 | ce0e7963fe8850ad2a8c30977718fc493957814b5bad46139f0bc48bc7ffc39f | 2026-09-23 02:55:07.131191+00
(4 rows)
```
**El `hash_evento` real de `audit_events` para cada `last_chain_seq` NO coincide con el `last_hash` guardado en
el manifiesto** (4 valores distintos y correctos en `audit_events`, contra un único valor fijo
`206df770...` guardado en los 4 manifiestos).

Dónde aparece realmente ese hash `206df770...`:
```sql
SELECT chain_seq, occurred_at, action FROM audit.audit_events WHERE encode(hash,'hex') = '206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3';
```
```
 chain_seq |          occurred_at          |     action
-----------+-------------------------------+----------------
      9999 | 2026-09-20 02:08:47.407018+00 | cola.succeeded
(1 row)
```
Es el hash de un evento (`chain_seq = 9999`) anterior a los 4 cortes, de un día distinto al primero de la
racha (19/09).

**La cadena de `audit_events` en sí está íntegra** (no es un problema de corrupción de la cadena):
```sql
SELECT audit.verify_chain(NULL::bigint, NULL::bigint) AS roto_en;
```
```
 roto_en
---------
 (null)
```
y cada `prev_hash` del evento siguiente enlaza con el `hash` del evento anterior en los 4 `chain_seq`
verificados (`enlaza = t` en los 4 casos, consulta en `/tmp/claude-0/e2-evidencia/09-verificacion-cadena.out`).

**Conclusión, sin inferir la causa del código**: el hallazgo es real. El campo `last_hash` guardado en
`audit.audit_daily_manifests` para los manifiestos del 19 al 22 de septiembre **no es el hash correcto** de la
cadena de auditoría en su propio `last_chain_seq` — es un valor fijo (`206df770...`) que en la cadena real
corresponde a un evento anterior y de otro día (`chain_seq = 9999`, 20/09 02:08 UTC). La cadena de eventos en sí
(`audit_events`) está íntegra y avanza correctamente; el problema está en lo que se guardó en
`audit_daily_manifests.last_hash` (o en lo que se firmó como parte del manifiesto, que no se puede revisar en
retrospectiva por lectura sola — el JSON firmado está en B2, no en esta base). Esto pega directo en la garantía
de "conciliación firmada": si el manifiesto firmado y subido a B2 lleva el mismo `last_hash` incorrecto que la
fila canónica, la firma es válida sobre un contenido que no fija el extremo real de la cadena de esos 4 días.
No se pudo determinar la causa exacta por lectura sola de Postgres (haría falta leer el JSON firmado en B2 y/o
los logs del scheduler en esas fechas, que están fuera del alcance de sólo-lectura de esta consulta).

### Reportes diarios firmados (`integrations.daily_shadow_reports`, incluyen la sección catálogo)

```sql
SELECT report_date, generated_at, encode(report_sha256,'hex') AS report_sha256, signing_key_id, b2_object_key, retention_until, email_sent_at
  FROM integrations.daily_shadow_reports
 WHERE report_date >= '2026-09-17'
 ORDER BY report_date;
```
```
 report_date |         generated_at          |                          report_sha256                           | signing_key_id |        b2_object_key        |      retention_until       |       email_sent_at
-------------+-------------------------------+------------------------------------------------------------------+----------------+-----------------------------+----------------------------+----------------------------
 2026-09-17  | 2026-09-18 12:30:03.617366+00 | e5a5e8ab668301b43577057f300e65a0277bbfad44548a9be75c350a1933c0bd | e1-2026-09     | e1/reportes/2026-09-17.json | 2027-09-20 12:30:01.429+00 | 2026-09-18 12:30:06.401+00
 2026-09-18  | 2026-09-19 10:00:14.876553+00 | 85d010d70fdcba9e8dc33c7f0d6816b292f6e3229e8ce216ca8d97b5ee93cc78 | e1-2026-09     | e1/reportes/2026-09-18.json | 2027-09-21 10:00:13.191+00 | 2026-09-19 10:00:17.683+00
 2026-09-19  | 2026-09-20 10:00:13.513446+00 | ae881302c88e92ecf3f0a318d8460d34521f6524be4885de486b50eebf39164b | e1-2026-09     | e1/reportes/2026-09-19.json | 2027-09-22 10:00:12.206+00 | 2026-09-20 10:00:16.675+00
 2026-09-20  | 2026-09-21 10:00:28.422362+00 | ed6de16117b8b4e29cb750cf923032de0c2e9742aa99924b9a7326487b6571ba | e1-2026-09     | e1/reportes/2026-09-20.json | 2027-09-23 10:00:27.042+00 | 2026-09-21 10:00:31.743+00
 2026-09-21  | 2026-09-22 10:00:29.317393+00 | 6ad802bb5eb0dd46e259de82b6f4097da4c279981934bb93d72f7bbae929c594 | e1-2026-09     | e1/reportes/2026-09-21.json | 2027-09-24 10:00:27.108+00 | 2026-09-22 10:00:34.727+00
 2026-09-22  | 2026-09-23 10:00:09.719477+00 | 79ef5ebb9073ee7e2c7f38f36378da17a5e72b7a403f9437c1b696a49b3c7fcd | e1-2026-09     | e1/reportes/2026-09-22.json | 2027-09-25 10:00:08.119+00 | 2026-09-23 10:00:14.223+00
(6 rows)
```
6 reportes diarios firmados y enviados por email desde el 17, cada uno con hash propio, en B2 con
`retention_mode = compliance`, incluyendo (por código, ver arriba) la sección de catálogo.

---

## 4. Ventana de 7 días de sólo lectura

Arranque de la ventana: **2026-09-20** (según opt-62). Hoy: **2026-09-23**. Van **4 días** con conciliación
diaria confirmada.

```sql
SELECT corte::date AS dia, confirmada_en, resultado->>'sinCambios' AS sin_cambios,
       resultado->>'abiertas' AS abiertas, resultado->>'cerradas' AS cerradas
  FROM catalog.copias
 WHERE tipo = 'matcher' AND estado = 'confirmada' AND corte >= '2026-09-20T00:00:00Z'
 ORDER BY corte;
```
(Mismo resultado que la tabla de la sección 2: 5 corridas, todas `abiertas: 0, cerradas: 0`.)

**Días sin diferencias: 4 de 4** (20, 21, 22, 23), incluida la corrida extra del día 20. Faltan **3 días** para
completar los 7 contractuales (se cumplirían el 2026-09-27, si sigue sin diferencias).

---

## 5. Los 313 casos de clasificación, agrupados

```sql
SELECT tipo, count(*) AS n FROM catalog.identity_cases
 WHERE tipo IN ('categoria_en_desacuerdo','categoria_sin_mapeo','categoria_persona_contradicha') AND cerrado_en IS NULL
 GROUP BY tipo ORDER BY tipo;
```
```
          tipo           |  n
-------------------------+-----
 categoria_en_desacuerdo |  37
 categoria_sin_mapeo     | 276
(2 rows)
```
`categoria_persona_contradicha`: **0** casos abiertos hoy (la 6b recién se desplegó a las 23:11 UTC del
2026-09-23; todavía no hubo ingestión con contradicción real).

### 5a. Los 37 `categoria_en_desacuerdo`, agrupados por par de nodos

```sql
SELECT (detalle->'nodos') AS nodos, count(*) AS n,
       (array_agg(m.titulo ORDER BY c.abierto_en))[1:2] AS ejemplos
  FROM catalog.identity_cases c JOIN catalog.product_models m ON m.id = c.model_id
 WHERE c.tipo = 'categoria_en_desacuerdo' AND c.cerrado_en IS NULL
 GROUP BY detalle->'nodos' ORDER BY n DESC, nodos;
```
```
                        nodos                         | n  |                                                        ejemplos
--------------------------------------------------------+----+------------------------------------------------------------------------------------------------------------------------
 ["grasas", "lubricantes"]                            | 11 | {"Grasa Shimano PREMIUM 100g","Grasa Molicsyn para Body y Rulemanes de Mazas 5g"}
 ["cubiertas-y-camaras", "selladores"]                |  4 | {"Kit Tubeless Sportace","Cinta Tubeless Molicsyn Ruta MTB Gravel 10m Ancho 27mm"}
 ["ciclocomputadoras-y-gps", "pedales-y-trabas"]      |  3 | {"Pedales Look X-Track Mtb Power Dual","Pedales Garmin Rally XC100 Potenciómetro con detección individual"}
 ["liquidos-de-frenos", "lubricantes"]                |  3 | {"Aceite de baja viscosidad SHIMANO (100 ml)","Aceite Mineral Para Frenos Hidráulicos Shimano 1000Ml"}
 ["ciclocomputadoras-y-gps", "transmision"]           |  2 | {"Potenciometro Xcadey Spider BCD104 p/SRAM Direct Mount","Potenciometro Xcadey Spider BCD104 p/Shimano Direct Mount"}
 ["cubiertas-y-camaras", "infladores-y-herramientas"] |  2 | {"Herramienta Air-Liner Vittoria","Tarugos De Repuesto Encore X20U"}
 ["fanttik", "infladores-y-herramientas"]             |  2 | {"Destornillador Eléctrico Fanttik S1 Pro Inalámbrico","Hidrolavadora Portatil Fanttik K100Flip"}
 ["frenos", "transmision"]                            |  2 | {"Manijas Integradas Shimano Ef510 3X9V","Set de Freno a Disco Shimano GRX Manija RX610 + Caliper RX410 12v"}
 ["bolsos", "portabicicletas"]                        |  1 | {"Cobertor Para Puerta De Camioneta Porta Bicicleta - Sportace"}
 ["cascos", "guantes"]                                |  1 | {"Guantes Ciclismo Largos Sportace"}
 ["cascos", "ruedas"]                                 |  1 | {"Adaptador Wahoo Kickr De Eje Pasante 12X142Mm"}
 ["ciclocomputadoras-y-gps", "rodillos"]              |  1 | {"Antena Receptor ANT+ USB THINKRIDER"}
 ["frenos", "infladores-y-herramientas"]              |  1 | {"Kit Purgado De Frenos Shimano Bt03-S"}
 ["hidratacion", "infladores-y-herramientas"]         |  1 | {"PRO Portacaramañola + Multiherramienta COMBIPACK BC SMART FULL KIT"}
 ["infladores-y-herramientas", "lubricantes"]         |  1 | {"Pomo 60Ml Guia P/Lubricar Cadena Por Goteo (No Incl Lubricante) Ezmtb No-Drip"}
 ["jerseys-y-calzas", "remeras"]                      |  1 | {"Remera Ciclista Zion"}
(16 grupos, suma = 37)
```
Nota: el grupo `["fanttik", "infladores-y-herramientas"]` (2 casos) es el ya diagnosticado en la evidencia de
la tarea 6a (dry-run, `plan-maestro-estado.md`) como desacuerdo real de Woo, no hueco de D26.

### 5b. Los 113 `categoria_no_mapeada`, agrupados por categoría del canal sin mapeo

```sql
SELECT cat->>'canal' AS canal, cat->>'valor' AS valor, count(*) AS n
  FROM catalog.identity_cases c, LATERAL jsonb_array_elements(c.detalle->'categorias') cat
 WHERE c.tipo = 'categoria_sin_mapeo' AND c.cerrado_en IS NULL AND c.detalle->>'razon' = 'categoria_no_mapeada'
 GROUP BY 1, 2 ORDER BY n DESC, canal, valor;
```
```
    canal     |   valor   | n
--------------+-----------+----
 mercadolibre | MLA109027 | 18
 mercadolibre | MLA78908  | 18
 mercadolibre | MLA9760   |  9
 mercadolibre | MLA458068 |  4
 woocommerce  | OTROS     |  4
 mercadolibre | MLA392132 |  3
 mercadolibre | MLA429288 |  3
 mercadolibre | MLA12012  |  2
 mercadolibre | MLA120350 |  2
 ... (47 grupos en total, ver /tmp/claude-0/e2-evidencia/05-casos.out para la lista completa)
 mercadolibre | MLA70411  |  1
 woocommerce  | QR PAGOS  |  1
(47 rows, suma = 113)
```
Verificado: suma de grupos = 113 = cantidad de casos `categoria_no_mapeada` abiertos.

### 5c. Los 163 `sin_categoria`, por canal

Un modelo `sin_categoria` no tiene ningún `categoria_canal`: el "canal" que corresponde es el canal de origen
del modelo (`product_models.channel_account_id`), no el de una representación (la mayoría no tiene
representación vigente — ver detalle):

```sql
SELECT ca.channel, count(*) AS n
  FROM catalog.identity_cases c
  JOIN catalog.product_models m ON m.id = c.model_id
  JOIN core.channel_accounts ca ON ca.id = m.channel_account_id
 WHERE c.tipo = 'categoria_sin_mapeo' AND c.cerrado_en IS NULL AND c.detalle->>'razon' = 'sin_categoria'
 GROUP BY ca.channel ORDER BY ca.channel;
```
```
   channel    |  n
--------------+-----
 mercadolibre | 162
 woocommerce  |   1
(2 rows, suma = 163)
```
Dato crudo adicional (por qué casi no hay representación vigente en estos casos):
```sql
SELECT count(*) FILTER (WHERE tiene_rep) AS con_representacion, count(*) FILTER (WHERE NOT tiene_rep) AS sin_representacion
  FROM (
    SELECT c.model_id, EXISTS(SELECT 1 FROM catalog.external_representations r WHERE r.model_id = c.model_id) AS tiene_rep
      FROM catalog.identity_cases c
     WHERE c.tipo = 'categoria_sin_mapeo' AND c.cerrado_en IS NULL AND c.detalle->>'razon' = 'sin_categoria'
  ) x;
```
```
 con_representacion | sin_representacion
---------------------+--------------------
                   3 |                160
```

---

## 6. Casos de identidad abiertos por tipo, hoy

```sql
SELECT tipo, prioridad, count(*) AS n FROM catalog.identity_cases WHERE cerrado_en IS NULL GROUP BY tipo, prioridad ORDER BY tipo, prioridad;
SELECT count(*) AS total_abiertos FROM catalog.identity_cases WHERE cerrado_en IS NULL;
```
```
          tipo           | prioridad |  n
--------------------------+-----------+------
 atributo_divergente     | normal    |  129
 categoria_en_desacuerdo | normal    |   37
 categoria_sin_mapeo     | normal    |  276
 identidad_legado        | urgente   |   29
 omitida_revisar         | baja      | 2227
 sku_inexistente_en_woo  | normal    |   17
 sku_pendiente           | normal    | 2098
 user_product_divergente | normal    |  500
 woo_sku_no_canonico     | normal    |   48
(9 rows)

 total_abiertos
----------------
           5361
```
Por tipo (sin partir por prioridad):
```
          tipo           |  n
--------------------------+------
 omitida_revisar         | 2227
 sku_pendiente           | 2098
 user_product_divergente |  500
 categoria_sin_mapeo     |  276
 atributo_divergente     |  129
 woo_sku_no_canonico     |   48
 categoria_en_desacuerdo |   37
 identidad_legado        |   29
 sku_inexistente_en_woo  |   17
(9 rows)
```

---

## Resumen de lo que NO cierra (para que José decida) — actualizado tras la revisión de opt-62

1. **Universo de Woo: CIERRA.** El hallazgo original (3190 recursos "huérfanos") era un error de la consulta:
   no contemplaba `variacion_normalizada`. Corregido en la sección 1e: 5300 vistos = 5300 con representación
   (recurso o variación) para Woo, 4217 = 4217 para ML. Diferencia real: 0 en ambas cuentas.
2. **Crosswalk con 7 discrepancias, ahora explicadas**: las 7 son decisiones del matcher (6 copiadas el
   2026-09-19 23:09:47 desde el legado, 1 por evento nuevo del 2026-09-23 18:03) a un SKU que existe en
   `sellable_variants`, para publicaciones de ML que **el bootstrap y los barridos nunca vieron** (0 mensajes en
   `integrations.inbox_messages` para esos 7 `item_id`). No es un problema del proyector: es que la plataforma
   nunca recibió esas publicaciones de ML. Sección 2.
3. **Hallazgo real (no descartado): el `last_hash` de los manifiestos firmados del 19 al 22 de septiembre no es
   el hash correcto de la cadena de auditoría en su propio `last_chain_seq`.** Es un valor fijo que en la cadena
   real corresponde a un evento anterior (`chain_seq = 9999`, 20/09 02:08 UTC), no al último evento de cada día
   (que sí avanza: `event_count` y `last_chain_seq` son correctos). La cadena de `audit_events` en sí está
   íntegra (`verify_chain` sin rota, `prev_hash` enlaza en los 4 puntos verificados) — el problema está
   específicamente en lo que quedó guardado como `last_hash` en `audit_daily_manifests` (y, potencialmente, en
   lo firmado y subido a B2, que no se pudo verificar por lectura sola de Postgres). Pega directo en la garantía
   de "conciliación firmada" de la aceptación. Sección 3, con cita de código
   (`plataforma/src/informes/manifiesto.ts:34-46`, `plataforma/src/informes/vuelta.ts:311-329`).
   **Causa raíz encontrada (sección 7): bug de tipo en `manifiesto.ts:43-46` — el `ORDER BY chain_seq DESC`
   ordena por el alias `chain_seq::text` (texto), no por el número, así que un `chain_seq` de 4 dígitos que
   empieza con `9` (p. ej. `9999`) le gana en orden de texto a uno de 5 dígitos que empieza con `1`
   (`11165`, `11981`, etc.), y el `LIMIT 1` se queda con el hash equivocado. No se aplicó fix: diagnóstico
   solamente, por instrucción de opt-62.
4. **Ventana de 7 días**: van 4 de 7, todos sin diferencias hasta ahora (2026-09-23). Faltan 3 días.
5. **313 casos de clasificación** agrupados arriba para decisión en bloque (secciones 5a/5b/5c) — sin cambios
   respecto de la primera versión.

## 7. Causa raíz del `last_hash` incorrecto (diagnóstico, sin fix aplicado)

Pedido de opt-62: descartar con cita de código + consulta cada hipótesis (a) contenido/hash cacheado y
reusado entre días, (b) `medianocheArt` calcula mal `hasta`, (c) algo arrastra el extremo (p. ej. un reintento
que rearma el manifiesto con otro `hasta`). Sólo lectura, sin cambios de código ni de producción.

### (a) ¿Se arma una sola vez y se reusa un contenido/hash cacheado? — DESCARTADO

`audit_daily_manifests.first_chain_seq`, `last_chain_seq` y `event_count` son **distintos y correctos cada
día** (verificado contra `audit_events` directamente):

```
manifest_date | first_chain_seq | last_chain_seq | event_count
2026-09-19    |              365 |          11165 |       10801
2026-09-20    |            11166 |          11981 |         816
2026-09-21    |            11982 |          13297 |        1316
2026-09-22    |            13298 |          14585 |        1288
```

Si el `contenido` completo se reusara o cacheara de un día a otro, estos tres campos también estarían
pegados al mismo valor. No lo están: sólo `last_hash` es idéntico los 4 días (`206df770dc4a3c...`). Esto
también descarta que `informes.entregas.hash_contenido` (que sí cambia cada día: `5f9543b8...`, `01cdbecf...`,
`d101fe06...`, `c93d436f...` — visto en `/tmp/claude-0/e2-evidencia/11-diagnostico-hash.out`) sea la fuente
del problema: `armarManifiesto()` corre de nuevo cada día con datos propios.

### (b) ¿`medianocheArt` calcula mal `hasta`? — DESCARTADO

`plataforma/src/informes/dia.ts:19-28` prueba offsets `[3, 2, 4]` contra la zona `America/Argentina/Buenos_Aires`
(sin DST desde 2009) y devuelve el instante UTC que corresponde a las 00:00 ART de la fecha pedida. Para el
19/09 eso da `2026-09-20T03:00:00.000Z` (ART = UTC-3 fijo). Verificado directamente:

```sql
-- MAX(chain_seq) con el filtro EXACTO que usa armarManifiesto() para el 19/09
SELECT MIN(chain_seq)::text AS primero, MAX(chain_seq)::text AS ultimo, COUNT(*)::text AS n
  FROM audit.audit_events WHERE occurred_at >= '2026-09-19T03:00:00.000Z' AND occurred_at < '2026-09-20T03:00:00.000Z';
--  primero | ultimo | n
--  365     | 11165  | 10801
```

`ultimo = 11165` es el valor correcto (coincide con `last_chain_seq` guardado). El corte `hasta` está bien
calculado; el problema no está en la ventana del día. (`/tmp/claude-0/e2-evidencia/14-hasta-correcto.out`,
`/tmp/claude-0/e2-evidencia/15-replica-armarManifiesto.out`)

### (c) ¿Algo arrastra el extremo (reintento que rearma con otro `hasta`)? — NO es esto; causa real encontrada

`informes.entregas` para `tipo='manifiesto'` muestra `intentos_deposito = 0` en los 4 días, todos
`estado_deposito='subido'` y `estado_aviso='avisado'` en el primer paso — no hay evidencia de reintento vía el
contador visible del estado. Se buscó también el path de reparación idempotente
(`repararCanonico`, `plataforma/src/informes/vuelta.ts:288-298`), que sólo actúa
`if (!fila || fila.estado_deposito !== 'subido' || fila.hash_contenido !== hash) return;` — exige que el
hash recalculado coincida exactamente con el guardado, así que tampoco puede introducir un `contenido`
distinto del que se firmó. Se descarta un reintento con `hasta` diferente.

**La causa real es otra, y no estaba entre las tres hipótesis: es un bug de tipo en la consulta que arma el
campo `ultimo_hash` del manifiesto**, en `plataforma/src/informes/manifiesto.ts:43-46`:

```ts
const hash = await cliente.query<{ hash: string | null; chain_seq: string | null }>(
  `SELECT encode(hash, 'hex') AS hash, chain_seq::text AS chain_seq FROM audit.audit_events
    WHERE occurred_at < $1 ORDER BY chain_seq DESC LIMIT 1`,
  [hasta],
);
```

`chain_seq` se proyecta como `chain_seq::text AS chain_seq`, y el `ORDER BY chain_seq DESC` de la MISMA
consulta resuelve contra el alias de salida (ya casteado a texto), no contra la columna numérica original.
Postgres confirma esto en el plan de ejecución, reproducido literal con el mismo filtro y la misma consulta
que usa el código (`/tmp/claude-0/e2-evidencia/17-desorden.out`):

```
QUERY PLAN
Limit  (cost=837.63..837.63 rows=1 width=64)
  ->  Sort  (cost=837.63..868.41 rows=12312 width=64)
        Sort Key: ((chain_seq)::text) DESC        -- ordena por TEXTO, no por número
        ->  Seq Scan on audit_events ...
```

Con orden lexicográfico DESC, `'9999'` (que empieza con `'9'`) queda ANTES que `'11165'`, `'11164'`, etc.
(que empiezan con `'1'`), porque `'9' > '1'` como carácter. El `LIMIT 1` se queda entonces con `chain_seq=9999`
en lugar del verdadero último (`11165`). Reproducido exacto en la misma transacción REPEATABLE READ que usa
el código real, con los dos SELECT de `armarManifiesto()` uno atrás del otro:

```sql
-- primer SELECT de armarManifiesto (correcto, numérico: MIN/MAX no tienen este problema)
--   primero=365, ultimo=11165, n=10801
-- segundo SELECT de armarManifiesto (el que arma ultimo_hash) -- MISMA transacción, mismo hasta:
SELECT encode(hash, 'hex') AS hash, chain_seq::text AS chain_seq FROM audit.audit_events
  WHERE occurred_at < '2026-09-20T03:00:00.000Z' ORDER BY chain_seq DESC LIMIT 1;
--   hash = 206df770dc4a3c025d1fad4095a1c206c53485cd90230a800f2164edbee5b5a3, chain_seq = 9999
```

Y se confirmó que ese hash pertenece exactamente a `chain_seq=9999`, evento `cola.succeeded` de
`2026-09-20 02:08:47.407018+00` (`/tmp/claude-0/e2-evidencia/16-donde-esta-206df770.out`):

```
chain_seq |          occurred_at          |     action     | aggregate_type
9999      | 2026-09-20 02:08:47.407018+00 | cola.succeeded | inbox
```

**Por qué aparece fijo desde el 19/09 y no antes**: el bug sólo se manifiesta cuando el `chain_seq` real del
día cruza el borde de 4 a 5 dígitos (de `9999` en adelante), porque recién ahí el orden de texto empieza a
divergir del orden numérico para los candidatos cercanos al tope. Antes de ese cruce (cualquier corte con
`chain_seq` tope de 4 dígitos o menos) el orden de texto y el numérico coinciden dentro del rango de valores
existente, así que el bug es silencioso hasta ese punto — coincide con que `chain_seq=9999` es justo el valor
que quedó "pegado" como `last_hash` los 4 días siguientes: una vez que el tope real supera los 5 dígitos,
`9999` (con primer dígito `9`) le sigue ganando en orden de texto a cualquier `1xxxx`, así que el bug persiste
mientras el primer dígito del tope real sea `1` y menor que `9`.

**Alcance del impacto**: sólo el campo `ultimo_hash` del objeto `Manifiesto` está afectado — `primer_chain_seq`,
`ultimo_chain_seq`, `eventos` y la verificación de integridad (`cadena.integra`, que usa `hastaVerificar =
ultimo ?? ...`, el valor NUMÉRICO correcto, no el de esta consulta) están todos bien. El daño es específico:
el manifiesto firmado y subido a B2 declara un `ultimo_hash` que no es el hash real del último evento del día,
lo cual rompe la garantía de "el extremo de la cadena quedó fijado afuera" que es la razón de ser del
manifiesto (ver el comentario de cabecera de `manifiesto.ts:4-5`). No se verificó si esto también corrompe
`verify_chain` en sí (no debería, porque usa `hastaVerificar` numérico), pero si algún consumidor externo
usa `audit_daily_manifests.last_hash` para revalidar contra `audit_events.hash` de ese `last_chain_seq`, la
comparación falla siempre que el bug esté activo.

**No se aplicó ningún fix** — por instrucción explícita de opt-62, esto es diagnóstico solamente.

## Nota sobre el acceso usado

Esta sesión tenía bloqueadas las lecturas directas contra producción por su clasificador de permisos
("Production Reads"). Se pidió y obtuvo aprobación directa de José, en esta misma sesión (no por relay de un
par), primero para el objetivo general de correr SELECTs de sólo lectura, y después específicamente para crear
el rol Postgres `auditor_e2_readonly` (CREATE ROLE + GRANT SELECT en catalog/core/audit/integrations, sin
DELETE/INSERT/UPDATE en ninguna tabla), que también había sido bloqueado por el clasificador pese a ser
estrictamente de sólo lectura hacia adelante. La clave del rol no se registra en este documento ni en ningún
otro lugar del repositorio.
