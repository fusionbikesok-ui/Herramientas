# Rediseño de la bandeja de identidad (escritorio primero) — plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development o superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Objetivo:** que José decida más casos correctos por minuto en la bandeja E3. Cambios: teclas visibles en cada botón; se agrega «No estoy seguro» (apartar sin decidir); «Omitir por ahora» deja de escribir una omisión permanente; el caso muestra el «por qué» de cada candidato. Se hace primero en escritorio.

**Arquitectura:** hay tres capas y se cambian las tres.
- **Plataforma (Fastify):** marca de «apartado» en `catalog.identity_cases`. No es una decisión: no toca `identity_decisions` ni el vínculo, y por eso no entra en la calibración.
- **Proxy Express:** `routes/bandejaIdentidad.js` reenvía los endpoints nuevos.
- **Pantalla:** `public/bandeja-identidad/` (JS vanilla, sin build): teclas, botones y la fila «Por qué».

**Stack:** Node 24 + TS sin transpilar (plataforma, vitest, Postgres); Express + JS vanilla (herramientas, vitest + jsdom).

**Diseño aprobado:** `/tmp/claude-0/-opt/d06339e9-48d1-4f37-949e-92b12643dcdb/scratchpad/bandeja-rediseno.html` (propuesta con mockups). Decisiones de José del 2026-09-25:
1. «No estoy seguro» existe y es distinto de «Omitir».
2. Las teclas quedan como en la propuesta.
3. Se usa sobre todo en la computadora.

## Decisiones de José sobre los supuestos (2026-09-25)

- **S1 — «Omitir por ahora» (O) NO escribe nada.** Pasa el caso al final de la cola de la sesión. Hoy `s` escribe `eleccion='omitir'`, que deja la publicación omitida *para siempre* (`catalogo/decisiones.ts:67`). Esa omisión permanente sigue disponible como botón «No vincular esta publicación», sin tecla, para que no se dispare por accidente.
- **S2 — La ayuda pasa de `?` a `a`**, porque `?` ahora es «No estoy seguro».
- **S3 — `1`/`2`/`3` SELECCIONAN (como hoy) y `Enter` vincula el seleccionado.** Decisión de José: dos teclas por caso, más seguro. Los botones siguen mostrando `1`/`2`/`3` en cada candidato.
- **S4 — En «Confirmar SKU»:** `Enter` confirma y `X` rechaza. Rechazar es `mantener_omision` si el caso es `omitida_revisar`, y `sin_candidato` en los demás casos.
- **S5 — Los apartados salen de la cola normal.** Van a un chip propio, «Apartados (N)», al final.

## Restricciones globales

- Nunca `git add -A`: sólo tus archivos, con rutas explícitas. El working tree tiene cambios sin commitear de una sesión pausada (`lib/matcherEngine.js`, `public/matcher/matcher-engine.js`, `lib/recepcionMatching.js`, `routes/gemini.js` y 3 tests): no se tocan.
- Por tarea: sólo tests afectados + `npx tsc --noEmit -p plataforma`. La suite completa la corre el orquestador al final de la entrega.
- Salida cruda de tests a `/tmp/claude-0/`.
- Textos de la UI en español rioplatense (vos), sin tecnicismos.
- Toda tecla visible en su botón, por ejemplo `Vincular seleccionado (Enter)`.
- WCAG 2.2 AA: foco visible y `aria-keyshortcuts` en cada botón con tecla.
- Sin despliegue: José despliega después de la revisión de opt-2f y la segunda opinión de Codex.
- Migración numerada: `plataforma/migrations/0022_casos_apartados.sql`, con `SET lock_timeout = '5s'`.

## Foco de revisión (entradas que ningún test cubre por defecto)

1. **Apartar un caso que cambió de versión mientras se miraba:** tiene que dar `version_conflict` como `decidirCaso`, no apartar a ciegas. → test en la Tarea 1.
2. **Decidir (vincular) un caso apartado:** la decisión se aplica y el caso deja de figurar como apartado. → test en la Tarea 1.
3. **Tecla `3` con sólo 2 candidatos:** no selecciona nada y lo anuncia; `Enter` sin selección no vincula a `undefined` y avisa «Elegí un candidato». → test en la Tarea 3.
4. **`Z` después de «No estoy seguro»:** desaparta con DELETE y vuelve al caso. No manda un `revierte` de decisión. → test en la Tarea 3.
5. **`O` sobre el último caso de la cola:** no entra en un bucle infinito: si sólo quedan casos omitidos-por-ahora, muestra «Sólo quedan casos que salteaste». → test en la Tarea 3.

---

### Tarea 1: «Apartado» en la plataforma (esquema + servicio + API)

**Archivos:**
- Crear: `plataforma/migrations/0022_casos_apartados.sql`
- Crear: `plataforma/src/identidad/apartar.ts`
- Modificar: `plataforma/src/api/identidad-interna.ts`:
  - `ConsultaCola.grupo` (l.54-57): `.max(6)` pasa a `.max(7)`;
  - `autenticar` (l.142-148): aceptar `'DELETE'` en el tipo del método y en la verificación de la firma;
  - `GRUPO_CASE` (l.81-90): el apartado va a un grupo propio, `7`;
  - objeto de contadores (l.208): agregar `apartados: en(7)`;
  - agregar rutas nuevas después de `/casos/:id/decisiones` (l.325-360).
- Modificar: `plataforma/src/identidad/decidir.ts`: al decidir, limpiar la marca (ver el paso 5).
- Tests: `plataforma/test/identidad/apartar.test.ts` (nuevo), `plataforma/test/identidad/api-interna.test.ts`, `plataforma/test/identidad/calibracion.test.ts`

**Interfaces:**
- Produce: `apartarCaso(pool, { caseId, expectedVersion, actor, motivo?, idempotencyKey }): Promise<{ ok: true; version: number } | { ok: false; code: 'version_conflict' | 'caso_cerrado' | 'caso_inexistente' | 'bandeja_apagada' | 'no_apartado' }>` y `desapartarCaso(pool, { caseId, expectedVersion, actor, idempotencyKey })` con el mismo tipo de resultado.
- **Idempotencia:** un reintento con la misma clave devuelve el mismo resultado sin volver a subir la versión ni auditar de nuevo. Se guarda en una tabla chica `catalog.identity_case_marks(idempotency_key text PRIMARY KEY, case_id uuid, accion text, version int, creado_en timestamptz)` (migración 0022).
- **Actor:** lo inyecta el proxy desde la sesión, igual que en decisiones (`routes/bandejaIdentidad.js:73-85`). La plataforma nunca lo toma del navegador.
- Produce HTTP, las dos rutas con el header `Idempotency-Key` obligatorio igual que `/decisiones`:
  - `POST /internal/v1/identidad/casos/:id/apartar` con body `{ expected_version, actor, motivo? }` → 200 `{ version }`, o 409/404/422 con `code`;
  - `DELETE /internal/v1/identidad/casos/:id/apartar` con body `{ expected_version, actor }` → 200 `{ version }`. Si el caso ya no está apartado o la versión es otra, da 409 (`no_apartado`/`version_conflict`), y un deshacer viejo nunca borra un apartado más nuevo.
- En la cola, cada caso trae `apartado: boolean`, y los `contadores` traen `apartados`.

- [ ] **Paso 1: Migración**

```sql
-- 0022 — Rediseño de la bandeja: «No estoy seguro» aparta un caso sin decidirlo. No es una decisión
-- (no escribe identity_decisions ni mueve el vínculo), así que la calibración no lo ve.
SET lock_timeout = '5s';
ALTER TABLE catalog.identity_cases
  ADD COLUMN apartado_en timestamptz,
  ADD COLUMN apartado_por text,
  ADD COLUMN apartado_motivo text;
CREATE TABLE catalog.identity_case_marks (
  idempotency_key text PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id),
  accion text NOT NULL CHECK (accion IN ('apartar','desapartar')),
  version int NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now());
COMMENT ON COLUMN catalog.identity_cases.apartado_en IS
  'Marcado «No estoy seguro» en la bandeja: sale de la cola normal hasta que se decide o se desaparta.';
```

- [ ] **Paso 2: Tests que fallan** (`test/identidad/apartar.test.ts`, con el mismo setup de base que `decidir.test.ts`):

```ts
it('aparta sin escribir decisiones ni tocar el vínculo', async () => {
  const caso = await casoAbierto();                       // helper existente de decidir.test.ts
  const antesRep = await repDe(caso);
  const r = await apartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
  expect(r).toEqual({ ok: true, version: caso.version + 1 });
  expect((await pool.query('select count(*)::int n from catalog.identity_decisions')).rows[0].n).toBe(0);
  expect(await repDe(caso)).toEqual(antesRep);
});
it('con una versión vieja da version_conflict y no aparta', async () => {
  const caso = await casoAbierto();
  const r = await apartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version - 1, actor: 'jose', idempotencyKey: 'k1' });
  expect(r).toEqual({ ok: false, code: 'version_conflict' });
  expect((await pool.query('select apartado_en from catalog.identity_cases where id=$1', [caso.id])).rows[0].apartado_en).toBeNull();
});
it('desapartar limpia la marca y sube la versión', async () => {
  const caso = await casoAbierto();
  await apartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
  const r = await desapartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version + 1, actor: 'jose', idempotencyKey: 'k2' });
  expect(r).toEqual({ ok: true, version: caso.version + 2 });
});
it('un deshacer con versión vieja no borra un apartado más nuevo', async () => {
  const caso = await casoAbierto();
  await apartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
  const r = await desapartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k2' });
  expect(r).toEqual({ ok: false, code: 'version_conflict' });
});
it('reintentar con la misma clave devuelve lo mismo sin subir la versión', async () => {
  const caso = await casoAbierto();
  const a = await apartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
  const b = await apartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
  expect(b).toEqual(a);
  expect((await pool.query('select version from catalog.identity_cases where id=$1', [caso.id])).rows[0].version).toBe(caso.version + 1);
});
it('decidir un caso apartado lo decide y limpia la marca', async () => {
  const caso = await casoAbierto(); await apartarCaso(pool, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
  const d = await decidirCaso(pool, { caseId: caso.id, expectedVersion: caso.version + 1, eleccion: 'sin_candidato', actor: 'jose', esAdmin: true, idempotencyKey: randomUUID() }, { bandeja: true });
  expect(d.ok).toBe(true);
  expect((await pool.query('select apartado_en from catalog.identity_cases where id=$1', [caso.id])).rows[0].apartado_en).toBeNull();
});
```

En `api-interna.test.ts`:
- en la cola, un caso apartado sale con `grupo: 7` y `apartado: true`, y `contadores.apartados === 1`;
- con `grupo=0..6` no aparece.

En `calibracion.test.ts`: apartar un caso de la ventana no cambia ninguna métrica. Se comparan las métricas antes y después de apartar, y tienen que ser iguales.

- [ ] **Paso 3: Correr y ver que fallan.** `cd plataforma && npx vitest run test/identidad/apartar.test.ts test/identidad/api-interna.test.ts test/identidad/calibracion.test.ts > /tmp/claude-0/t1-rojo.txt 2>&1`

- [ ] **Paso 4: `src/identidad/apartar.ts`.** Usa el mismo lock que `decidirCaso`: `SELECT … FOR UPDATE` del caso dentro de `enTransaccion`. Chequea `cerrado_en IS NULL` y `version = expectedVersion`. Hace `UPDATE … SET apartado_en=now(), apartado_por=$actor, apartado_motivo=$motivo, version=version+1` y registra el evento con `registrarEvento` (`audit/auditoria.ts`), igual que decidir. Antes de todo, busca `idempotency_key` en `identity_case_marks`: si ya está, devuelve `{ ok: true, version }` guardado. Si no, al final inserta la fila en la misma transacción. `desapartarCaso` sigue el mismo flujo, con expectedVersion y exigiendo `apartado_en IS NOT NULL` (`no_apartado` si no), y pone NULL en las tres columnas. El evento de auditoría es `identidad.caso_apartado`/`identidad.caso_desapartado`: **invariante**, calibracion.ts sólo lee `identity_decisions`, nunca estos eventos.

- [ ] **Paso 5: `decidir.ts`.** El caso se actualiza dos veces al decidir (l.184-187 y l.255-257). Agregar `apartado_en=NULL, apartado_por=NULL, apartado_motivo=NULL` en el **primero** (l.184-187), que es el que corre siempre, también en `revierte`. Test: vincular un apartado y revertir esa decisión deja el caso sin apartar (no resucita el apartado).

- [ ] **Paso 6: API.**
  - En `GRUPO_CASE`, la primera rama es `WHEN c.apartado_en IS NOT NULL THEN 7`: un apartado va a su chip, aunque sea conflicto.
  - En la fila de la cola, agregar `apartado: f.g === 7`.
  - Rutas `POST` y `DELETE` `/casos/:id/apartar` con el mismo `autenticar` + zod + `Idempotency-Key` que `/decisiones` (l.325-360). Mapeo de códigos: version_conflict→409, caso_cerrado→409, caso_inexistente→404, bandeja_apagada→503.

- [ ] **Paso 7: Tests en verde y tsc.** Mismo comando que el paso 3 → `/tmp/claude-0/t1-verde.txt`, y `npx tsc --noEmit -p .`

- [ ] **Paso 8: Commit.** `git add plataforma/migrations/0022_casos_apartados.sql plataforma/src/identidad/apartar.ts plataforma/src/identidad/decidir.ts plataforma/src/api/identidad-interna.ts plataforma/test/identidad/apartar.test.ts plataforma/test/identidad/api-interna.test.ts plataforma/test/identidad/calibracion.test.ts && git commit -m "feat(identidad): «No estoy seguro» aparta un caso sin decidirlo"`

### Tarea 2: Proxy Express para apartar

**Archivos:**
- Modificar: `routes/bandejaIdentidad.js` (junto al `router.post('/casos/:id/decisiones'` de la l.69; sumar las líneas nuevas al comentario de cabecera, l.4-7)
- Test: el test existente del proxy (`grep -ln bandejaIdentidad test/` para ubicarlo)

**Interfaces:**
- Consume: los endpoints HTTP de la Tarea 1.
- Produce: `POST` y `DELETE` `/api/bandeja-identidad/casos/:id/apartar`, con el mismo permiso que decisiones (`matcher` en nivel escritura, `lib/permisos.js:61`).

- [ ] **Paso 1: Tests que fallan:**
  - el `POST` reenvía `expected_version`, `motivo` y el header `Idempotency-Key`, **inyecta `actor` desde la sesión** (si el navegador manda `actor`, se ignora) y devuelve el status de la plataforma;
  - el `DELETE` hace lo mismo;
  - el usuario `auditor` (sólo lectura) recibe 403 en los dos.
- [ ] **Paso 2: Ver que fallan.** `npx vitest run test/<archivo> > /tmp/claude-0/t2-rojo.txt 2>&1`
- [ ] **Paso 3: Implementar,** copiando el patrón de `/decisiones`: validar el `:id` como UUID y reenviar con `reenviar(res, 'POST'|'DELETE', …)`.
- [ ] **Paso 4: Verde** → `/tmp/claude-0/t2-verde.txt`
- [ ] **Paso 5: Commit** con sólo `routes/bandejaIdentidad.js` y su test.

### Tarea 3: Teclas y acciones en la pantalla

**Archivos:**
- Modificar: `public/bandeja-identidad/bandeja.js`:
  - acciones en la l.543-559;
  - clicks en la l.636-645;
  - teclado en la l.650-672: **se reemplazan** las ramas `s` (omisión permanente) y `?` (ayuda), no sólo se agregan;
  - `deshacer()` en la l.355-380;
  - `textoDecision()` en la l.288.
- Modificar: `public/bandeja-identidad/logica.js`: helpers puros testeables.
- Modificar: `public/bandeja-identidad/index.html`: tabla de ayuda (l.510-570) y chip «Apartados».
- Tests: `test/bandejaIdentidad.test.js` (lógica) y `test/bandejaIdentidad-ui.test.js` (jsdom), en la raíz de herramientas

**Interfaces:**
- Consume: `POST` y `DELETE` `/api/bandeja-identidad/casos/:id/apartar` (Tarea 2), y `apartado`/`contadores.apartados` de la cola (Tarea 1).
- Produce en `logica.js`:
  - `accionDeTecla(key, ctx) → { tipo: 'seleccionar', n } | { tipo: 'vincular' } | { tipo: 'confirmar' } | { tipo: 'rechazar' } | { tipo: 'omitir_por_ahora' } | { tipo: 'apartar' } | { tipo: 'no_existe' } | { tipo: 'buscar' } | { tipo: 'deshacer' } | { tipo: 'ayuda' } | null`. `ctx = { confirmable: boolean, nCandidatos: number, tipoCaso: string }`.
  - `siguienteNoSalteado(cola, idx, salteados) → number | -1`
  - `GRUPOS.apartados = 7`

**Mapa de teclas final** (S2–S4):

| Tecla | Caso normal | Caso «Confirmar SKU» |
|---|---|---|
| `1` `2` `3` | selecciona el candidato N (si no existe: anuncia «No hay candidato N») | — |
| `Enter` | vincula el seleccionado | confirma |
| `X` | — | rechaza (`mantener_omision` si `omitida_revisar`; si no, `sin_candidato`) |
| `/` | buscar otra variante | buscar |
| `O` | omitir por ahora (sin escribir; al final de la cola de la sesión) | ídem |
| `N` | no existe en el catálogo (`sin_candidato`) | — |
| `?` | no estoy seguro (apartar) | ídem |
| `Z` | deshacer lo último (decisión → `revierte`; apartado → DELETE; omitir por ahora → vuelve al caso) | ídem |
| `a` | ayuda | ídem |
| `j`/`k`, `d`, `f`, `h` | sin cambios | sin cambios |

El botón «No vincular esta publicación» (escribe `eleccion='omitir'`) queda sin tecla (S1).

- [ ] **Paso 1: Tests que fallan de lógica** (`test/bandejaIdentidad.test.js`):

```js
it('1/2/3 seleccionan si existe el candidato y Enter vincula', () => {
  expect(L.accionDeTecla('2', { confirmable: false, nCandidatos: 3, tipoCaso: 'sku_pendiente' })).toEqual({ tipo: 'seleccionar', n: 2 });
  expect(L.accionDeTecla('Enter', { confirmable: false, nCandidatos: 3, tipoCaso: 'sku_pendiente' })).toEqual({ tipo: 'vincular' });
  expect(L.accionDeTecla('3', { confirmable: false, nCandidatos: 2, tipoCaso: 'sku_pendiente' })).toBeNull();
});
it('? aparta, a es ayuda, O omite por ahora, N no existe', () => {
  const c = { confirmable: false, nCandidatos: 3, tipoCaso: 'sku_pendiente' };
  expect(L.accionDeTecla('?', c)).toEqual({ tipo: 'apartar' });
  expect(L.accionDeTecla('a', c)).toEqual({ tipo: 'ayuda' });
  expect(L.accionDeTecla('o', c)).toEqual({ tipo: 'omitir_por_ahora' });
  expect(L.accionDeTecla('n', c)).toEqual({ tipo: 'no_existe' });
  expect(L.accionDeTecla('s', c)).toBeNull();                 // la omisión permanente ya no tiene tecla
});
it('en confirmable Enter confirma y X rechaza', () => {
  const c = { confirmable: true, nCandidatos: 0, tipoCaso: 'omitida_revisar' };
  expect(L.accionDeTecla('Enter', c)).toEqual({ tipo: 'confirmar' });
  expect(L.accionDeTecla('x', c)).toEqual({ tipo: 'rechazar' });
});
it('siguienteNoSalteado no da vueltas infinitas', () => {
  const cola = [{ id: 'a' }, { id: 'b' }];
  expect(L.siguienteNoSalteado(cola, 0, new Set(['b']))).toBe(-1);
  expect(L.siguienteNoSalteado(cola, 0, new Set())).toBe(1);
});
```

- [ ] **Paso 2: Tests UI que fallan** (`test/bandejaIdentidad-ui.test.js`, con el setup jsdom + fetch simulado que ya usa ese archivo):
  - `?` hace `POST …/apartar` con `expected_version`, avanza y muestra «Apartado. Z deshace».
  - `Z` después de apartar hace `DELETE …/apartar` y reabre el mismo caso, sin mandar ningún `POST …/decisiones`.
  - `2` y después `Enter` hacen `POST …/decisiones` con `eleccion:'vincular'` y el `variant_id` del segundo candidato; `2` solo no hace ningún POST.
  - `O` no hace ningún POST y el caso siguiente queda abierto.
  - Si todos los casos restantes están salteados, aparece el texto «Sólo quedan casos que salteaste».
  - Todos los botones con tecla tienen `aria-keyshortcuts` y muestran la tecla en el texto.

- [ ] **Paso 3: Ver que fallan.** `npx vitest run test/bandejaIdentidad.test.js test/bandejaIdentidad-ui.test.js > /tmp/claude-0/t3-rojo.txt 2>&1`

- [ ] **Paso 4: Implementar en `logica.js`** `accionDeTecla` y `siguienteNoSalteado`, y agregar `apartados: 7` a `GRUPOS` y `GRUPO_NOMBRE`.

- [ ] **Paso 5: Implementar en `bandeja.js`:**
  1. El listener de teclado llama a `L.accionDeTecla` y hace `switch` sobre `tipo`.
  2. `apartar()` es un camino propio, no una decisión. La maquinaria de deshacer de hoy asume `entry.promise`, `decisionId` y el resultado de una decisión (l.358-372), así que no sirve tal cual. `apartar()` hace `conReintentos` con una `Idempotency-Key` fija por intento y guarda `S.ultima = { tipo:'apartado', casoId, promesa, versionNueva }`. `deshacer()` se parte en tres por `S.ultima.tipo`: `'decision'` (el código actual, sin cambios), `'apartado'` (espera la promesa y hace DELETE con `expected_version: versionNueva` y su propia clave; si da 409, avisa «Ya cambió; no se deshizo») y `'salteado'`.
  3. `omitirPorAhora()` agrega a `S.salteados` (un Set) y usa `siguienteNoSalteado`; `deshacer()` de un salteado lo saca del Set y vuelve.
  4. Los botones quedan en este orden: `Vincular seleccionado Enter` (primario; cada candidato muestra su tecla 1/2/3), `Buscar /`, `No estoy seguro ?`, `Omitir por ahora O`, `No existe N`, y separado a la derecha `No vincular esta publicación`. En confirmables: `Confirmar Enter` y `No es este X`.
  5. `textoDecision`: `apartado` → «Apartado para revisar después.», `omitir` → «Publicación sin vincular.»

- [ ] **Paso 6: `index.html`.** Actualizar la tabla de ayuda según el mapa y agregar el chip `data-filtro="apartados"` con el contador, último en la fila de chips.

- [ ] **Paso 7: Verde** → `/tmp/claude-0/t3-verde.txt`

- [ ] **Paso 8: Commit** con sólo los tres archivos de `public/bandeja-identidad/` y los dos tests.

### Tarea 4: Fila «Por qué» y atributos iguales colapsados (escritorio)

**Archivos:**
- Modificar: `public/bandeja-identidad/bandeja.js` `renderMatriz` (l.440-480; filas fijas en la l.454)
- Modificar: `public/bandeja-identidad/logica.js`
- Modificar: `public/bandeja-identidad/bandeja.css`
- Tests: los mismos dos archivos de la Tarea 3

**Interfaces:**
- Consume: `candidatos[].explicacion.atributos[]` (`{ nombre, marca }`; las marcas están en `MARCAS` de `logica.js`) del detalle.
- Produce:
  - `L.porQue(opcion) → string`: resumen corto de lo que coincide y lo que difiere, por ejemplo «modelo, color y talle coinciden» o «el color difiere; el talle falta».
  - `L.atributosIguales(opciones) → string[]`: atributos con la misma marca de coincidencia en todos los candidatos.

- [ ] **Paso 1: Tests que fallan:**
  - `porQue` con marcas `ok`/`miss`/`falta` arma las tres formas del mockup;
  - `atributosIguales` devuelve sólo los iguales en todos los candidatos;
  - en la UI, la matriz tiene una fila «Por qué» (última fila de la tabla) y una fila «Iguales: Marca, rodado… · Ver más» que al hacer clic despliega esas filas;
  - con `d` (sólo diferencias) la fila «Iguales» sigue visible.
- [ ] **Paso 2: Ver que fallan** → `/tmp/claude-0/t4-rojo.txt`
- [ ] **Paso 3: Implementar.** Los atributos iguales en todos los candidatos se colapsan por defecto en una sola fila. Usar los tokens de `public/lib/theme.css`, sin colores nuevos.
- [ ] **Paso 4: Verde** → `/tmp/claude-0/t4-verde.txt`
- [ ] **Paso 5: Revisar en escritorio con Playwright** a 1440×900 y 1280×800 contra QA (`scripts/qa/qa.sh`). Nada cortado ni con scroll horizontal, y el foco visible con Tab. Capturas en `/tmp/claude-0/t4-*.png`.
- [ ] **Paso 6: Commit** de los archivos de la tarea.

### Tarea 5: Cierre de la entrega

- [ ] Segunda opinión de Codex sobre el diff completo: `git diff <base>..HEAD > /tmp/claude-0/bandeja-diff.txt; codex exec --sandbox read-only "<prompt en inglés: buscar defectos reales con archivo:línea y un escenario de falla>" > /tmp/claude-0/codex-bandeja-review.txt`. Responder cada hallazgo.
- [ ] Avisar a opt-2f con los hashes, los archivos de salida y la respuesta a Codex.
- [ ] opt-2f revisa y corre la suite completa una vez.
- [ ] José aplica la migración 0022, despliega api + herramientas (antes etiqueta la imagen de cada servicio para poder volver atrás) y prueba 10 casos reales.
- [ ] Medición: tiempo mediano por caso, deshacer, casos que terminan en búsqueda manual y errores de color/talle, antes y después (métrica de la propuesta). Recién entonces arranca la ventana de calibración de 7 días de E3.
