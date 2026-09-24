# E3 corte 1: bandeja con autoridad y motor en sombra. Plan de implementación

> **Para quien ejecuta:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development o superpowers:executing-plans. Los pasos usan checkbox (`- [ ]`).

**Objetivo:** José decide casos de identidad en una bandeja web desde el día 1, y sus decisiones se aplican en el catálogo de la plataforma. El motor único calcula candidatos y `auto_sku` **sólo en sombra**. Con esto arranca la ventana de 7 días de calibración.

**Arquitectura:**
- La decisión humana vive en `catalog.identity_decisions`, append-only.
- `vincularMl` y `reconciliarClave` consultan una sola función, `decisionVigente`, con este orden: humana E3 → legado → pendiente. En este corte **no** hay `auto_sku` aplicado.
- La pantalla vive en el **legado** (`public/bandeja-identidad/`), con su login y el permiso `matcher`. El servidor del legado llama a la plataforma por una API interna HMAC, la misma que ya usa la outbox (`lib/internoHmac.js`).
- **Por qué la pantalla va en el legado:** la plataforma no tiene sesión real todavía (`plataforma/src/auth/sesion.ts`: `sinSesion` devuelve siempre null), así que una ruta pública `/api/v2/identity/*` respondería 401 en producción.
- Las rutas `/api/v2/identity/*` de la spec (§10) quedan para cuando exista sesión en la plataforma, y se anota como desvío de la spec.

**Stack:**
- Plataforma: TypeScript, Fastify, pg, zod, vitest.
- Legado: Express ESM, vitest, HTML/JS en `public/`.

**Spec:** `docs/superpowers/specs/2026-09-24-e3-identidad-design.md` (aprobada por José el 2026-09-24).

## Restricciones globales

- **Un solo escritor de `variant_id`:** el camino proyector/`reconciliarClave`, siempre bajo `bloquearDecisiones(tx, cuenta)` y después con las filas bloqueadas.
- **Decisiones append-only:** el rol de la app no tiene UPDATE ni DELETE sobre `identity_decisions`. Revertir es una decisión nueva con `supersede_a`.
- **Decisión humana:** `origen='humano'` y siempre `efecto='aplicar'`. Una `auto_sku` es siempre `efecto='sombra'` en este corte, y se rechaza en la base con un CHECK hasta la migración del corte 3.
- **Flag `E3_BANDEJA`**, apagado por omisión:
  - apagado: `decisionVigente` ignora `identity_decisions` (comportamiento de hoy) y la API interna de decisiones responde 503 `bandeja_apagada`;
  - las lecturas funcionan igual.
- **SKU normalizado:** `trim()` + `toUpperCase()`, sin tocar los espacios internos; un SKU vacío o `null` nunca matchea. La versión de la normalización forma parte de `ENGINE_VERSION = 'e3-motor-1'`.
- **Unicidad:** por `company_id`, sobre `sellable_variants` con `archivado_en IS NULL`.
- **GTIN nunca vincula.**
- **Nada se escribe en ML ni en Woo.**
- **Gemini no entra en este corte.**
- **Errores de la API:** `{code, message, correlation_id, details?}`.
- **Pantalla:** 390/768/1440 y WCAG 2.2 AA, con los tokens de `public/lib/theme.css`.
- **Permisos:** leer y decidir con `matcher`; revertir sólo el admin.
- **Git:** commits sólo de archivos propios, nunca `git add -A`. La salida cruda de las suites va a `/tmp/claude-0/*.log`.
- **Producción:** migración, flag y deploy los aprueba José, uno por uno.

## Foco de revisión

1. **Dos personas deciden el mismo caso a la vez:** el segundo recibe 409 `version_conflict` sin ningún efecto parcial; la pantalla recarga el caso y conserva lo elegido. Test en la tarea 3.
2. **Doble clic o reintento de red con la misma `Idempotency-Key`:** la misma respuesta y una sola decisión; la misma clave con otro cuerpo da 422. Test en la tarea 3.
3. **Llega un evento del legado sobre una clave con decisión humana E3:** no cambia el vínculo y abre `decision_en_conflicto`. Test en la tarea 2.
4. **Se elige una variante archivada o de otra empresa:** 422 `variante_invalida`. Test en la tarea 3.
5. **Con el flag apagado,** el vínculo de cada publicación es idéntico al de hoy aunque haya decisiones humanas guardadas. Test en la tarea 2.

---

### Tarea 1: migración `0020_identidad.sql`

**Archivos:**
- Crear: `plataforma/migrations/0020_identidad.sql`
- Test: `plataforma/test/identidad/esquema.test.ts`, siguiendo el patrón de `test/catalogo/esquema.test.ts`.

**Produce:**
- tablas `catalog.identity_decisions`, `catalog.identity_candidates`, `catalog.identity_evidence`;
- columnas `identity_cases.version` y `identity_cases.estado`.

- [ ] **Paso 1: escribir el test que falla.** Cubre:
  - (a) insertar una decisión `humano`/`aplicar`: ok;
  - (b) `auto_sku`/`aplicar`: viola el CHECK;
  - (c) dos decisiones vigentes (`supersede_a IS NULL` y no superadas) para la misma clave y efecto: viola el UNIQUE;
  - (d) UPDATE o DELETE sobre `identity_decisions` con el rol de la app: permiso denegado;
  - (e) `identity_cases.version` vale 1 por omisión y `estado` vale `actionable` por omisión;
  - (f) la misma `idempotency_key` repetida: viola el UNIQUE.
- [ ] **Paso 2:** `npx vitest run test/identidad/esquema.test.ts` → FAIL, porque la tabla no existe.
- [ ] **Paso 3: la migración.**

```sql
SET lock_timeout = '5s';
ALTER TABLE catalog.identity_cases
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD COLUMN estado text NOT NULL DEFAULT 'actionable' CHECK (estado IN
    ('unclassified','actionable','decided','verified','parked','intervention','conflict','archived'));

CREATE TABLE catalog.identity_decisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  case_id uuid REFERENCES catalog.identity_cases(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  recurso text NOT NULL, variacion_normalizada text NOT NULL DEFAULT '',
  eleccion text NOT NULL CHECK (eleccion IN ('vincular','omitir','mantener_omision','sin_candidato')),
  variant_id uuid REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  origen text NOT NULL CHECK (origen IN ('humano','auto_sku')),
  actor text NOT NULL, motivo text,
  efecto text NOT NULL CHECK (efecto IN ('sombra','aplicar')),
  engine_version text, hash_payload_ml text, expected_version int,
  idempotency_key text UNIQUE, hash_peticion text,
  supersede_a uuid REFERENCES catalog.identity_decisions(id),
  superada_en timestamptz,            -- la única columna que cambia, y sólo la escribe un trigger al superar
  creado_en timestamptz NOT NULL DEFAULT now(),
  CHECK ((eleccion = 'vincular') = (variant_id IS NOT NULL)),
  CHECK (origen <> 'humano' OR efecto = 'aplicar'),
  CHECK (origen <> 'auto_sku' OR efecto = 'sombra')   -- el corte 3 lo reemplaza
);
CREATE UNIQUE INDEX identity_decisions_una_vigente
  ON catalog.identity_decisions (channel_account_id, recurso, variacion_normalizada, efecto)
  WHERE superada_en IS NULL;
```

- [ ] **Paso 4: append-only.**
  - `REVOKE UPDATE, DELETE` al rol de la app; usar el mismo nombre de rol que `0013`.
  - Un trigger `BEFORE INSERT` con `SECURITY DEFINER` marca `superada_en = now()` en la vigente anterior de la misma clave y efecto.
  - Así la app nunca hace UPDATE.
  - `identity_candidates` (case_id, run_id, variant_id, rank, puntaje, explicacion jsonb, fuentes text[], engine_version, creado_en) con índice (case_id, creado_en DESC).
  - `identity_evidence` (case_id, fuente, observado_en, hash, campos jsonb).
- [ ] **Paso 5:** el test pasa, y también `npx vitest run test/migraciones.test.ts`.
- [ ] **Paso 6:** commit con `git add plataforma/migrations/0020_identidad.sql plataforma/test/identidad/esquema.test.ts`, mensaje `feat(e3): esquema de decisiones, candidatos y evidencia de identidad`.

### Tarea 2: `decisionVigente` única y autoridad de la humana

**Archivos:**
- Crear: `plataforma/src/identidad/autoridad.ts`
- Modificar:
  - `plataforma/src/catalogo/aplicar.ts:216-239` (vincularMl);
  - `plataforma/src/catalogo/decisiones.ts:45-66` (reconciliarClave);
  - `plataforma/src/catalogo/copias.ts` (aplicarEvento, al recibir un evento del legado).
- Test: `plataforma/test/identidad/autoridad.test.ts`

**Interfaces:**

```ts
export type Vigente =
  | { fuente: 'humano'; eleccion: 'vincular'; variantId: string; decisionId: string }
  | { fuente: 'humano'; eleccion: 'omitir' | 'mantener_omision' | 'sin_candidato'; decisionId: string }
  | { fuente: 'legado'; accion: 'omitir' }
  | { fuente: 'legado'; accion: 'confirmar' | 'asignar'; sku: string }
  | null;
export async function decisionVigente(tx: Consultable, cuenta: string, recurso: string, variacion: string,
  o: { bandeja: boolean }): Promise<Vigente>;
```

**Cómo se traduce cada decisión humana a lo que se desea para la publicación:**

| Elección humana | Deseado |
|---|---|
| `vincular` | variante `variantId` |
| `omitir` / `mantener_omision` | omitida |
| `sin_candidato` | pendiente `sku_pendiente`, con el caso marcado `estado='decided'` para que no vuelva a la cola |

**Qué se toca en cada archivo:**
- `vincularMl` y `reconciliarClave` usan `decisionVigente` en lugar de su SELECT sobre `matcher_decisions`.
- El flag llega por `ContextoAplicacion.bandeja`, que sale de la config del worker (`E3_BANDEJA`), y por un parámetro nuevo de `reconciliarClave`.
- **`copias.ts`:**
  - al aplicar un evento del legado sobre una clave con una humana E3 vigente (y la bandeja encendida), se guarda la decisión del legado como hoy, pero **no** se llama a `reconciliarClave`;
  - se abre `decision_en_conflicto` sobre la representación con `detalle {legado:{accion,sku}, e3:decisionId}` y `estado='conflict'`;
  - se emite el evento de auditoría `identidad.conflicto_legado`.

- [ ] **Paso 1: tests que fallan.**
  - (a) Con la bandeja encendida: humana `vincular` V2 y legado `confirmar` SKU→V1; `reconciliarClave` deja la publicación en V2.
  - (b) Con la bandeja apagada, en el mismo estado: queda en V1, igual que hoy.
  - (c) Humana `omitir` → `omitida_por_decision=true` y caso `omitida_revisar`.
  - (d) Evento del legado sobre una clave con humana → vínculo sin cambios y un caso `decision_en_conflicto` abierto. Reenviar el mismo evento no abre un segundo caso.
  - (e) Evento del legado sobre una clave sin humana → comportamiento de hoy.
  - (f) `vincularMl` de una publicación nueva con humana `vincular` → nace vinculada a esa variante.
- [ ] **Paso 2:** correr `npx vitest run test/identidad/autoridad.test.ts` → FAIL.
- [ ] **Paso 3: implementar.** No debe cambiar ningún test existente de `test/catalogo/`. Correr `npx vitest run test/catalogo` → verde.
- [ ] **Paso 4:** commit con `git add` de los archivos listados, mensaje `feat(e3): la decisión humana de la bandeja manda sobre la copiada del legado`.

### Tarea 3: `decidirCaso`, el servicio de decisión

**Archivos:**
- Crear: `plataforma/src/identidad/decidir.ts`
- Test: `plataforma/test/identidad/decidir.test.ts`

**Interfaz:**

```ts
export interface PedidoDecision { caseId: string; expectedVersion: number; eleccion: 'vincular'|'omitir'|'mantener_omision'|'sin_candidato';
  variantId?: string; actor: string; esAdmin: boolean; motivo?: string; idempotencyKey: string; revierte?: string }
export type ResultadoDecision = { ok: true; decisionId: string; version: number; vinculo: Reconciliacion }
  | { ok: false; code: 'version_conflict'|'idempotency_mismatch'|'variante_invalida'|'caso_cerrado'|'caso_sin_publicacion'|'solo_admin'|'bandeja_apagada'; details?: object };
export async function decidirCaso(pool: pg.Pool, p: PedidoDecision, o: { bandeja: boolean }): Promise<ResultadoDecision>;
```

**Flujo, en una sola transacción (`enTransaccion`):**
1. Busca por `idempotency_key`.
   - Si existe y el `hash_peticion` (sha256 del pedido canónico sin la clave) coincide, devuelve el resultado original.
   - Si no coincide, `idempotency_mismatch`.
2. Lee el caso y obtiene la clave de la publicación:
   - por `representation_id`;
   - o, si cuelga de `variant_id`, la única representación de ML de esa variante.
   - Si hay 0 o más de 1, `caso_sin_publicacion`.
3. Toma `bloquearDecisiones(tx, cuenta)` y después `SELECT … FOR UPDATE` del caso.
4. Si `version <> expectedVersion`, `version_conflict` con `details {version_actual}`.
5. Valida la variante: misma empresa y `archivado_en IS NULL`.
6. Si revierte y no es admin, `solo_admin`.
7. Inserta la decisión (`origen='humano'`, `efecto='aplicar'`, `supersede_a` = la vigente).
8. Actualiza el caso con `version = version + 1` y `estado='decided'`.
9. Llama a `reconciliarClave(tx, cuenta, recurso, variacion, 'bandeja: <actor>', {bandeja:true})`.
10. Si el resultado es `vinculada` u `omitida`, cierra el caso con `motivo_cierre='decidido en bandeja'` y `estado='verified'`.
11. Registra el evento de auditoría `identidad.decision` con el actor, el antes y el después, y el `correlation_id`.

- [ ] **Paso 1: tests que fallan.**
  - (a) vincular un caso `sku_pendiente` → la publicación queda en la variante elegida, el caso se cierra, la versión sube a 2, la pendiente se archiva por fusión y hay evento de auditoría;
  - (b) dos `decidirCaso` concurrentes con `expectedVersion=1` y claves distintas (`Promise.all`) → exactamente un `ok` y un `version_conflict`, una sola fila en `identity_decisions`;
  - (c) la misma clave de idempotencia dos veces → el mismo `decisionId` y una sola fila;
  - (d) la misma clave con otro `variantId` → `idempotency_mismatch`;
  - (e) una variante archivada → `variante_invalida`;
  - (f) una variante de otra empresa → `variante_invalida`;
  - (g) revertir sin admin → `solo_admin`;
  - (h) revertir con admin → una decisión nueva con `supersede_a`, la anterior con `superada_en` y el vínculo vuelto atrás;
  - (i) `bandeja:false` → `bandeja_apagada` y 0 filas.
- [ ] **Paso 2:** FAIL. **Paso 3:** implementar. **Paso 4:** verde, y `npx vitest run test/catalogo test/identidad` verde.
- [ ] **Paso 5:** commit con el mensaje `feat(e3): decidir un caso con versión esperada e idempotencia`.

### Tarea 4: motor en sombra (SKU exacto + candidatos)

**Archivos:**
- Crear:
  - `plataforma/src/identidad/sku.ts`
  - `plataforma/src/identidad/candidatos.ts`: port a TS de `lib/matcherEngine.js`, con las funciones que usa `candidatosDeItem` y los arreglos de `fe8d1a42`;
  - `plataforma/src/identidad/motor.ts`
  - `plataforma/src/worker/identidad.ts`: el ciclo.
- Modificar: `plataforma/src/worker/main.ts` (encender el ciclo si `E3_MOTOR=1`), `plataforma/src/comun/config.ts`.
- Test: `plataforma/test/identidad/sku.test.ts`, `candidatos.test.ts` y `motor.test.ts`.

**Interfaces:**

```ts
export const ENGINE_VERSION = 'e3-motor-1';
export function normalizarSku(s: string | null | undefined): string | null; // '' → null
export async function skuUnico(tx: Consultable, empresa: string, skuNorm: string): Promise<{ variantId: string } | 'ninguna' | 'varias'>;
export interface Candidato { variantId: string; rank: number; puntaje: number;
  explicacion: { coincide: string[]; difiere: string[] } }
export function candidatosDe(ml: ItemMl, woo: ItemWoo[], indice: IndiceWoo, n = 3): Candidato[];
export async function correrMotor(pool: pg.Pool, o: { empresa: string; limite: number; log: Logger }): Promise<{ casos: number; autoSku: number }>;
```

**Qué hace una corrida del motor sobre los casos abiertos `sku_pendiente`, `omitida_revisar` y `sku_inexistente_en_woo`:**
- **Candidatos:** calcula el top-3 y lo inserta en `identity_candidates` con `run_id` y `engine_version`.
- **Auto-SKU en sombra:** si el `sku_observado` normalizado da `skuUnico` → `{variantId}` y la clave no tiene humana vigente ni `omitir` del legado, inserta una `auto_sku`/`sombra`. Lo mismo vale para las 17 de D5.
  - La sombra **nunca** llama a `reconciliarClave`.
  - Es idempotente: si ya hay una vigente con la misma variante, no inserta.
- **Datos:** títulos de `product_models.titulo` (el modelo propio de ML y los de Woo); talle y color de `catalog.model_facets` y de los atributos que ya persiste E2.
  - Si hace falta un dato que sólo está en el inbox cifrado, **pará y avisá**: no descifres payloads desde el motor.
- **Ciclo:** cada 30 minutos, con `pg_try_advisory_lock('identidad.motor')` y un lote de 500 casos por vuelta.

- [ ] **Paso 1: tests de `sku.ts`.**
  - `' fb-12 '`→`'FB-12'`, `'fb 12'`→`'FB 12'`, `''`→`null`, `null`→`null`;
  - `skuUnico`: 0, 1 o 2 variantes, ignorando las archivadas y las de otra empresa.
- [ ] **Paso 2: test de paridad de `candidatos.ts`.** Congelar 30 pares ML/Woo de la muestra de 299 (`docs/superpowers/evidence/e3/`) en `test/identidad/fixtures/muestra-30.json`, con el top-3 que da hoy `lib/matcherEngine.js`. El port en TS tiene que dar el mismo orden, y cada candidato tiene que traer su `explicacion`.
- [ ] **Paso 3: tests de `motor.ts`.**
  - SKU único → hay `auto_sku` en sombra y el vínculo **no** cambia;
  - empate de SKU → no hay `auto_sku`;
  - GTIN igual y SKU distinto → no hay `auto_sku`;
  - con humana vigente → no hay `auto_sku`;
  - dos corridas → una sola `auto_sku`;
  - el top-3 queda guardado.
- [ ] **Paso 4:** FAIL → implementar → verde.
- [ ] **Paso 5:** commit con el mensaje `feat(e3): motor único en sombra: SKU exacto y candidatos explicados`.

### Tarea 5: API interna de la bandeja (plataforma)

**Archivos:**
- Crear: `plataforma/src/api/identidad-interna.ts`
- Modificar: `plataforma/src/api/app.ts`, para registrarla igual que `registrarCatalogoInterno`.
- Test: `plataforma/test/identidad/api-interna.test.ts`, con el patrón de `test/catalogo/api-interna.test.ts`.

**Rutas:** HMAC con `verificarInterna`, origen permitido y nonce de un solo uso, igual que `catalogo-interna.ts`.

| Método | Ruta | Uso |
|---|---|---|
| GET | `/internal/v1/identidad/casos?tipo&estado&cursor&limit` | cola priorizada |
| GET | `/internal/v1/identidad/casos/:id` | detalle |
| POST | `/internal/v1/identidad/casos/:id/decisiones` | decidir |

- **Orden de la cola:** `conflict` → las 17 de D5 (`detalle.d5=true`, que marca el motor) → casos con una `auto_sku` en sombra → publicaciones activas con stock → el resto. Dentro de cada grupo, `abierto_en`.
- **El detalle devuelve:**
  - la publicación: recurso, título, SKU observado, estado y link a ML;
  - el último top-3 con su explicación, **sin puntaje**;
  - la `auto_sku` en sombra, si la hay;
  - el historial de decisiones;
  - la evidencia y `version`.
- **El POST:**
  - el cuerpo es un zod strict `{expected_version, eleccion, variant_id?, motivo?, revierte?}`;
  - el actor (`{usuario, es_admin}`) viaja en el cuerpo firmado, y lo firma el legado después de verificar la sesión;
  - la cabecera `Idempotency-Key` es obligatoria;
  - se mapean `version_conflict`→409, `idempotency_mismatch`/`variante_invalida`→422, `solo_admin`→403, `bandeja_apagada`→503 y `caso_cerrado`→409.
- **Búsqueda de "otro candidato":** `GET /internal/v1/identidad/variantes?q=` busca por SKU exacto o por título (ILIKE, límite 20, sólo no archivadas).

- [ ] **Paso 1: tests que fallan.**
  - sin firma → 401;
  - nonce repetido → rechazo;
  - lista paginada con el orden de prioridad;
  - el detalle no trae el campo `puntaje`;
  - POST sin `Idempotency-Key` → 422;
  - 409 con `correlation_id`;
  - 503 con el flag apagado.
- [ ] **Paso 2:** FAIL → implementar → verde. **Paso 3:** commit con el mensaje `feat(e3): API interna firmada de la bandeja de identidad`.

### Tarea 6: pantalla de la bandeja en el legado

**Antes de codificar:** invocar a `disenador-ux` y a `disenador-ui` con la spec §10 y este contrato. Ellos definen el flujo y el sistema visual; después se implementa.

**Archivos:**
- Crear:
  - `routes/bandejaIdentidad.js`: el proxy firmado, con `firmarInterno` de `lib/internoHmac.js` y el mismo keyring que `lib/outboxPlataforma.js`;
  - `public/bandeja-identidad/index.html`, `bandeja.js` y `bandeja.css`.
- Modificar:
  - `server.js`: montarla como `/api/bandeja-identidad`, detrás de la sesión y del permiso `matcher`;
  - `public/home`: el acceso.
- Test: `test/bandejaIdentidad.test.js`

**Qué hace el proxy:**
- toma el actor **de la sesión del legado**, nunca del cliente;
- `es_admin` también sale de la sesión;
- reenvía `Idempotency-Key`;
- con un timeout de 5 s responde 502 `plataforma_no_responde`.

**Qué hace la pantalla:**
- **Cola:** la lista a la izquierda, o arriba en móvil.
- **Caso:** la publicación (foto, título, SKU, precio) y 3 tarjetas de candidato con «coincide/difiere».
- **Acciones:** elegir, buscar otro, omitir y «no existe en el catálogo».
- **Estados:** cargando, vacío, error y 409 («otra persona decidió este caso: recargado»). Ante un 409 recarga el caso y conserva la selección si la variante sigue disponible.
- **Idempotency-Key:** se genera una por intento de decisión (`crypto.randomUUID()`) y se reutiliza si el mismo intento se reintenta.

- [ ] **Paso 1: tests del proxy.**
  - sin sesión → 401;
  - sin `matcher` → 403;
  - el actor sale de la sesión aunque el cliente mande otro;
  - la firma es válida contra `verificarInterna` con la clave de test.
- [ ] **Paso 2:** FAIL → implementar → verde.
- [ ] **Paso 3:** `probador-e2e` en QA (`scripts/qa/qa.sh`) a 390/768/1440 con axe: decidir, 409 con dos pestañas, buscar otro y omitir.
- [ ] **Paso 4:** commit con el mensaje `feat(e3): bandeja de identidad en el legado`.

### Tarea 7: calibración, `test:e3` y evidencia

**Archivos:**
- Crear:
  - `plataforma/src/identidad/calibracion.ts`
  - `plataforma/scripts/calibracion-e3.mjs`
  - `plataforma/test/identidad/calibracion.test.ts`
- Modificar: `plataforma/package.json`, con `"test:e3": "vitest run test/identidad"`.

**Interfaz:**

```ts
export interface Metricas { engineVersion: string; n: number; top1: number; top3: number; top1MalAlto: number; recallN: number;
  autoSkuSombra: { total: number; coincideHumana: number; contradiceHumana: number }; tiempoMedianoDecisionS: number | null }
export async function calibrar(pool: pg.Pool, o: { desde: Date; hasta: Date; muestra: VerdadMuestra[] }): Promise<Metricas>;
```

- **Denominador:** la muestra de 299 más las decisiones humanas `vincular` de la ventana.
- **`contradiceHumana`** es el error de D6 en sombra.
- **Qué hace el script:** imprime JSON y escribe `docs/superpowers/evidence/e3/<fecha>-calibracion.md`.

- [ ] **Paso 1: test.** Con la muestra congelada en el fixture, `calibrar` reproduce el top-1 y el top-3 que da el port sobre esos datos. Una `auto_sku` distinta de la humana cuenta en `contradiceHumana`.
- [ ] **Paso 2: `test:e3` falla si falta un escenario.** Agregar `test/identidad/cobertura-e3.test.ts`, que lista los nombres de los escenarios de §11 que entran en este corte:
  - auto-SKU sólo con SKU único;
  - empate;
  - GTIN;
  - las 17;
  - 409 con dos operadores;
  - legado posterior → conflict;
  - idempotencia;
  - flag apagado;
  - calibración.

  El test verifica con `grep` sobre `test/identidad/*.test.ts` que existe un `it(` con cada nombre exacto. Los de relectura y canario son del corte 3.
- [ ] **Paso 3:** `npm run test:e3` verde; `npm test` de la plataforma verde, con la salida en `/tmp/claude-0/e3-plataforma.log`.
- [ ] **Paso 4:** commit.

### Tarea 8: puesta en producción, cada paso aprobado por José

1. **Gate:**
   - `npm test` de la plataforma y del legado (lo corre el orquestador, sin nada más corriendo);
   - `revisor` sobre el diff;
   - Codex en modo read-only;
   - `auditor-despliegue`.
2. **Migración 0020:** `build` desde un worktree limpio, `migrate`, y verificar que `schema_migrations=20`. Requiere OK de José.
3. **Worker con `E3_MOTOR=1` y `E3_BANDEJA=0`:** se verifican una corrida del motor y los candidatos guardados. Requiere OK.
4. **API y legado desplegados;** después `E3_BANDEJA=1` en worker y API. José decide 3 casos de prueba y se verifica el vínculo y la auditoría. Requiere OK.
5. **Arranque de la ventana de calibración:** se registra la fecha en la ficha E3 y en `docs/memory/active.md`.

**Rollback:**
- `E3_BANDEJA=0`: `decisionVigente` vuelve al legado y las decisiones se conservan;
- `E3_MOTOR=0`;
- la imagen anterior queda etiquetada `fusion-plataforma:antes-e3c1`.
