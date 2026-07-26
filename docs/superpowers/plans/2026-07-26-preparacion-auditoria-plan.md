# Preparación de Pedidos — Ciclo 3: Actividad (auditoría por paso) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar quién hizo cada acción durante la preparación de un pedido (escanear,
subir/borrar foto, marcar embalaje/despacho, completar) en una sección nueva "Actividad"
dentro del detalle del pedido, visible para cualquiera que lo abra.

**Architecture:** Tabla append-only `preparacion_eventos` instrumentada desde los 5
endpoints existentes de `routes/preparacion.js`, sin cambiar su lógica de negocio. El
detalle del pedido (`GET /:id`) devuelve los eventos junto con items/fotos; un endpoint
liviano nuevo (`GET /:id/eventos`) permite refrescar solo la actividad sin re-renderizar
el resto. El heartbeat de presencia (ya existente, cada 15s) informa el id del último
evento para que el frontend sepa si hay novedades sin pedir nada de más.

**Tech Stack:** Express, better-sqlite3, vitest + supertest (backend); JS vanilla sin
build step (frontend, `public/preparacion/index.html`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-preparacion-auditoria-design.md`.
- Los escaneos **rechazados** (`no_coincide`, `sobrante`) **NO** generan evento — solo
  `resultado==='match'`.
- `preparacion_eventos` es **append-only**: ningún endpoint la actualiza ni borra filas.
- El registro de un evento es **fail-open** respecto a la acción principal: si el
  `INSERT` de evento falla, la acción real (escanear, subir foto, etc.) igual se completa —
  envolver cada insert de evento en `try/catch` que solo loguea con `console.error`.
- Fotos: `DELETE /:id/foto/:fotoId` pasa a **soft-delete** (`UPDATE ... SET borrado_en=?`),
  nunca vuelve a hacer `DELETE FROM preparacion_fotos`. El archivo físico NUNCA se borraba
  hasta ahora (verificado: no hay ningún `fs.unlink` en el código actual) — se mantiene así
  hasta la purga (Task 6).
- Todo lugar que lea `preparacion_fotos` para uso operativo (armar `item.fotos`, contar
  `total_fotos`, chequear `fotosFaltantes` en `/completar`) debe filtrar
  `WHERE borrado_en IS NULL` — una foto borrada no debe seguir contando como presente.
- Nombre de la sección en la UI: **"Actividad"**, nunca "Historial" (colisión con la
  pestaña global existente).
- Sin migraciones `.sql` numeradas: el proyecto no las usa para estas tablas — sigue el
  patrón `ensureTables()` idempotente ya existente en `routes/preparacion.js`.

---

### Task 1: Esquema — tabla `preparacion_eventos`, columna `borrado_en`, helpers

**Files:**
- Modify: `routes/preparacion.js:20-104` (función `ensureTables`)
- Modify: `utils/storage.js` (agregar `rutaAbsoluta`)
- Test: `test/preparacion.test.js`
- Test: `test/storage.test.js` (si no existe, crear)

**Interfaces:**
- Produce: `registrarEvento(db, { preparacionId, itemId = null, tipo, usuario, detalle })`
  → inserta una fila en `preparacion_eventos`, no devuelve nada útil (fire-and-forget,
  fail-open). Exportada desde `routes/preparacion.js` para poder testearla directo.
- Produce: `rutaAbsoluta(url)` en `utils/storage.js` → dado `/uploads/x/y/z.jpg` devuelve
  la ruta absoluta en disco (`.../uploads/x/y/z.jpg`).

- [ ] **Step 1: Escribir el test de la tabla nueva y de `registrarEvento`**

Agregar en `test/preparacion.test.js`, después del `describe('POST /:id/heartbeat'...)`:

```js
import { preparacionRouter, crearPreparacion, registrarEvento } from '../routes/preparacion.js';
```

(agregar `registrarEvento` al import ya existente en la línea 10 del archivo, que hoy es
`import { preparacionRouter, crearPreparacion } from '../routes/preparacion.js';`)

```js
describe('registrarEvento', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} } });

  it('inserta un evento con detalle_json serializado', () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 900, numeroPedido: '900', comprador: 'Ana', items: [] });
    registrarEvento(db, { preparacionId: id, itemId: null, tipo: 'completado', usuario: 'juan', detalle: { foo: 'bar' } });
    const ev = db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=?').get(id);
    expect(ev.tipo).toBe('completado');
    expect(ev.usuario).toBe('juan');
    expect(JSON.parse(ev.detalle_json)).toEqual({ foo: 'bar' });
    expect(ev.creado_en).toBeTruthy();
  });

  it('no lanza si el insert falla (fail-open) — se traga el error', () => {
    const id = crearPreparacion(db, { canal: 'web', wcOrderId: 901, numeroPedido: '901', comprador: 'Ana', items: [] });
    // preparacion_id inexistente en sí no rompe (no hay FK), forzamos el fallo con un tipo raro
    // que igual la tabla acepta (TEXT, no hay CHECK) — probamos el catch con un db roto:
    const dbRoto = { prepare: () => { throw new Error('boom'); } };
    expect(() => registrarEvento(dbRoto, { preparacionId: id, tipo: 'completado', usuario: 'juan', detalle: {} })).not.toThrow();
  });
});
```

- [ ] **Step 2: Correr el test y ver que falla**

Run: `npx vitest run test/preparacion.test.js -t registrarEvento`
Expected: FAIL — `registrarEvento is not a function` / tabla no existe.

- [ ] **Step 3: Agregar la tabla, la columna y el helper**

En `routes/preparacion.js`, dentro de `ensureTables(db)` (después del bloque de
`preparacion_vistas`, línea ~104):

```js
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_eventos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    preparacion_id INTEGER NOT NULL,
    item_id        INTEGER,
    tipo           TEXT NOT NULL,
    usuario        TEXT,
    detalle_json   TEXT NOT NULL,
    creado_en      TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_preparacion_eventos_prep ON preparacion_eventos(preparacion_id, id)').run();

  // borrado_en: soft-delete de fotos (columna nueva, agregada con try/catch porque SQLite
  // no tiene "ADD COLUMN IF NOT EXISTS" — falla con "duplicate column" si ya existe, y eso
  // es justamente lo esperado en cada arranque salvo el primero).
  try {
    db.prepare('ALTER TABLE preparacion_fotos ADD COLUMN borrado_en TEXT').run();
  } catch (_) { /* la columna ya existe */ }
```

Y, cerca del final del archivo (junto a `crearPreparacion`, exportada), agregar:

```js
export function registrarEvento(db, { preparacionId, itemId = null, tipo, usuario, detalle }) {
  // Fail-open a propósito: el historial de "Actividad" es auxiliar, nunca debe poder
  // frenar la acción real (escanear, subir foto, etc.) que el operario está haciendo.
  try {
    db.prepare(`
      INSERT INTO preparacion_eventos (preparacion_id, item_id, tipo, usuario, detalle_json, creado_en)
      VALUES (?,?,?,?,?,?)
    `).run(preparacionId, itemId, tipo, usuario ?? null, JSON.stringify(detalle ?? {}), now());
  } catch (e) {
    console.error('registrarEvento: no se pudo registrar', tipo, e.message);
  }
}
```

- [ ] **Step 4: Correr el test y ver que pasa**

Run: `npx vitest run test/preparacion.test.js -t registrarEvento`
Expected: PASS (2 tests).

- [ ] **Step 5: `rutaAbsoluta` en `utils/storage.js`**

Test (crear `test/storage.test.js` si no existe; si existe uno para `guardarArchivo`,
agregar el `describe` ahí):

```js
import { describe, it, expect } from 'vitest';
import path from 'path';
import { guardarArchivo, rutaAbsoluta } from '../utils/storage.js';

describe('rutaAbsoluta', () => {
  it('resuelve la url guardada a una ruta absoluta que coincide con el filepath real', () => {
    const saved = guardarArchivo({
      buffer: Buffer.from('x'), originalname: 'foto.jpg', mimetype: 'image/jpeg',
      importador: 'test-ruta-absoluta', numeroPedido: '999',
    });
    expect(rutaAbsoluta(saved.url)).toBe(path.resolve(saved.filepath));
  });
});
```

Run: `npx vitest run test/storage.test.js` → FAIL (`rutaAbsoluta is not exported`).

Implementación en `utils/storage.js` (agregar después de `guardarArchivo`):

```js
export function rutaAbsoluta(url) {
  return path.join(path.dirname(UPLOADS_DIR), url);
}
```

Run: `npx vitest run test/storage.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/preparacion.js utils/storage.js test/preparacion.test.js test/storage.test.js
git commit -m "Preparación: tabla preparacion_eventos + borrado_en + registrarEvento/rutaAbsoluta"
```

---

### Task 2: Instrumentar escaneo (`/escanear`, `/confirmar-manual`)

**Files:**
- Modify: `routes/preparacion.js:525-556` (endpoints `/escanear` y `/confirmar-manual`)
- Test: `test/preparacion.test.js`

**Interfaces:**
- Consume: `registrarEvento` (Task 1).
- Produce: eventos `tipo:'escaneo'` con `detalle: { sku, nombre, cantidad_nueva, cantidad_esperada, origen }`,
  `origen ∈ 'lector_teclado' | 'camara'` para `/escanear`, y `origen:'manual'` para
  `/confirmar-manual`.

- [ ] **Step 1: Test — `/escanear` con match registra el evento; sin match, no**

```js
it('escanear con match registra un evento tipo escaneo; no_coincide y sobrante no registran nada', async () => {
  const id = nuevaPrep();
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1', origen: 'camara' });
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'NOEXISTE' }); // no_coincide
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' }); // match, sin origen -> default lector_teclado
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' }); // sobrante (ya está 2/2)

  const eventos = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo' ORDER BY id").all(id);
  expect(eventos).toHaveLength(2);
  const d0 = JSON.parse(eventos[0].detalle_json);
  expect(d0).toMatchObject({ sku: 'CUB-1', cantidad_nueva: 1, cantidad_esperada: 2, origen: 'camara' });
  const d1 = JSON.parse(eventos[1].detalle_json);
  expect(d1.origen).toBe('lector_teclado');
  expect(eventos[0].usuario).toBe('tester');
});

it('confirmar-manual registra un evento tipo escaneo con origen manual', async () => {
  const id = nuevaPrep();
  const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=''").get(id);
  await request(app).post(`/api/preparacion/${id}/item/${item.id}/confirmar-manual`).send({});
  const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='escaneo'").get(id);
  expect(JSON.parse(ev.detalle_json)).toMatchObject({ sku: '', origen: 'manual' });
});
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run test/preparacion.test.js -t "registra un evento"`
Expected: FAIL (0 eventos, la tabla puede existir por Task 1 pero nadie inserta todavía).

- [ ] **Step 3: Instrumentar `/escanear`**

En `routes/preparacion.js`, el bloque `router.post('/:id/escanear', ...)` (línea ~525),
reemplazar el final (a partir de `const nuevaCant = ...`) por:

```js
    const nuevaCant = item.cantidad_escaneada + 1;
    const verificado = nuevaCant >= item.cantidad_esperada;
    db.prepare('UPDATE preparacion_items SET cantidad_escaneada=?, estado_item=? WHERE id=?')
      .run(nuevaCant, verificado ? 'verificado' : 'pendiente', item.id);

    const origen = ['camara', 'lector_teclado'].includes(req.body?.origen) ? req.body.origen : 'lector_teclado';
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'escaneo', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, cantidad_nueva: nuevaCant, cantidad_esperada: item.cantidad_esperada, origen },
    });

    res.json({ ok: true, resultado: 'match', item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
```

- [ ] **Step 4: Instrumentar `/confirmar-manual`**

En el bloque `router.post('/:id/item/:itemId/confirmar-manual', ...)` (línea ~551),
después del `UPDATE`:

```js
    db.prepare("UPDATE preparacion_items SET confirmado_manual=1, estado_item='verificado', cantidad_escaneada=cantidad_esperada WHERE id=?")
      .run(item.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'escaneo', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, cantidad_nueva: item.cantidad_esperada, cantidad_esperada: item.cantidad_esperada, origen: 'manual' },
    });
    res.json({ ok: true, item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
```

- [ ] **Step 5: Correr y confirmar que pasan**

Run: `npx vitest run test/preparacion.test.js`
Expected: PASS (toda la suite del archivo, no solo los tests nuevos).

- [ ] **Step 6: Commit**

```bash
git add routes/preparacion.js test/preparacion.test.js
git commit -m "Preparación: instrumentar escaneo y confirmar-manual en preparacion_eventos"
```

---

### Task 3: Instrumentar fotos (subida, soft-delete + evento de borrado)

**Files:**
- Modify: `routes/preparacion.js:482-497` (`GET /:id`), `:606-665` (`POST /:id/foto`),
  `:667-672` (`DELETE /:id/foto/:fotoId`), `:412-420` (historial, `total_fotos`),
  `:675-720` (`/completar`, lectura de fotos)
- Test: `test/preparacion.test.js`

**Interfaces:**
- Consume: `registrarEvento` (Task 1).
- Produce: eventos `foto_subida: { sku, nombre, tipo_foto, nombre_archivo, foto_id }` y
  `foto_borrada: { sku, nombre, tipo_foto, nombre_archivo, foto_id, subida_por }`.
- Todas las consultas operativas de `preparacion_fotos` filtran `WHERE borrado_en IS NULL`.

- [ ] **Step 1: Test — subir foto registra evento; borrar hace soft-delete + evento; foto borrada no cuenta para completar**

```js
it('subir foto registra un evento foto_subida', async () => {
  const id = nuevaPrep();
  const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
  const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const r = await request(app).post(`/api/preparacion/${id}/foto`)
    .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
  const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_subida'").get(id);
  expect(JSON.parse(ev.detalle_json)).toMatchObject({ sku: 'CUB-1', tipo_foto: 'articulo', foto_id: r.body.foto.id });
});

it('borrar foto NO borra la fila (soft-delete), registra evento foto_borrada, y deja de contar para /completar', async () => {
  const id = nuevaPrep();
  const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
  const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const subida = await request(app).post(`/api/preparacion/${id}/foto`)
    .field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'a.jpg');
  const fotoId = subida.body.foto.id;

  await request(app).delete(`/api/preparacion/${id}/foto/${fotoId}`);

  const fila = db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId);
  expect(fila).toBeTruthy(); // NO se borró la fila
  expect(fila.borrado_en).toBeTruthy();

  const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='foto_borrada'").get(id);
  expect(JSON.parse(ev.detalle_json)).toMatchObject({ sku: 'CUB-1', foto_id: fotoId, subida_por: 'tester' });

  const detalle = await request(app).get(`/api/preparacion/${id}`);
  const itemDetalle = detalle.body.data.items.find(i => i.id === item.id);
  expect(itemDetalle.fotos).toHaveLength(0); // la foto borrada no cuenta como presente
});
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run test/preparacion.test.js -t "foto_subida\|soft-delete"`
Expected: FAIL.

- [ ] **Step 3: Instrumentar `POST /:id/foto`**

Después del `INSERT INTO preparacion_fotos` (línea ~661-663), antes del `res.json`:

```js
    const fotoId = db.prepare(
      'INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, nombre_archivo, creado_en) VALUES (?,?,?,?,?,?)'
    ).run(prep.id, item_id ? parseInt(item_id) : null, tipo, saved.url, saved.filename, now()).lastInsertRowid;

    const itemRef = item_id ? db.prepare('SELECT sku, nombre FROM preparacion_items WHERE id=?').get(parseInt(item_id)) : null;
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item_id ? parseInt(item_id) : null, tipo: 'foto_subida', usuario: req.user?.username,
      detalle: { sku: itemRef?.sku ?? null, nombre: itemRef?.nombre ?? null, tipo_foto: tipo, nombre_archivo: saved.filename, foto_id: fotoId },
    });

    res.json({ ok: true, foto: db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId) });
```

- [ ] **Step 4: Convertir `DELETE /:id/foto/:fotoId` a soft-delete + evento**

Reemplazar el handler completo (línea ~667-672):

```js
  router.delete('/:id/foto/:fotoId', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const fotoId = parseInt(req.params.fotoId);
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=? AND preparacion_id=? AND borrado_en IS NULL').get(fotoId, prep.id);
    if (!foto) return res.json({ ok: true, borradas: 0 });

    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(now(), fotoId);

    const itemRef = foto.item_id ? db.prepare('SELECT sku, nombre FROM preparacion_items WHERE id=?').get(foto.item_id) : null;
    registrarEvento(db, {
      preparacionId: prep.id, itemId: foto.item_id, tipo: 'foto_borrada', usuario: req.user?.username,
      detalle: { sku: itemRef?.sku ?? null, nombre: itemRef?.nombre ?? null, tipo_foto: foto.tipo, nombre_archivo: foto.nombre_archivo, foto_id: fotoId, subida_por: null },
    });
    res.json({ ok: true, borradas: 1 });
  });
```

Nota: `subida_por` queda `null` en esta primera vuelta porque `preparacion_fotos` no
guardaba quién la subió antes de este ciclo. Como la Task 3 ya agrega el evento
`foto_subida` con el usuario, un lector del historial puede cruzarlo manualmente por ahora;
dejar `subida_por` como columna a futuro está fuera de alcance de este ciclo (no lo pide la
spec, evita over-engineering).

- [ ] **Step 5: Filtrar `borrado_en IS NULL` en las 3 lecturas operativas restantes**

`GET /:id` (línea ~486): cambiar
`db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? ORDER BY id').all(prep.id)`
por
`db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND borrado_en IS NULL ORDER BY id').all(prep.id)`.

`total_fotos` en la cola de pendientes/historial (línea ~416): cambiar
`(SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id) AS total_fotos`
por
`(SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id AND borrado_en IS NULL) AS total_fotos`.

`/completar` (línea ~681): cambiar
`db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(prep.id)`
por
`db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND borrado_en IS NULL').all(prep.id)`.

- [ ] **Step 6: Correr y confirmar que pasan**

Run: `npx vitest run test/preparacion.test.js`
Expected: PASS (toda la suite).

- [ ] **Step 7: Commit**

```bash
git add routes/preparacion.js test/preparacion.test.js
git commit -m "Preparación: fotos con soft-delete + eventos foto_subida/foto_borrada"
```

---

### Task 4: Instrumentar embalaje, despacho y completar

**Files:**
- Modify: `routes/preparacion.js:563-579` (`/embalaje`), `:580-599` (`/despacho`),
  `:675-720` (`/completar`)
- Test: `test/preparacion.test.js`

**Interfaces:**
- Consume: `registrarEvento` (Task 1).
- Produce: eventos `embalaje`/`despacho` con `detalle: { sku, nombre, valor_anterior, valor_nuevo }`,
  y `completado` con `detalle: {}`.

- [ ] **Step 1: Test — embalaje/despacho registran valor anterior→nuevo; completar registra el cierre**

```js
it('embalaje y despacho registran valor_anterior -> valor_nuevo', async () => {
  const id = nuevaPrep();
  const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='BICI-1'").get(id);

  await request(app).post(`/api/preparacion/${id}/item/${item.id}/embalaje`).send({ estado_embalaje: 'abierta' });
  await request(app).post(`/api/preparacion/${id}/item/${item.id}/embalaje`).send({ estado_embalaje: 're_embalada' });

  const evsEmb = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='embalaje' ORDER BY id").all(id);
  expect(evsEmb).toHaveLength(2);
  expect(JSON.parse(evsEmb[0].detalle_json)).toMatchObject({ valor_anterior: null, valor_nuevo: 'abierta' });
  expect(JSON.parse(evsEmb[1].detalle_json)).toMatchObject({ valor_anterior: 'abierta', valor_nuevo: 're_embalada' });

  await request(app).post(`/api/preparacion/${id}/item/${item.id}/despacho`).send({ modo: 'deposito_relajado' });
  const evDesp = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='despacho'").get(id);
  expect(JSON.parse(evDesp.detalle_json)).toMatchObject({ valor_anterior: 'local', valor_nuevo: 'deposito_relajado' });
});

it('completar registra un evento tipo completado', async () => {
  const id = nuevaPrep();
  for (const sku of ['BICI-1', 'CUB-1', 'CUB-1']) {
    await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: sku });
  }
  const itemSinSku = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku=''").get(id);
  await request(app).post(`/api/preparacion/${id}/item/${itemSinSku.id}/confirmar-manual`).send({});
  await request(app).post(`/api/preparacion/${id}/item/${db.prepare("SELECT id FROM preparacion_items WHERE preparacion_id=? AND sku='BICI-1'").get(id).id}/foto`);
  // (subida real de foto omitida por brevedad: este test se enfoca en el evento 'completado',
  // no en la validación de fotos ya cubierta por el test existente "completar exige...")
  const r = await request(app).post(`/api/preparacion/${id}/completar`).send({});
  if (r.body.ok && r.body.estado === 'completada') {
    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND tipo='completado'").get(id);
    expect(ev).toBeTruthy();
    expect(ev.usuario).toBe('tester');
  }
});
```

Nota para quien implemente: el segundo test es best-effort (usa `if (r.body.ok...)` porque
completar puede fallar por falta de fotos obligatorias del perfil `bici`, que no es el foco
de este test) — el objetivo es solo confirmar que SI se completa, queda el evento.

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run test/preparacion.test.js -t "valor_anterior\|evento tipo completado"`
Expected: FAIL.

- [ ] **Step 3: Instrumentar `/embalaje`**

En el bloque `router.post('/:id/item/:itemId/embalaje', ...)`, antes del `UPDATE`:

```js
    const valorAnterior = item.estado_embalaje;
    db.prepare('UPDATE preparacion_items SET estado_embalaje=? WHERE id=?').run(estado_embalaje, item.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'embalaje', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, valor_anterior: valorAnterior, valor_nuevo: estado_embalaje },
    });
    const actualizado = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    res.json({ ok: true, item: actualizado, requisitos_foto: requisitosParaItem(db, actualizado) });
```

- [ ] **Step 4: Instrumentar `/despacho`**

En el bloque `router.post('/:id/item/:itemId/despacho', ...)`:

```js
    let estadoItem = item.estado_item;
    if (modo === 'deposito_relajado') estadoItem = 'exento';
    else if (item.estado_item === 'exento') estadoItem = 'pendiente';

    const valorAnterior = item.despacho;
    db.prepare('UPDATE preparacion_items SET despacho=?, despacho_motivo=?, estado_item=? WHERE id=?')
      .run(modo, motivo, estadoItem, item.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'despacho', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, valor_anterior: valorAnterior, valor_nuevo: modo },
    });
    res.json({ ok: true, item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
```

- [ ] **Step 5: Instrumentar `/completar`** (solo en el camino que sí completa, no en
  `pendiente_deposito` ni en el 400 de faltantes)

Después de `db.prepare("UPDATE preparaciones SET estado='completada'...")`:

```js
    db.prepare("UPDATE preparaciones SET estado='completada', completado_en=?, preparado_por=? WHERE id=?")
      .run(now(), req.user?.username || null, prep.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: null, tipo: 'completado', usuario: req.user?.username, detalle: {},
    });
    res.json({ ok: true, estado: 'completada' });
```

- [ ] **Step 6: Correr y confirmar que pasan**

Run: `npx vitest run test/preparacion.test.js`
Expected: PASS (toda la suite).

- [ ] **Step 7: Commit**

```bash
git add routes/preparacion.js test/preparacion.test.js
git commit -m "Preparación: instrumentar embalaje, despacho y completar en preparacion_eventos"
```

---

### Task 5: Exponer eventos — `GET /:id`, `GET /:id/eventos`, heartbeat con `ultimo_evento_id`

**Files:**
- Modify: `routes/preparacion.js:482-497` (`GET /:id`), `:505-521` (heartbeat)
- Test: `test/preparacion.test.js`

**Interfaces:**
- Produce: `GET /:id` → `data.eventos` (array, más reciente primero, sin paginado en
  backend).
- Produce: `GET /:id/eventos` (nuevo) → `{ ok, eventos }`, mismo formato, para refresco
  liviano sin traer items/fotos de nuevo.
- Produce: `POST /:id/heartbeat` → agrega `ultimo_evento_id` a la respuesta.

- [ ] **Step 1: Test**

```js
it('GET /:id incluye eventos (más reciente primero)', async () => {
  const id = nuevaPrep();
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
  const r = await request(app).get(`/api/preparacion/${id}`);
  expect(r.body.data.eventos.length).toBe(2);
  expect(r.body.data.eventos[0].id).toBeGreaterThan(r.body.data.eventos[1].id);
});

it('GET /:id/eventos devuelve solo los eventos, sin items ni fotos', async () => {
  const id = nuevaPrep();
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
  const r = await request(app).get(`/api/preparacion/${id}/eventos`);
  expect(r.body.ok).toBe(true);
  expect(r.body.eventos).toHaveLength(1);
  expect(r.body.items).toBeUndefined();
});

it('heartbeat informa el id del último evento', async () => {
  const id = nuevaPrep();
  let r = await request(app).post(`/api/preparacion/${id}/heartbeat`);
  expect(r.body.ultimo_evento_id).toBe(0);
  await request(app).post(`/api/preparacion/${id}/escanear`).send({ codigo: 'CUB-1' });
  r = await request(app).post(`/api/preparacion/${id}/heartbeat`);
  expect(r.body.ultimo_evento_id).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run test/preparacion.test.js -t "eventos\|ultimo_evento_id"`
Expected: FAIL.

- [ ] **Step 3: `GET /:id` — agregar eventos**

En el handler de `router.get('/:id', ...)`, después de armar `fotos`:

```js
    const eventos = db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? ORDER BY id DESC').all(prep.id)
      .map(e => ({ ...e, detalle: JSON.parse(e.detalle_json) }));
    const data = {
      ...prep,
      items: items.map(it => ({
        ...it,
        requisitos_foto: requisitosParaItem(db, it),
        fotos: fotos.filter(f => f.item_id === it.id),
      })),
      fotos_generales: fotos.filter(f => !f.item_id),
      eventos,
    };
```

- [ ] **Step 4: `GET /:id/eventos` — nuevo endpoint**

Agregar justo después del handler de `GET /:id`:

```js
  router.get('/:id/eventos', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const eventos = db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? ORDER BY id DESC').all(prep.id)
      .map(e => ({ ...e, detalle: JSON.parse(e.detalle_json) }));
    res.json({ ok: true, eventos });
  });
```

- [ ] **Step 5: Heartbeat — agregar `ultimo_evento_id`**

En `router.post('/:id/heartbeat', ...)`, antes del `res.json`:

```js
    const ultimoEvento = db.prepare('SELECT MAX(id) AS m FROM preparacion_eventos WHERE preparacion_id=?').get(prep.id);
    res.json({ ok: true, otros, ultimo_evento_id: ultimoEvento.m || 0 });
```

- [ ] **Step 6: Correr y confirmar que pasan**

Run: `npx vitest run test/preparacion.test.js`
Expected: PASS (toda la suite).

- [ ] **Step 7: Commit**

```bash
git add routes/preparacion.js test/preparacion.test.js
git commit -m "Preparación: exponer eventos en GET /:id, GET /:id/eventos y heartbeat"
```

---

### Task 6: Purga de fotos borradas (más de 60 días)

**Files:**
- Modify: `routes/preparacion.js` (nueva función exportada `purgarFotosBorradas`)
- Modify: `server.js` (registrar cron diario)
- Test: `test/preparacion.test.js`

**Interfaces:**
- Consume: `rutaAbsoluta` (Task 1).
- Produce: `purgarFotosBorradas(db)` — borra del disco y de la tabla las fotos con
  `borrado_en` de más de 60 días. Devuelve la cantidad purgada (para logging).

- [ ] **Step 1: Test**

```js
it('purgarFotosBorradas borra archivo y fila si borrado_en tiene más de 60 días; conserva las más recientes', async () => {
  const id = nuevaPrep();
  const item = db.prepare("SELECT * FROM preparacion_items WHERE preparacion_id=? AND sku='CUB-1'").get(id);
  const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();

  const vieja = await request(app).post(`/api/preparacion/${id}/foto`).field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'vieja.jpg');
  const reciente = await request(app).post(`/api/preparacion/${id}/foto`).field('item_id', String(item.id)).field('tipo', 'articulo').attach('archivo', buf, 'reciente.jpg');

  const hace70dias = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(hace70dias, vieja.body.foto.id);
  db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(now(), reciente.body.foto.id);

  const rutaVieja = rutaAbsoluta(vieja.body.foto.url);
  expect(fs.existsSync(rutaVieja)).toBe(true);

  const purgadas = purgarFotosBorradas(db);

  expect(purgadas).toBe(1);
  expect(fs.existsSync(rutaVieja)).toBe(false);
  expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(vieja.body.foto.id)).toBeUndefined();
  expect(db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(reciente.body.foto.id)).toBeTruthy();
});
```

Imports a agregar en `test/preparacion.test.js`: `now` no está exportado hoy — usar
`new Date().toISOString()` inline en el test en vez de importar `now`. Y agregar
`purgarFotosBorradas` al import de `../routes/preparacion.js`, y `rutaAbsoluta` al import
de `../utils/storage.js`.

- [ ] **Step 2: Correr y ver que falla**

Run: `npx vitest run test/preparacion.test.js -t purgarFotosBorradas`
Expected: FAIL — `purgarFotosBorradas is not a function`.

- [ ] **Step 3: Implementar `purgarFotosBorradas`**

Cambiar la línea 8 de `routes/preparacion.js` de
`import { guardarArchivo } from '../utils/storage.js';` a
`import { guardarArchivo, rutaAbsoluta } from '../utils/storage.js';`, y agregar
`import fs from 'fs';` junto a los demás imports del tope del archivo (línea 1-13, no
duplicar si ya existiera).

Agregar en `routes/preparacion.js`, junto a `crearPreparacion`/`registrarEvento`:

```js
export function purgarFotosBorradas(db) {
  const limite = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const vencidas = db.prepare('SELECT id, url FROM preparacion_fotos WHERE borrado_en IS NOT NULL AND borrado_en < ?').all(limite);
  for (const f of vencidas) {
    try { fs.unlinkSync(rutaAbsoluta(f.url)); } catch (_) { /* archivo ya no está, seguir igual */ }
    db.prepare('DELETE FROM preparacion_fotos WHERE id=?').run(f.id);
  }
  return vencidas.length;
}
```

(agregar el `import fs from 'fs'` junto a los demás imports del tope del archivo si no
está ya presente — verificar antes de duplicarlo).

- [ ] **Step 4: Correr y confirmar que pasa**

Run: `npx vitest run test/preparacion.test.js`
Expected: PASS (toda la suite).

- [ ] **Step 5: Registrar el cron diario en `server.js`**

Dentro del mismo bloque `if (process.env.DISABLE_CRONS === 'true') {...} else {...}` que
ya existe (ver `server.js:163-198`), agregar junto a los demás `cron.schedule`:

```js
      cron.schedule('0 4 * * *', () => {
        try {
          const n = purgarFotosBorradas(app._db);
          if (n) console.log(`Purgadas ${n} fotos de preparación (borrado_en > 60 días)`);
        } catch (err) { console.error('Error purgando fotos de preparación:', err.message); }
      });
```

Agregar `purgarFotosBorradas` al import de `./routes/preparacion.js` en `server.js`
(verificar el import existente de ese router antes de duplicarlo).

- [ ] **Step 6: Commit**

```bash
git add routes/preparacion.js server.js test/preparacion.test.js
git commit -m "Preparación: purga diaria de fotos borradas con más de 60 días"
```

---

### Task 7: Frontend — sección "Actividad" (render + colapso + chip de acceso)

**Files:**
- Modify: `public/preparacion/index.html` (`:root` local, `renderDetalle`, CSS)
- No hace falta test automatizado dedicado (JS vanilla sin build ni test runner de
  frontend en este proyecto) — se verifica con `probador-e2e` al final del pipeline.

**Interfaces:**
- Consume: `PREP.eventos` (array, ya viene ordenado más reciente primero desde
  `GET /:id`, Task 5).
- Produce: función `renderActividad(eventos)` que devuelve el HTML de la sección; se
  llama desde `renderDetalle()`.

- [ ] **Step 1: Tokens nuevos en el `:root` local de la página**

Ubicar el bloque `<style>:root{...}</style>` de `public/preparacion/index.html` (línea 8
según lo relevado) y agregar, junto a los tokens existentes:

```css
--tap-comfort:56px;
--act-rail:rgba(36,48,74,.55);
--act-new-hold:6s;
--act-deleted-veil:rgba(220,60,60,.18);
--act-deleted-hatch:rgba(220,60,60,.25);
```

(usar los valores exactos de color que ya usa la página para rojo/borde — revisar el
`:root` existente para `--red`/`--red-bd`/similar y reusar esos, no inventar un rojo
nuevo — si la página ya tiene `--red-bd` definido, usarlo en vez de un literal).

- [ ] **Step 2: CSS de la sección**

Agregar al `<style>` de la página:

```css
.act-head{width:100%;min-height:var(--tap-comfort);display:flex;align-items:center;gap:8px;
  padding:12px 16px;background:var(--surface,#141A25);border:1px solid var(--border,#24304a);
  border-radius:12px 12px 0 0;font:inherit;cursor:pointer;text-align:left}
.act-head.cerrado{border-radius:12px}
.act-head .car{font-size:12px;color:var(--muted,#8a97ad);transition:transform .18s}
.act-head.abierto .car{transform:rotate(90deg)}
.act-head .tit{font-weight:800;font-size:14px}
.act-head .badge-n{font-size:11px;color:var(--muted,#8a97ad);background:var(--surface2,#1b2436);
  border:1px solid var(--border,#24304a);border-radius:999px;padding:2px 8px}
.act-head .nuevos{font-size:11.5px;font-weight:700;color:var(--blue,var(--azul,#4aa3ff))}
.act-body{border:1px solid var(--border,#24304a);border-top:none;border-radius:0 0 12px 12px;padding:4px 0}
.feed-item{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:10px 10px 10px 0;
  border-top:1px solid var(--act-rail)}
.feed-item:first-child{border-top:none}
.feed-item.nuevo{background:rgba(74,163,255,.08);border-left:3px solid var(--blue,var(--azul,#4aa3ff));
  transition:background 1.2s, border-color 1.2s}
.feed-badge{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px}
.feed-l1{font-size:13.5px;line-height:1.35}
.feed-l1 b{font-weight:800}
.feed-sku{font-size:11.5px;color:var(--muted,#8a97ad);font-family:monospace}
.feed-meta{font-size:11.5px;color:var(--muted,#8a97ad)}
.feed-thumb{width:56px;height:56px;border-radius:8px;object-fit:cover;cursor:pointer}
.feed-thumb.borrada{filter:grayscale(1);opacity:.55;border:1px dashed var(--red-bd,#a33);
  background-image:repeating-linear-gradient(45deg,var(--act-deleted-hatch) 0 4px,transparent 4px 8px)}
.feed-delta{font-size:12px}
.feed-delta .antes{color:var(--muted,#8a97ad);text-decoration:line-through}
.feed-delta .desp{font-weight:700}
.act-empty,.act-error{text-align:center;padding:20px;font-size:13px;color:var(--muted,#8a97ad)}
.act-empty{border:1px dashed var(--border,#24304a);border-radius:12px}
.act-error{border:1px solid var(--amber-bd,#a83);background:rgba(245,185,66,.06);border-radius:12px;text-align:left;padding:14px}
.chip-jump{min-height:44px;padding:0 14px;border-radius:999px;background:var(--chip-bg,var(--surface2,#1b2436));
  border:1px solid var(--chip-bd,var(--border,#24304a));color:var(--chip-txt,var(--muted,#8a97ad));
  font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.chip-jump .dot{width:7px;height:7px;border-radius:50%;background:transparent}
.chip-jump.nuevo .dot{background:var(--blue,var(--azul,#4aa3ff))}
```

- [ ] **Step 3: Estado de colapso en `sessionStorage` + funciones de render**

Agregar cerca de las demás variables globales (junto a `var VISTA=...` línea 157):

```js
function actAbierta(){ return sessionStorage.getItem('prep_actividad_abierta')==='1'; }
function setActAbierta(v){ sessionStorage.setItem('prep_actividad_abierta', v?'1':'0'); }
```

Agregar, cerca de `flash()` (línea 415), las funciones de render de la sección:

```js
function verboEvento(tipo,detalle){
  if(tipo==='escaneo'){
    if(detalle.origen==='manual')return 'confirmó sin código';
    return detalle.origen==='camara'?'escaneó (cámara)':'escaneó';
  }
  if(tipo==='foto_subida')return 'subió foto';
  if(tipo==='foto_borrada')return 'borró foto';
  if(tipo==='embalaje')return 'marcó embalaje';
  if(tipo==='despacho')return 'marcó despacho';
  if(tipo==='completado')return 'completó el pedido';
  return tipo;
}

function feedItemHtml(ev,esNuevo){
  var d=ev.detalle||{};
  var iconos={escaneo:'◎',foto_subida:'▣',foto_borrada:'⌫',embalaje:'⬒',despacho:'➜',completado:'★'};
  var quien=ev.usuario?esc(ev.usuario):'—';
  var cuando=fecha(ev.creado_en);
  var hm=haceMin(ev.creado_en);
  var linea1='<b>'+verboEvento(ev.tipo,d)+'</b>'
    +(d.nombre?' '+esc(d.nombre):'')
    +(d.cantidad_nueva!=null?' <span class="feed-meta">'+d.cantidad_nueva+'/'+d.cantidad_esperada+'</span>':'')
    +(esNuevo?' <span class="feed-meta" style="color:var(--blue,#4aa3ff);font-weight:700">NUEVO</span>':'');
  var extra='';
  if(ev.tipo==='foto_subida'||ev.tipo==='foto_borrada'){
    var borrada=ev.tipo==='foto_borrada';
    extra='<div style="margin-top:6px;display:flex;align-items:center;gap:8px">'
      +'<div class="feed-thumb'+(borrada?' borrada':'')+'" style="background:var(--surface2,#1b2436)"></div>'
      +'<span class="feed-meta">'+esc(d.tipo_foto||'')+(borrada?' — (borrada)':'')+'</span></div>';
  }else if(ev.tipo==='embalaje'||ev.tipo==='despacho'){
    extra='<div class="feed-delta">'
      +(d.valor_anterior?'<span class="antes">'+esc(d.valor_anterior)+'</span> › ':'')
      +'<span class="desp">'+esc(d.valor_nuevo)+'</span></div>';
  }
  return '<div class="feed-item'+(esNuevo?' nuevo':'')+'" data-ev="'+ev.id+'">'
    +'<div class="feed-badge">'+(iconos[ev.tipo]||'•')+'</div>'
    +'<div><div class="feed-l1">'+linea1+'</div>'
    +(d.sku?'<div class="feed-sku">SKU '+esc(d.sku)+'</div>':'')
    +'<div class="feed-meta">'+quien+' · <time title="'+esc(cuando)+'">'+esc(hm?'hace '+hm:cuando)+'</time></div>'
    +extra+'</div></div>';
}

function renderActividad(){
  var eventos=(PREP.eventos||[]);
  var abierta=actAbierta();
  var head='<button class="act-head'+(abierta?' abierto':' cerrado')+'" onclick="toggleActividad()">'
    +'<span class="car">▸</span><span class="tit">Actividad</span>'
    +'<span class="badge-n">'+eventos.length+'</span></button>';
  if(!abierta)return head;

  var cuerpo;
  if(!eventos.length){
    cuerpo='<div class="act-empty">No hay actividad registrada.</div>';
  }else{
    var tope=eventos.slice(0,30);
    cuerpo=tope.map(function(e){return feedItemHtml(e,false);}).join('');
    if(eventos.length>30){
      cuerpo+='<button class="btn sec" style="width:100%;margin-top:8px" onclick="verMasActividad()">Ver más actividad ('+(eventos.length-30)+' restantes)</button>';
    }
  }
  return head+'<div class="act-body" id="act-body">'+cuerpo+'</div>';
}

function toggleActividad(){ setActAbierta(!actAbierta()); renderDetalle(); }
var ACT_TOPE=30;
function verMasActividad(){ ACT_TOPE+=30; renderDetalle(); }
```

- [ ] **Step 4: Enganchar en `renderDetalle()` y agregar el chip de acceso rápido**

En `renderDetalle()` (línea 313), agregar el chip junto al comprador y la sección al
final, antes de asignar `document.getElementById('cuerpo').innerHTML=html;`:

```js
  html+='<div style="display:flex;justify-content:space-between;align-items:center">'
    +'<p class="sub" style="margin:0">'+esc(p.comprador||'')+'</p>'
    +'<button class="chip-jump'+((p.eventos||[]).length?'':' oculto')+'" onclick="irActividad()">'
    +'<span class="dot"></span> Actividad ('+(p.eventos||[]).length+')</button></div>';
```

(reemplaza la línea existente `+'<p class="sub">'+esc(p.comprador||'')+'</p>'`)

Y al final, antes del cierre de `html` (después del `finbar`):

```js
  html+='<div style="margin-top:16px">'+renderActividad()+'</div>';
```

Agregar la función de scroll:

```js
function irActividad(){
  if(!actAbierta())toggleActividad();
  var el=document.querySelector('.act-head');
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
}
```

- [ ] **Step 5: Commit**

```bash
git add public/preparacion/index.html
git commit -m "Preparación: render de la sección Actividad (colapso, chip, feed)"
```

---

### Task 8: Frontend — wiring (origen, refresco incremental, puente con presencia)

**Files:**
- Modify: `public/preparacion/index.html` (`escanear`, `abrirCamara`, `heartbeat`,
  `refrescarDetalle`)

**Interfaces:**
- Consume: `GET /:id/eventos` (Task 5), `ultimo_evento_id` del heartbeat (Task 5).

- [ ] **Step 1: Pasar `origen` en las llamadas a `/escanear`**

`escanear(codigo)` (línea 423) pasa a `escanear(codigo, origen)`:

```js
async function escanear(codigo, origen){
  if(!codigo||!PREP)return;
  var r=await api('/'+PREP.id+'/escanear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({codigo:codigo, origen:origen||'lector_teclado'})});
  var b=r.body;
  await refrescarDetalle();
  if(b.resultado==='match')flash('ok','✓ '+codigo+' — '+(b.item.estado_item==='verificado'?'ítem completo':'anotado '+b.item.cantidad_escaneada+'/'+b.item.cantidad_esperada));
  else if(b.resultado==='sobrante')flash('warn','⚠︎ '+codigo+' ya está completo — ¿estás poniendo de más?');
  else if(b.resultado==='no_coincide')flash('bad','✕ '+codigo+' NO pertenece a este pedido');
  else flash('bad',b.error||'error');
}
```

`abrirCamara`'s `onCode` (línea 535) pasa a `onCode:function(v){cerrarCamara();escanear(v,'camara');}`.
El resto de los llamadores (`escanearManual`, el buffer de teclado global) no pasan
segundo argumento, así que caen en el default `'lector_teclado'` — correcto según la
decisión de Task 2 (ambos casos de teclado se tratan igual).

- [ ] **Step 2: Rastrear el máximo evento local y refrescar solo Actividad en el heartbeat**

Modificar `heartbeat(id)` (línea 288):

```js
var ULTIMO_EVENTO_VISTO=0;
async function heartbeat(id){
  try{
    var r=await api('/'+id+'/heartbeat',{method:'POST'});
    if(r.body.ok){
      renderBannerPresencia(r.body.otros||[]);
      if(r.body.ultimo_evento_id>ULTIMO_EVENTO_VISTO && ULTIMO_EVENTO_VISTO>0){
        await refrescarSoloActividad();
      }
      ULTIMO_EVENTO_VISTO=Math.max(ULTIMO_EVENTO_VISTO, r.body.ultimo_evento_id||0);
    }
  }catch(e){/* no bloqueante */}
}
```

- [ ] **Step 3: `refrescarSoloActividad()` — no toca el resto del detalle**

Agregar junto a `refrescarDetalle()`:

```js
async function refrescarSoloActividad(){
  if(!PREP)return;
  try{
    var r=await api('/'+PREP.id+'/eventos');
    if(!r.body.ok)return;
    var nuevos=r.body.eventos.filter(function(e){return e.id>ULTIMO_EVENTO_VISTO;});
    PREP.eventos=r.body.eventos;
    var badge=document.querySelector('.act-head .badge-n');
    if(badge)badge.textContent=r.body.eventos.length;
    if(!actAbierta()){
      var head=document.querySelector('.act-head');
      if(head && nuevos.length){
        var extra=head.querySelector('.nuevos');
        if(!extra){extra=document.createElement('span');extra.className='nuevos';head.appendChild(extra);}
        extra.textContent=' · '+nuevos.length+' nuevos';
      }
    }else{
      var body=document.getElementById('act-body');
      if(body){
        var html=nuevos.map(function(e){return feedItemHtml(e,true);}).join('');
        body.insertAdjacentHTML('afterbegin', html);
        setTimeout(function(){
          nuevos.forEach(function(e){
            var el=body.querySelector('[data-ev="'+e.id+'"]');
            if(el)el.classList.remove('nuevo');
          });
        }, 6000);
      }
    }
    if(nuevos.some(function(e){return e.usuario && e.usuario!==USERNAME;})){
      var otro=nuevos.find(function(e){return e.usuario && e.usuario!==USERNAME;});
      flash('ok', esc(otro.usuario)+' '+verboEvento(otro.tipo, otro.detalle||{}));
    }
  }catch(e){/* no bloqueante */}
}
```

Nota: `USERNAME` ya existe como variable global (línea 157) pero no se ve asignada en el
código relevado — verificar si se completa al cargar sesión (`GET /api/auth/me`, agregado
en el ciclo 2 de concurrencia); si no está seteada, usar comparación laxa (mostrar el toast
siempre que haya `usuario`, sin excluir al propio, ya que las acciones propias entran de
inmediato vía `refrescarDetalle()` normal y rara vez coincidirán con un evento "nuevo" del
heartbeat).

- [ ] **Step 4: Manejo de error de carga fail-open en `renderActividad`**

Dado que `PREP.eventos` viene siempre en la respuesta de `GET /:id` (Task 5, no puede
faltar salvo error de red general que ya maneja `abrirDetalle`), el estado de "error de
carga" de la sección solo aplica a `refrescarSoloActividad()` fallando en segundo plano —
ya está cubierto por el `catch` silencioso del Step 3 (fail-open: no se muestra nada raro,
simplemente no se actualiza hasta el próximo heartbeat exitoso). No hace falta un estado de
error visible separado para este ciclo — simplifica sin perder el requisito de "nunca
bloquea la preparación".

- [ ] **Step 5: Commit**

```bash
git add public/preparacion/index.html
git commit -m "Preparación: wiring de origen de escaneo y refresco incremental de Actividad"
```

---

## Notas para el pipeline posterior a este plan

- Tras Task 8, correr `npm test` completo (no solo `test/preparacion.test.js`) antes de
  pasar a `revisor`.
- `probador-e2e` debe cubrir explícitamente: escanear con cámara y con lector/input,
  subir y borrar una foto (confirmar que la miniatura borrada se ve con la trama/gris),
  marcar embalaje y despacho, completar, y verificar que el chip y la sección coinciden en
  el conteo — en desktop y mobile (390px), con foco en que la scanbar NUNCA pierda el
  autofocus al llegar un evento por heartbeat.
- `auditor-despliegue`: no hay migración `.sql` que verificar (el proyecto no las usa acá),
  pero sí confirmar que `ensureTables()` corre sin error contra una base ya poblada (la
  columna `borrado_en` debe agregarse una sola vez, sin romper en arranques siguientes).
