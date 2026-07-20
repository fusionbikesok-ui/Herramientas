# Consulta de Precios — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Herramienta web para consultar el precio de venta web de un producto por SKU o EAN, con card (foto, título, marca, categoría, precio) pensada para escaneo continuo en el mostrador.

**Architecture:** Router Express `/api/consulta-precios` que lee `catalogo_cache` (precio/nombre/marca/categoría/foto) y una tabla nueva `ean_sku` que aprende el puente EAN→SKU de a uno. Página estática que ingresa el código por teclado del teléfono, lector USB o cámara (módulo `Scanner` compartido). El EAN no existe en Woo, por eso la tabla `ean_sku`. La marca sí (taxonomía `brands` de Woo) y se suma como columna de `catalogo_cache`.

**Tech Stack:** Node/Express (ESM), better-sqlite3, vitest + supertest para tests, HTML/CSS/JS vanilla para el frontend.

## Global Constraints

- ESM en todo el código (`import`/`export`, no `require`). Node 20.
- No commitear `.env`, `*.db`, `*.sqlite`, `uploads/`, `data/` (ya en `.gitignore`).
- Tests: `npm test` (vitest). Los tests de router usan `openDb(TEST_DB)` + `supertest`, y borran el archivo `.sqlite` en `afterEach`.
- Español en toda la UI y los mensajes de usuario.
- El id de permiso, el slug del estático y el prefijo del href de la home deben ser **exactamente** `consulta-precios` (la home deriva el permiso del href `/herramientas/<tool>/`).
- Migraciones de DB en `db/index.js` (bloque incremental idempotente), no en `db/schema.sql`.
- Paleta oscura estándar del proyecto: `--azul #2DB8E8`, fondo `#0C0F16`, panel `#141A25`, borde `#24304A`, texto `#E4EAF4`, muted `#8493B0`, verde `#34D399`, ámbar `#FBBF24`, rojo `#F87171`.

---

### Task 1: Marca en el modelo de producto

Agrega el campo `marca` al modelo canónico de producto (funciones puras, sin DB ni red).

**Files:**
- Modify: `lib/modelos/producto.js`
- Test: `test/modelos-producto.test.js` (existente — actualizar + agregar casos)

**Interfaces:**
- Consumes: nada.
- Produces: el `Producto` canónico ahora incluye `marca: string` (`''` si no hay). `normalizarProductoWc(raw)` lee `raw.brands?.[0]?.name`. `normalizarVariacionWc(rawVar, padre)` hereda `padre.marca`. `filaCatalogo(p)` incluye `marca` (columna). `productoDesdeFilaCatalogo(row)` incluye `marca`.

- [ ] **Step 1: Actualizar los tests existentes + agregar casos de marca**

Los tests actuales comparan el objeto `Producto` completo con `.toEqual`, así que hay que sumar `marca` a cada objeto esperado. En `test/modelos-producto.test.js`:

En el test `'mapea un producto simple completo'`, agregar `brands` al raw y `marca` al esperado:

```js
  it('mapea un producto simple completo', () => {
    const raw = {
      id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0,
      stock_quantity: 4, categories: [{ id: 1, name: 'Cascos' }],
      images: [{ src: 'https://x/img.jpg' }], price: '15000.50',
      brands: [{ id: 5, name: 'Bell', slug: 'bell' }],
    };
    expect(normalizarProductoWc(raw)).toEqual({
      id_woo: 10, nombre: 'Casco Bell L', sku: 'CBL', tipo: 'simple', id_padre: null,
      stock: 4, categorias: ['Cascos'], atributos: [], img: 'https://x/img.jpg', precio: 15000.5,
      marca: 'Bell',
    });
  });
```

En `'sin categorías/img/precio/sku produce nulls y defaults'`, agregar:

```js
    expect(p.marca).toBe('');
```

En el `describe('normalizarVariacionWc')`, cambiar el `padre` para que tenga marca y afirmar la herencia:

```js
  const padre = normalizarProductoWc({
    id: 20, name: 'Casco X', type: 'variable', categories: [{ name: 'Cascos' }],
    brands: [{ name: 'Giro' }],
  });
```

y en el test `'compone nombre "Padre — attrs" y hereda categorías del padre'` agregar:

```js
    expect(v.marca).toBe('Giro');
```

En el `describe('filaCatalogo / productoDesdeFilaCatalogo (round-trip)')`, agregar `marca` a los dos objetos `producto`:

```js
    // en 'serializa y deserializa preservando la forma canónica'
    const producto = {
      id_woo: 30, nombre: 'Producto Full', sku: 'PF-1', tipo: 'simple', id_padre: null,
      stock: 7, categorias: ['Bicicletas', 'Rodado 29'],
      atributos: [{ name: 'Color', option: 'Negro' }], img: 'https://x/full.jpg', precio: 99999.99,
      marca: 'Shimano',
    };
```

```js
    // en 'sin categorías/atributos, guarda null y round-trip da arrays vacíos'
    const producto = {
      id_woo: 31, nombre: 'Sin extras', sku: '', tipo: 'variable', id_padre: null,
      stock: 0, categorias: [], atributos: [], img: null, precio: null,
      marca: '',
    };
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npm test -- test/modelos-producto.test.js`
Expected: FAIL — los objetos esperados incluyen `marca` que el modelo todavía no produce.

- [ ] **Step 3: Implementar `marca` en el modelo**

En `lib/modelos/producto.js`:

Actualizar el typedef `Producto` (agregar una línea antes de `*/` del bloque):

```js
 * @property {string} marca            Marca (taxonomía brands de WC); '' si no tiene
```

En `normalizarProductoWc`, agregar la extracción de marca y devolverla:

```js
export function normalizarProductoWc(raw) {
  const categorias = Array.isArray(raw.categories) && raw.categories.length
    ? raw.categories.map(c => c.name)
    : [];
  const marca = Array.isArray(raw.brands) && raw.brands.length ? (raw.brands[0].name || '') : '';
  // products usan images[] array; variations usan image singular.
  const img = raw.image?.src || (Array.isArray(raw.images) && raw.images[0]?.src) || null;
  // Woo devuelve price/regular_price como string; se persiste para comparar contra el neto ML.
  const precio = raw.price != null && raw.price !== '' ? parseFloat(raw.price)
    : (raw.regular_price ? parseFloat(raw.regular_price) : null);
  return {
    id_woo: raw.id,
    nombre: raw.name,
    sku: raw.sku || '',
    tipo: raw.type,
    id_padre: raw.parent_id || null,
    stock: raw.stock_quantity ?? 0,
    categorias,
    atributos: [],
    img,
    precio: Number.isFinite(precio) ? precio : null,
    marca,
  };
}
```

En `normalizarVariacionWc`, heredar la marca del padre (junto a `categorias`):

```js
  return {
    ...base,
    id_padre: padre.id_woo,
    categorias: padre.categorias,
    atributos,
    marca: padre.marca,
  };
```

En `filaCatalogo`, agregar la columna `marca` (antes de `actualizado_en`):

```js
    precio: producto.precio ?? null,
    atributos_json: producto.atributos && producto.atributos.length ? JSON.stringify(producto.atributos) : null,
    marca: producto.marca || null,
    actualizado_en: actualizadoEn,
```

En `productoDesdeFilaCatalogo`, devolver `marca`:

```js
    img: row.img ?? null,
    precio: row.precio ?? null,
    marca: row.marca ?? '',
  };
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -- test/modelos-producto.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/modelos/producto.js test/modelos-producto.test.js
git commit -m "Modelo producto: agregar marca (taxonomia brands de WC), heredada por variaciones

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Persistir marca + crear tabla ean_sku

Migraciones de DB (columna `marca` + tabla `ean_sku`) y persistencia de `marca` en `refrescarCatalogo`.

**Files:**
- Modify: `db/index.js` (bloque de migraciones incrementales)
- Modify: `routes/woo.js` (`refrescarCatalogo`, upsert de `catalogo_cache`)
- Test: `test/woo.test.js` (agregar un caso)

**Interfaces:**
- Consumes: `filaCatalogo` de Task 1 (ya devuelve `marca`).
- Produces: `catalogo_cache` tiene columna `marca`; existe la tabla `ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)`. `refrescarCatalogo` persiste `marca`.

- [ ] **Step 1: Escribir el test de persistencia de marca**

En `test/woo.test.js`, agregar dentro de `describe('woo route', ...)`:

```js
  it('refrescarCatalogo persiste la marca desde brands', async () => {
    axios.request.mockResolvedValue({
      status: 200, headers: {},
      data: [{ id: 40, name: 'Cinta SUPACAZ', sku: 'FB-40', type: 'simple', parent_id: 0,
        stock_quantity: 2, brands: [{ id: 9, name: 'SUPACAZ', slug: 'supacaz' }] }],
    });
    const db = openDb(TEST_DB);
    await refrescarCatalogo(db, { url: 'https://fusionbikes.com.ar', ck: 'x', cs: 'y' });
    const row = getCatalogo(db).find(r => r.sku === 'FB-40');
    expect(row.marca).toBe('SUPACAZ');
    db.close();
  });

  it('openDb crea la tabla ean_sku', () => {
    const db = openDb(TEST_DB);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ean_sku'").get();
    expect(t).toBeTruthy();
    db.close();
  });
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- test/woo.test.js`
Expected: FAIL — `row.marca` es `undefined` (columna/upsert faltan) y la tabla `ean_sku` no existe.

- [ ] **Step 3: Agregar las migraciones en `db/index.js`**

En `db/index.js`, junto a las otras migraciones de `catalogo_cache` (después de la línea del `ALTER TABLE ... atributos_json`), agregar:

```js
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN marca TEXT'); } catch (_) {}
  // Consulta de Precios ── puente EAN→SKU (el EAN no vive en Woo); aprende de a uno.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ean_sku (
    ean TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
```

- [ ] **Step 4: Persistir `marca` en `refrescarCatalogo`**

En `routes/woo.js`, en el `INSERT ... ON CONFLICT` de `catalogo_cache`, agregar la columna `marca` en los tres lugares:

```js
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, marca, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @marca, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre = excluded.nombre, sku = excluded.sku, tipo = excluded.tipo,
      id_padre = excluded.id_padre, stock = excluded.stock,
      categorias_json = excluded.categorias_json, img = excluded.img, precio = excluded.precio,
      atributos_json = excluded.atributos_json, marca = excluded.marca, actualizado_en = excluded.actualizado_en
  `);
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npm test -- test/woo.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/index.js routes/woo.js test/woo.test.js
git commit -m "Catalogo: persistir marca; nueva tabla ean_sku para Consulta de Precios

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Router de la API `/api/consulta-precios`

Endpoints de búsqueda unificada, enseñar EAN, importar en lote y autocomplete de SKU.

**Files:**
- Create: `routes/consultaPrecios.js`
- Test: `test/consultaPrecios.test.js`

**Interfaces:**
- Consumes: `catalogo_cache` (con `marca`) y `ean_sku` de Task 2.
- Produces: `consultaPreciosRouter(db)` → Express Router montable en `/api/consulta-precios`. Exporta también `pareceEan(codigo)` (pura). Endpoints:
  - `GET /buscar?q=` → `{ ok, found, tipo?, producto?, needsSku?, ean?, skuHuerfano? }`
  - `POST /ean` body `{ ean, sku }` → `{ ok, producto }` | `400`
  - `POST /importar` body `{ pares:[{ean,sku}] }` → `{ ok, importados, recibidos }`
  - `GET /buscar-sku?q=` → `{ ok, data:[{sku,nombre,stock,tipo}] }`
  - `producto` = `{ sku, nombre, marca, categorias, precio, stock, tipo, img }`.

- [ ] **Step 1: Escribir los tests del router**

Create `test/consultaPrecios.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { consultaPreciosRouter, pareceEan } from '../routes/consultaPrecios.js';

const TEST_DB = './test/tmp-consulta-precios.sqlite';

function appConDatos() {
  const db = openDb(TEST_DB);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, categorias_json, img, precio, marca, actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(1, 'Cinta SUPACAZ Bling', 'FB-40', 'simple', 3, '["CINTAS Y PUÑOS"]', 'https://x/a.jpg', 15000, 'SUPACAZ', now);
  db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7791234567890', 'FB-40', now);
  const app = express();
  app.use(express.json());
  app.use('/api/consulta-precios', consultaPreciosRouter(db));
  return { app, db };
}

describe('pareceEan', () => {
  it('acepta 8/12/13/14 dígitos', () => {
    expect(pareceEan('12345678')).toBe(true);
    expect(pareceEan('7791234567890')).toBe(true);
    expect(pareceEan('12345678901234')).toBe(true);
  });
  it('rechaza con letras, guiones o largo no-EAN', () => {
    expect(pareceEan('FB-40')).toBe(false);
    expect(pareceEan('123')).toBe(false);
    expect(pareceEan('7791234567890123456')).toBe(false);
  });
});

describe('GET /api/consulta-precios/buscar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('encuentra por SKU', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=FB-40');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.tipo).toBe('sku');
    expect(res.body.producto).toMatchObject({
      sku: 'FB-40', nombre: 'Cinta SUPACAZ Bling', marca: 'SUPACAZ',
      categorias: ['CINTAS Y PUÑOS'], precio: 15000, stock: 3, img: 'https://x/a.jpg',
    });
    db.close();
  });

  it('encuentra por EAN conocido', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=7791234567890');
    expect(res.body.found).toBe(true);
    expect(res.body.tipo).toBe('ean');
    expect(res.body.producto.sku).toBe('FB-40');
    db.close();
  });

  it('EAN desconocido que parece EAN → needsSku', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=7790000000000');
    expect(res.body.found).toBe(false);
    expect(res.body.needsSku).toBe(true);
    expect(res.body.ean).toBe('7790000000000');
    db.close();
  });

  it('EAN conocido cuyo SKU ya no está → skuHuerfano', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7799999999999', 'FB-BORRADO', now);
    const res = await request(app).get('/api/consulta-precios/buscar?q=7799999999999');
    expect(res.body.found).toBe(false);
    expect(res.body.skuHuerfano).toBe('FB-BORRADO');
    db.close();
  });

  it('basura → found:false sin needsSku', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=XYZ-NADA');
    expect(res.body.found).toBe(false);
    expect(res.body.needsSku).toBeFalsy();
    db.close();
  });
});

describe('POST /api/consulta-precios/ean', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('rechaza SKU inexistente con 400', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean').send({ ean: '7000000000001', sku: 'NO-EXISTE' });
    expect(res.status).toBe(400);
    db.close();
  });

  it('enseña un EAN nuevo y devuelve el producto', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean').send({ ean: '7000000000001', sku: 'FB-40' });
    expect(res.status).toBe(200);
    expect(res.body.producto.sku).toBe('FB-40');
    const guardado = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7000000000001');
    expect(guardado.sku).toBe('FB-40');
    db.close();
  });
});

describe('POST /api/consulta-precios/importar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('importa pares válidos e ignora incompletos', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/importar').send({
      pares: [
        { ean: '7000000000002', sku: 'FB-40' },
        { ean: '', sku: 'FB-40' },
        { ean: '7000000000003', sku: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.recibidos).toBe(3);
    expect(res.body.importados).toBe(1);
    db.close();
  });
});

describe('GET /api/consulta-precios/buscar-sku', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('autocompleta por sku o nombre', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar-sku?q=supacaz');
    expect(res.body.data.some(r => r.sku === 'FB-40')).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npm test -- test/consultaPrecios.test.js`
Expected: FAIL — `routes/consultaPrecios.js` no existe.

- [ ] **Step 3: Implementar el router**

Create `routes/consultaPrecios.js`:

```js
/**
 * Consulta de Precios: busca un producto por SKU o EAN y devuelve su precio web
 * (más título, marca, categoría y foto), leyendo catalogo_cache.
 *
 * El EAN no vive en WooCommerce, así que el puente EAN→SKU se guarda en la tabla
 * ean_sku, que aprende de a uno: cuando aparece un EAN desconocido, el frontend
 * pide el SKU y lo enseña con POST /ean.
 */

import { Router } from 'express';
import { productoDesdeFilaCatalogo } from '../lib/modelos/producto.js';

const now = () => new Date().toISOString();

/** ¿El código parece un EAN? Sólo dígitos, largo 8/12/13/14 (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function pareceEan(codigo) {
  const s = String(codigo || '').trim();
  return /^\d+$/.test(s) && [8, 12, 13, 14].includes(s.length);
}

/** Fila de catalogo_cache → objeto liviano para la card de resultado. */
function productoParaCard(row) {
  const p = productoDesdeFilaCatalogo(row);
  return {
    sku: p.sku, nombre: p.nombre, marca: p.marca, categorias: p.categorias,
    precio: p.precio, stock: p.stock, tipo: p.tipo, img: p.img,
  };
}

export function consultaPreciosRouter(db) {
  const router = Router();

  const porSku = db.prepare("SELECT * FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1");
  const eanRow = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?');

  // Búsqueda unificada: SKU exacto → EAN conocido → ¿parece EAN nuevo? → nada.
  router.get('/buscar', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, found: false });

    const filaSku = porSku.get(q);
    if (filaSku) return res.json({ ok: true, found: true, tipo: 'sku', producto: productoParaCard(filaSku) });

    const ean = eanRow.get(q);
    if (ean) {
      const fila = porSku.get(ean.sku);
      if (fila) return res.json({ ok: true, found: true, tipo: 'ean', producto: productoParaCard(fila) });
      return res.json({ ok: true, found: false, tipo: 'ean', ean: q, skuHuerfano: ean.sku });
    }

    if (pareceEan(q)) return res.json({ ok: true, found: false, needsSku: true, ean: q });
    return res.json({ ok: true, found: false });
  });

  // Enseña un EAN nuevo (o corrige uno mal mapeado). Valida que el SKU exista.
  router.post('/ean', (req, res) => {
    const ean = String(req.body?.ean || '').trim();
    const sku = String(req.body?.sku || '').trim();
    if (!ean || !sku) return res.status(400).json({ ok: false, error: 'ean y sku requeridos' });
    const fila = porSku.get(sku);
    if (!fila) return res.status(400).json({ ok: false, error: `SKU "${sku}" no está en el catálogo` });
    db.prepare(`
      INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
    `).run(ean, sku, now());
    res.json({ ok: true, producto: productoParaCard(fila) });
  });

  // Sembrado en lote desde el mapa del Contador de inventario. No valida contra el catálogo.
  router.post('/importar', (req, res) => {
    const pares = Array.isArray(req.body?.pares) ? req.body.pares : [];
    const validos = pares
      .map(p => ({ ean: String(p?.ean || '').trim(), sku: String(p?.sku || '').trim() }))
      .filter(p => p.ean && p.sku);
    const ins = db.prepare(`
      INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
    `);
    const tx = db.transaction((filas) => { for (const f of filas) ins.run(f.ean, f.sku, now()); });
    tx(validos);
    res.json({ ok: true, importados: validos.length, recibidos: pares.length });
  });

  // Autocomplete de SKU para enseñar un EAN nuevo.
  router.get('/buscar-sku', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, data: [] });
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT sku, nombre, stock, tipo FROM catalogo_cache
      WHERE (sku LIKE ? OR nombre LIKE ?) AND sku <> ''
      ORDER BY nombre ASC LIMIT 20
    `).all(like, like);
    res.json({ ok: true, data: rows });
  });

  return router;
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -- test/consultaPrecios.test.js`
Expected: PASS (todos los `describe`).

- [ ] **Step 5: Commit**

```bash
git add routes/consultaPrecios.js test/consultaPrecios.test.js
git commit -m "API Consulta de Precios: buscar por SKU/EAN, ensenar e importar EANs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Permiso y montaje en el servidor

Registra el permiso `consulta-precios`, la regla de ruta, y monta el router + el estático.

**Files:**
- Modify: `lib/permisos.js` (`HERRAMIENTAS` + `REGLAS`)
- Modify: `server.js` (import, `app.use` del router y del estático)
- Test: `test/permisos.test.js` (nuevo)

**Interfaces:**
- Consumes: `consultaPreciosRouter` de Task 3.
- Produces: permiso `consulta-precios` (niveles read/write) enforced; `/api/consulta-precios/*` montado; estático servido en `/consulta-precios`.

- [ ] **Step 1: Escribir el test de permisos**

Create `test/permisos.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { HERRAMIENTAS, resolvePermiso, permiteAcceso } from '../lib/permisos.js';

describe('permiso consulta-precios', () => {
  it('está en la lista de herramientas con niveles', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'consulta-precios');
    expect(h).toBeTruthy();
    expect(h.niveles).toBe(true);
  });

  it('GET /consulta-precios/buscar requiere read', () => {
    const req = resolvePermiso('GET', '/consulta-precios/buscar');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /consulta-precios/ean requiere write', () => {
    const req = resolvePermiso('POST', '/consulta-precios/ean');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'read' }], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'write' }], req)).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- test/permisos.test.js`
Expected: FAIL — la herramienta y la regla no existen todavía.

- [ ] **Step 3: Agregar la herramienta y la regla en `lib/permisos.js`**

En el array `HERRAMIENTAS`, agregar (después de `preparacion`):

```js
  { id: 'consulta-precios', label: 'Consulta de Precios', niveles: true  },
```

En el array `REGLAS`, agregar una regla (después de la de Precios ML, antes de la de Preparación):

```js
  // ── Consulta de Precios (lookup por SKU/EAN; write = enseñar/importar EANs) ──
  { re: /^\/consulta-precios(\/|$)/, resolve: (m) => ({ anyOf: ['consulta-precios'], nivel: nivelDe(m) }) },
```

- [ ] **Step 4: Montar el router y el estático en `server.js`**

Agregar el import (junto a los otros routers, después de `preparacionRouter`):

```js
import { consultaPreciosRouter } from './routes/consultaPrecios.js';
```

Montar el router y el estático (después del bloque de `preparacion`):

```js
  app.use('/api/consulta-precios', consultaPreciosRouter(db));
  app.use('/consulta-precios', express.static(path.join(__dirname, 'public/consulta-precios')));
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npm test -- test/permisos.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/permisos.js server.js test/permisos.test.js
git commit -m "Wiring Consulta de Precios: permiso, regla de ruta y montaje (router + estatico)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Página frontend `public/consulta-precios/index.html`

Página de consulta con caja (teclado/lector), cámara, card de resultado, flujo de EAN nuevo, escaneo continuo con historial e importación desde el inventario.

**Files:**
- Create: `public/consulta-precios/index.html`

**Interfaces:**
- Consumes: `GET/POST /api/consulta-precios/*` (Task 3), `window.Scanner` de `/lib/scanner.js`, `localStorage['fb_inv_descmap_v1']`.
- Produces: página estática. Sin exports.

- [ ] **Step 1: Crear el archivo HTML completo**

Create `public/consulta-precios/index.html`:

```html
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Consulta de Precios — Fusion Bikes</title>
<style>
  :root{
    --azul:#2DB8E8;--azul-dk:#1C93BD;--bg:#0C0F16;
    --panel:#141A25;--panel2:#1B2235;--border:#24304A;--border2:#2E3B57;
    --txt:#E4EAF4;--muted:#8493B0;--muted2:#5B6B8C;
    --green:#34D399;--amber:#FBBF24;--red:#F87171;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;}
  .wrap{max-width:640px;margin:0 auto;padding:16px 16px 60px;}
  a.back{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);text-decoration:none;margin-bottom:12px;}
  a.back:hover{color:var(--azul);}
  h1{font-size:1.4rem;font-weight:800;letter-spacing:-.03em;margin:4px 0 12px;}
  h1 em{font-style:normal;color:var(--azul);}
  .scanrow{display:flex;gap:8px;}
  #q{flex:1;font-size:20px;padding:14px 12px;border-radius:10px;border:2px solid var(--azul);background:var(--bg);color:var(--txt);font-weight:700;outline:none;box-shadow:0 0 0 3px rgba(45,184,232,.12);}
  #q::placeholder{color:var(--muted);font-weight:400;}
  .btn{background:var(--azul);color:#06131C;border:0;border-radius:10px;padding:0 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;}
  .btn:hover{background:var(--azul-dk);}
  .btn.sec{background:var(--panel2);color:var(--txt);}
  .btn.sec:hover{background:var(--border2);}
  .hint{font-size:12px;color:var(--muted);margin:8px 2px 0;}
  .result{margin-top:16px;}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:16px;display:flex;gap:14px;}
  .card img{width:96px;height:96px;border-radius:10px;object-fit:cover;background:var(--panel2);border:1px solid var(--border);flex-shrink:0;}
  .card .noimg{width:96px;height:96px;border-radius:10px;background:var(--panel2);border:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--muted2);font-size:11px;}
  .card .info{min-width:0;flex:1;}
  .card .marca{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--azul);}
  .card .tit{font-size:15px;font-weight:700;line-height:1.25;margin:2px 0 4px;}
  .card .cat{font-size:12px;color:var(--muted);}
  .card .precio{font-size:30px;font-weight:800;color:var(--green);margin-top:8px;font-variant-numeric:tabular-nums;}
  .card .meta{font-size:11.5px;color:var(--muted2);font-family:ui-monospace,Menlo,monospace;margin-top:6px;}
  .badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:6px;}
  .b-sku{background:rgba(45,184,232,.14);color:var(--azul);}
  .b-ean{background:rgba(52,211,153,.14);color:var(--green);}
  .msg{margin-top:16px;padding:16px;border-radius:12px;border:1px solid var(--border);background:var(--panel);font-size:14px;}
  .msg.warn{border-color:rgba(251,191,36,.4);}
  .msg.err{border-color:rgba(248,113,113,.4);color:var(--red);}
  .learn{margin-top:10px;}
  .learn input{width:100%;font-size:15px;padding:10px 12px;border-radius:9px;border:1px solid var(--border2);background:var(--bg);color:var(--txt);outline:none;}
  .learn input:focus{border-color:var(--azul);}
  .sugs{border:1px solid var(--border);border-radius:9px;margin-top:6px;overflow:hidden;background:var(--panel2);}
  .sug{padding:9px 11px;font-size:13px;cursor:pointer;border-bottom:1px solid var(--border);}
  .sug:last-child{border-bottom:0;}
  .sug:hover{background:var(--border2);}
  .sug b{color:var(--azul);font-family:ui-monospace,monospace;}
  .hist{margin-top:22px;}
  .hist-h{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted2);margin-bottom:8px;}
  .hist-row{display:flex;justify-content:space-between;gap:10px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px;font-size:13px;cursor:pointer;background:var(--panel);}
  .hist-row:hover{border-color:var(--border2);}
  .hist-row .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--txt);}
  .hist-row .p{color:var(--green);font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums;}
  .tools{margin-top:26px;border-top:1px solid var(--border);padding-top:14px;}
  .tools summary{font-size:12px;color:var(--muted);cursor:pointer;}
  .tools .btn{margin-top:10px;}
  .tools .out{font-size:12px;color:var(--muted);margin-top:8px;}
  /* Modal cámara */
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:50;padding:16px;}
  .modal.open{display:flex;}
  .modal-box{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:14px;max-width:460px;width:100%;}
  .modal-box video{width:100%;border-radius:10px;background:#000;display:block;}
  .modal-box .sub{color:var(--muted);font-size:13px;margin:10px 0;text-align:center;}
  .modal-box .cerrar{width:100%;font-size:14px;font-weight:700;padding:10px;border-radius:9px;border:1px solid var(--border);background:var(--panel2);color:var(--txt);cursor:pointer;}
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/herramientas/home/">&larr; Volver al inicio</a>
  <h1>Consulta de <em>Precios</em></h1>

  <div class="scanrow">
    <input id="q" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
           placeholder="Escaneá o tipeá SKU / EAN…">
    <button class="btn" id="btn-buscar">Buscar</button>
    <button class="btn sec" id="btn-cam">📷</button>
  </div>
  <div class="hint">Escaneá con el lector, tipeá con el teclado o usá la cámara 📷. Después de cada consulta la caja se vacía para el próximo código.</div>

  <div id="result" class="result"></div>

  <div class="hist" id="hist" style="display:none">
    <div class="hist-h">Consultas recientes</div>
    <div id="hist-list"></div>
  </div>

  <details class="tools">
    <summary>Herramientas</summary>
    <button class="btn sec" id="btn-import">Importar EANs del Contador de inventario</button>
    <div class="out" id="import-out"></div>
  </details>
</div>

<div class="modal" id="cam-modal">
  <div class="modal-box">
    <video id="cam-video" playsinline muted></video>
    <div class="sub" id="cam-sub">Apuntá al código de barras…</div>
    <button class="cerrar" id="cam-cerrar">Cerrar cámara</button>
  </div>
</div>

<script type="module" src="/lib/scanner.js"></script>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function fmtPrecio(n){
  if(n==null) return 'sin precio';
  return '$ ' + Number(n).toLocaleString('es-AR',{minimumFractionDigits:0,maximumFractionDigits:2});
}

var qEl = document.getElementById('q');
var resultEl = document.getElementById('result');
var historial = [];

function focusInput(){ try{ qEl.focus(); qEl.select(); }catch(e){} }

function cardHtml(p, tipo){
  var img = p.img ? '<img src="'+esc(p.img)+'" alt="">' : '<div class="noimg">sin foto</div>';
  var cat = (p.categorias && p.categorias.length) ? esc(p.categorias.join(' · ')) : '';
  var badge = tipo === 'ean' ? '<span class="badge b-ean">por EAN</span>' : '<span class="badge b-sku">por SKU</span>';
  return '<div class="card">' + img +
    '<div class="info">' +
      (p.marca ? '<div class="marca">'+esc(p.marca)+'</div>' : '') +
      '<div class="tit">'+esc(p.nombre)+badge+'</div>' +
      (cat ? '<div class="cat">'+cat+'</div>' : '') +
      '<div class="precio">'+fmtPrecio(p.precio)+'</div>' +
      '<div class="meta">'+esc(p.sku)+' · stock '+(p.stock==null?'?':p.stock)+'</div>' +
    '</div></div>';
}

function pushHistorial(p, tipo){
  historial.unshift({ p:p, tipo:tipo });
  if(historial.length > 12) historial.pop();
  var host = document.getElementById('hist');
  var list = document.getElementById('hist-list');
  list.innerHTML = historial.map(function(h, i){
    return '<div class="hist-row" data-i="'+i+'"><span class="t">'+esc(h.p.nombre)+'</span>' +
      '<span class="p">'+fmtPrecio(h.p.precio)+'</span></div>';
  }).join('');
  host.style.display = 'block';
  Array.prototype.forEach.call(list.querySelectorAll('.hist-row'), function(row){
    row.onclick = function(){ var h = historial[+row.dataset.i]; resultEl.innerHTML = cardHtml(h.p, h.tipo); };
  });
}

function mostrarEncontrado(p, tipo){
  resultEl.innerHTML = cardHtml(p, tipo);
  pushHistorial(p, tipo);
}

// ---- Flujo EAN nuevo / huérfano: pedir el SKU ----
function mostrarAprender(ean, textoTitulo){
  resultEl.innerHTML =
    '<div class="msg warn">' +
      '<div>'+esc(textoTitulo)+'</div>' +
      '<div style="font-size:12px;color:var(--muted);margin-top:4px">EAN: '+esc(ean)+'</div>' +
      '<div class="learn">' +
        '<input id="sku-input" placeholder="Buscá el SKU o nombre del producto…" autocomplete="off">' +
        '<div class="sugs" id="sugs" style="display:none"></div>' +
      '</div>' +
    '</div>';
  var input = document.getElementById('sku-input');
  var sugs = document.getElementById('sugs');
  var t = null;
  input.oninput = function(){
    clearTimeout(t);
    var q = input.value.trim();
    if(!q){ sugs.style.display='none'; return; }
    t = setTimeout(async function(){
      var r = await fetch('/api/consulta-precios/buscar-sku?q='+encodeURIComponent(q));
      var d = await r.json();
      if(!d.ok || !d.data.length){ sugs.style.display='none'; return; }
      sugs.innerHTML = d.data.map(function(row){
        return '<div class="sug" data-sku="'+esc(row.sku)+'"><b>'+esc(row.sku)+'</b> — '+esc(row.nombre)+'</div>';
      }).join('');
      sugs.style.display='block';
      Array.prototype.forEach.call(sugs.querySelectorAll('.sug'), function(el){
        el.onclick = function(){ enseñarEan(ean, el.dataset.sku); };
      });
    }, 220);
  };
  input.focus();
}

async function enseñarEan(ean, sku){
  var r = await fetch('/api/consulta-precios/ean', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ ean: ean, sku: sku }),
  });
  var d = await r.json();
  if(!d.ok){ resultEl.innerHTML = '<div class="msg err">'+esc(d.error||'No se pudo guardar')+'</div>'; return; }
  mostrarEncontrado(d.producto, 'ean');
  focusInput();
}

// ---- Búsqueda ----
async function buscar(codigo){
  var q = String(codigo == null ? qEl.value : codigo).trim();
  if(!q) return;
  var r = await fetch('/api/consulta-precios/buscar?q='+encodeURIComponent(q));
  var d = await r.json();
  qEl.value = '';
  if(d.found){ mostrarEncontrado(d.producto, d.tipo); focusInput(); return; }
  if(d.needsSku){ mostrarAprender(d.ean, 'EAN nuevo — ¿a qué producto pertenece?'); return; }
  if(d.skuHuerfano){ mostrarAprender(d.ean, 'Este EAN apuntaba a un SKU que ya no está ('+d.skuHuerfano+'). Re-asignalo:'); return; }
  resultEl.innerHTML = '<div class="msg">No se encontró nada para <b>'+esc(q)+'</b>. Revisá el código.</div>';
  focusInput();
}

document.getElementById('btn-buscar').onclick = function(){ buscar(); };
qEl.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); buscar(); } });

// ---- Cámara (escaneo continuo) ----
var modal = document.getElementById('cam-modal');
document.getElementById('btn-cam').onclick = function(){
  modal.classList.add('open');
  window.Scanner.open({
    video: document.getElementById('cam-video'),
    mode: 'continuous',
    onCode: function(code){
      document.getElementById('cam-sub').textContent = '✓ ' + code;
      buscar(code);
    },
    onError: function(msg){ document.getElementById('cam-sub').textContent = msg; },
  });
};
function cerrarCam(){ window.Scanner.close(); modal.classList.remove('open'); focusInput(); }
document.getElementById('cam-cerrar').onclick = cerrarCam;

// ---- Importar EANs del Contador de inventario ----
function pareceEanCliente(code){ return /^\d+$/.test(code) && [8,12,13,14].includes(code.length); }
document.getElementById('btn-import').onclick = async function(){
  var out = document.getElementById('import-out');
  var raw;
  try{ raw = JSON.parse(localStorage.getItem('fb_inv_descmap_v1') || '{}'); }catch(e){ raw = {}; }
  var pares = [];
  for(var code in raw){
    if(!Object.prototype.hasOwnProperty.call(raw, code)) continue;
    var e = raw[code] || {};
    var other = String(e.other || '').trim();
    if(!other) continue;
    if(pareceEanCliente(code)) pares.push({ ean: code, sku: other });
    else pares.push({ ean: other, sku: code });
  }
  pares = pares.filter(function(p){ return p.ean && p.sku; });
  if(!pares.length){ out.textContent = 'No se encontró ningún mapa EAN↔SKU en este navegador.'; return; }
  var r = await fetch('/api/consulta-precios/importar', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pares: pares }),
  });
  var d = await r.json();
  out.textContent = d.ok ? ('Importados '+d.importados+' de '+d.recibidos+' pares.') : ('Error: '+(d.error||''));
};

// Auth gate + foco inicial
fetch('/api/auth/me').then(function(r){
  if(r.status === 401){ window.location.href = '/herramientas/login/'; return; }
  focusInput();
});
</script>
</body>
</html>
```

- [ ] **Step 2: Verificación manual con el server corriendo**

Levantar el server local y probar el flujo end-to-end. En una terminal:

```bash
node server.js
```

Luego, en otra terminal, verificar que los endpoints responden (sin sesión darán 401, lo cual confirma el gate; el flujo visual se prueba en el navegador logueado):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/consulta-precios/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/consulta-precios/buscar?q=FB-40
```

Expected: la página `/consulta-precios/` responde `200`; `/api/consulta-precios/buscar` responde `401` sin sesión (gate de auth activo). En el navegador, logueado y con permiso, buscar un SKU real muestra la card con foto/marca/categoría/precio.

- [ ] **Step 3: Commit**

```bash
git add public/consulta-precios/index.html
git commit -m "Frontend Consulta de Precios: caja/lector/camara, card, EAN nuevo, historial e import

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Card en la home

Agrega la tarjeta de acceso en la sección "Control" de la home.

**Files:**
- Modify: `public/home/index.html` (sección `<!-- CONTROL -->`)

**Interfaces:**
- Consumes: el permiso `consulta-precios` (la home gatea sola por el href).
- Produces: card visible para usuarios con el permiso.

- [ ] **Step 1: Agregar la card**

En `public/home/index.html`, dentro de `<div class="cards">` de la sección `<!-- CONTROL -->` (después de la card del Contador de Inventario que termina en su `</a>`, antes de la de Etiquetas), insertar:

```html
      <a class="card card-control" href="/herramientas/consulta-precios/">
        <div class="card-top">
          <div class="card-icon icon-control">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <path d="M21 21l-4.35-4.35"/>
            </svg>
          </div>
        </div>
        <div class="card-title">Consulta de Precios</div>
        <div class="card-desc">Escaneá o tipeá un SKU o código EAN y mirá al instante el precio web, con foto, marca y categoría del producto.</div>
        <div class="card-footer">
          <span class="card-tag">SKU · EAN · Precio</span>
          <svg class="card-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
      </a>
```

- [ ] **Step 2: Verificación manual**

Con el server corriendo y logueado como admin (o usuario con el permiso `consulta-precios`), abrir `/herramientas/home/`: la card "Consulta de Precios" aparece en la sección Control y linkea a `/herramientas/consulta-precios/`. Como usuario sin el permiso, no aparece.

- [ ] **Step 3: Correr toda la suite**

Run: `npm test`
Expected: PASS — toda la suite verde (los 208 previos + los nuevos de Tasks 1-4).

- [ ] **Step 4: Commit**

```bash
git add public/home/index.html
git commit -m "Home: card de acceso a Consulta de Precios en la seccion Control

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notas de integración final

- Tras desplegar, correr una vez "Recargar catálogo" (o esperar el cron de 15 min) para poblar `marca` en las filas existentes; hasta entonces la card muestra el producto sin marca (no rompe nada).
- Dar el permiso `consulta-precios` a los usuarios de mostrador desde Usuarios y Permisos (la UI se arma sola desde `HERRAMIENTAS`).
- Sembrado inicial opcional: abrir la herramienta en el mismo navegador donde se usó el Contador de inventario y tocar "Importar EANs del Contador de inventario".
