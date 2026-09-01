# Apertura diaria, ola congelada y mini-olas — diseño

**Estado:** aprobado por usuario, pendiente de plan de implementación
**Entrega:** E1
**Rama/worktree:** `feature/e1-current-rollout` / `/tmp/fusion-e1-current`
**Fuente de objetivo:** `docs/superpowers/plans/plan-maestro-v2.md` §4 (flujo, estados, excepciones)

## Alcance

Este diseño cubre exclusivamente:

1. Apertura de jornada (`OperationalDay`).
2. Ola inicial congelada al abrir.
3. Mini-olas continuas acumulativas (`PickWave`), incluida la mini-ola ML urgente.
4. El aviso de vencimiento del claim de una mini-ola (extensión del claim existente, no un
   mecanismo nuevo).

No cubre: picking consolidado por SKU/ruta física (secuencia de ubicaciones sigue sin definir,
ver plan maestro §4 "decisiones pendientes"), reasignación automática de última unidad (E12),
evidencia/paquetes (E2), ni cambios de UI más allá de lo estrictamente necesario para exponer
el nuevo estado. Es puramente backend/VPS.

## Decisiones confirmadas con el usuario (2026-09-01)

- La ola inicial la dispara manualmente el primer operario al abrir la jornada (no hay cron).
- Después de la ola inicial, hay una única mini-ola "abierta" que acumula todo pedido nuevo
  elegible hasta que un operario la reclama para pickear: en ese momento se congela con
  snapshot de lo que tenía y se abre automáticamente una mini-ola nueva vacía para lo
  siguiente. No hay ventana de tiempo ni agrupación por lotes.
- Un pedido ML urgente crea siempre su propia mini-ola `ml_urgente` aparte, sin esperar
  acumulación (no se mezcla con la mini-ola abierta acumulativa).
- El aviso de vencimiento de claim a los 10 minutos se resuelve server-side: cualquier
  endpoint que devuelva un claim vigente agrega `por_vencer` (bool) y `segundos_restantes`
  calculados contra `expires_at`. No es un estado persistido ni una tabla nueva.
- El SLA de MercadoLibre ya está resuelto en código (`lib/horariosDespacho.js:62`,
  `fechaEstimadaShipment`); falta solo que el responsable de integración confirme el campo
  contra un pedido real de producción (bloqueo de decisión, no de diseño — no bloquea este
  plan, se registra en el bloqueo existente del maestro).
- La secuencia física de ubicaciones NO está definida todavía (confirmado por el usuario). Este
  diseño no la implementa: el picking consolidado por SKU/ruta queda fuera de esta iteración y
  se agrega cuando exista esa decisión.

## Modelo de datos

### `operational_days`

Una fila por fecha local (zona `America/Argentina/Buenos_Aires`, mismo criterio que
`lib/horariosDespacho.js`).

```sql
CREATE TABLE operational_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL UNIQUE,              -- YYYY-MM-DD local
  estado TEXT NOT NULL DEFAULT 'abierta',  -- abierta | cerrada
  hora_corte_web TEXT,                     -- copiado de despacho_horarios al abrir (snapshot)
  ventana_ml_json TEXT,                    -- ventana ML confirmada por humano (texto libre JSON)
  abierta_por TEXT NOT NULL,
  abierta_en TEXT NOT NULL,
  cerrada_por TEXT,
  cerrada_en TEXT
);
```

Por qué snapshot de `hora_corte_web`: el maestro (§17) exige que un cambio de configuración a
mitad de jornada no reescriba silenciosamente el pasado; la jornada ya abierta debe seguir
mostrando el corte que regía cuando se abrió.

### `pick_waves`

```sql
CREATE TABLE pick_waves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operational_day_id INTEGER NOT NULL REFERENCES operational_days(id),
  tipo TEXT NOT NULL,                      -- inicial | mini | ml_urgente
  estado TEXT NOT NULL DEFAULT 'abierta',  -- abierta | congelada | en_picking | completada
  creada_en TEXT NOT NULL,
  congelada_en TEXT,
  congelada_por TEXT,                      -- usuario cuyo claim disparó el freeze
  completada_en TEXT
);
CREATE INDEX idx_pick_waves_day_estado ON pick_waves(operational_day_id, estado);
```

Invariante: a lo sumo una fila `tipo='inicial'` por `operational_day_id` (se crea junto con la
apertura, en la misma transacción, y nace ya `congelada`). A lo sumo una fila
`estado='abierta'` de `tipo='mini'` por día (la mini-ola acumulativa activa) — se aplica con un
índice único parcial:

```sql
CREATE UNIQUE INDEX uq_pick_waves_mini_abierta
  ON pick_waves(operational_day_id)
  WHERE tipo = 'mini' AND estado = 'abierta';
```

`ml_urgente` no tiene este límite: puede haber varias simultáneas (cada pedido ML urgente
nuevo que no cabe en una `ml_urgente` ya abierta y sin congelar crea la suya — en la práctica,
dado que se congelan casi al crearse, esto rara vez se acumula, pero el modelo no lo impide).

### `pick_wave_items`

```sql
CREATE TABLE pick_wave_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pick_wave_id INTEGER NOT NULL REFERENCES pick_waves(id),
  pedido_id INTEGER NOT NULL,              -- FK lógica a pedidos_cache.id
  agregado_en TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_pick_wave_items_pedido ON pick_wave_items(pedido_id);
```

El índice único sobre `pedido_id` (sin `pick_wave_id`) impone la regla de negocio central: un
pedido pertenece a una sola ola/mini-ola viva a la vez. Cuando una mini-ola se congela, sus
`pick_wave_items` quedan fijos (snapshot); no se borran ni se mueven.

### Claim de mini-ola: reutilización, no tabla nueva

`preparacion_claims` ya implementa claim con TTL configurable (`claimPreparacion`,
`routes/preparacion.js:552`). Se generaliza a una columna discriminadora en vez de una tabla
paralela:

```sql
ALTER TABLE preparacion_claims ADD COLUMN entidad TEXT NOT NULL DEFAULT 'preparacion';
-- entidad ∈ {'preparacion', 'pick_wave'}; preparacion_id pasa a interpretarse como
-- "id de la entidad reclamada" según `entidad`.
```

Se evalúa renombrar `preparacion_id` a `entidad_id` en esta misma migración para que el nombre
no mienta; si el volumen de referencias en código lo hace riesgoso para esta entrega, queda
como alias documentado y se revisita en una entrega posterior — decisión que toma
`hard-worker-backend` al implementar, no bloquea el diseño.

`claimPreparacion`/`claimConflict`/`requireClaim` se generalizan para aceptar `entidad` como
parámetro; el comportamiento (TTL, upsert, conflicto 409) es idéntico al ya probado.

## Aviso de vencimiento (`por_vencer`)

No hay tabla ni estado nuevo. Cualquier respuesta que hoy serializa un claim
(`{ usuario, claimed_at, expires_at }`) agrega dos campos calculados en el momento de responder:

```js
function anotarVencimiento(claim, ahora = new Date()) {
  const restanteMs = new Date(claim.expires_at).getTime() - ahora.getTime();
  return {
    ...claim,
    segundos_restantes: Math.max(0, Math.round(restanteMs / 1000)),
    por_vencer: restanteMs <= 10 * 60 * 1000,
  };
}
```

`10 * 60 * 1000` es el aviso; el TTL real de liberación sigue siendo el existente
(`CLAIM_TTL_DEFAULT_MS = 15 * 60 * 1000`, `routes/preparacion.js:545`) — no se toca. Si en el
futuro el TTL configurado baja de 10 minutos, `por_vencer` sería `true` desde el claim inicial;
es un caso de configuración operativa, no un bug de este diseño, y no se valida en código
(el operador que configure un TTL menor a 10 min ya está aceptando ese comportamiento).

## Endpoints nuevos

- `POST /api/preparacion/jornada/abrir` — body `{ hora_corte_web?, ventana_ml_json? }`. Crea
  `operational_days` (rechaza si ya hay una fila para la fecha local de hoy, `409
  OPERATIONAL_DAY_EXISTS`) y en la misma transacción arma la `pick_wave` inicial con snapshot
  de pedidos elegibles (mismo criterio de elegibilidad que ya usa `GET
  /api/preparacion/pendientes`, reutilizado, no reinventado).
- `GET /api/preparacion/jornada/hoy` — devuelve la jornada del día local si existe, o `null`.
- `POST /api/preparacion/jornada/cerrar` — solo supervisor/despacho (mismo criterio de permiso
  que ya usan otros cierres en este router). Marca `cerrada`; no exige reconciliación física
  completa de staging (maestro §2.2).
- `POST /api/preparacion/ola/:id/reclamar` — usa el claim generalizado con `entidad='pick_wave'`.
  Si la ola es `tipo='mini'` y `estado='abierta'`, el claim exitoso congela la ola (snapshot de
  `pick_wave_items` actuales, `estado='congelada'`, `congelada_en`, `congelada_por`) y abre
  atómicamente una mini-ola nueva vacía en la misma transacción. Devuelve el claim anotado con
  `por_vencer`/`segundos_restantes`.
- `GET /api/preparacion/olas` — lista olas del día (para el panel: cuántas mini-olas hay,
  cuál está abierta acumulando, cuál está siendo pickeada por quién).

Ningún endpoint existente de preparación cambia de contrato; la pertenencia a una ola es
metadata adicional expuesta en `GET /api/preparacion/pendientes` (`pick_wave_id`,
`pick_wave_tipo`) para que el panel pueda agrupar visualmente sin una segunda llamada.

## Estados y transiciones

```
operational_days: abierta → cerrada (terminal para el día; no hay reapertura, ver maestro §2.2)

pick_waves:
  inicial:     (nace) → congelada                         [nace ya congelada, no pasa por abierta]
  mini:        abierta → congelada → en_picking → completada
  ml_urgente:  abierta → congelada → en_picking → completada
```

`en_picking`/`completada` son responsabilidad del flujo de preparación existente (claim de
preparación por pedido, ya implementado) — `pick_waves.estado` pasa a `en_picking` cuando el
claim de la ola se toma con éxito (mismo momento del freeze) y a `completada` cuando todos sus
`pick_wave_items` tienen preparación aprobada o retenida explícitamente. El cálculo de
`completada` se hace por consulta (no hay trigger), evaluado en el mismo endpoint que consulta
el estado de una ola.

## Excepciones y concurrencia

- **Dos operarios reclaman la mini-ola abierta al mismo tiempo:** mismo mecanismo ya probado de
  `claimPreparacion` (transacción + `UNIQUE`/lectura antes de update) — uno gana, el otro recibe
  409 `PREPARATION_CLAIMED` (o el código equivalente para `pick_wave`). No hay condición de
  carrera nueva: se reutiliza exactamente el patrón existente.
- **Pedido nuevo llega en el instante exacto del freeze:** el freeze y la apertura de la mini-ola
  siguiente ocurren en una sola transacción SQLite; un `INSERT` en `pick_wave_items` que intente
  sumarse a la mini-ola que se está congelando debe resolver a qué ola pertenece leyendo dentro
  de la misma transacción (usar `SELECT ... FOR UPDATE` no existe en SQLite: se resuelve con la
  transacción exclusiva que ya usa el resto del router, `db.transaction()`). Si ese pedido no
  llega a entrar en el snapshot, cae naturalmente a la mini-ola nueva recién abierta — no hay
  pedido que se pierda, en el peor caso hay una ambigüedad de un evento sobre a cuál de las dos
  mini-olas cayó, y ambos casos son válidos operativamente.
- **Doble apertura de jornada el mismo día:** `UNIQUE(fecha)` + `409
  OPERATIONAL_DAY_EXISTS` con el estado actual en el body, para que el frontend pueda mostrar
  "ya está abierta, por X desde HH:MM" en vez de un error genérico.
- **Cierre de jornada con mini-ola abierta sin pickear:** permitido (maestro §2.2: "pendientes
  se arrastran con alerta"). El cierre no fuerza congelar ni completar nada; el `GET
  /api/preparacion/jornada/hoy` del día siguiente debe poder mostrar que hay una mini-ola
  arrastrada de un `operational_day` anterior aún `abierta` o `congelada`-sin-completar (esto
  es solo lectura para esta entrega: el arrastre real de pendientes ya lo maneja el flujo de
  preparación existente vía pedidos no completados, no algo que `pick_waves` deba resolver).

## Testing (orden TDD)

Antes de escribir el código de rutas, se escriben estos tests (vitest, mismo archivo o uno
nuevo `test/jornada.test.js` según decida `hard-worker-backend` al ver el tamaño):

1. Abrir jornada crea `operational_days` + `pick_wave` inicial congelada con snapshot exacto de
   pedidos elegibles en ese instante (pedido creado un segundo después NO entra en la inicial).
2. Doble apertura el mismo día responde 409 con el estado existente, no crea una segunda fila.
3. Pedido nuevo tras la apertura cae en una mini-ola `abierta` nueva (se crea si no existe).
4. Segundo pedido nuevo se suma a la MISMA mini-ola abierta (no crea una por pedido).
5. Reclamar la mini-ola abierta la congela con exactamente los items que tenía, y abre
   atómicamente una mini-ola nueva vacía; un pedido que llega después del claim cae en la nueva,
   no en la congelada.
6. Dos claims simultáneos sobre la misma mini-ola: uno gana, el otro 409, y no hay doble freeze
   ni dos mini-olas nuevas creadas.
7. Pedido ML urgente crea su propia `ml_urgente` sin tocar la mini-ola acumulativa abierta.
8. `por_vencer` es `false` recién claimeado y `true` cuando faltan ≤10 min para `expires_at`
   (usar tiempo inyectado, no `sleep` real).
9. Cierre de jornada con mini-ola sin pickear no falla y queda reflejado en el estado.

## Riesgos / decisiones que toma quien implemente

- Nombre de columna `preparacion_id` vs `entidad_id` en `preparacion_claims` (ver sección de
  claim arriba) — no bloquea, se resuelve al implementar.
- Si "pedidos elegibles" para la ola inicial debe excluir algo que hoy `GET
  /api/preparacion/pendientes` sí incluye (p. ej. retenidos) — se usa el mismo criterio de
  elegibilidad ya vigente en ese endpoint; cualquier diferencia se trata como bug del contrato
  existente, no como decisión nueva de este diseño.
