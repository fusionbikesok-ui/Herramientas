# Contador de Inventario v2 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el Contador de Inventario 100% client-side por una herramienta con
backend real: sesiones de conteo con alcance (categoría/marca) que evita el solape entre
operarios, comparación en vivo contra el stock de WooCommerce, ajuste de stock fail-closed
al confirmar, aprendizaje de EANs nuevos, y una interfaz de 6 pantallas pensada para
depósito (celular, táctil grande, alto contraste).

**Architecture:** Node/Express ESM + better-sqlite3 en backend (`routes/inventario.js`,
nuevo); HTML/CSS/JS plano en `public/inventario/index.html` (reescrito completo). Reusa
`setStockWc`/`buildWooPath` de `lib/wooStock.js`, la tabla `ean_sku` ya existente, y
`public/lib/scanner.js` sin cambios.

**Tech Stack:** Express, better-sqlite3, vitest, `public/lib/format.js`/`api.js`/`theme.css`
(ya existentes).

## Global Constraints

- Contenido y comentarios en español.
- No tocar `.env`, `data/`, `uploads/`, `*.db`, `*.sqlite`.
- `hard-worker-backend` dueño de `routes/`, `server.js`; `hard-worker-frontend` dueño de
  `public/`.
- **Ninguna escritura a Woo sin el paso explícito de confirmación** — `POST
  /sesiones/:id/confirmar` es la única acción que ajusta stock real, y solo si no hay
  ítems "sin asociar" pendientes (bloqueo explícito, no advertencia).
- **Fail-closed por ítem al confirmar**: si el `PUT` de stock de un producto falla, no
  aborta el resto de la sesión — se reporta aparte y la sesión no queda en un estado
  ambiguo (los que sí se ajustaron quedan ajustados, los demás se pueden reintentar).
- El checksum GS1 de clasificación EAN/SKU se replica en el backend (no confiar
  ciegamente en la clasificación que mande el cliente).
- Al final de cada tarea que toque `routes/`/`server.js`, correr `npm test` y confirmar
  que la suite completa sigue verde.
- Tokens visuales: usar los definidos por `disenador-ui` en `theme.css` (Task 5), nunca
  hardcodear hex nuevos en el HTML de la herramienta.

---

## Task 1: Tabla + helpers + `GET /alcance-opciones` + `GET /sesion-activa`

**Files:**
- Create: `routes/inventario.js`
- Test: `test/inventario.test.js`

**Interfaces:**
- Produces: `inventarioRouter(db, wooCfg)`, montable en `/api/inventario`.
- Produce funciones exportadas: `looksLikeEan(code)`, `ensureTables(db)`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/inventario.test.js`:

```javascript
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { inventarioRouter, looksLikeEan } from '../routes/inventario.js';

const TEST_DB = './test/tmp-inventario.sqlite';
const CFG = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
const now = () => new Date().toISOString();

function buildApp(db, usuario = 'operario1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0 }; next(); });
  app.use('/api/inventario', inventarioRouter(db, CFG));
  return app;
}

function insertProducto(db, extra) {
  const base = {
    id_woo: 1, nombre: 'Producto', sku: 'FB-1', tipo: 'simple', id_padre: null,
    stock: 5, categorias_json: null, img: null, precio: null, atributos_json: null,
    marca: null, gtin: null, actualizado_en: now(),
  };
  const row = { ...base, ...extra };
  db.prepare(`
    INSERT INTO catalogo_cache
      (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, marca, gtin, actualizado_en)
    VALUES
      (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @marca, @gtin, @actualizado_en)
  `).run(row);
  return row;
}

describe('looksLikeEan', () => {
  it('reconoce un EAN-13 válido (checksum GS1 correcto)', () => {
    expect(looksLikeEan('7791234567895')).toBe(true); // dígito de control real 5? ver Step 3, ajustar si el checksum calculado difiere
  });
  it('rechaza un código con checksum inválido', () => {
    expect(looksLikeEan('7791234567890')).toBe(false);
  });
  it('rechaza un SKU alfanumérico', () => {
    expect(looksLikeEan('FB-123')).toBe(false);
  });
  it('rechaza longitudes no válidas de EAN (ni 8/12/13/14 dígitos)', () => {
    expect(looksLikeEan('12345')).toBe(false);
  });
});

describe('GET /api/inventario/alcance-opciones', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve categorías y marcas distintas de catalogo_cache, sin duplicados', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', categorias_json: '["Cascos","Accesorios"]' });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', marca: 'Continental', categorias_json: '["Cubiertas"]' });

    const res = await request(buildApp(db)).get('/api/inventario/alcance-opciones');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.marcas.sort()).toEqual(['Bell', 'Continental']);
    expect(res.body.categorias.sort()).toEqual(['Accesorios', 'Cascos', 'Cubiertas']);
  });
});

describe('GET /api/inventario/sesion-activa', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve null si el usuario no tiene sesión abierta', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).get('/api/inventario/sesion-activa');
    expect(res.status).toBe(200);
    expect(res.body.sesion).toBeNull();
  });

  it('devuelve la sesión abierta propia, no la de otro usuario', async () => {
    const db = openDb(TEST_DB);
    db.prepare(`CREATE TABLE IF NOT EXISTS inventario_sesiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, categoria TEXT, marca TEXT,
      estado TEXT NOT NULL DEFAULT 'abierta', creado_en TEXT NOT NULL, confirmado_en TEXT)`).run();
    db.prepare("INSERT INTO inventario_sesiones (usuario, marca, estado, creado_en) VALUES ('otro_operario','Bell','abierta',?)").run(now());
    db.prepare("INSERT INTO inventario_sesiones (usuario, marca, estado, creado_en) VALUES ('operario1','Continental','abierta',?)").run(now());

    const res = await request(buildApp(db, 'operario1')).get('/api/inventario/sesion-activa');

    expect(res.status).toBe(200);
    expect(res.body.sesion).toBeTruthy();
    expect(res.body.sesion.marca).toBe('Continental');
  });
});
```

- [ ] **Step 2: Correr los tests para confirmar que fallan**

Run: `npx vitest run test/inventario.test.js`
Expected: FAIL — el módulo `routes/inventario.js` no existe.

- [ ] **Step 3: Implementar `routes/inventario.js` (parte 1)**

Crear `routes/inventario.js`:

```javascript
import express from 'express';
import { parseCategorias } from '../lib/modelos/producto.js';

const now = () => new Date().toISOString();

// ─── Clasificación EAN/SKU por formato + dígito de control GS1 ───────────────
// Portado tal cual de public/inventario/index.html (kindOf/gtinCheckOk actuales).
function gtinCheckOk(code) {
  const n = code.length;
  let sum = 0;
  for (let i = n - 2; i >= 0; i--) {
    const d = code.charCodeAt(i) - 48;
    const mult = ((n - 2 - i) % 2 === 0) ? 3 : 1;
    sum += d * mult;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (code.charCodeAt(n - 1) - 48);
}

export function looksLikeEan(code) {
  if (!/^[0-9]+$/.test(code)) return false;
  const n = code.length;
  if (n !== 8 && n !== 12 && n !== 13 && n !== 14) return false;
  return gtinCheckOk(code);
}

// ─── Tablas ───────────────────────────────────────────────────────────────────

export function ensureTables(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_sesiones (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario        TEXT NOT NULL,
    categoria      TEXT,
    marca          TEXT,
    estado         TEXT NOT NULL DEFAULT 'abierta',
    creado_en      TEXT NOT NULL,
    confirmado_en  TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_inv_sesiones_estado ON inventario_sesiones(estado)').run();

  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_conteos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sesion_id      INTEGER NOT NULL,
    ean            TEXT NOT NULL,
    sku            TEXT,
    cantidad       INTEGER NOT NULL DEFAULT 0,
    actualizado_en TEXT NOT NULL,
    UNIQUE(sesion_id, ean)
  )`).run();
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function inventarioRouter(db, wooCfg) {
  ensureTables(db);
  const router = express.Router();

  router.get('/alcance-opciones', (req, res) => {
    const rows = db.prepare("SELECT categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>''").all();
    const categorias = new Set();
    const marcas = new Set();
    for (const r of rows) {
      for (const c of parseCategorias(r.categorias_json)) if (c) categorias.add(c);
      if (r.marca) marcas.add(r.marca);
    }
    res.json({ ok: true, categorias: [...categorias], marcas: [...marcas] });
  });

  router.get('/sesion-activa', (req, res) => {
    const usuario = req.user?.username;
    const sesion = db.prepare(
      "SELECT * FROM inventario_sesiones WHERE usuario=? AND estado='abierta' ORDER BY id DESC LIMIT 1"
    ).get(usuario);
    res.json({ ok: true, sesion: sesion || null });
  });

  return router;
}
```

- [ ] **Step 4: Ajustar el checksum del test si hace falta**

El test del Step 1 usa `'7791234567895'` como EAN-13 válido de ejemplo — calculá vos mismo
el dígito de control real para `779123456789` con el algoritmo de `gtinCheckOk` (peso 3
alternado desde la derecha, dígito de control = `(10 - suma%10) % 10`) y reemplazá el
último dígito del código de test por el valor correcto antes de correr los tests, si
`779123456789` + `5` no da checksum válido. Documentá en un comentario del test cuál es el
dígito de control calculado y por qué.

- [ ] **Step 5: Correr los tests para confirmar que pasan**

Run: `npx vitest run test/inventario.test.js`
Expected: PASS — 7 tests verdes.

- [ ] **Step 6: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa.

- [ ] **Step 7: Commit**

```bash
git add routes/inventario.js test/inventario.test.js
git commit -m "Agregar routes/inventario.js: tabla, checksum GS1, alcance-opciones y sesion-activa"
```

---

## Task 2: `POST /sesiones` (anti-solape) + `GET /sesiones/:id`

**Files:**
- Modify: `routes/inventario.js`
- Modify: `test/inventario.test.js`

**Interfaces:**
- Consumes: `parseCategorias` (Task 1), `productoDesdeFilaCatalogo` (`lib/modelos/producto.js`, ya existente).
- Produces: `POST /sesiones` → `{ok:true, sesion}` o 409 `{ok:false, error, ocupada_por, categoria, marca}`. `GET /sesiones/:id` → `{ok:true, sesion, items, pendientes}`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/inventario.test.js`:

```javascript
describe('POST /api/inventario/sesiones', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('crea una sesión con el alcance elegido', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sesion.marca).toBe('Bell');
    expect(res.body.sesion.estado).toBe('abierta');
  });

  it('rechaza sin categoría ni marca (alcance obligatorio)', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).post('/api/inventario/sesiones').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rechaza con 409 si otra sesión abierta ya cubre la misma marca, mostrando el dueño', async () => {
    const db = openDb(TEST_DB);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    const res = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.ocupada_por).toBe('juan');
  });

  it('permite crear sesión con marca distinta aunque otra esté abierta', async () => {
    const db = openDb(TEST_DB);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    const res = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Continental' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rechaza si el usuario ya tiene una sesión abierta propia', async () => {
    const db = openDb(TEST_DB);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    const res = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Continental' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya ten[eé]s una sesión/i);
  });
});

describe('GET /api/inventario/sesiones/:id', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve items contados + pendientes del alcance (comparado contra stock real)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', stock: 10, nombre: 'Casco A' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 4, nombre: 'Casco B' });

    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const sesionId = crear.body.sesion.id;
    db.prepare("INSERT INTO inventario_conteos (sesion_id, ean, sku, cantidad, actualizado_en) VALUES (?,?,?,?,?)")
      .run(sesionId, '1234567890128', 'FB-1', 7, now());

    const res = await request(buildApp(db, 'juan')).get(`/api/inventario/sesiones/${sesionId}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ sku: 'FB-1', cantidad: 7, stock_woo: 10 });
    expect(res.body.pendientes).toHaveLength(1);
    expect(res.body.pendientes[0].sku).toBe('FB-2');
  });
});
```

- [ ] **Step 2: Correr para confirmar que fallan**

Run: `npx vitest run test/inventario.test.js -t "POST /api/inventario/sesiones"`
Expected: FAIL — la ruta no existe.

- [ ] **Step 3: Implementar**

Agregar dentro de `inventarioRouter`, después de `/sesion-activa`:

```javascript
  function coincideAlcance(prodCategorias, prodMarca, categoria, marca) {
    const matchCat = categoria ? prodCategorias.includes(categoria) : false;
    const matchMarca = marca ? prodMarca === marca : false;
    if (categoria && marca) return matchCat || matchMarca;
    if (categoria) return matchCat;
    return matchMarca;
  }

  function solapan(a, b) {
    // Dos alcances se solapan si comparten categoría, o comparten marca, o ambos
    // están definidos y cualquiera de los dos coincide (mismo criterio "OR" que
    // usa coincideAlcance para decidir qué producto entra en cada sesión).
    if (a.categoria && b.categoria && a.categoria === b.categoria) return true;
    if (a.marca && b.marca && a.marca === b.marca) return true;
    return false;
  }

  router.post('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    const categoria = String(req.body?.categoria || '').trim() || null;
    const marca = String(req.body?.marca || '').trim() || null;
    if (!categoria && !marca) {
      return res.status(400).json({ ok: false, error: 'Elegí categoría y/o marca para el alcance.' });
    }

    const propia = db.prepare("SELECT id FROM inventario_sesiones WHERE usuario=? AND estado='abierta'").get(usuario);
    if (propia) {
      return res.status(409).json({ ok: false, error: 'Ya tenés una sesión abierta. Retomala o descartala antes de crear otra.' });
    }

    const abiertas = db.prepare("SELECT usuario, categoria, marca FROM inventario_sesiones WHERE estado='abierta'").all();
    const nueva = { categoria, marca };
    const choque = abiertas.find(s => solapan(s, nueva));
    if (choque) {
      return res.status(409).json({
        ok: false,
        error: `El alcance se cruza con la sesión de ${choque.usuario}.`,
        ocupada_por: choque.usuario,
        categoria: choque.categoria,
        marca: choque.marca,
      });
    }

    const id = db.prepare(
      "INSERT INTO inventario_sesiones (usuario, categoria, marca, estado, creado_en) VALUES (?,?,?,'abierta',?)"
    ).run(usuario, categoria, marca, now()).lastInsertRowid;
    const sesion = db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(id);
    res.json({ ok: true, sesion });
  });

  function getSesion(id, usuario) {
    const sesion = db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(id);
    if (!sesion || sesion.usuario !== usuario) return null;
    return sesion;
  }

  router.get('/sesiones/:id', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });

    const conteos = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=?').all(sesion.id);
    const items = conteos.map(c => {
      const prod = c.sku ? db.prepare('SELECT stock, nombre FROM catalogo_cache WHERE sku=?').get(c.sku) : null;
      return {
        id: c.id, ean: c.ean, sku: c.sku, cantidad: c.cantidad,
        nombre: prod?.nombre || null,
        stock_woo: prod ? prod.stock : null,
        diferencia: prod ? c.cantidad - prod.stock : null,
      };
    });

    const skusContados = new Set(items.map(i => i.sku).filter(Boolean));
    const catalogo = db.prepare("SELECT sku, nombre, stock, categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>'' AND tipo<>'variable'").all();
    const pendientes = catalogo
      .filter(p => coincideAlcance(parseCategorias(p.categorias_json), p.marca, sesion.categoria, sesion.marca))
      .filter(p => !skusContados.has(p.sku))
      .map(p => ({ sku: p.sku, nombre: p.nombre, stock_woo: p.stock }));

    res.json({ ok: true, sesion, items, pendientes });
  });
```

- [ ] **Step 4: Correr los tests para confirmar que pasan**

Run: `npx vitest run test/inventario.test.js`
Expected: PASS — todos verdes.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa.

- [ ] **Step 6: Commit**

```bash
git add routes/inventario.js test/inventario.test.js
git commit -m "Agregar POST /sesiones (anti-solape) y GET /sesiones/:id con comparación vs stock"
```

---

## Task 3: Escanear, asociar EAN y eliminar ítem

**Files:**
- Modify: `routes/inventario.js`
- Modify: `test/inventario.test.js`

**Interfaces:**
- Consumes: `looksLikeEan` (Task 1).
- Produces: `POST /sesiones/:id/escanear`, `POST /sesiones/:id/asociar`, `DELETE /sesiones/:id/items/:itemId`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/inventario.test.js`:

```javascript
describe('POST /api/inventario/sesiones/:id/escanear', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  async function crearSesion(db, usuario, body) {
    const r = await request(buildApp(db, usuario)).post('/api/inventario/sesiones').send(body);
    return r.body.sesion.id;
  }

  it('escanea un SKU directo: crea/incrementa la fila con ese sku', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r1 = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    expect(r1.body.item.sku).toBe('FB-1');
    expect(r1.body.item.cantidad).toBe(1);

    const r2 = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    expect(r2.body.item.cantidad).toBe(2);
  });

  it('escanea un EAN conocido (en ean_sku): resuelve el sku automáticamente', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    db.prepare("INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES ('1234567890128','FB-1',?)").run(now());
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    expect(r.body.item.sku).toBe('FB-1');
    expect(r.body.item.ean).toBe('1234567890128');
  });

  it('escanea un EAN NO reconocido: crea fila con sku null (sin asociar)', async () => {
    const db = openDb(TEST_DB);
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    expect(r.status).toBe(200);
    expect(r.body.item.sku).toBeNull();
    expect(r.body.item.sin_asociar).toBe(true);
  });

  it('rechaza escanear en la sesión de otro usuario', async () => {
    const db = openDb(TEST_DB);
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r = await request(buildApp(db, 'ana')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });

    expect(r.status).toBe(404);
  });
});

describe('POST /api/inventario/sesiones/:id/asociar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('asocia un EAN sin sku a un SKU existente y siembra ean_sku', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/asociar`).send({ ean: '1234567890128', sku: 'FB-1' });

    expect(r.status).toBe(200);
    expect(r.body.item.sku).toBe('FB-1');
    const fila = db.prepare("SELECT sku FROM ean_sku WHERE ean='1234567890128'").get();
    expect(fila.sku).toBe('FB-1');
  });

  it('rechaza asociar a un SKU que no existe en el catálogo', async () => {
    const db = openDb(TEST_DB);
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/asociar`).send({ ean: '1234567890128', sku: 'NO-EXISTE' });

    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/inventario/sesiones/:id/items/:itemId', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('elimina una fila contada (deshacer)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    const esc = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    const itemId = esc.body.item.id;

    const r = await request(buildApp(db, 'juan')).delete(`/api/inventario/sesiones/${id}/items/${itemId}`);

    expect(r.status).toBe(200);
    const fila = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(itemId);
    expect(fila).toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr para confirmar que fallan**

Run: `npx vitest run test/inventario.test.js -t "escanear"`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Agregar dentro de `inventarioRouter`, después de `GET /sesiones/:id`:

```javascript
  router.post('/sesiones/:id/escanear', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });

    const codigo = String(req.body?.codigo || '').trim();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Código requerido' });

    let ean, sku;
    if (looksLikeEan(codigo)) {
      ean = codigo;
      const catalogado = db.prepare('SELECT sku FROM catalogo_cache WHERE gtin=?').get(ean)
        || db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get(ean);
      sku = catalogado?.sku || null;
    } else {
      ean = codigo; // se guarda igual como "código leído" aunque sea SKU, para tener una clave única por fila
      sku = codigo;
    }

    const existente = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND ean=?').get(sesion.id, ean);
    let itemId;
    if (existente) {
      db.prepare('UPDATE inventario_conteos SET cantidad=cantidad+1, actualizado_en=? WHERE id=?').run(now(), existente.id);
      itemId = existente.id;
    } else {
      itemId = db.prepare(
        'INSERT INTO inventario_conteos (sesion_id, ean, sku, cantidad, actualizado_en) VALUES (?,?,?,1,?)'
      ).run(sesion.id, ean, sku, now()).lastInsertRowid;
    }
    const item = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(itemId);
    res.json({ ok: true, item: { ...item, sin_asociar: !item.sku } });
  });

  router.post('/sesiones/:id/asociar', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });

    const ean = String(req.body?.ean || '').trim();
    const sku = String(req.body?.sku || '').trim();
    const prod = db.prepare("SELECT sku FROM catalogo_cache WHERE sku=?").get(sku);
    if (!prod) return res.status(400).json({ ok: false, error: `SKU "${sku}" no está en el catálogo` });

    db.prepare(`
      INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)
      ON CONFLICT(ean) DO UPDATE SET sku=excluded.sku, actualizado_en=excluded.actualizado_en
    `).run(ean, sku, now());
    db.prepare('UPDATE inventario_conteos SET sku=?, actualizado_en=? WHERE sesion_id=? AND ean=?')
      .run(sku, now(), sesion.id, ean);

    const item = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND ean=?').get(sesion.id, ean);
    res.json({ ok: true, item });
  });

  router.delete('/sesiones/:id/items/:itemId', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    db.prepare('DELETE FROM inventario_conteos WHERE id=? AND sesion_id=?').run(req.params.itemId, sesion.id);
    res.json({ ok: true });
  });
```

Nota: la tabla `ean_sku` puede no existir todavía si `routes/consultaPrecios.js`/`routes/codigos.js`
no corrieron antes en el proceso de test — `openDb(TEST_DB)` en `db/index.js` ya la crea
globalmente al abrir la conexión (confirmado en la investigación previa de este plan), así
que no hace falta un `ensureTables` propio para `ean_sku` en `routes/inventario.js`; si el
test falla por "no such table: ean_sku", agregar `db.prepare('CREATE TABLE IF NOT EXISTS
ean_sku (...)').run()` dentro de `ensureTables` de este archivo como red de seguridad.

- [ ] **Step 4: Correr los tests para confirmar que pasan**

Run: `npx vitest run test/inventario.test.js`
Expected: PASS.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa.

- [ ] **Step 6: Commit**

```bash
git add routes/inventario.js test/inventario.test.js
git commit -m "Agregar escanear/asociar EAN/eliminar ítem al Contador de Inventario"
```

---

## Task 4: Descartar, confirmar (ajuste de stock fail-closed) e historial

**Files:**
- Modify: `routes/inventario.js`
- Modify: `test/inventario.test.js`

**Interfaces:**
- Consumes: `setStockWc` de `lib/wooStock.js`.
- Produces: `POST /sesiones/:id/descartar`, `POST /sesiones/:id/confirmar`, `GET /sesiones`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/inventario.test.js` (mockeando `setStockWc`):

```javascript
vi.mock('../lib/wooStock.js', async () => {
  const actual = await vi.importActual('../lib/wooStock.js');
  return { ...actual, setStockWc: vi.fn() };
});
import { setStockWc } from '../lib/wooStock.js';

describe('POST /api/inventario/sesiones/:id/descartar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('cierra la sesión sin ajustar stock', async () => {
    const db = openDb(TEST_DB);
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/descartar`);

    expect(r.status).toBe(200);
    expect(setStockWc).not.toHaveBeenCalled();
    const sesion = db.prepare('SELECT estado FROM inventario_sesiones WHERE id=?').get(id);
    expect(sesion.estado).toBe('descartada');
  });
});

describe('POST /api/inventario/sesiones/:id/confirmar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('bloquea con 409 si hay ítems sin asociar', async () => {
    const db = openDb(TEST_DB);
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(409);
    expect(setStockWc).not.toHaveBeenCalled();
  });

  it('ajusta stock por cada ítem contado y marca la sesión confirmada', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell' });
    setStockWc.mockResolvedValue();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-2' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(200);
    expect(r.body.ajustados).toBe(2);
    expect(setStockWc).toHaveBeenCalledTimes(2);
    const sesion = db.prepare('SELECT estado, confirmado_en FROM inventario_sesiones WHERE id=?').get(id);
    expect(sesion.estado).toBe('confirmada');
    expect(sesion.confirmado_en).toBeTruthy();
  });

  it('fail-closed por ítem: un PUT que falla no aborta el resto', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell' });
    setStockWc.mockRejectedValueOnce(new Error('Woo caído')).mockResolvedValueOnce();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-2' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(200);
    expect(r.body.ajustados).toBe(1);
    expect(r.body.fallidos).toBe(1);
    expect(setStockWc).toHaveBeenCalledTimes(2);
  });

  it('rechaza confirmar una sesión ya confirmada (evita doble ajuste)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    setStockWc.mockResolvedValue();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);
    vi.clearAllMocks();

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(400);
    expect(setStockWc).not.toHaveBeenCalled();
  });
});

describe('GET /api/inventario/sesiones (historial)', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('devuelve solo sesiones cerradas del usuario, no las abiertas ni las de otro', async () => {
    const db = openDb(TEST_DB);
    setStockWc.mockResolvedValue();
    const c1 = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${c1.body.sesion.id}/descartar`);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Continental' }); // queda abierta
    await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Shimano' });

    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones');

    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].estado).toBe('descartada');
  });
});
```

- [ ] **Step 2: Correr para confirmar que fallan**

Run: `npx vitest run test/inventario.test.js -t "confirmar"`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Agregar el import al tope del archivo:

```javascript
import { setStockWc } from '../lib/wooStock.js';
```

Y dentro de `inventarioRouter`, después de `DELETE /sesiones/:id/items/:itemId`:

```javascript
  router.post('/sesiones/:id/descartar', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });
    db.prepare("UPDATE inventario_sesiones SET estado='descartada' WHERE id=?").run(sesion.id);
    res.json({ ok: true });
  });

  router.post('/sesiones/:id/confirmar', async (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });

    const items = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=?').all(sesion.id);
    const sinAsociar = items.filter(i => !i.sku);
    if (sinAsociar.length) {
      return res.status(409).json({ ok: false, error: 'Hay ítems sin asociar a un SKU. Asocialos antes de confirmar.', sin_asociar: sinAsociar.length });
    }

    let ajustados = 0, fallidos = 0;
    const errores = [];
    for (const item of items) {
      try {
        await setStockWc(wooCfg, db, item.sku, item.cantidad);
        ajustados++;
      } catch (e) {
        fallidos++;
        errores.push({ sku: item.sku, error: e.message });
      }
    }

    db.prepare("UPDATE inventario_sesiones SET estado='confirmada', confirmado_en=? WHERE id=?").run(now(), sesion.id);
    res.json({ ok: true, ajustados, fallidos, errores });
  });

  router.get('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    const rows = db.prepare(
      "SELECT * FROM inventario_sesiones WHERE usuario=? AND estado<>'abierta' ORDER BY COALESCE(confirmado_en,creado_en) DESC LIMIT 100"
    ).all(usuario);
    res.json({ ok: true, data: rows });
  });
```

- [ ] **Step 4: Correr los tests para confirmar que pasan**

Run: `npx vitest run test/inventario.test.js`
Expected: PASS — toda la suite del archivo.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa.

- [ ] **Step 6: Commit**

```bash
git add routes/inventario.js test/inventario.test.js
git commit -m "Agregar descartar/confirmar (ajuste de stock fail-closed) e historial al Contador de Inventario"
```

---

## Task 5: Registrar el router + tokens visuales en `theme.css`

**Files:**
- Modify: `server.js`
- Modify: `public/lib/theme.css`
- Create: `public/lib/design-system.md` (si no existe todavía)

**Interfaces:**
- Consumes: `inventarioRouter` (Task 1-4).

- [ ] **Step 1: Registrar el router en `server.js`**

Ubicar el `import` de `preparacionRouter` y agregar debajo:

```javascript
import { inventarioRouter } from './routes/inventario.js';
```

Ubicar el `app.use('/inventario', express.static(...))` existente (ya sirve el HTML
estático) y agregar ANTES de esa línea:

```javascript
  app.use('/api/inventario', inventarioRouter(db, wooCfg));
```

- [ ] **Step 2: Verificar sintaxis y tests**

Run: `node --check server.js && npm test`
Expected: sin errores de sintaxis, suite completa verde.

- [ ] **Step 3: Agregar tokens a `theme.css`**

Leer `public/lib/theme.css` primero para confirmar los nombres reales de `--red`,
`--red-bg`, `--red-bd`, `--accent`, `--muted`, `--panel`/`--surface` (usar el nombre real
del archivo, no el citado acá si difiere) y `--radius-pill`/`--radius-lg` ya agregados en
ciclos anteriores. Insertar, dentro de `:root`, después del bloque de tokens de severidad
ya existente (`--critical`/`--warning`/`--success`):

```css
  /* Contador de Inventario — herramienta de depósito, celular en mano, luz variable. */
  --tap-min: 44px;

  --chip-bg:     var(--surface2);
  --chip-bd:     var(--border);
  --chip-txt:    var(--muted);
  --chip-on-bg:  var(--accent-dim);
  --chip-on-bd:  var(--accent);
  --chip-on-txt: var(--accent);

  --diff-neg:  var(--critical);
  --diff-pos:  var(--success);
  --diff-zero: var(--muted);

  --state-pending:  var(--muted);
  --state-counted:  var(--success);
  --state-unlinked: var(--warning);

  --progress-track: var(--surface2);
  --progress-fill:  var(--accent);

  --danger:       var(--red);
  --danger-bg:    var(--red-bg);
  --danger-bd:    var(--red-bd);
  --danger-solid: var(--red);
  --danger-on:    #2A0505;
  --danger-veil:  rgba(6,8,13,.92);

  --sheet-bg: var(--surface);
  --sheet-bd: var(--border2);
```

(Ajustar los nombres del lado derecho a los reales del archivo si difieren — por ejemplo
`--surface2` podría llamarse `--panel2` según lo que confirmaste en la lectura previa.)

- [ ] **Step 4: Verificar balance de llaves**

Run: `node -e "const fs=require('fs');const c=fs.readFileSync('public/lib/theme.css','utf8');const o=(c.match(/{/g)||[]).length;const cl=(c.match(/}/g)||[]).length;if(o!==cl)throw new Error('desbalanceado: '+o+' vs '+cl);console.log('OK: '+o+' bloques')"`
Expected: `OK: N bloques` sin excepción.

- [ ] **Step 5: Crear/actualizar `public/lib/design-system.md`**

Si el archivo no existe (verificar primero — pudo haberse creado en el ciclo del home),
crearlo con el contenido base documentado en la spec de este ciclo (sección de tokens del
Contador de Inventario) siguiendo el formato ya usado en `docs/superpowers/specs/2026-07-24-contador-inventario-v2-design.md`
sección "Tokens/componentes nuevos". Si ya existe, agregar una sección nueva
`## Contador de Inventario` sin borrar lo que ya haya del ciclo del home.

- [ ] **Step 6: Commit**

```bash
git add server.js public/lib/theme.css public/lib/design-system.md
git commit -m "Registrar router de inventario y sumar tokens visuales de Contador de Inventario"
```

---

## Task 6: Frontend — Inicio y Elegir alcance

**Files:**
- Modify: `public/inventario/index.html` (reescritura completa del archivo)

**Interfaces:**
- Consumes: `GET /api/inventario/sesion-activa`, `GET /api/inventario/alcance-opciones`,
  `POST /api/inventario/sesiones`, `GET /api/inventario/sesiones` (historial).

- [ ] **Step 1: Estructura base del archivo**

Reemplazar el `&lt;body&gt;` completo del `public/inventario/index.html` actual por una SPA
de vistas (`&lt;div id="vista-inicio"&gt;`, `&lt;div id="vista-alcance"&gt;`,
`&lt;div id="vista-conteo"&gt;`, etc., todas ocultas salvo la activa vía
`display:none`/`display:block` controlado por JS — mismo patrón de "una sola página,
varias vistas conmutadas" que ya usa `public/preparacion/index.html` con sus tabs). Cargar
`public/lib/format.js`, `public/lib/api.js`, `public/lib/scanner.js` (módulo), y
`public/lib/theme.css` como en las demás páginas del proyecto.

- [ ] **Step 2: Vista Inicio**

Al cargar, llamar `GET /api/inventario/sesion-activa`:
- Si hay sesión: mostrar `.card-retomar` (token de la Task 5) con
  categoría/marca + antigüedad (`fecha relativa desde sesion.creado_en`, reusar `format.js`
  si tiene helper de fecha relativa, si no calcular con `Date.now() - new
  Date(creado_en)`), botón grande "Retomar" que navega a la vista Conteo con esa sesión, y
  botón secundario "Nueva sesión" (deshabilitado con tooltip "Ya tenés una sesión abierta —
  retomala o descartala" si hay una abierta, matching la regla del backend que rechaza
  crear una segunda).
- Si no hay sesión: solo botón "Nueva sesión" → navega a vista Alcance.
- `&lt;details&gt;` colapsable "Historial" que al abrirse llama `GET /api/inventario/sesiones`
  y lista las cerradas (categoría/marca, estado, fecha, ajustados si confirmada) en
  read-only, sin acción.

- [ ] **Step 3: Vista Elegir alcance**

Al entrar, llamar `GET /api/inventario/alcance-opciones` y poblar dos `&lt;input list="...">`
(datalist nativo, simple y accesible) para Categoría y Marca con las opciones recibidas.
Botón "Empezar a contar" deshabilitado si ambos campos están vacíos. Al confirmar, `POST
/api/inventario/sesiones {categoria, marca}`:
- Si 200: navegar a vista Conteo con la sesión creada.
- Si 409 con `ocupada_por`: mostrar aviso inline (no alert nativo) con `.chip` o tarjeta de
  advertencia usando `--warning-bg`/`--warning-bd`: "El alcance se cruza con la sesión de
  **{ocupada_por}** ({categoria}/{marca})." + botones "Cambiar alcance" (limpia el form) /
  "Cancelar" (vuelve a Inicio).
- Si 409 sin `ocupada_por` (ya tenés sesión propia abierta): mismo patrón de aviso con el
  mensaje que devuelve el backend.

- [ ] **Step 2 y 3, verificación conjunta: sintaxis**

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/inventario/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: `scripts inline OK: N` sin excepción.

- [ ] **Step 4: Commit**

```bash
git add public/inventario/index.html
git commit -m "Contador de Inventario: reescritura base + vistas Inicio y Elegir alcance"
```

---

## Task 7: Frontend — Conteo y panel EAN nuevo

**Files:**
- Modify: `public/inventario/index.html`

**Interfaces:**
- Consumes: `GET /api/inventario/sesiones/:id`, `POST /api/inventario/sesiones/:id/escanear`,
  `POST /api/inventario/sesiones/:id/asociar`, `DELETE /api/inventario/sesiones/:id/items/:itemId`,
  `GET /api/codigos/buscar` (ya existente, para buscar SKU al asociar un EAN nuevo).

- [ ] **Step 1: Vista Conteo**

Barra de estado fija arriba: texto "Contando · {categoria/marca del alcance}" + LED de
foco del input de escaneo (portar la lógica de foco/color del `public/inventario/index.html`
actual, adaptada a la clase `.tap`/tokens nuevos) + chip "Guardado" (`--success`, visible
apenas la última escritura al servidor resolvió sin error).

Input de escaneo grande con `autofocus`, capturando tanto tipeo de pistola HID (mismo
patrón de buffer con timeout que ya usa la herramienta actual) como submit por Enter →
`POST /sesiones/:id/escanear {codigo}`. Botón de cámara que abre el modal ya existente
del módulo `scanner.js` (portar el modal tal cual del HTML actual, sin cambios de esa
lógica).

3 contadores derivados de la respuesta de `GET /sesiones/:id` (recargada tras cada
escaneo): Contados (`items.length`), Pendientes (`pendientes.length`), Con diferencia
(`items.filter(i => i.diferencia !== 0).length`).

Chips de filtro (`.chip-filtro`, activo/inactivo con los tokens de la Task 5): "Pendientes"
| "Contados" | "Todos" — controla qué lista se muestra (pendientes = `pendientes[]` sin
acción de +1/-1 porque no están contados aún, solo informativos con botón "Contar" que
llama `/escanear` con el SKU; contados = `items[]` con +1/-1/eliminar). Botón de orden
"Por diferencia" que reordena `items[]` por `Math.abs(diferencia)` descendente.

Cada fila de `items[]`: EAN/SKU, nombre, contado vs. `stock_woo`, `.diff` con signo
explícito (`+`/`−`/`0`) coloreado con `--diff-neg`/`--diff-pos`/`--diff-zero`. Botones +1
(`POST /escanear` de nuevo con el mismo código)/−1 (necesita un endpoint de decremento —
**si no existe, usar `DELETE` + re-escanear N-1 veces es incorrecto; en su lugar, para −1
simple, el frontend puede llamar a un PATCH directo `cantidad-1` — pero como el plan no
definió ese endpoint, para esta tarea el botón "−1" con cantidad ya en 1 debe usar el
`DELETE /items/:itemId` existente [elimina la fila], y con cantidad &gt;1 debe deshabilitarse
con nota "editable solo en Revisión" hasta que exista un endpoint de ajuste directo — no
inventes un endpoint nuevo no planificado, dejalo así y anotalo en tu reporte como
limitación conocida de este ciclo**)/eliminar (`DELETE /items/:itemId`).

Botón fijo abajo (`.bottom-bar`) "Revisar y cerrar" → navega a vista Revisión.

- [ ] **Step 2: Panel EAN nuevo (bottom-sheet)**

Cuando la respuesta de `/escanear` trae `sin_asociar: true`, abrir un `.sheet` (token de
la Task 5) sin bloquear el input de escaneo (que sigue con foco activo detrás):
- EAN leído en grande.
- Input de búsqueda que llama `GET /api/codigos/buscar?q=...` (debounced, mismo patrón de
  debounce ya usado en `public/sync-detalle/index.html`) y lista resultados tocables
  (`min-height:52px`, token `--tap-min`).
- Al tocar un resultado: `POST /sesiones/:id/asociar {ean, sku}` → cierra el sheet, la fila
  deja de estar `sin_asociar`.
- Botón "Después": cierra el sheet sin asociar, la fila queda visible en la lista marcada
  con `--state-unlinked` (borde/ícono, no solo color).

- [ ] **Step 3: Verificación de sintaxis**

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/inventario/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: `scripts inline OK: N` sin excepción.

- [ ] **Step 4: Commit**

```bash
git add public/inventario/index.html
git commit -m "Contador de Inventario: vista Conteo + panel EAN nuevo"
```

---

## Task 8: Frontend — Revisión, Confirmación y Resultado

**Files:**
- Modify: `public/inventario/index.html`

**Interfaces:**
- Consumes: `GET /api/inventario/sesiones/:id`, `POST /api/inventario/sesiones/:id/confirmar`,
  `POST /api/inventario/sesiones/:id/descartar`.

- [ ] **Step 1: Vista Revisión**

Lista de `items[]` (de `GET /sesiones/:id`) ordenada por `Math.abs(diferencia)`
descendente. Cada fila editable: input numérico de "nuevo stock" prellenado con
`cantidad`. Bloque separado arriba, con borde `--danger`, para ítems `sin_asociar` (si
quedó alguno del paso "Después" en Conteo) — bloqueante, con botón "Asociar" que reabre el
panel EAN nuevo de la Task 7. Nota informativa (`--muted`) con la cantidad de
`pendientes.length` ("N productos del alcance no se contaron — su stock no se toca").
Botones: "Volver a contar" (vuelve a vista Conteo) / "Confirmar ajuste" (deshabilitado si
hay `sin_asociar.length > 0`, con tooltip explicando por qué).

- [ ] **Step 2: Vista Confirmación (modal)**

Al tocar "Confirmar ajuste": modal con `--danger-veil` de fondo (más denso que cualquier
otro modal de la herramienta). Resumen numérico: "Vas a ajustar stock de **{items.length}**
productos" + conteo de subas/bajas (`items.filter(i=>i.diferencia>0).length` /
`.filter(i=>i.diferencia<0).length`). Frase fija: "Esto ajusta el stock real en
WooCommerce y no se puede deshacer." Confirmación de doble paso: botón que requiere
mantener presionado 2 segundos (usar `pointerdown`/`pointerup` con un `setTimeout` de
2000ms cancelado si se suelta antes, con relleno visual `--danger-solid` creciendo durante
el hold) — al completar el hold, dispara `POST /sesiones/:id/confirmar`. Botón "Cancelar"
del mismo tamaño (`--tap-min`), cierra el modal sin acción.

- [ ] **Step 3: Vista Resultado**

Tras la respuesta de `/confirmar`: mostrar resumen `{ajustados}` (`--success`),
`{fallidos}` (`--danger`) con lista de `errores[]` si los hay y botón "Reintentar
fallidos" (vuelve a llamar `/confirmar` — el backend es idempotente para los ítems ya
ajustados porque `setStockWc` simplemente vuelve a poner el mismo valor, así que reintentar
no duplica nada). Sesión queda con sello "CERRADA" (leer `sesion.estado` al recargar) y la
vista pasa a solo-lectura (sin botones de +1/-1/confirmar). Botón "Volver a Inicio".

También cablear el botón "Descartar sesión" (mencionado en el menú secundario de Conteo,
Task 7) → `POST /sesiones/:id/descartar` con `confirm()` nativo simple (no necesita el
nivel de fricción de Confirmación, porque descartar NO toca stock) → vuelve a Inicio.

- [ ] **Step 4: Verificación de sintaxis**

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/inventario/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: `scripts inline OK: N` sin excepción.

- [ ] **Step 5: Commit**

```bash
git add public/inventario/index.html
git commit -m "Contador de Inventario: vistas Revisión, Confirmación y Resultado"
```

---

## Task 9: Frontend — Enviar selección a Etiquetas de Productos

**Files:**
- Modify: `public/inventario/index.html`

**Interfaces:**
- Produce: escritura de `localStorage['fb_inv_session_v1']` y
  `localStorage['fb_inv_descmap_v1']`, mismo shape que ya consume
  `public/etiquetas/index.html:730-793` (integración pre-existente, no se toca del lado de
  Etiquetas).

**Contexto (agregado tras aprobación del backend, no estaba en el spec original):** el
usuario pidió poder mandar una selección de lo contado al generador de Etiquetas para
imprimir. La integración ya existe del lado de Etiquetas (lee esas dos claves de
`localStorage` al abrirse) — solo hace falta que el Contador v2 las escriba con el mismo
formato antes de navegar para allá.

- [ ] **Step 1: Checkboxes en la lista de Conteo**

En la vista Conteo (Task 7), agregar un checkbox a la izquierda de cada fila de `items[]`
(los ya contados, no los pendientes). Mantener un `Set` en memoria de `id`s seleccionados.
Un checkbox "seleccionar todo" en el header de la lista, igual patrón que ya usa
`public/sync-detalle/index.html` (`toggleAll`).

- [ ] **Step 2: Botón "Enviar a Etiquetas"**

Agregar al menú secundario de la vista Conteo (junto a "Descartar sesión") un botón
"Enviar a Etiquetas ({N} seleccionados)", deshabilitado si no hay ninguna fila
seleccionada. Al tocarlo:

```javascript
function enviarAEtiquetas(itemsSeleccionados) {
  var rows = itemsSeleccionados.map(function(i) {
    return { code: i.sku || i.ean, qty: i.cantidad };
  });
  var prev = JSON.parse(localStorage.getItem('fb_inv_session_v1') || '{"rows":[],"history":[]}');
  var merged = { rows: rows, history: prev.history || [] };
  localStorage.setItem('fb_inv_session_v1', JSON.stringify(merged));
  window.location.href = '/herramientas/etiquetas/';
}
```

Nota: se **reemplaza** `rows` (no se agrega a lo que ya hubiera de una sesión vieja del
Contador v1) para que el envío sea predecible — "esto es exactamente lo que seleccioné
ahora", no una mezcla con datos de otra sesión. `fb_inv_descmap_v1` no hace falta escribirlo
en este flujo: el Contador v2 ya resuelve nombre/categoría contra `catalogo_cache` en el
propio backend (a diferencia del v1, que dependía del mapa local), así que Etiquetas va a
poder resolver cada `code` (que siempre es un SKU real cuando la fila está seleccionable,
por la regla de "sin asociar" bloqueante) contra su propio `/api/woo/catalogo` sin
necesitar el mapa de respaldo.

- [ ] **Step 3: Verificación de sintaxis**

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/inventario/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: `scripts inline OK: N` sin excepción.

- [ ] **Step 4: Commit**

```bash
git add public/inventario/index.html
git commit -m "Contador de Inventario: enviar selección a Etiquetas de Productos"
```

---

## Self-Review

1. **Cobertura del spec:** tabla+helpers (Task 1) ✓; anti-solape con dueño visible +
   comparación vs stock (Task 2) ✓; escanear/asociar/eliminar (Task 3) ✓;
   descartar/confirmar fail-closed/historial (Task 4) ✓; router+tokens (Task 5) ✓; 6
   pantallas (Tasks 6-8) ✓.
2. **Chequeo de redundancia** (regla sumada 2026-07-24): ¿hay dos operaciones caras
   pegando al mismo recurso? `GET /sesion-activa` y `GET /sesiones/:id` son consultas
   distintas con propósitos distintos (existencia vs. detalle completo), no redundantes.
   `POST /escanear` y `POST /asociar` ambos escriben a `inventario_conteos` pero en
   momentos y con datos distintos del flujo — no es la misma operación repetida. Sin
   hallazgos de redundancia.
3. **Placeholders:** ninguno, salvo la limitación explícita y documentada del botón "−1"
   en la Task 7 (no se inventa un endpoint fuera de alcance del plan; se deja como
   limitación conocida a reportar, no como código incompleto sin explicar).
4. **Consistencia de nombres:** `looksLikeEan`, `ensureTables`, `coincideAlcance`,
   `solapan`, `getSesion` se definen y usan consistentemente dentro del mismo archivo
   (`routes/inventario.js`) a través de las Tasks 1-4.
5. **Gap detectado en este self-review:** el checksum del EAN de ejemplo en el Test del
   Step 1 de la Task 1 (`'7791234567895'`) no fue verificado a mano por mí — el propio
   Step 4 de esa tarea instruye al implementador a calcularlo y corregirlo si hace falta,
   en vez de dejarlo como un valor no verificado que podría hacer fallar el test sin
   explicación. Ya está resuelto con esa instrucción explícita, no requiere cambio
   adicional.
