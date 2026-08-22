# Cierre seguro de sesión del Contador — Plan de implementación

> **Para quien ejecute:** las tres tareas son **una sola entrega**. La Tarea 1 sola deja al
> operario sin poder confirmar y sin salida — no se despliega suelta. Los pasos usan checkbox
> (`- [ ]`).

**Goal:** que sea imposible confirmar un conteo dejando productos con stock sin decisión
explícita.

**Architecture:** un gate fail-closed en `POST /confirmar` (mismo patrón que el gate de
`sin_asociar` que ya existe), una ruta para cerrar en 0 productos **con** stock por lista
explícita, y una pantalla de cierre que obliga a elegir. Sin migración ni columna nueva: el
backend ya expone `pendientes[]` y `resumen.pendientes_con_stock` en `GET /sesiones/:id`.

**Tech Stack:** Node/Express ESM, better-sqlite3, vitest. Frontend en `public/` sin framework,
scripts clásicos.

**Spec:** `docs/superpowers/specs/2026-08-21-cierre-seguro-conteo-design.md`
**Incidente que lo origina:** `docs/incidentes/2026-08-21-sobreventa-por-no-contado.md`

## Global Constraints

- **Nunca escribir en `data/*.sqlite`.** Los tests usan sus `.sqlite` temporales de `test/`.
- El bloque `sin_stock` **no** entra al gate: ya está en 0 en Woo, ajustarlo es no-op.
- `todos:true` **nunca** vale para el bloque `con_stock`: bajar a 0 algo que tenía stock es
  destructivo y pasa por Woo al confirmar.
- Español en toda la copy de usuario y en los mensajes de error de la API.
- La suite completa la corre **solo** el orquestador, al final, sin nadie más trabajando.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `routes/inventario.js` | Gate en `/confirmar` (~:657), helper `cerrarEnCero`, ruta nueva `POST /sesiones/:id/cerrar-en-cero` |
| `test/inventario.test.js` | Tests del gate y de la ruta nueva |
| `public/inventario/index.html` | Pantalla de cierre + su cableado con `renderRevision` (~:1761) y `btn-confirmar-ajuste` (~:1859) |

---

### Task 1: El gate — no se puede confirmar con pendientes con stock

**Files:**
- Modify: `routes/inventario.js:657-712` (`POST /sesiones/:id/confirmar`)
- Test: `test/inventario.test.js`

**Interfaces:**
- Produces: respuesta 409 con `{ ok:false, error, pendientes_con_stock:number,
  pendientes:[{sku, nombre, stock_woo}] }`. La Tarea 3 consume esa forma.

- [ ] **Step 1: Escribir el test que falla**

En `test/inventario.test.js`, en el bloque de confirmar:

```js
// El alcance se arma solo desde catalogo_cache: un producto con stock>0 cae en el bloque
// `con_stock`. No hay helper para sembrar alcance a mano — se siembra con insertProducto.
it('no confirma si quedan productos CON STOCK sin contar, y no toca Woo', async () => {
  const db = openDb(TEST_DB);
  insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', stock: 3 });
  insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 2 });
  const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
  const id = crear.body.sesion.id;
  await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });

  const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

  expect(r.status).toBe(409);
  expect(r.body.pendientes_con_stock).toBe(1);
  expect(r.body.pendientes[0].sku).toBe('FB-2');
  expect(setStockWc).not.toHaveBeenCalled();          // NI UNA llamada a Woo
  // el reclamo atómico no se ejecutó: la sesión sigue reintentable
  expect(db.prepare('SELECT estado FROM inventario_sesiones WHERE id=?').get(id).estado).toBe('abierta');
});

it('confirma normalmente cuando el pendiente con stock se cerró en 0', async () => {
  setStockWc.mockResolvedValue();
  const db = openDb(TEST_DB);
  insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', stock: 3 });
  insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 2 });
  const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
  const id = crear.body.sesion.id;
  await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
  await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/cerrar-en-cero`).send({ skus: ['FB-2'] });

  const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
});

it('un pendiente SIN stock no bloquea: ajustarlo a 0 seria un no-op', async () => {
  setStockWc.mockResolvedValue();
  const db = openDb(TEST_DB);
  insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', stock: 3 });
  insertProducto(db, { id_woo: 9, sku: 'FB-9', marca: 'Bell', stock: 0 });   // bloque sin_stock
  const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
  const id = crear.body.sesion.id;
  await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });

  const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);
  expect(r.status).toBe(200);
});
```

Los helpers reales del archivo son `buildApp(db, usuario)`, `insertProducto(db, extra)` y
`openDb(TEST_DB)`; `setStockWc` está mockeado con `vi.fn()` en el tope del archivo, así que
"no se llamó a Woo" se afirma con `expect(setStockWc).not.toHaveBeenCalled()`. Los tests de
confirmar viven en el `describe('POST /api/inventario/sesiones/:id/confirmar')` (~:421) y
crean la sesión inline, sin helper. **Seguí ese patrón; no inventes infraestructura nueva.**

- [ ] **Step 2: Correr y verificar que falla**

`npx vitest run test/inventario.test.js -t 'no confirma si quedan'`
Esperado: FALLA con `expected 200 to be 409`. Si pasa en verde, el test no está probando
nada — arreglalo antes de seguir.

- [ ] **Step 3: Implementar el gate**

En `routes/inventario.js`, dentro de `/confirmar`, **justo después** del bloque
`if (sinAsociar.length) {...}` y **antes** del reclamo atómico (`UPDATE ... estado='confirmando'`):

```js
    // Fail-closed contra la sobreventa: un producto CON stock que nunca se contó no tiene
    // fila en inventario_conteos, así que el ajuste de abajo ni lo ve — se queda publicado
    // con el stock que tenía. Si ya no está físicamente, se vende (incidente 2026-08-21).
    // El bloque sin_stock no entra: ya está en 0 en Woo, ajustarlo a 0 es un no-op.
    const pendientesConStock = db.prepare(`
      SELECT a.sku, a.nombre, COALESCE(c.stock, a.stock_inicial) AS stock_woo
      FROM inventario_sesion_alcance a
      LEFT JOIN catalogo_cache c ON c.sku = a.sku
      WHERE a.sesion_id=? AND a.bloque='con_stock'
        AND a.sku NOT IN (SELECT COALESCE(sku,'') FROM inventario_conteos WHERE sesion_id=?)
      ORDER BY a.sku
    `).all(sesion.id, sesion.id);
    if (pendientesConStock.length) {
      return res.status(409).json({
        ok: false,
        error: 'Quedan productos con stock sin contar. Decidí uno por uno antes de confirmar: '
             + 'pasalos a 0 si no había ninguna, o dejalos pendientes para revisar.',
        pendientes_con_stock: pendientesConStock.length,
        pendientes: pendientesConStock,
      });
    }
```

**Importante:** va antes del reclamo atómico. Si va después, la sesión queda en estado
`confirmando` y no se puede reintentar.

- [ ] **Step 4: Correr y verificar que pasa**

`npx vitest run test/inventario.test.js`
Esperado: los tres tests nuevos en verde y **ningún test viejo roto**. Si alguno viejo se pone
rojo, es porque armaba sesiones con pendientes con stock y confirmaba: revisá si el test
describía el comportamiento que estamos eliminando a propósito — en ese caso actualizalo y
dejá un comentario diciendo por qué.

- [ ] **Step 5: Commit**

```bash
git add routes/inventario.js test/inventario.test.js
git commit -m "No se puede confirmar un conteo con productos con stock sin contar"
```

---

### Task 2: Cerrar en 0 productos **con** stock, por lista explícita

**Files:**
- Modify: `routes/inventario.js:606-641` (`cerrar-sin-stock`) — extraer helper
- Test: `test/inventario.test.js`

**Interfaces:**
- Consumes: nada de la Tarea 1.
- Produces: `POST /sesiones/:id/cerrar-en-cero` con body `{ skus: string[] }` →
  `{ ok:true, cerrados:number, skus:string[] }`. La Tarea 3 la llama.

- [ ] **Step 1: Escribir el test que falla**

```js
// Mismo patrón que el resto del archivo: sembrar catálogo con insertProducto y crear la
// sesión por la API. El alcance sale solo de catalogo_cache (stock>0 → bloque con_stock).
it('cierra en 0 un producto CON stock cuando se lo pide por SKU', async () => {
  const db = openDb(TEST_DB);
  insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 2 });
  const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
  const id = crear.body.sesion.id;

  const r = await request(buildApp(db, 'juan'))
    .post(`/api/inventario/sesiones/${id}/cerrar-en-cero`).send({ skus: ['FB-2'] });

  expect(r.status).toBe(200);
  expect(r.body.cerrados).toBe(1);
  const fila = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND sku=?').get(id, 'FB-2');
  expect(fila.cantidad).toBe(0);
  expect(fila.confirmado_por_omision).toBe(1);
  expect(fila.bloque).toBe('con_stock');
});

// Bajar a 0 algo que tenía stock es destructivo: pasa por Woo al confirmar. Un `todos:true`
// acá sería el botón que vacía el depósito cuando el operario se cansó.
it('rechaza todos:true para productos con stock', async () => {
  const db = openDb(TEST_DB);
  insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 2 });
  const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
  const id = crear.body.sesion.id;

  const r = await request(buildApp(db, 'juan'))
    .post(`/api/inventario/sesiones/${id}/cerrar-en-cero`).send({ todos: true });

  expect(r.status).toBe(400);
  expect(db.prepare('SELECT COUNT(*) n FROM inventario_conteos WHERE sesion_id=?').get(id).n).toBe(0);
});

it('ignora un SKU que no esta en el alcance de la sesion', async () => {
  const db = openDb(TEST_DB);
  insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 2 });
  const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
  const id = crear.body.sesion.id;

  const r = await request(buildApp(db, 'juan'))
    .post(`/api/inventario/sesiones/${id}/cerrar-en-cero`).send({ skus: ['FB-999'] });

  expect(r.body.cerrados).toBe(0);
});

it('no cierra nada si la sesion no esta abierta', async () => {
  const db = openDb(TEST_DB);
  insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 2 });
  const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
  const id = crear.body.sesion.id;
  db.prepare("UPDATE inventario_sesiones SET estado='confirmada' WHERE id=?").run(id);

  const r = await request(buildApp(db, 'juan'))
    .post(`/api/inventario/sesiones/${id}/cerrar-en-cero`).send({ skus: ['FB-2'] });

  expect(r.status).toBe(400);
});
```

- [ ] **Step 2: Correr y verificar que falla**

`npx vitest run test/inventario.test.js -t 'cierra en 0 un producto CON stock'`
Esperado: FALLA con 404 (la ruta no existe).

- [ ] **Step 3: Extraer el helper y agregar la ruta**

En `routes/inventario.js`, arriba de `cerrar-sin-stock`:

```js
  // Inserta filas de conteo en 0 para SKUs del alcance que todavía no se contaron.
  // `bloque` acota a qué mitad del alcance se aplica; devuelve cuántas filas creó.
  function cerrarEnCero(sesionId, skusPedidos, bloque) {
    const candidatos = db.prepare(`
      SELECT a.sku FROM inventario_sesion_alcance a
      WHERE a.sesion_id=? AND a.bloque=?
        AND a.sku NOT IN (SELECT COALESCE(sku,'') FROM inventario_conteos WHERE sesion_id=?)
    `).all(sesionId, bloque, sesionId).map(r => r.sku);
    const aCerrar = candidatos.filter(s => skusPedidos.includes(s));
    const insertar = db.prepare(`INSERT OR IGNORE INTO inventario_conteos
      (sesion_id, ean, sku, cantidad, bloque, fuera_de_alcance, confirmado_por_omision, actualizado_en)
      VALUES (?,?,?,0,?,0,1,?)`);
    const tx = db.transaction(skus => {
      let n = 0;
      for (const sku of skus) n += insertar.run(sesionId, sku, sku, bloque, now()).changes;
      return n;
    });
    return { cerrados: tx(aCerrar), skus: aCerrar };
  }
```

Y la ruta nueva, después de `cerrar-sin-stock`:

```js
  // Cierra en 0 productos que SÍ tenían stock ("lo busqué, no había ninguna"). A diferencia
  // de cerrar-sin-stock, acá NO existe `todos:true`: esto termina bajando stock real en Woo,
  // y un botón masivo sería la salida fácil que devuelve el problema que este cambio arregla.
  router.post('/sesiones/:id/cerrar-en-cero', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });
    asegurarAlcance(sesion);

    const pedidos = parseLista(req.body?.skus);
    if (!pedidos.length) {
      return res.status(400).json({
        ok: false,
        error: 'Indicá una lista `skus` no vacía. Para productos con stock no existe `todos`.',
      });
    }
    res.json({ ok: true, ...cerrarEnCero(sesion.id, pedidos, 'con_stock') });
  });
```

Reescribí el cuerpo de `cerrar-sin-stock` para que use el helper, conservando su `todos:true`
(ese sí es seguro: son productos que ya están en 0):

```js
    const aCerrarTodos = todos
      ? db.prepare(`SELECT a.sku FROM inventario_sesion_alcance a
           WHERE a.sesion_id=? AND a.bloque='sin_stock'
             AND a.sku NOT IN (SELECT COALESCE(sku,'') FROM inventario_conteos WHERE sesion_id=?)`)
          .all(sesion.id, sesion.id).map(r => r.sku)
      : pedidos;
    res.json({ ok: true, ...cerrarEnCero(sesion.id, aCerrarTodos, 'sin_stock') });
```

- [ ] **Step 4: Correr y verificar que pasa**

`npx vitest run test/inventario.test.js`
Esperado: los cuatro tests nuevos verdes **y los viejos de `cerrar-sin-stock` intactos** (el
refactor no debe cambiar su comportamiento).

- [ ] **Step 5: Commit**

```bash
git add routes/inventario.js test/inventario.test.js
git commit -m "Cerrar en 0 productos con stock, solo por lista explicita"
```

---

### Task 3: La pantalla de cierre

**Files:**
- Modify: `public/inventario/index.html` — markup nuevo cerca del modal de confirmación
  (~:499), lógica cerca de `renderRevision` (~:1761) y del handler de
  `btn-confirmar-ajuste` (~:1859)

**Interfaces:**
- Consumes: el 409 de la Tarea 1 y `POST /cerrar-en-cero` de la Tarea 2. También
  `revisionData.pendientes` (ya lo trae `GET /sesiones/:id`), filtrando `bloque === 'con_stock'`.

- [ ] **Step 1: Cambiar el texto que documenta el bug**

`public/inventario/index.html:1780` dice hoy: *"N productos del alcance no se contaron — su
stock no se toca."* Esa frase describe exactamente lo que causó la sobreventa. Reemplazar por:

```js
    var notaPend = document.getElementById('revision-nota-pendientes');
    var pendConStock = revisionData.pendientes.filter(function(p){ return p.bloque === 'con_stock'; });
    notaPend.textContent = pendConStock.length
      ? pendConStock.length + ' producto' + (pendConStock.length === 1 ? '' : 's') +
        ' con stock todavía sin contar. Hay que decidir qué pasa con ' +
        (pendConStock.length === 1 ? 'ese' : 'cada uno') + ' antes de confirmar.'
      : '';
```

- [ ] **Step 2: Markup de la pantalla de cierre**

Al lado del `confirm-veil` existente (~:499), agregar un `<div class="confirm-veil" id="cierre-veil" role="dialog" aria-modal="true" aria-label="Decidir los productos sin contar" hidden>` con: un `<h3>`, un párrafo explicativo, un `<div id="cierre-lista">` que se llena por JS, y dos botones — `id="btn-cierre-confirmar"` ("Pasar a 0 y confirmar") y `id="btn-cierre-guardar"` ("Guardar y seguir después") — más un `id="btn-cierre-cancelar"` ("Volver").

Copiá las clases del `confirm-veil` que ya existe para que herede la estética; **no inventes
tokens nuevos**, los de `public/lib/theme.css` fijan el sistema visual.

Cada fila de `#cierre-lista` es:

```html
<label class="fila-cierre">
  <input type="checkbox" data-sku="FB-2">
  <span class="cierre-nombre">Zapatillas ... </span>
  <span class="cierre-stock">2 publicadas</span>
  <span class="cierre-marca">no lo revisé</span>
</label>
```

**Sin tildar = "no había ninguna" (pasa a 0).** Ese es el default a propósito: la acción
segura contra sobreventa es la que no cuesta esfuerzo.

- [ ] **Step 3: Cablear**

- El handler de `btn-confirmar-ajuste` (~:1859): si `pendConStock.length > 0`, abre
  `#cierre-veil` en vez del modal de confirmación.
- `btn-cierre-confirmar`: habilitado **solo** si ningún checkbox está tildado. Manda
  `POST /cerrar-en-cero` con **todos** los SKU no tildados, espera la respuesta, y recién
  entonces abre el modal de confirmación de siempre.
- `btn-cierre-guardar`: manda `POST /cerrar-en-cero` con los no tildados, refresca y **deja la
  sesión abierta** (vuelve a la vista de conteo). Si no hay ninguno sin tildar, no manda nada.
- Ambas escrituras van por `encolarEscritura` (la cola de `conteoCantidad.js`), como el resto
  de las escrituras del conteo.
- Un cambio en cualquier checkbox recalcula el `disabled` de `btn-cierre-confirmar`.

- [ ] **Step 4: Probar a mano en el navegador**

Levantá un servidor con una **copia** de la base (`DB_PATH=<copia> DISABLE_CRONS=true
PORT=<libre, nunca 3001>`), y **vaciá `ml_oauth_token` en la copia**. Verificá:
a) con pendientes con stock, "Confirmar ajuste" abre la pantalla de cierre;
b) tildar uno deshabilita "Pasar a 0 y confirmar"; destildarlo lo habilita;
c) "Guardar y seguir después" crea los ceros y deja la sesión abierta.
**Nunca toques "Confirmar ajuste" del modal final:** escribe stock real en Woo.

- [ ] **Step 5: Commit**

```bash
git add public/inventario/index.html
git commit -m "Pantalla de cierre: decidir producto por producto antes de confirmar"
```

---

## Verificación final (la hace el orquestador)

- [ ] `npm test` completo, **sin ningún otro proceso corriendo**
  (`pgrep -af "vitest|node.*server"`). Leer el resumen "Test Files": el exit code es 0 aunque
  haya archivos en rojo.
- [ ] Mutación del gate: comentar el `return res.status(409)` de la Tarea 1 y confirmar que el
  test de la Tarea 1 se pone rojo. Si no, el test no prueba nada.
- [ ] `revisor` sobre el diff → sin hallazgos bloqueantes.
- [ ] `probador-e2e` sobre la pantalla de cierre (desktop + 390x844).
- [ ] `auditor-despliegue` con el veredicto del revisor y el reporte del e2e pegados en el
      prompt. Sin esos dos insumos es 🔴 automático.
- [ ] El merge a master y el `pm2 restart herramientas` **los hace el usuario a mano**.
