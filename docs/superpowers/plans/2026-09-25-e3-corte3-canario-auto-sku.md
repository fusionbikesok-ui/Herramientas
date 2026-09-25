# E3 corte 3 — Canario del auto-SKU con relectura y replay: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development o superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Objetivo:** dejar construido y probado, con los flags apagados, todo lo que necesita el día de canario (spec E3 §6–§8 y §12.3):
- relectura de ML antes de vincular;
- observación de formato;
- conjunto congelado;
- aplicación del auto-SKU bajo la autoridad existente;
- clasificación D6 y replay.

Nada se enciende en producción sin José.

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
- Flags nuevos en `src/comun/config.ts`, junto a `E3_BANDEJA`/`E3_MOTOR` (l.152-154): `E3_CANARIO: z.enum(['0','1']).default('0')` y `E3_AUTO_SKU: z.enum(['0','1']).default('0')`. Con los dos en `0`, el comportamiento es idéntico al de hoy (test obligatorio).
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
- Produce:
  - `estructuraItemMl(payload: unknown): EstructuraMl`, con `EstructuraMl = { listing_type_id: string|null; catalog_listing: boolean; buying_mode: string|null; variaciones: Array<{ id: string; combinacion: string[] }>; pack: Record<string,string> }`;
  - `hashEstructura(e: EstructuraMl): string`: sha256 de `canonizar(e)` (`src/informes/jcs.ts`);
  - `registrarFormato(tx, { cuenta, recurso, estructura, origen: 'barrido'|'relectura' }): Promise<'nueva'|'igual'|'cambio'>`.

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
it('registrarFormato: primera vez nueva, igual no inserta, distinta es cambio', async () => {
  expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e1, origen: 'barrido' })).toBe('nueva');
  expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e1, origen: 'relectura' })).toBe('igual');
  expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e2, origen: 'relectura' })).toBe('cambio');
  expect((await tx.query('select count(*)::int n from catalog.format_observations')).rows[0].n).toBe(2);
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
  origen text NOT NULL CHECK (origen IN ('barrido','relectura')),
  observado_en timestamptz NOT NULL DEFAULT now());
CREATE INDEX format_observations_ultima ON catalog.format_observations (channel_account_id, recurso, observado_en DESC, id DESC);
```

Sólo se inserta una fila cuando el hash difiere de la última. La tabla es la historia de cambios, no un log por lectura.

- [ ] **Paso 4: Implementar `formato.ts`.** Ordenar las variaciones por id y cada combinación como `"<attr_id>=<value_id|value_name>"`, también ordenada. `pack` = los atributos cuyo id está en `ATRIBUTOS_PACK`.

- [ ] **Paso 5: Enganchar en `aplicar.ts`.** Donde se proyecta un payload `ml.items` (la misma transacción de `aplicarProyeccion`), llamar `registrarFormato(..., origen: 'barrido')`. Si devuelve `'cambio'`, NO hacer nada más en esta tarea: la transición a `intervention` es la Tarea 6.

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

```sql
-- Parte 2: el auto-SKU puede APLICAR (canario o E3_AUTO_SKU). Guarda qué payload de ML se releyó.
ALTER TABLE catalog.identity_decisions ADD COLUMN hash_payload_ml text;
ALTER TABLE catalog.identity_decisions ADD CONSTRAINT auto_sku_aplicar_con_hash
  CHECK (NOT (origen = 'auto_sku' AND efecto = 'aplicar') OR hash_payload_ml IS NOT NULL);
```

(Verificar en 0020 que no haya un CHECK que prohíba `auto_sku` + `aplicar`. Si lo hay, reemplazarlo en esta migración y decirlo en el reporte.)

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
2. `no_disponible` → caso a `actionable` con evidencia en `detalle.canario`, y `bandeja`.
3. `cambio` → caso a `intervention` + evidencia, y `intervention`. No vincula.
4. `ok` → relectura local: `skuUnico(empresa, skuCongelado)` tiene que seguir siendo `{ variantId: variantIdCongelada }`. Si da otra, `varias` o `ninguna` → `bandeja` (§7.3: no es error).
5. Registrar formato (`origen: 'relectura'`). Si da `'cambio'` → `intervention`.
6. INSERT de la decisión (`origen='auto_sku'`, `efecto='aplicar'`, `hash_payload_ml`, `engine_version`, `supersede_a` = la `auto_sku`/`sombra` vigente, que queda superada) → `reconciliarClave(..., 'e3 canario: sku exacto')`. Si NO devuelve `'vinculada'` a `variantIdCongelada`, la transacción entera hace rollback y el resultado es `parked` (`reconciliar_distinto`).
7. Caso a `verified` y `version+1`; evento de auditoría `identidad.auto_sku_aplicado` con el antes y el después.

- [ ] **Paso 1: Tests que fallan:**
  - `[esc:auto-sku-unico]` vincula;
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
  - `correrCanario(pool, relector, { corridaId, bandeja }): Promise<ResumenCanario>`;
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
  PRIMARY KEY (corrida_id, case_id));
```

- [ ] **Paso 2: Tests que fallan:**
  - `congelar` excluye D5, las que tienen humana o legado, y SKU `varias`;
  - una segunda `congelar` el mismo día falla (UNIQUE) y no toca la primera;
  - un caso abierto DESPUÉS del congelado no entra;
  - `correr` es idempotente (dos veces seguidas: los `vinculado` no se re-aplican);
  - `[esc:canario-401]` a mitad: la corrida pasa a `abortada`, los ya vinculados quedan y el resto sigue `pendiente`;
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
- Modificar: `plataforma/src/catalogo/aplicar.ts`: el punto de la Tarea 1 donde `registrarFormato` devuelve `'cambio'`, y la observación de `sku_observado`
- Crear: `plataforma/migrations/0023_e3_canario.sql` parte 4: `catalog.identity_commands (id uuid pk default uuidv7(), case_id uuid not null references catalog.identity_cases(id), tipo text not null check (tipo in ('pausar_publicacion')), estado text not null default 'parked' check (estado in ('parked')), motivo text not null, creado_en timestamptz not null default now())`. No hay ejecutor: es para E4.
- Test: `plataforma/test/identidad/intervention.test.ts`

**Interfaces:**
- Consume: `registrarFormato` (T1).
- Produce: al proyectar un `ml.items` cuya clave tiene una decisión VIGENTE `auto_sku`/`aplicar` (o humana `vincular`):
  - si el SKU normalizado observado ya no es el de la variante vinculada → caso `intervention` (se reabre o crea `tipo='sku_cambiado'` sobre la representación). El vínculo NO cambia;
  - si el formato dio `'cambio'` → caso `intervention` + un `identity_commands` `pausar_publicacion` `parked`. El vínculo NO cambia;
  - en los dos casos, evento de auditoría `identidad.intervention`.

- [ ] **Paso 1: Tests que fallan:**
  - cambio de SKU → intervention sin tocar `variant_id`;
  - cambio de formato → intervention + 1 comando parked;
  - la misma observación repetida no duplica el caso ni el comando;
  - sin decisión vigente → nada;
  - con los flags apagados, esto SIGUE funcionando: es sombra, sólo abre casos.
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

- [ ] **Paso 1: Tests que fallan:**
  - una `auto_sku`/`sombra` igual a la humana → coincide;
  - una distinta → `difieren` y `no_apto`;
  - una humana `sin_candidato` sobre una clave con `auto_sku` → cuenta en `difieren` (el humano dijo que no es esa);
  - una humana `apartado` (no es decisión) no cuenta.
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
  2. desplegar el worker con `E3_CANARIO=0` y `E3_AUTO_SKU=0`, que no cambia nada (antes se etiqueta la imagen de cada servicio para poder volver atrás);
  3. dejar correr la Tarea 6 en sombra;
  4. al cierre de la ventana de 7 días: `e3-replay`, y si da `apto`, José autoriza `e3-canario congelar/correr/cerrar`.
