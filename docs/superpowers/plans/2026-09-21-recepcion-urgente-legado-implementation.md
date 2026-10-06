# Recepción urgente sobre el legado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or execute this plan task-by-task in one session. Steps use checkbox syntax for tracking. Do not skip red/green cycles or the final complete-suite gate.

**Goal:** recuperar el uso diario de Recepción conectando el matcher seguro existente, aprendiendo correcciones por proveedor y permitiendo crear productos o variaciones como borradores de WooCommerce antes de confirmar el ingreso.

**Architecture:** el navegador deja de decidir matches y envía las líneas al backend. Un servicio combina alias vigentes por proveedor, SKU exacto único y `lib/ingresoMatcher.js`; las decisiones se persisten con historia en SQLite. Los productos inexistentes se crean mediante un servicio Woo acotado, siempre como `draft`, con una operación local que impide repeticiones ciegas.

**Tech Stack:** Node.js ESM, Express 5, SQLite/better-sqlite3, WooCommerce REST API, HTML/JavaScript sin framework, Vitest, Supertest y Playwright.

**Spec:** `docs/superpowers/plans/2026-09-21-recepcion-documental-stock-anticipado.md` §3 y `docs/superpowers/plans/2026-09-21-revision-recepcion-vs-plan-maestro.md` §§191–229.

**Execution Profile:** diseñado para `gpt-5.6-luna` con reasoning `low`. El ejecutor debe seguir el orden, nombres, contratos y comandos literalmente; si una precondición real contradice el documento, debe detener esa tarea y registrar evidencia en vez de inventar otra arquitectura.

## Global Constraints

- Alcance exclusivo del legado inmediato: matcher backend, alias por proveedor, bandeja de excepciones y alta borrador.
- No implementar stock anticipado, E6, libro PostgreSQL, conciliación mult documento ni sincronización anticipada a ML.
- Todo producto nuevo queda con `status:"draft"`; nunca se publica ni se envía a Mercado Libre.
- Crear un borrador Woo usa stock cero. La cantidad se aplica una sola vez mediante `POST /api/recepciones/:id/confirmar`.
- Solamente alias vigente, SKU exacto único o `autoAplicable()` pueden precargar una línea.
- Ningún candidato ambiguo o de confianza baja se asigna automáticamente.
- Toda selección manual requiere confirmación explícita y puede aprenderse solamente para el proveedor actual.
- Los alias son versionados y revocables. Nunca se comparten entre proveedores.
- Una operación Woo incierta por timeout/red no se reintenta automáticamente.
- No cambiar costos, pedidos, semántica documental ni sincronización ML posterior a una recepción normal.
- Conservar todos los cambios no relacionados presentes en el worktree.
- Línea base verificada: 22 filas `estado_item='sin_match'` en `data/fusion.sqlite` al 2026-09-21.
- No declarar terminado el trabajo hasta completar las suites completas de raíz y `plataforma/`.

---

## File Map

**Create**

- `migrations/109_recepcion_aliases_proveedor.sql`: alias y operaciones de alta.
- `lib/recepcionAliases.js`: normalización y versiones de alias.
- `lib/recepcionMatching.js`: prioridad alias → SKU → matcher.
- `lib/nuevosProductosWoo.js`: creación fail-closed de borradores Woo.
- `test/recepcion-aliases.test.js`
- `test/recepcion-matching.test.js`
- `test/recepcion-matching-route.test.js`
- `test/nuevos-productos-crear.test.js`
- `test/recepcion-ui-logica.test.js`
- `scripts/recepcion-urgente-browser-smoke.mjs`
- `scripts/audit-recepcion-urgente.mjs`: auditoría read-only de los casos históricos.

**Modify**

- `db/schema.sql`, `db/index.js`
- `routes/recepciones.js`, `routes/nuevosProductos.js`
- `public/recepcion/index.html`
- `lib/permisos.js`, `server.js`, `package.json`
- Tests existentes de Gemini, recepción, permisos, servidor y nuevos productos.
- Memoria, índice y revisión de diseño.

---

### Task 1: Congelar línea base y hacer segura la suite

**Files**
- Modify: `test/gemini.test.js`
- Create: `test/fixtures/recepcion/sin-match-baseline.json`

**Produces**
- Fixture anonimizado `{ generado_en, total, por_recepcion:[{recepcion_id,cantidad}] }`.
- Limpieza que elimina exclusivamente el archivo creado por cada test.

- [ ] **Step 1: derivar la línea base en solo lectura**

Run:

```bash
node --input-type=module - <<'NODE'
import Database from 'better-sqlite3';
const db = new Database('data/fusion.sqlite', { readonly: true });
console.log(JSON.stringify({
  total: db.prepare("SELECT count(*) n FROM recepcion_items WHERE estado_item='sin_match'").get().n,
  por_recepcion: db.prepare("SELECT recepcion_id, count(*) cantidad FROM recepcion_items WHERE estado_item='sin_match' GROUP BY recepcion_id ORDER BY recepcion_id").all()
}, null, 2));
db.close();
NODE
```

Expected: total 22. Guardar solo conteos, sin nombres, códigos, precios ni proveedores.

- [ ] **Step 2: escribir la prueba de limpieza acotada**

Crear un centinela en `uploads/sin_importador/`, ejecutar la carga XML, capturar `res.body.file_url`, eliminar solo la ruta generada y comprobar:

```js
expect(fs.existsSync(centinela)).toBe(true);
expect(fs.existsSync(archivoDelTest)).toBe(false);
```

- [ ] **Step 3: comprobar el fallo actual**

Run: `npx vitest run test/gemini.test.js`

Expected: FAIL porque el `afterAll` actual borra todo `uploads/sin_importador`.

- [ ] **Step 4: corregir la limpieza**

Eliminar el `rmSync(..., {recursive:true})`. Mantener un Set de archivos exactos creados; borrarlos en `afterEach`. Intentar `rmdirSync` solo si el directorio queda vacío e ignorar exclusivamente `ENOTEMPTY` y `ENOENT`.

- [ ] **Step 5: verificar y commitear**

Run: `npx vitest run test/gemini.test.js`

Expected: PASS.

```bash
git add test/gemini.test.js test/fixtures/recepcion/sin-match-baseline.json
git commit -m "test: proteger archivos reales al probar recepcion"
```

---

### Task 2: Almacenamiento versionado de alias

**Files**
- Create: `migrations/109_recepcion_aliases_proveedor.sql`
- Modify: `db/schema.sql`, `db/index.js`
- Create: `lib/recepcionAliases.js`
- Create: `test/recepcion-aliases.test.js`

**Produces**
- `normalizarProveedor(texto): string`
- `claveAlias(input): {proveedorNorm,codigoNorm,descripcionNorm,variacionNorm}`
- `buscarAliasVigente(db,input): Alias|null`
- `confirmarAlias(db,input): Alias`
- `revocarAlias(db,id,{motivo,actor,ahora?}): boolean`

**DDL exacto**

```sql
CREATE TABLE IF NOT EXISTS recepcion_aliases_proveedor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proveedor_norm TEXT NOT NULL,
  codigo_norm TEXT NOT NULL DEFAULT '',
  descripcion_norm TEXT NOT NULL,
  variacion_norm TEXT NOT NULL DEFAULT '',
  id_woo INTEGER NOT NULL,
  sku TEXT,
  recepcion_item_id INTEGER,
  creado_por TEXT NOT NULL,
  vigente_desde TEXT NOT NULL,
  vigente_hasta TEXT,
  motivo_cierre TEXT,
  CHECK (codigo_norm <> '' OR descripcion_norm <> ''),
  CHECK ((vigente_hasta IS NULL) = (motivo_cierre IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS recepcion_alias_codigo_vigente
ON recepcion_aliases_proveedor(proveedor_norm,codigo_norm)
WHERE vigente_hasta IS NULL AND codigo_norm <> '';
CREATE UNIQUE INDEX IF NOT EXISTS recepcion_alias_descripcion_vigente
ON recepcion_aliases_proveedor(proveedor_norm,descripcion_norm,variacion_norm)
WHERE vigente_hasta IS NULL AND codigo_norm = '';
```

- [ ] **Step 1: escribir pruebas fallidas**

Cubrir normalización, tabla/índices en base limpia, aislamiento entre proveedores, idempotencia, reasignación con motivo, revocación, alias cuyo producto desapareció y fallback descripción+variación cuando no hay código.

- [ ] **Step 2: confirmar rojo**

Run: `npx vitest run test/recepcion-aliases.test.js`

Expected: FAIL por módulo y tabla inexistentes.

- [ ] **Step 3: aplicar migración**

Copiar DDL a schema y migración. En `openDb`, usar marcador `recepcion_aliases_proveedor_109`; ejecutar archivo y marcador dentro de una transacción. Envolver errores con causa.

- [ ] **Step 4: implementar lectura**

Prioridad: proveedor+código; sin código, proveedor+descripción+variación. Sin proveedor retorna null. Antes de devolver, verificar que `catalogo_cache.id_woo` existe.

- [ ] **Step 5: implementar confirmación**

En transacción: devolver la vigente si apunta al mismo producto; si cambia, exigir motivo, cerrar anterior e insertar versión; conservar actor e item de origen.

- [ ] **Step 6: implementar revocación**

Exigir actor y motivo. Actualizar solo una fila vigente. Retornar `changes===1`.

- [ ] **Step 7: verificar y commitear**

Run: `npx vitest run test/recepcion-aliases.test.js`

Expected: PASS.

```bash
git add migrations/109_recepcion_aliases_proveedor.sql db/schema.sql db/index.js lib/recepcionAliases.js test/recepcion-aliases.test.js
git commit -m "feat: aprender aliases de recepcion por proveedor"
```

---

### Task 3: Servicio de matching

**Files**
- Create: `lib/recepcionMatching.js`
- Create: `test/recepcion-matching.test.js`
- Reuse unchanged: `lib/ingresoMatcher.js`, `lib/matcherEngine.js`

**Produces**

```js
construirIndiceRecepcion(rows)
resolverLineaRecepcion(db, proveedor, linea, indice)
resolverLoteRecepcion(db, proveedor, lineas)
```

**Resultado exacto**

```js
{
  linea_id: 'local-1',
  estado: 'resuelto' | 'revisar' | 'sin_match',
  auto_aplicable: true | false,
  origen: 'alias_proveedor' | 'sku_exacto' | 'matcher' | 'ninguno',
  candidato: null | {
    id_woo, id_padre, sku, nombre, tipo, stock,
    confianza: 'alta' | 'revisar' | 'baja',
    razones: []
  },
  candidatos: [],
  ambiguo: false,
  sin_candidato: false
}
```

- [ ] **Step 1: escribir pruebas fallidas**

Sembrar alias; dos filas con SKU duplicado; variaciones hermanas 41/43/45 con atributos estructurados. Probar alias primero, SKU único, SKU duplicado revisable, hermanos ambiguos, talle correcto autoaplicable y confianza baja sin autoaplicar.

- [ ] **Step 2: confirmar rojo**

Run: `npx vitest run test/recepcion-matching.test.js`

Expected: FAIL por módulo inexistente.

- [ ] **Step 3: construir índice una vez por lote**

Query exacta:

```sql
SELECT id_woo,id_padre,sku,nombre,tipo,stock,atributos_json,marca
FROM catalogo_cache
WHERE COALESCE(sku,'') <> ''
ORDER BY id_woo
```

Pasar filas a `construirWCIndex`; agregar `marcasConocidas` como Set normalizado.

- [ ] **Step 4: implementar prioridad**

1. Alias vigente: alta, candidato único, autoaplicable.
2. Código proveedor igual a SKU case-insensitive: solo autoaplicar si hay una fila; duplicados quedan revisar.
3. Matcher: descripción = nombre+variación; usar color/talle/marca estructurados y `autoAplicable` sin cambiar umbrales.
4. Copiar stock por ID.
5. Traducir señales a razones humanas deterministas; no inventar porcentajes.

- [ ] **Step 5: verificar motor y servicio**

Run: `npx vitest run test/recepcion-matching.test.js test/ingreso-matcher.test.js`

Expected: PASS.

- [ ] **Step 6: commit**

```bash
git add lib/recepcionMatching.js test/recepcion-matching.test.js
git commit -m "feat: resolver recepciones con matcher seguro"
```

---

### Task 4: API de matching y decisiones

**Files**
- Modify: `routes/recepciones.js`
- Create: `test/recepcion-matching-route.test.js`
- Modify: `test/recepciones.test.js`

**Produces**
- `POST /api/recepciones/matchear`
- `POST /api/recepciones/:id/items/:itemId/resolver`
- `GET /api/recepciones/aliases?proveedor=...`
- `POST /api/recepciones/aliases/:aliasId/revocar`

**Match request**

```json
{"proveedor":"Bike Group","items":[{"linea_id":"local-1","nombre_doc":"Zapatilla X","variacion":"43 negro","codigo_proveedor":"ZX-43","marca":"Marca","color":"Negro","talle":"43"}]}
```

**Resolve request**

```json
{"id_woo":123,"aprender":true,"motivo":"confirmado contra etiqueta"}
```

- [ ] **Step 1: escribir pruebas fallidas HTTP**

Probar 400 sin proveedor/items, más de 250 filas, texto mayor a 500; orden estable; 404 de entidades; 409 para padre variable/no vendible o item no pendiente; resolver+aprender; revocar dos veces.

- [ ] **Step 2: confirmar rojo**

Run: `npx vitest run test/recepcion-matching-route.test.js`

Expected: rutas 404.

- [ ] **Step 3: implementar matching read-only**

Validar sin coerciones silenciosas, índice único por request, máximo 250 y errores `{ok:false,code,error}`.

- [ ] **Step 4: implementar resolución transaccional**

Leer recepción+item; validar producto vendible; actualizar `id_woo,sku,estado_item='pendiente',error_wc=NULL`; aprender con actor autenticado. No aplicar stock dentro de esta ruta.

- [ ] **Step 5: implementar GET y revocación**

GET solo vigentes del proveedor, orden estable. Revocación exige motivo.

- [ ] **Step 6: verificar y commit**

Run: `npx vitest run test/recepcion-matching-route.test.js test/recepciones.test.js`

Expected: PASS.

```bash
git add routes/recepciones.js test/recepcion-matching-route.test.js test/recepciones.test.js
git commit -m "feat: exponer matching y aprendizaje de recepcion"
```

---

### Task 5: Alta Woo fail-closed

**Files**
- Create: `lib/nuevosProductosWoo.js`
- Extend: migration 109 and `db/schema.sql`
- Create: `test/nuevos-productos-crear.test.js`

**Produces**
- `validarFichaAlta(input): FichaAlta`
- `listarCategoriasWoo(cfg,{fetchWoo?}): Promise<Categoria[]>`
- `crearBorradorWoo({db,cfg,operationId,ficha,actor,fetchWoo?}): Promise<AltaResult>`

**Ficha exacta**

```js
{
  modo: 'simple' | 'familia_variable' | 'variacion_existente',
  titulo, marca,
  categoria_id: 17,
  categoria_nombre: 'CASCOS',
  precio: '120000',
  descripcion: '',
  parent_id: null,
  atributos: [{nombre:'Color',valor:'Negro'}]
}
```

**Operaciones**

```sql
CREATE TABLE IF NOT EXISTS recepcion_altas_woo (
 operation_id TEXT PRIMARY KEY,
 request_hash TEXT NOT NULL,
 estado TEXT NOT NULL CHECK (estado IN ('procesando','creado','incierto','fallido')),
 modo TEXT NOT NULL,
 id_woo INTEGER,
 id_padre INTEGER,
 sku TEXT,
 respuesta_json TEXT,
 error TEXT,
 creado_por TEXT NOT NULL,
 creado_en TEXT NOT NULL,
 actualizado_en TEXT NOT NULL
);
```

- [ ] **Step 1: escribir validaciones fallidas**

Rechazar operation ID no UUID; título/marca/categoría vacíos; precio no positivo; variación sin padre; simple con padre; atributos vacíos/repetidos; padre inexistente/no variable.

- [ ] **Step 2: escribir payload tests**

Simple: POST `/products` draft con stock 0; PATCH SKU `FB-{id}`; GET y verificar.

Familia: POST parent variable draft; POST única variación con stock 0; PATCH SKU; GET variación.

Variación existente: no crear parent y crear bajo parent confirmado.

- [ ] **Step 3: confirmar rojo**

Run: `npx vitest run test/nuevos-productos-crear.test.js`

Expected: módulo inexistente.

- [ ] **Step 4: categorías paginadas**

GET `/products/categories?per_page=100&page=N&hide_empty=false`, detener con página corta, máximo 20. Conservar id/name/parent. Al crear, verificar coincidencia ID+nombre.

- [ ] **Step 5: idempotencia local**

Hash SHA-256 de ficha canónica. Insertar `procesando` antes de red. Mismo ID+hash creado devuelve resultado. Hash distinto da conflicto. `procesando` o `incierto` bloquea. HTTP definitivo marca `fallido` terminal. Timeout/red o relectura inconsistente marca incierto. Una operación `fallido` no se reutiliza: después de corregir la ficha, la UI genera un UUID nuevo; así cada intento conserva su evidencia.

- [ ] **Step 6: crear, asignar SKU y releer**

Nunca usar publish ni stock positivo. SKU inmutable `FB-{id_woo}`. Si parent se creó y variación falla, guardar parent ID y estado incierto; no repetir parent.

- [ ] **Step 7: completar fallos**

Probar replay exitoso sin red, hash distinto, timeout POST, timeout luego del parent, relectura incorrecta y ausencia total de publish/stock positivo.

- [ ] **Step 8: verificar y commit**

Run: `npx vitest run test/nuevos-productos-crear.test.js`

Expected: PASS.

```bash
git add lib/nuevosProductosWoo.js migrations/109_recepcion_aliases_proveedor.sql db/schema.sql test/nuevos-productos-crear.test.js
git commit -m "feat: crear borradores woo de forma segura"
```

---

### Task 6: Rutas de alta y permisos

**Files**
- Modify: `routes/nuevosProductos.js`, `server.js`, `lib/permisos.js`
- Modify: `test/nuevosProductos.test.js`, `test/permisos.test.js`, `test/server.test.js`

**Produces**
- `GET /api/nuevos-productos/categorias-woo`
- `POST /api/nuevos-productos/crear-borrador`

Cambiar firma:

```js
nuevosProductosRouter(geminiKey, db, wooCfg, deps = {})
```

Permiso antes del catch-all:

```js
{ re:/^\/nuevos-productos\/(categorias-woo|crear-borrador)$/, resolve:(m)=>({anyOf:['stock','recepcion'],nivel:m==='GET'?'read':'write'}) }
```

- [ ] **Step 1: escribir pruebas fallidas**

Recepción write puede crear; recepción read recibe 403; Stock conserva acceso; body inválido 400; incierto 409; éxito enlaza item guardado; alta sin item devuelve identidad para una fila local.

- [ ] **Step 2: confirmar rojo**

Run: `npx vitest run test/nuevosProductos.test.js test/permisos.test.js test/server.test.js`

Expected: FAIL por rutas/firma/permisos.

- [ ] **Step 3: montar router con wooCfg**

Actualizar firma y montaje sin alterar endpoints existentes.

- [ ] **Step 4: implementar categorías y creación**

Mapear validación 400, inexistente 404, conflicto/incierto 409 y error Woo definitivo 502. No devolver stack, credenciales ni payload remoto completo.

- [ ] **Step 5: enlazar item**

Si vienen recepción e item, exigir ambos; validar relación y estado. En éxito actualizar `id_woo,sku,estado_item='creado',ficha_json,resuelto_en`. Sin IDs, solo devolver identidad.

- [ ] **Step 6: verificar y commit**

Run: `npx vitest run test/nuevosProductos.test.js test/permisos.test.js test/server.test.js test/nuevos-productos-crear.test.js`

Expected: PASS.

```bash
git add routes/nuevosProductos.js server.js lib/permisos.js test/nuevosProductos.test.js test/permisos.test.js test/server.test.js
git commit -m "feat: exponer alta borrador desde recepcion"
```

---

### Task 7: Sustituir matcher del navegador

**Files**
- Modify: `public/recepcion/index.html`
- Create: `test/recepcion-ui-logica.test.js`
- Modify: `test/recepcion-busqueda.test.js`

- [ ] **Step 1: congelar retirada del matcher viejo**

```js
expect(html).not.toMatch(/function\s+matchItem\s*\(/);
expect(html).not.toMatch(/function\s+fuzzyMatchItem\s*\(/);
expect(html).not.toContain("fetch('/api/woo/catalogo')");
expect(html).toContain("fetch('/api/recepciones/matchear'");
```

Probar además respuestas fuera de orden mediante `matchRequestVersion`.

- [ ] **Step 2: confirmar rojo**

Run: `npx vitest run test/recepcion-ui-logica.test.js test/recepcion-busqueda.test.js`

Expected: FAIL.

- [ ] **Step 3: retirar catálogo global automático**

Eliminar arranque `cargarCatalogo`, cache de catálogo, `matchItem`, `fuzzyMatchItem` y normalización exclusiva. El buscador manual también debe usar backend.

- [ ] **Step 4: match asíncrono por lote**

`crearItem` deja `matchEstado:'cargando'`. Tras incorporar todas las líneas, un único POST. Máximo 250. Ignorar respuestas de versión vieja. Autoasignar solo `auto_aplicable:true`. Error deja reintento visible, sin candidato aplicado.

- [ ] **Step 5: renderizar estados**

Verde resuelto+origen; ámbar revisar+candidatos+razones; rojo sin match+alta; error recuperable. Nunca mostrar ambiguo como asignado.

- [ ] **Step 6: verificar y commit**

Run: `npx vitest run test/recepcion-ui-logica.test.js test/recepcion-busqueda.test.js test/ingreso-matcher.test.js`

Expected: PASS.

```bash
git add public/recepcion/index.html test/recepcion-ui-logica.test.js test/recepcion-busqueda.test.js
git commit -m "feat: usar matcher backend en recepcion"
```

---

### Task 8: Confirmación y aprendizaje en UI

**Files**
- Modify: `public/recepcion/index.html`, `routes/recepciones.js`
- Modify: tests de UI y recepción.

- [ ] **Step 1: escribir pruebas fallidas**

Alta segura preseleccionada; revisar/baja requieren click; checkbox recordar marcado por defecto solo con código; proveedor vacío bloquea; cambiar proveedor invalida matches.

- [ ] **Step 2: confirmar rojo**

Run: `npx vitest run test/recepcion-ui-logica.test.js`

Expected: FAIL.

- [ ] **Step 3: panel de confirmación**

Mostrar línea original, candidato, SKU, atributos, razones/contradicciones, checkbox recordar y motivo obligatorio al reemplazar alias.

- [ ] **Step 4: persistir en el momento correcto**

Recepción guardada usa `/resolver`. Fila local incluye `match_origen,match_confirmado,aprender_alias,motivo_alias` en payload; backend inserta items y alias en la misma transacción.

- [ ] **Step 5: resumen antes de confirmar**

Separar seguros, manuales, pendientes y no recibidos. Un item revisar sin confirmar no cuenta como match ni toca stock.

- [ ] **Step 6: verificar y commit**

Run: `npx vitest run test/recepcion-ui-logica.test.js test/recepciones.test.js test/recepcion-matching-route.test.js`

Expected: PASS.

```bash
git add public/recepcion/index.html routes/recepciones.js test/recepcion-ui-logica.test.js test/recepciones.test.js
git commit -m "feat: confirmar y aprender matches de recepcion"
```

---

### Task 9: Alta asistida en UI

**Files**
- Modify: `public/recepcion/index.html`
- Modify: tests UI y nuevos productos.

- [ ] **Step 1: escribir pruebas fallidas**

Cubrir simple, familia variable y variación existente; una sola variación real; campos obligatorios; texto Crear borrador; operation ID estable; incierto bloquea; éxito enlaza y la confirmación suma una vez.

- [ ] **Step 2: confirmar rojo**

Run: `npx vitest run test/recepcion-ui-logica.test.js test/nuevosProductos.test.js`

Expected: FAIL.

- [ ] **Step 3: abrir ficha**

Usar `/analizar`; traducir `ti,m,mo,da,t,c,a,v,d`; cargar categorías Woo con ID. Toda sugerencia queda editable/no confirmada.

- [ ] **Step 4: elegir modo**

Simple sin padre. Familia variable exige eje+valor y crea solo esta variación. Variación existente exige buscar y confirmar padre variable. Nunca agrupar automáticamente.

- [ ] **Step 5: validar campos**

Título, marca, categoría ID, precio positivo, atributos variables y padre cuando corresponda; mostrar error junto a cada campo.

- [ ] **Step 6: crear y enlazar**

Generar UUID una vez al abrir. En éxito marcar `alta_borrador`, asignar ID/SKU y avisar que el stock se cargará al confirmar. En incierto bloquear otro POST y mostrar operation ID. En 400 conservar formulario y UUID porque no hubo intento remoto. En 502 definitivo, conservar el error; al corregir la ficha, generar un UUID nuevo antes del próximo POST.

- [ ] **Step 7: verificar y commit**

Run: `npx vitest run test/recepcion-ui-logica.test.js test/nuevosProductos.test.js test/nuevos-productos-crear.test.js test/recepciones.test.js`

Expected: PASS.

```bash
git add public/recepcion/index.html test/recepcion-ui-logica.test.js test/nuevosProductos.test.js
git commit -m "feat: crear productos borrador desde recepcion"
```

---

### Task 10: E2E responsive local

**Files**
- Create: `scripts/recepcion-urgente-browser-smoke.mjs`
- Create: `scripts/audit-recepcion-urgente.mjs`
- Modify: `package.json`

**Produces**
- `npm run e2e:recepcion-urgente`

- [ ] **Step 1: levantar fixture local**

Usar `buildApp`, SQLite temporal y mocks Gemini/Woo; ninguna red ni credenciales. Sembrar match seguro, hermanas ambiguas, línea inexistente y categorías.

- [ ] **Step 2: recorrer 390, 768 y 1440 px**

Autenticar, abrir recepción, cargar fixture, revisar seguro/ambiguo, confirmar y aprender, crear borrador, confirmar recepción, verificar un incremento por línea y cero requests ML por el borrador. Fallar ante console error, pageerror o HTTP 5xx.

- [ ] **Step 3: agregar script**

```json
"e2e:recepcion-urgente": "node scripts/recepcion-urgente-browser-smoke.mjs"
```

- [ ] **Step 4: agregar auditoría histórica read-only**

`scripts/audit-recepcion-urgente.mjs` recibe `--db <ruta>` y abre SQLite con `{readonly:true,fileMustExist:true}`. Consulta solamente items `sin_match`, agrupa por recepción/proveedor, construye una vez el índice y ejecuta `resolverLoteRecepcion` sin guardar alias ni modificar items. La salida JSON incluye únicamente totales y conteos por recepción:

```json
{"total":22,"resuelto_automatico":0,"requiere_revision":0,"sin_match":0,"por_recepcion":[{"recepcion_id":1,"total":1,"resuelto_automatico":0,"requiere_revision":0,"sin_match":1}]}
```

No incluir nombres, SKU, códigos, proveedores, precios, candidatos ni razones. Comparar antes/después `PRAGMA data_version`, cantidad total de items y cantidad de alias; fallar si cambia alguno.

- [ ] **Step 5: verificar E2E y auditoría**

Run: `npm run e2e:recepcion-urgente`

Expected: PASS tres viewports.

Run: `node scripts/audit-recepcion-urgente.mjs --db data/fusion.sqlite`

Expected: `total:22`, suma de los tres resultados igual a 22 y confirmación read-only en stderr.

- [ ] **Step 6: commit**

```bash
git add scripts/recepcion-urgente-browser-smoke.mjs scripts/audit-recepcion-urgente.mjs package.json
git commit -m "test: cubrir recepcion urgente de punta a punta"
```

---

### Task 11: Documentación fiel

**Files**
- Modify: `docs/memory/modules/warehouse-operations.md`
- Modify: `docs/memory/active.md`
- Modify: `docs/superpowers/INDEX.md`
- Modify: revisión de diseño.

- [ ] **Step 1: corregir formatos**

No afirmar XLSX. Describir XML con límites/codificación realmente implementados.

- [ ] **Step 2: registrar los 22**

Añadir consulta, fecha, base y distribución anonimizada del fixture.

- [ ] **Step 3: marcar alcance**

Implementado: matcher backend, alias, alta draft, excepciones. Diferido: anticipado, E6, documentos canónicos, conciliación, publicación completa.

- [ ] **Step 4: validar y commit**

Run: `npm run docs:validate-deliveries`

Expected: PASS.

```bash
git add docs/memory/modules/warehouse-operations.md docs/memory/active.md docs/superpowers/INDEX.md docs/superpowers/plans/2026-09-21-revision-recepcion-vs-plan-maestro.md
git commit -m "docs: registrar recepcion urgente implementada"
```

---

### Task 12: Gate final de suite completa

**Files**
- Create: `docs/superpowers/evidence/recepcion-urgente-2026-09-21.md`

- [ ] **Step 1: integridad del diff**

Run:

```bash
git status --short
git diff --check
```

Expected: diff check sin salida; cambios preexistentes identificados y preservados.

- [ ] **Step 2: suite completa del legado**

Run: `npm test`

Expected: todos los test files PASS, sin filtros ni exclusiones.

- [ ] **Step 3: E2E de iniciativa**

Run: `npm run e2e:recepcion-urgente`

Expected: PASS en tres viewports.

- [ ] **Step 4: auditar los 22 casos sin mutar producción**

Run: `node scripts/audit-recepcion-urgente.mjs --db data/fusion.sqlite`

Expected: total 22; suma de `resuelto_automatico`, `requiere_revision` y `sin_match` igual a 22; verificación read-only exitosa. Registrar los conteos en evidencia.

- [ ] **Step 5: plataforma completa**

Run:

```bash
cd plataforma
npm run typecheck
npm test
```

Expected: typecheck y todos los tests PASS.

- [ ] **Step 6: contratos adicionales**

Desde raíz:

```bash
npm run docs:validate-deliveries
npm run verify:mobile-contract
```

Expected: PASS.

- [ ] **Step 7: lint atribuible**

Run global `npm run lint` y guardar baseline preexistente. Luego:

```bash
npx eslint routes/recepciones.js routes/nuevosProductos.js lib/recepcionAliases.js lib/recepcionMatching.js lib/nuevosProductosWoo.js test/recepcion-aliases.test.js test/recepcion-matching.test.js test/recepcion-matching-route.test.js test/nuevos-productos-crear.test.js test/recepcion-ui-logica.test.js scripts/recepcion-urgente-browser-smoke.mjs scripts/audit-recepcion-urgente.mjs
```

Expected: cero errores en archivos de la iniciativa. No ampliar alcance para arreglar deuda global.

- [ ] **Step 8: invariantes SQL**

En base E2E:

```sql
SELECT proveedor_norm,codigo_norm,count(*)
FROM recepcion_aliases_proveedor
WHERE vigente_hasta IS NULL
GROUP BY proveedor_norm,codigo_norm
HAVING count(*)>1;

SELECT * FROM recepcion_items
WHERE estado_item='creado' AND (id_woo IS NULL OR sku IS NULL);
```

Expected: sin filas.

- [ ] **Step 9: evidencia**

Registrar SHA, Node/npm, comandos, timestamps, duración, conteo de tests, resultados, baseline lint y confirmación de cero red real.

- [ ] **Step 10: commit**

```bash
git add docs/superpowers/evidence/recepcion-urgente-2026-09-21.md
git commit -m "test: registrar evidencia completa de recepcion urgente"
```

---

## Acceptance Checklist

- [ ] La UI no descarga el catálogo completo para match automático.
- [ ] `matchItem` y `fuzzyMatchItem` desaparecieron de Recepción.
- [ ] Alias, SKU duplicado, hermanos ambiguos y contradicciones tienen pruebas.
- [ ] Ninguna línea ambigua toca stock sin confirmación.
- [ ] Aprendizaje se reutiliza solo para el mismo proveedor y puede revocarse.
- [ ] Se crean simple, familia variable y variación existente como borradores.
- [ ] Alta nueva queda sin publicar, stock cero antes de confirmar y sin ML.
- [ ] Replay exitoso no duplica; operación incierta queda bloqueada.
- [ ] Confirmar recepción suma cada cantidad una sola vez.
- [ ] Los 22 casos históricos están respaldados por fixture anonimizado.
- [ ] Suite completa raíz, E2E responsive, typecheck y suite completa plataforma pasan.
- [ ] Documentación separa parche inmediato de plan maestro.

## Explicitly Deferred to the Master Plan

- Stock anticipado y fórmula de disponibilidad.
- Existencia física versus reservas, retenciones y tránsito.
- Conciliación orden/remito/factura.
- E6 PostgreSQL, putaway y conteos.
- Outbox canónica para todos los efectos remotos.
- Alta comercial con imágenes, SEO, texto final y publicación.
- Sustitución y apagado definitivo del legado.
