# E3 corte 3 — Canario del auto-SKU con relectura y replay: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development o superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Objetivo:** dejar construido y probado, con los flags apagados, todo lo que necesita el día de canario (spec E3 §6–§8 y §12.3):
- relectura de ML antes de vincular;
- observación de formato;
- conjunto congelado;
- aplicación del auto-SKU bajo la autoridad existente;
- clasificación D6 y replay.

Nada se enciende en producción sin José.

**Nota sobre normalización de SKU (pregunta abierta para José):** este plan NO cambia `normalizarSku`
(`src/identidad/sku.ts`). Esa función sólo homogeneiza mayúsculas y espacios de borde; NO colapsa espacios
internos (`"FB 12"` vs `"FB  12"` normalizan distinto), aunque la spec §5 sugiere que debería. Como el SKU
canónico es `^FB-[0-9]+$` (CHECK de `sellable_variants`), un SKU bien formado nunca tiene espacios internos
y esto no cambia ningún vínculo existente en la práctica — por eso no se toca acá. La Tarea 1 agrega un test
que fija (pinnea) el comportamiento actual de `normalizarSku` con espacios internos, para que quede
documentado y cualquier cambio futuro sea deliberado, no un efecto colateral. Si José quiere el colapso de
espacios internos igual, es un cambio aparte fuera de este corte.

**Arquitectura:** todo vive en `plataforma/src/identidad/`.
- `formato.ts` (puro): estructura de una publicación de ML y su hash.
- `relectura-auto-sku.ts`: relectura de ML con la política de §6. La red se lee FUERA de la transacción.
- `aplicar-auto-sku.ts`: una transacción con relectura local, decisión `auto_sku`/`aplicar` y `reconciliarClave`.
- `canario.ts`: congelar el conjunto, correrlo y cerrarlo con su clasificación D6.
- `replay.ts`: el motor sobre la muestra de 299 más las decisiones humanas de la ventana.

`decisionVigente` (autoridad.ts) suma el paso 3 detrás de un modo de auto-SKU. Los CLI de `scripts/` los corre José.

**Stack:** Node 24 + TypeScript ejecutado directo, pg, vitest y Postgres de prueba (mismo harness que `test/identidad/*`).

**Spec:** `docs/superpowers/specs/2026-09-24-e3-identidad-design.md` §3, §6, §7, §8, §11, §12.

## Precondiciones y límites

- Este plan **no** depende de que termine la ventana de 7 días: construye y prueba con fixtures. El día de canario real necesita esa ventana cerrada, el replay en verde y el OK de José.
- Flags nuevos en `src/comun/config.ts`, junto a `E3_BANDEJA`/`E3_MOTOR` (l.152-154): `E3_CANARIO: z.enum(['0','1']).default('0')`, `E3_AUTO_SKU: z.enum(['0','1']).default('0')` y `E3_INTERVENTION: z.enum(['0','1']).default('0')`. Con los tres en `0`, el comportamiento de VINCULACIÓN es idéntico al de hoy (test obligatorio) — la Tarea 6 (transición a `intervention` por cambio posterior) queda además detrás de `E3_INTERVENTION` porque abre casos nuevos aunque `E3_CANARIO`/`E3_AUTO_SKU` estén apagados: con `E3_INTERVENTION=0` no abre nada; con `=1` abre casos `intervention` aunque el canario/auto-SKU sigan apagados (es sombra: observa y avisa, no vincula).
- La relectura usa el relector existente `crearRelectoresMl(...)['ml.items']` (`src/reconciliacion/relectura.ts`). No se crea otro cliente HTTP. Los errores ya vienen clasificados: `ErrorBarridoReintentable` (408/429/5xx, con `retryAfter`) y `ErrorCanalTerminal` (con `status` 401/403/4xx).
- «Formato/pack» (D4) = los campos estructurales que define la Tarea 1. Se verifican contra payloads reales en una **copia** de la base, nunca en producción.

## Restricciones globales

- Nunca `git add -A`: sólo tus archivos, con rutas explícitas. No se tocan los archivos de otras sesiones (ver `git status`).
- Por tarea: sólo tests afectados + `npx tsc --noEmit -p plataforma`. Salida cruda a `/tmp/claude-0/c3-tN-*.txt`. La suite completa la corre opt-55 al final.
- Después de cada tarea: segunda opinión de `codex exec --sandbox read-only` sobre el diff (prompt en inglés, salida a `/tmp/claude-0/codex-c3-tN.txt`). Se responde cada hallazgo y se espera el OK de opt-55.
- Migraciones: `plataforma/migrations/0023_e3_canario.sql`, con `SET lock_timeout = '5s'`. Si 0022 (bandeja) todavía no está commiteada, usar el número siguiente libre y avisar.
- Nada contra producción: ni lecturas de ML, ni migraciones, ni despliegues.

## Foco de revisión

1. **Un SKU que dejó de ser único entre el congelado y la aplicación:** no vincula; el caso va a la bandeja y NO cuenta como error (§7.3). → test en la Tarea 4.
2. **Dos corridas del canario al mismo tiempo, o reintentar una clave ya vinculada:** idempotente; nunca dos decisiones `aplicar` vigentes por clave (UNIQUE parcial existente). → test en la Tarea 5.
3. **La bandeja decide la misma clave mientras el canario la está aplicando:** gana el primero bajo `bloquearDecisiones`; el otro ve `version_conflict` o el caso ya cerrado, y no hay efecto parcial. → test en la Tarea 4.
4. **Relectura con 401 a mitad del conjunto:** se aborta, los ya aplicados quedan como están (no se deshacen efectos confirmados), el resto sigue `pendiente` y la corrida queda `abortada`. → test en la Tarea 5.
5. **Una publicación sin `format_observations` previa:** la primera relectura es la línea base. No es «cambio»: se registra y sigue. → test en la Tarea 2.

---

### Tarea 1: Estructura de formato y su observación

**Archivos:**
- Crear: `plataforma/src/identidad/formato.ts`
- Crear: `plataforma/migrations/0023_e3_canario.sql` (esta tarea crea sólo `format_observations`; las Tareas 3 y 5 agregan lo suyo a la MISMA migración mientras no esté aplicada en ningún lado salvo tests)
- Modificar: `plataforma/src/catalogo/aplicar.ts`: registrar la observación cuando se proyecta un `ml.items`
- Test: `plataforma/test/identidad/formato.test.ts`

**Interfaces:**
- Consume: `normalizarSku` (`src/identidad/sku.ts`) — sólo en el test que fija su comportamiento actual con espacios internos (ver nota bajo el objetivo).
- Produce:
  - `estructuraItemMl(payload: unknown): EstructuraMl`, con `EstructuraMl = { listing_type_id: string|null; catalog_listing: boolean; buying_mode: string|null; sku_vendedor: string|null; variaciones: Array<{ id: string; combinacion: string[]; sku_vendedor: string|null }>; pack: Record<string,string> }`. `sku_vendedor` por atributo/`seller_custom_field` del ítem, y por variación (spec §4: el formato observa también el SKU declarado, no sólo la estructura, para poder distinguir D4 de D6 en la relectura);
  - `hashEstructura(e: EstructuraMl): string`: sha256 de `canonizar(e)` (`src/informes/jcs.ts`);
  - `registrarFormato(tx, { cuenta, recurso, estructura, versionRemota: string|null, origen: 'barrido'|'relectura' }): Promise<{ resultado: 'nueva'|'igual'|'cambio'; que: 'sku'|'formato'|null }>`. Antes de leer la última observación, toma
    `pg_advisory_xact_lock(hashtextextended('identidad.formato:'||cuenta||':'||recurso, 0))`: dos llamadas
    concurrentes para la MISMA clave (un barrido y una relectura del canario solapados, por ejemplo) no
    deben poder leer la misma "última" fila y las dos insertar como si fueran la primera en detectar el
    cambio. El lock se libera solo al cierre de la transacción (`xact`), sin unlock explícito.

- [ ] **Paso 0: Verificar los campos contra payloads reales en una COPIA.** Levantar la copia como en el backfill (postgres:18-alpine aislado, dump/restore, sin puertos). Descifrar 30 payloads de `integrations.inbox_messages` con topic `ml.items` y variedad: con variaciones, sin variaciones, catálogo y packs. Usar `descifrarSobre` + keyring, el mismo camino que `src/catalogo/backfill-titulo-observado.ts`. Listar qué `attributes[].id` aparecen que signifiquen unidades por pack o formato de venta, por ejemplo `UNITS_PER_PACK`, `SALE_FORMAT` o `PACKAGE_UNITS`. Guardar sólo los ids de atributo y los conteos (sin títulos ni precios) en `/tmp/claude-0/c3-t1-atributos-pack.txt`. Destruir la copia. La lista final de ids va como constante `ATRIBUTOS_PACK` en `formato.ts`, con un comentario que cite ese archivo y la fecha.

- [ ] **Paso 1: Tests que fallan:**

```ts
it('la estructura ignora precio, stock, título y fechas', () => {
  const a = estructuraItemMl({ ...base, price: 100, available_quantity: 3, title: 'x', last_updated: '2026-09-01T00:00:00Z' });
  const b = estructuraItemMl({ ...base, price: 999, available_quantity: 0, title: 'y', last_updated: '2026-09-25T00:00:00Z' });
  expect(hashEstructura(a)).toBe(hashEstructura(b));
});
it('cambiar el pack, el tipo de publicación o las variaciones cambia el hash', () => {
  const h = hashEstructura(estructuraItemMl(base));
  expect(hashEstructura(estructuraItemMl({ ...base, attributes: [{ id: ATRIBUTOS_PACK[0], value_name: '2' }] }))).not.toBe(h);
  expect(hashEstructura(estructuraItemMl({ ...base, listing_type_id: 'gold_pro' }))).not.toBe(h);
  expect(hashEstructura(estructuraItemMl({ ...base, variations: [] }))).not.toBe(h);
});
it('el orden de variaciones y de combinaciones no cambia el hash', () => { /* mismo item con arrays invertidos */ });
it('[pin] normalizarSku NO colapsa espacios internos (comportamiento actual, no lo cambia este corte)', () => {
  expect(normalizarSku('FB 12')).not.toBe(normalizarSku('FB  12')); // dos espacios vs uno: siguen distintos
});
it('registrarFormato: primera vez nueva, igual no inserta, distinta con SKU distinto es cambio/sku, distinta con estructura distinta es cambio/formato', async () => {
  expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e1, versionRemota: 'v1', origen: 'barrido' })).toEqual({ resultado: 'nueva', que: null });
  expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e1, versionRemota: 'v1', origen: 'relectura' })).toEqual({ resultado: 'igual', que: null });
  const eSkuDistinto = { ...e1, sku_vendedor: 'FB-OTRO' };
  expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: eSkuDistinto, versionRemota: 'v2', origen: 'relectura' })).toEqual({ resultado: 'cambio', que: 'sku' });
  expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e2, versionRemota: 'v3', origen: 'relectura' })).toEqual({ resultado: 'cambio', que: 'formato' });
  expect((await tx.query('select count(*)::int n from catalog.format_observations')).rows[0].n).toBe(3);
});
it('dos registrarFormato concurrentes para la MISMA clave, con la misma estructura nueva: sólo uno inserta', async () => {
  // Dos transacciones (dos conexiones del pool), NO la misma tx: el advisory lock serializa la segunda
  // hasta que la primera cierra, y entonces la segunda ve la fila que la primera ya insertó.
  const [r1, r2] = await Promise.all([
    registrarFormato(pool, { cuenta, recurso: 'MLA2', estructura: e1, versionRemota: 'v1', origen: 'barrido' }),
    registrarFormato(pool, { cuenta, recurso: 'MLA2', estructura: e1, versionRemota: 'v1', origen: 'barrido' }),
  ]);
  expect([r1.resultado, r2.resultado].sort()).toEqual(['igual', 'nueva']);
  expect((await pool.query("select count(*)::int n from catalog.format_observations where recurso = 'MLA2'")).rows[0].n).toBe(1);
});
```

- [ ] **Paso 2: Ver que fallan** → `/tmp/claude-0/c3-t1-rojo.txt`

- [ ] **Paso 3: Migración (parte 1):**

```sql
-- 0023 — E3 corte 3: canario del auto-SKU. Parte 1: observación de formato (D4, spec §6).
SET lock_timeout = '5s';
CREATE TABLE catalog.format_observations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_account_id uuid NOT NULL,
  recurso text NOT NULL,
  hash_estructura text NOT NULL,
  estructura jsonb NOT NULL,
  -- Columnas propias por spec §4 (no sólo el jsonb de estructura): permiten filtrar/leer sin parsear jsonb.
  version_remota text,
  variaciones jsonb,
  cantidad_pack int,
  listing_type text,
  catalog_listing boolean,
  seller_sku text,
  origen text NOT NULL CHECK (origen IN ('barrido','relectura')),
  observado_en timestamptz NOT NULL DEFAULT now());
CREATE INDEX format_observations_ultima ON catalog.format_observations (channel_account_id, recurso, observado_en DESC, id DESC);
```

Sólo se inserta una fila cuando el hash difiere de la última. La tabla es la historia de cambios, no un log por lectura.

`registrarFormato` recibe además `versionRemota: string | null` (la versión/revisión que trae el payload de
ML, si la tiene) y la guarda en `version_remota`. Devuelve `{ resultado: 'nueva'|'igual'|'cambio'; que: 'sku'|'formato'|null }`:
`que` distingue si lo que cambió respecto de la última observación fue el `seller_sku` (declarado, D6) o el
resto de la estructura (D4) — `null` cuando `resultado` no es `'cambio'`. Los llamadores de la Tarea 6 (que
necesitan diferenciar intervention por SKU vs. por formato) usan este campo en vez de volver a comparar
estructuras.

- [ ] **Paso 4: Implementar `formato.ts`.** Ordenar las variaciones por id y cada combinación como `"<attr_id>=<value_id|value_name>"`, también ordenada. `pack` = los atributos cuyo id está en `ATRIBUTOS_PACK`.

- [ ] **Paso 5: Enganchar en `aplicar.ts`.** Donde se proyecta un payload `ml.items` (la misma transacción de `aplicarProyeccion`), llamar `registrarFormato(..., origen: 'barrido')`. Si `resultado === 'cambio'`, NO hacer nada más en esta tarea: la transición a `intervention` es la Tarea 6.

- [ ] **Paso 6: Verde** (`formato.test.ts` + los tests del proyector: `test/catalogo/*.test.ts` que toquen ML) → `/tmp/claude-0/c3-t1-verde.txt`, más tsc.

- [ ] **Paso 7: Commit** de los archivos de la tarea.

### Tarea 2: Relectura para el auto-SKU (política §6)

**Archivos:**
- Crear: `plataforma/src/identidad/relectura-auto-sku.ts`
- Test: `plataforma/test/identidad/relectura-auto-sku.test.ts`

**Interfaces:**
- Consume: `Relector` (`src/reconciliacion/relectura.ts`), `estructuraItemMl` y `hashEstructura` (Tarea 1), `normalizarSku` (`src/identidad/sku.ts`).
- Produce:
  - `releerParaAutoSku(relector: Relector, e: { recurso: string; variacion: string; skuCongelado: string; hashFormatoPrevio: string | null }, dep?: { esperar?(ms:number):Promise<void>; azar?():number }): Promise<ResultadoRelecturaAutoSku>`
  - `ResultadoRelecturaAutoSku = { tipo: 'ok'; hashPayload: string; estructura: EstructuraMl } | { tipo: 'cambio'; que: 'sku'|'formato'; detalle: object } | { tipo: 'no_disponible'; motivo: 'not_found'|'closed'|'deleted' } | { tipo: 'parked'; motivo: string } | { tipo: 'abortar'; status: 401|403 }`

**Tabla de la política** (§6; cada fila es un test):

| Entrada | Resultado |
|---|---|
| 200, SKU y formato iguales (o formato previo null) | `ok` |
| 200, publicación `paused` | `ok` (sigue elegible) |
| 200, `closed` o `deleted` | `no_disponible` |
| 404 (`sin_baja`) | `no_disponible` (`not_found`) |
| 200 con SKU normalizado distinto | `cambio` / `sku` |
| 200 con hash de formato distinto del previo | `cambio` / `formato` |
| `ErrorBarridoReintentable` 3 veces (backoff 1 s·2^n con jitter ±20 %, respetando `retryAfter`) | `parked` |
| respuesta sin `id`/`status` o SKU no legible | `parked` (`incompleta`) |
| `ErrorCanalTerminal` 401/403 | `abortar` |
| otro `ErrorCanalTerminal` | `parked` |

El SKU de la variación: si `variacion` no es `''`, se toma el `seller_custom_field` o el atributo `SELLER_SKU` de la variación con ese id; si no, el del ítem. **Es la misma regla que ya usa `sku_observado`**: ubicarla en `src/catalogo/ml.ts` y reusarla. No escribir otra.

- [ ] **Paso 1: Tests que fallan:** uno por fila de la tabla, con un `Relector` falso que devuelve o lanza lo indicado. Para el reintento: `esperar` registra las esperas y se afirma que hubo 2 esperas antes del `parked`, y que la primera respeta `retryAfter` si viene.
- [ ] **Paso 2: Ver que fallan** → `/tmp/claude-0/c3-t2-rojo.txt`
- [ ] **Paso 3: Implementar.** `hashPayload` = sha256 de `canonizar(payload)` del ítem releído. Queda guardado en la decisión (Tarea 4).
- [ ] **Paso 4: Verde** → `/tmp/claude-0/c3-t2-verde.txt`
- [ ] **Paso 5: Commit.**

### Tarea 3: Autoridad paso 3 (auto-SKU aplicado detrás de un modo)

**Archivos:**
- Modificar: `plataforma/migrations/0023_e3_canario.sql` (parte 2)
- Modificar: `plataforma/src/identidad/autoridad.ts`
- Modificar: los llamadores de `decisionVigente`: `src/catalogo/aplicar.ts:224`, `src/catalogo/decisiones.ts` (`reconciliarClave`), `src/identidad/motor.ts` (paso 2) y `src/catalogo/copias.ts` (los que pasan `{ bandeja }`)
- Modificar: `plataforma/src/comun/config.ts` (flags)
- Test: `plataforma/test/identidad/autoridad.test.ts`

**Interfaces:**
- Produce: `decisionVigente(tx, cuenta, recurso, variacion, o: { bandeja: boolean; autoSku?: 'apagado'|'aplicado' })`. Con `'aplicado'`, el orden es el de §3: humano → legado → auto_sku. El auto_sku aplicado sólo se consulta si no hay humana ni legado. Devuelve `{ fuente: 'auto_sku'; eleccion: 'vincular'; variantId; decisionId }`.
- El modo se decide en el llamador: `'aplicado'` si `E3_AUTO_SKU=1`, o si `E3_CANARIO=1` y la clave está en la corrida de canario abierta (Tarea 5). Para eso: `modoAutoSku(tx, cuenta, recurso, variacion, flags): Promise<'apagado'|'aplicado'>` en `autoridad.ts`.

- [ ] **Paso 1: Migración (parte 2):**

`hash_payload_ml` ya existe (0020:38, nulable): esta parte NO lo agrega de nuevo. Lo que sí hay que
reemplazar es el CHECK sin nombre de 0020:45 (`CHECK (origen <> 'auto_sku' OR efecto = 'sombra')`), que hoy
prohíbe exactamente `auto_sku`+`aplicar` — el propio comentario de 0020:13 avisa que este corte lo reemplaza.
Como es un CHECK de columna sin nombre (nombre autogenerado por Postgres, no fijo entre entornos), se ubica
por su definición vía `pg_constraint`/`pg_get_constraintdef`, no por nombre:

```sql
-- Parte 2: el auto-SKU puede APLICAR (canario o E3_AUTO_SKU). hash_payload_ml ya existe desde 0020:38;
-- acá se reemplaza el CHECK sin nombre de 0020:45 que hoy prohíbe auto_sku+aplicar, por uno que además
-- exige hash_payload_ml cuando efecto='aplicar' con origen='auto_sku' (evidencia de qué se releyó).
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname
    FROM pg_constraint
   WHERE conrelid = 'catalog.identity_decisions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%auto_sku%sombra%';
  IF v_conname IS NULL THEN
    RAISE EXCEPTION '0023: no se encontró el CHECK de 0020:45 (origen<>auto_sku OR efecto=sombra) en catalog.identity_decisions; revisar antes de continuar';
  END IF;
  EXECUTE format('ALTER TABLE catalog.identity_decisions DROP CONSTRAINT %I', v_conname);
END $$;
ALTER TABLE catalog.identity_decisions ADD CONSTRAINT auto_sku_aplicar_con_hash
  CHECK (origen <> 'auto_sku' OR efecto = 'sombra' OR (efecto = 'aplicar' AND hash_payload_ml IS NOT NULL));
```

- [ ] **Paso 1b: Tests de esquema** (antes o junto con el Paso 2): un INSERT `auto_sku`/`aplicar` SIN
  `hash_payload_ml` es rechazado por el CHECK; el mismo INSERT CON `hash_payload_ml` pasa; un INSERT
  `humano`/`sombra` (combinación inválida por el otro CHECK de 0020:44) sigue rechazado. Corren contra la
  base de prueba ya migrada, no contra producción.

- [ ] **Paso 2: Tests que fallan** en `autoridad.test.ts`:
  - `[esc:flag-apagado]` con `autoSku` omitido o `'apagado'`: una `auto_sku`/`aplicar` vigente es INVISIBLE (devuelve lo mismo que hoy);
  - con `'aplicado'` y sin humana ni legado: devuelve la `auto_sku`;
  - con `'aplicado'` y un legado `omitir`: gana el legado;
  - con `'aplicado'` y una humana: gana la humana;
  - una `auto_sku` con efecto `sombra` nunca se devuelve, en ningún modo.
- [ ] **Paso 3: Ver que fallan** → `/tmp/claude-0/c3-t3-rojo.txt`
- [ ] **Paso 4: Implementar** en `autoridad.ts` y pasar el modo desde cada llamador. **Invariante:** con `E3_CANARIO=0` y `E3_AUTO_SKU=0`, ningún llamador consulta `e3_canario_*` ni la rama nueva. Test que lo afirma contando queries con un `Consultable` espía.
- [ ] **Paso 5: Verde** (`autoridad.test.ts`, `decidir.test.ts`, `motor.test.ts` y los tests de `catalogo/` que usan `decisionVigente`) → `/tmp/claude-0/c3-t3-verde.txt`
- [ ] **Paso 6: Commit.**

### Tarea 4: Aplicar un auto-SKU (§6, una transacción)

**Archivos:**
- Crear: `plataforma/src/identidad/aplicar-auto-sku.ts`
- Test: `plataforma/test/identidad/aplicar-auto-sku.test.ts`

**Interfaces:**
- Consume: `ResultadoRelecturaAutoSku` (T2), `registrarFormato` (T1), `skuUnico`/`normalizarSku` (`sku.ts`), `bloquearDecisiones`/`reconciliarClave` (`catalogo/decisiones.ts`), `registrarEvento` (`audit/auditoria.ts`).
- Produce: `aplicarAutoSku(pool, e: { casoId: string; cuenta: string; recurso: string; variacion: string; skuCongelado: string; variantIdCongelada: string }, relectura: ResultadoRelecturaAutoSku, o: { bandeja: boolean }): Promise<{ resultado: 'vinculado'|'bandeja'|'intervention'|'parked'|'abortar'|'ya_resuelto'; detalle?: object }>`

**Qué hace**, en este orden y en una sola transacción, salvo que la relectura ya venga como `parked`/`abortar` (esos no abren transacción):
1. `bloquearDecisiones(tx, cuenta)`; `SELECT … FOR UPDATE` del caso. Si está cerrado o ya tiene una decisión humana vigente → `ya_resuelto`, sin escribir nada.
2. `no_disponible` → caso a `actionable`, con evidencia INSERTADA en `catalog.identity_evidence` existente
   (0020, `fuente='ml'`, `hash` = el hash del payload releído si lo hay, `campos` con el motivo/detalle de la
   relectura) — NO en `detalle.canario`: esa tabla ya existe justo para esto (D4), no hace falta una columna
   nueva. Resultado `bandeja`.
3. `cambio` → caso a `intervention` + evidencia en `catalog.identity_evidence` (mismo patrón que el paso 2). No vincula.
4. `ok` → relectura local: `skuUnico(empresa, skuCongelado)` tiene que seguir siendo `{ variantId: variantIdCongelada }`. Si da otra, `varias` o `ninguna` → `bandeja` (§7.3: no es error).
5. Registrar formato (`origen: 'relectura'`). Si `resultado === 'cambio'` → `intervention` (usa `que` para el detalle guardado).
6. **BUG evitado (hallazgo de opt-55):** `supersede_a` NO puede apuntar a la decisión `auto_sku`/`sombra`
   vigente. El trigger `identity_decisions_superar_anterior` (0020) exige `anterior.efecto = NEW.efecto`
   para aceptar un `supersede_a`; la nueva fila es `efecto='aplicar'` y la `sombra` vigente tiene
   `efecto='sombra'` — apuntarla ahí aborta el INSERT entero (`supersede_a % es de otra clave o empresa`).
   La decisión `aplicar` se inserta SIN `supersede_a` (NULL): coexiste con la `auto_sku`/`sombra` vigente,
   que sigue ahí sin superar — son dos anotaciones distintas de la misma clave, tal como ya documenta el
   comentario de 0020:18. `autoridad.ts` (Tarea 3) ya resuelve la prioridad correcta entre las dos (humano →
   legado → `auto_sku`/`aplicar`; `sombra` nunca se devuelve en ningún modo), así que no hace falta
   superarla para que deje de "ganar". INSERT: `origen='auto_sku'`, `efecto='aplicar'`, `hash_payload_ml`,
   `engine_version`, `supersede_a = NULL` → `reconciliarClave(..., 'e3 canario: sku exacto')`. Si NO
   devuelve `'vinculada'` a `variantIdCongelada`, la transacción entera hace rollback y el resultado es
   `parked` (`reconciliar_distinto`).
7. Caso a `verified` y `version+1`; evento de auditoría `identidad.auto_sku_aplicado` con el antes y el después.

- [ ] **Paso 1: Tests que fallan:**
  - `[esc:auto-sku-unico]` vincula;
  - `[esc:aplicar-no-supera-sombra]` cuando hay una `auto_sku`/`sombra` vigente para la misma clave: la decisión `aplicar` se inserta con `supersede_a = NULL` y NO la supera (`superada_en` de la sombra sigue NULL después); las dos coexisten en la tabla;
  - SKU que dejó de ser único → `bandeja` y sin decisión;
  - `[esc:relectura-cambio]` → `intervention`, sin vínculo;
  - caso ya decidido por humano → `ya_resuelto` con 0 filas nuevas;
  - la bandeja decide en paralelo: dos transacciones concurrentes (patrón del test `[esc:409-dos-operadores]` de `decidir.test.ts`) → exactamente una decisión vigente y ningún efecto parcial;
  - reintentar `aplicarAutoSku` sobre una clave ya vinculada → `ya_resuelto`, sin segunda decisión;
  - si `reconciliarClave` no vincula → rollback completo (0 decisiones nuevas y caso sin cambios).
- [ ] **Paso 2: Ver que fallan** → `/tmp/claude-0/c3-t4-rojo.txt`
- [ ] **Paso 3: Implementar.**
- [ ] **Paso 4: Verde** → `/tmp/claude-0/c3-t4-verde.txt`
- [ ] **Paso 5: Commit.**

### Tarea 5: Canario: congelar, correr, cerrar con D6

**Archivos:**
- Modificar: `plataforma/migrations/0023_e3_canario.sql` (parte 3)
- Crear: `plataforma/src/identidad/canario.ts`
- Crear: `plataforma/scripts/e3-canario.ts` (CLI: `congelar | correr | cerrar | estado`, con `--apply` obligatorio para escribir; sin `--apply` imprime lo que haría)
- Test: `plataforma/test/identidad/canario.test.ts`

**Interfaces:**
- Consume: todo lo de las Tareas 1–4 y el relector `ml.items`.
- Produce:
  - `congelarCanario(pool, { empresa, dia }): Promise<{ corridaId; casos: number; excluidosD5: number }>`: congela los `sku_pendiente` abiertos con `auto_sku`/`sombra` vigente, SKU único y sin decisión humana ni legado; excluye `detalle.d5=true` y las 17;
  - `correrCanario(pool, relector, { corridaId, bandeja }): Promise<ResumenCanario>`. Límites de transacción
    por caso (así se puede correr con concurrencia y recuperar de un worker que se cae a mitad, sin abrir una
    transacción larga que abarque una llamada de red):
    (a) transacción corta: reclama el caso con `SELECT ... FOR UPDATE SKIP LOCKED` sobre la fila de
        `e3_canario_casos` en estado `pendiente` (o `parked` para reintento) y CON `tomado_hasta` vencido o
        NULL, y fija `tomado_por = <id del proceso>`, `tomado_hasta = now() + interval '2 minutes'`. `SKIP
        LOCKED` dentro del `FOR UPDATE` es lo que permite que dos `correr` concurrentes tomen casos
        DISTINTOS sin bloquearse entre sí, y el filtro por `tomado_hasta` es lo que permite reclamar un caso
        cuyo lease anterior venció (un worker que se cayó a mitad) sin esperar a que ese worker vuelva;
    (b) la relectura a ML (`releerParaAutoSku`) corre AFUERA de cualquier transacción — igual que el resto
        del código de red del proyecto (`cliente-http.ts`, cortes anteriores): nunca hay I/O de red dentro de
        una transacción de Postgres;
    (c) `aplicarAutoSku` (Tarea 4) corre en SU PROPIA transacción, que ya incluye el UPDATE del estado del
        caso en `e3_canario_casos` (a `vinculado`/`bandeja`/`intervention`/etc., limpiando `tomado_por`);
    (d) si la relectura o `aplicarAutoSku` devuelven `abortar` (401/403), una transacción SEPARADA marca la
        corrida (`e3_canario_corridas.estado = 'abortada'`) y libera el lease del caso actual (`tomado_por =
        NULL, tomado_hasta = NULL`, vuelve a `pendiente`); los casos ya `vinculado` en pasadas anteriores NO
        se tocan (paso 4 del "Qué hace" de la Tarea 4 ya es atómico por caso, así que no hay estado a medio
        camino que deshacer).
  - `cerrarCanario(pool, { corridaId }): Promise<ClasificacionD6>`, con `ClasificacionD6 = { errores: Array<{ tipo: 'corregido_por_jose'|'parked_sin_resolver'; recurso: string }>; noErrores: Record<'redundante'|'intervention'|'dejo_de_ser_unico'|'no_disponible', number>; veredicto: 'cero_errores'|'con_errores'|'abortado' }`.

- [ ] **Paso 1: Migración (parte 3):**

```sql
-- Parte 3: conjunto congelado del día de canario (spec §7.1).
CREATE TABLE catalog.e3_canario_corridas (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  dia date NOT NULL,
  estado text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada','abortada')),
  congelado_en timestamptz NOT NULL DEFAULT now(),
  cerrado_en timestamptz,
  clasificacion jsonb,
  UNIQUE (company_id, dia));
CREATE UNIQUE INDEX e3_canario_una_abierta ON catalog.e3_canario_corridas (company_id) WHERE estado = 'abierta';
CREATE TABLE catalog.e3_canario_casos (
  corrida_id uuid NOT NULL REFERENCES catalog.e3_canario_corridas(id),
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id),
  channel_account_id uuid NOT NULL, recurso text NOT NULL, variacion_normalizada text NOT NULL,
  sku_congelado text NOT NULL, variant_id_congelada uuid NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','vinculado','bandeja','intervention','parked','ya_resuelto')),
  intentos int NOT NULL DEFAULT 0, detalle jsonb,
  -- Lease corto por caso (paso 4a más abajo): quién lo está procesando ahora mismo y hasta cuándo, para que
  -- dos `correr` concurrentes (o un `correr` colgado) no procesen el mismo caso dos veces en paralelo.
  tomado_por text, tomado_hasta timestamptz,
  PRIMARY KEY (corrida_id, case_id));
```

- [ ] **Paso 2: Tests que fallan:**
  - `congelar` excluye D5, las que tienen humana o legado, y SKU `varias`;
  - una segunda `congelar` el mismo día falla (UNIQUE) y no toca la primera;
  - un caso abierto DESPUÉS del congelado no entra;
  - `correr` es idempotente (dos veces seguidas: los `vinculado` no se re-aplican);
  - un caso con `tomado_hasta` VENCIDO (de un `correr` anterior que se cayó a mitad) es reclamado por un `correr` nuevo;
  - un caso con `tomado_hasta` VIGENTE de OTRO proceso se deja en paz (no lo reclama un `correr` concurrente, ni se re-procesa mientras el lease siga vivo);
  - `[esc:canario-401]` a mitad: la corrida pasa a `abortada`, los ya vinculados quedan, el caso en curso libera su lease y vuelve a `pendiente`, y el resto sigue `pendiente`;
  - `[esc:relectura-5xx]` → `parked`; un segundo `correr` lo reintenta y, si da ok, pasa a `vinculado`;
  - `cerrar`:
    - un `parked` al cierre cuenta como error;
    - una decisión humana posterior a otra variante cuenta como error `corregido_por_jose`;
    - una humana igual cuenta como `redundante`;
    - el veredicto es `cero_errores` sólo si no hay ningún error.
- [ ] **Paso 3: Ver que fallan** → `/tmp/claude-0/c3-t5-rojo.txt`
- [ ] **Paso 4: Implementar `canario.ts` y el CLI.** El CLI arma el relector igual que `src/worker/main.ts:53-60` (transporte por cuenta desde el registro), usa `DATABASE_URL` y `CATALOGO_KEYRING_FILE` como el backfill, e imprime un resumen sin PII (conteos y recursos MLA).
- [ ] **Paso 5: Verde** → `/tmp/claude-0/c3-t5-verde.txt`
- [ ] **Paso 6: Commit.**

### Tarea 6: Transición `verified → intervention` por cambio posterior (§8)

**Archivos:**
- Modificar: `plataforma/src/catalogo/aplicar.ts`: el punto de la Tarea 1 donde `registrarFormato` devuelve `resultado: 'cambio'`, y la observación de `sku_observado`
- Crear: `plataforma/migrations/0023_e3_canario.sql` parte 4: `catalog.identity_commands (id uuid pk default uuidv7(), case_id uuid not null references catalog.identity_cases(id), tipo text not null check (tipo in ('pausar_publicacion')), estado text not null default 'parked' check (estado in ('parked')), motivo text not null, creado_en timestamptz not null default now())`. No hay ejecutor: es para E4.
- Test: `plataforma/test/identidad/intervention.test.ts`

**Interfaces:**
- Consume: `registrarFormato` (T1).
- Produce: al proyectar un `ml.items` cuya clave tiene una decisión VIGENTE `auto_sku`/`aplicar` (o humana `vincular`):
  - si el SKU normalizado observado ya no es el de la variante vinculada → caso `intervention` (se reabre o crea `tipo='sku_cambiado'` sobre la representación). El vínculo NO cambia;
  - si el formato dio `resultado: 'cambio'` (con `que: 'formato'`; `que: 'sku'` ya lo cubre la rama anterior) → caso `intervention` + un `identity_commands` `pausar_publicacion` `parked`. El vínculo NO cambia;
  - en los dos casos, evento de auditoría `identidad.intervention`.

- [ ] **Paso 1: Tests que fallan:**
  - cambio de SKU → intervention sin tocar `variant_id`;
  - cambio de formato → intervention + 1 comando parked;
  - la misma observación repetida no duplica el caso ni el comando;
  - sin decisión vigente → nada;
  - `E3_INTERVENTION=0` (default): no abre ningún caso `intervention` aunque el resto de las condiciones se cumplan — es la corrección al ítem anterior de este plan, que decía "con los flags apagados esto sigue funcionando"; eso era incorrecto: sin `E3_INTERVENTION=1` esta tarea no abre nada;
  - `E3_INTERVENTION=1` con `E3_CANARIO=0` y `E3_AUTO_SKU=0`: SÍ abre casos `intervention` igual (es sombra, no depende del canario ni del auto-SKU aplicado).
- [ ] **Paso 2: Rojo** → `/tmp/claude-0/c3-t6-rojo.txt`
- [ ] **Paso 3: Implementar.** Verificar en 0020 que `'intervention'` esté en el CHECK de `estado` (lo está) y si `tipo` tiene CHECK; si lo tiene, agregar `'sku_cambiado'` en la parte 4.
- [ ] **Paso 4: Verde** → `/tmp/claude-0/c3-t6-verde.txt`
- [ ] **Paso 5: Commit.**

### Tarea 7: Replay previo al canario (§7.2)

**Archivos:**
- Crear: `plataforma/src/identidad/replay.ts`
- Crear: `plataforma/scripts/e3-replay.ts`
- Test: `plataforma/test/identidad/replay.test.ts`

**Interfaces:**
- Consume: `calibrar` (`src/identidad/calibracion.ts`), para top-1/top-3 sobre la muestra y las humanas de la ventana.
- Produce: `replay(pool, { empresa, desde, hasta }): Promise<{ calibracion: Metricas; autoSkuVsHumano: { coinciden: number; difieren: Array<{ recurso: string; autoSku: string; humano: string }> }; veredicto: 'apto'|'no_apto' }>`. Es `apto` sólo si `difieren.length === 0`: es el error D6 tipo 2, medido sobre la ventana.

**Denominador de `autoSkuVsHumano` (precisión sobre el ítem del plan original, que no lo definía):** sólo
entran las claves con una `auto_sku` Y con una verdad humana conocida — una decisión humana vigente
`vincular` (compara contra esa variante), o `sin_candidato`/`omitir` (verdad = "no es ninguna candidata",
así que cualquier `auto_sku` vigente sobre esa clave cuenta como `difieren`). Una clave con `auto_sku` pero
SIN ninguna decisión humana (ni vincular ni sin_candidato/omitir) NO entra en el denominador: no hay verdad
contra la cual comparar, así que ni suma a `coinciden` ni a `difieren`. Igual que `calibracion.ts`, un
apartado («No estoy seguro») no es una decisión y por lo tanto tampoco entra.

- [ ] **Paso 1: Tests que fallan:**
  - una `auto_sku`/`sombra` igual a la humana `vincular` → coincide;
  - una distinta → `difieren` y `no_apto`;
  - una humana `sin_candidato` sobre una clave con `auto_sku` → cuenta en `difieren` (el humano dijo que no es esa);
  - una humana `apartado` (no es decisión) no cuenta;
  - una `auto_sku` sobre una clave SIN ninguna decisión humana (ni vincular ni sin_candidato/omitir) → no entra en el denominador: no suma ni a `coinciden` ni a `difieren`.
- [ ] **Paso 2: Rojo** → `/tmp/claude-0/c3-t7-rojo.txt`
- [ ] **Paso 3: Implementar**, más el CLI: sólo lectura, imprime el JSON.
- [ ] **Paso 4: Verde** → `/tmp/claude-0/c3-t7-verde.txt`
- [ ] **Paso 5: Commit.**

### Tarea 8: `test:e3` completo y cierre

**Archivos:**
- Modificar: `plataforma/test/identidad/cobertura-e3.test.ts`: los tres `it.todo` de E3-COV-02 pasan a exigir `[esc:relectura-cambio]`, `[esc:relectura-5xx]` y `[esc:canario-401]`.

- [ ] **Paso 1:** Reemplazar los `it.todo` por claves en una lista `C3` con el mismo `it.each` que `C1`.
- [ ] **Paso 2:** `npm run test:e3` (dentro de `plataforma`) → `/tmp/claude-0/c3-t8-teste3.txt`. Tiene que pasar y no puede quedar ningún `todo`.
- [ ] **Paso 3:** Segunda opinión de Codex sobre el diff COMPLETO del corte → `/tmp/claude-0/codex-c3-final.txt`.
- [ ] **Paso 4:** Avisar a opt-55. opt-55 revisa y corre la suite completa una vez.
- [ ] **Paso 5 (con José):**
  1. aplicar 0023 en producción;
  2. desplegar el worker con `E3_CANARIO=0`, `E3_AUTO_SKU=0` y `E3_INTERVENTION=0`, que no cambia nada de la vinculación NI abre casos nuevos (antes se etiqueta la imagen de cada servicio para poder volver atrás);
  3. José activa `E3_INTERVENTION=1` (sombra: abre casos `intervention`, no vincula) para dejar correr la Tarea 6;
  4. al cierre de la ventana de 7 días: `e3-replay`, y si da `apto`, José autoriza `e3-canario congelar/correr/cerrar`.
