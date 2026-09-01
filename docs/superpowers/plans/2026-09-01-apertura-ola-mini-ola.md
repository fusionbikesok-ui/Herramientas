# Apertura diaria, ola congelada y mini-olas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar apertura de jornada, ola inicial congelada, mini-olas acumulativas continuas, mini-ola ML urgente, y el aviso de vencimiento de claim a 10 minutos, sobre el backend de preparación de FusionBikes.

**Architecture:** Un router nuevo `routes/jornada.js` (siguiendo el mismo patrón que `preparacionRouter`: `ensureTablesJornada(db)` + `jornadaRouter(db, cfg)`) con su lógica de dominio en `lib/jornada.js`. Reutiliza el criterio de elegibilidad ya existente en `GET /api/preparacion/pendientes` (extraído a una función compartida) y el mecanismo de claim con TTL ya probado en `routes/preparacion.js`, sin modificar su tabla ni su contrato — se agrega una tabla de claims paralela para `pick_wave`, mismo patrón que ya usa el código para no reescribir historia.

**Tech Stack:** Node/Express (ESM), better-sqlite3, vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-01-apertura-ola-mini-ola-design.md`

## Global Constraints

- Zona horaria operativa: `America/Argentina/Buenos_Aires` (nunca UTC ni hora del server) — usar los helpers de `lib/tiempo.js` / `lib/horariosDespacho.js`, no reinventar cálculo de offset.
- Toda mutación reintentable/concurrente usa transacción `db.transaction()`, igual que el resto de `routes/preparacion.js`.
- Ningún endpoint existente de `/api/preparacion` cambia de contrato (solo se le agregan campos opcionales `pick_wave_id`/`pick_wave_tipo`).
- El TTL real de liberación de claim sigue siendo `CLAIM_TTL_DEFAULT_MS = 15 * 60 * 1000` (no se toca); el aviso a 10 min es un campo calculado, no un TTL nuevo.
- Criterio "ML urgente" (confirmado con el usuario 2026-09-01): un pedido `canal='ml'` (o `espejo_ml=1`) es urgente si su `fecha_despacho` (ya calculada por `lib/horariosDespacho.js`) es la fecha local de hoy.
- `pedidos_cache` tiene PK `clave` (TEXT), no `id` — toda referencia a un pedido en las tablas nuevas usa `pedido_clave TEXT`, nunca un id numérico inexistente.
- No correr `npm test` (suite completa) desde ningún agente de tarea — cada tarea corre solo su archivo de test. La suite completa la corre el orquestador al final.

---

### Task 1: Extraer `pedidosElegiblesOrdenados` a `lib/preparacion.js`

**Files:**
- Modify: `lib/preparacion.js` (agregar función nueva al final)
- Modify: `routes/preparacion.js:800-802` (reemplazar la consulta inline por la función extraída)
- Test: `test/preparacion.test.js` (agregar un test unitario directo sobre la función extraída; los tests existentes de `GET /pendientes` no deben cambiar de comportamiento — sirven de regresión)

**Interfaces:**
- Produces: `pedidosElegiblesOrdenados(db)` — `lib/preparacion.js`. Devuelve `Array<row>` de `pedidos_cache`, mismo shape de fila que hoy expone `SELECT * FROM pedidos_cache WHERE estado_envio='pendiente' ORDER BY CASE WHEN canal='ml' OR espejo_ml=1 THEN 0 ELSE 1 END, fecha ASC`. Usado por Task 3 (`abrirJornada`) y Task 6 (sincronización de mini-ola).

- [ ] **Step 1: Escribir el test que fija el contrato de la función extraída (todavía no existe)**

En `test/preparacion.test.js`, agregar cerca de los tests existentes de `/pendientes` (buscar `describe` que cubra ese endpoint):

```js
import { pedidosElegiblesOrdenados } from '../lib/preparacion.js';

// ... dentro de un describe existente o uno nuevo:
it('pedidosElegiblesOrdenados prioriza ml/espejo_ml sobre web y antigüedad dentro de cada grupo', () => {
  const ts = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO pedidos_cache
    (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, espejo_ml, items_json, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run('web:1', 'web', 1, '1', 'A', '2026-09-01T10:00:00Z', 'pendiente', 0, '[]', ts);
  ins.run('ml:1', 'ml', null, '2', 'B', '2026-09-01T11:00:00Z', 'pendiente', 0, '[]', ts);
  ins.run('web:2', 'web', 2, '3', 'C', '2026-09-01T09:00:00Z', 'pendiente', 1, '[]', ts); // espejo_ml
  const rows = pedidosElegiblesOrdenados(db);
  expect(rows.map(r => r.clave)).toEqual(['ml:1', 'web:2', 'web:1']);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/preparacion.test.js -t "pedidosElegiblesOrdenados" --reporter=dot`
Expected: FAIL con `pedidosElegiblesOrdenados is not a function` (el import falla porque todavía no existe).

- [ ] **Step 3: Extraer la función en `lib/preparacion.js`**

Agregar al final de `lib/preparacion.js`:

```js
// Elegibilidad + orden compartidos entre GET /api/preparacion/pendientes y la apertura de
// jornada (E1) — una sola fuente de verdad para "qué pedidos entran a trabajar hoy y en
// qué orden". Ver plan-maestro-v2.md §4: ML/espejo_ml primero, antigüedad después.
export function pedidosElegiblesOrdenados(db) {
  return db.prepare(
    "SELECT * FROM pedidos_cache WHERE estado_envio='pendiente' ORDER BY CASE WHEN canal='ml' OR espejo_ml=1 THEN 0 ELSE 1 END, fecha ASC"
  ).all();
}
```

- [ ] **Step 4: Reemplazar la consulta inline en `routes/preparacion.js`**

En `routes/preparacion.js`, agregar `pedidosElegiblesOrdenados` al import existente de `../lib/preparacion.js` (línea ~10-14), y reemplazar dentro de `router.get('/pendientes', ...)`:

```js
// antes:
const rows = db.prepare("SELECT * FROM pedidos_cache WHERE estado_envio='pendiente' ORDER BY CASE WHEN canal='ml' OR espejo_ml=1 THEN 0 ELSE 1 END, fecha ASC").all();
// después:
const rows = pedidosElegiblesOrdenados(db);
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/preparacion.test.js --reporter=dot`
Expected: PASS, todos los tests existentes de `/pendientes` siguen verdes (comportamiento idéntico) + el nuevo test unitario pasa.

- [ ] **Step 6: Commit**

```bash
cd /tmp/fusion-e1-current
git add lib/preparacion.js routes/preparacion.js test/preparacion.test.js
git commit -m "refactor(preparacion): extraer pedidosElegiblesOrdenados para reutilizar en E1"
```

---

### Task 2: Esquema de tablas — `routes/jornada.js` (`ensureTablesJornada`)

**Files:**
- Create: `routes/jornada.js`
- Test: `test/jornada.test.js`

**Interfaces:**
- Produces: `ensureTablesJornada(db)` — crea `operational_days`, `pick_waves`, `pick_wave_items`, `pick_wave_claims`. Idempotente (usa `IF NOT EXISTS`), se llama desde `jornadaRouter(db, cfg)` (Task 4).
- Produces: `jornadaRouter(db, cfg)` — placeholder que exporta un `express.Router()` vacío por ahora; las rutas se agregan en tareas siguientes sobre este mismo archivo.

- [ ] **Step 1: Escribir el test de esquema (falla porque el archivo no existe)**

Crear `test/jornada.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { ensureTablesJornada } from '../routes/jornada.js';

const TEST_DB = 'test/jornada.test.sqlite';

describe('ensureTablesJornada', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('crea las 4 tablas y es idempotente al llamarse dos veces', () => {
    ensureTablesJornada(db);
    ensureTablesJornada(db); // no debe tirar error
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tablas).toEqual(expect.arrayContaining([
      'operational_days', 'pick_waves', 'pick_wave_items', 'pick_wave_claims',
    ]));
  });

  it('operational_days rechaza fecha duplicada (UNIQUE)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts);
    expect(() => db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts)).toThrow();
  });

  it('pick_waves rechaza una segunda mini-ola abierta en el mismo día (índice único parcial)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    const dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts);
    expect(() => db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts)).toThrow();
  });

  it('pick_wave_items rechaza que el mismo pedido esté en dos olas (índice único sobre pedido_clave)', () => {
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    const dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    const waveId = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,?,?,?)`)
      .run(dayId, 'mini', 'abierta', ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(waveId, 'ml:1', ts);
    expect(() => db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`)
      .run(waveId, 'ml:1', ts)).toThrow();
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: FAIL — `routes/jornada.js` no existe.

- [ ] **Step 3: Crear `routes/jornada.js` con el esquema**

```js
import express from 'express';

const now = () => new Date().toISOString();

export function ensureTablesJornada(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS operational_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL UNIQUE,
    estado TEXT NOT NULL DEFAULT 'abierta',
    hora_corte_web TEXT,
    ventana_ml_json TEXT,
    abierta_por TEXT NOT NULL,
    abierta_en TEXT NOT NULL,
    cerrada_por TEXT,
    cerrada_en TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS pick_waves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operational_day_id INTEGER NOT NULL REFERENCES operational_days(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('inicial', 'mini', 'ml_urgente')),
    estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'congelada', 'en_picking', 'completada')),
    creada_en TEXT NOT NULL,
    congelada_en TEXT,
    congelada_por TEXT,
    completada_en TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pick_waves_day_estado ON pick_waves(operational_day_id, estado)').run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_waves_mini_abierta
    ON pick_waves(operational_day_id) WHERE tipo = 'mini' AND estado = 'abierta'`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_wave_id INTEGER NOT NULL REFERENCES pick_waves(id),
    pedido_clave TEXT NOT NULL,
    agregado_en TEXT NOT NULL
  )`).run();
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_wave_items_pedido ON pick_wave_items(pedido_clave)').run();

  // Claim de ola: tabla paralela a preparacion_claims (mismo patrón, misma razón: no
  // reescribir el contrato ya probado de preparacion_claims). PK simple porque a lo sumo
  // un claim vigente por ola.
  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_claims (
    pick_wave_id INTEGER PRIMARY KEY,
    usuario TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    renovado_en TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pick_wave_claims_expira ON pick_wave_claims(expires_at)').run();
}

export function jornadaRouter(db, cfg) {
  ensureTablesJornada(db);
  const router = express.Router();
  return router;
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
cd /tmp/fusion-e1-current
git add routes/jornada.js test/jornada.test.js
git commit -m "feat(jornada): esquema de operational_days, pick_waves, pick_wave_items y claims"
```

---

### Task 3: `lib/jornada.js` — `abrirJornada` con snapshot de ola inicial

**Files:**
- Create: `lib/jornada.js`
- Test: `test/jornada.test.js` (agregar tests)

**Interfaces:**
- Consumes: `pedidosElegiblesOrdenados(db)` de `lib/preparacion.js` (Task 1).
- Produces: `fechaLocalHoy(now = new Date())` — `lib/jornada.js`. Devuelve `'YYYY-MM-DD'` en zona Buenos Aires.
- Produces: `abrirJornada(db, { usuario, horaCorteWeb = null, ventanaMlJson = null }, now = new Date())` — `lib/jornada.js`. Devuelve `{ ok: true, jornada, olaInicial }` o `{ ok: false, code: 'OPERATIONAL_DAY_EXISTS', jornada }`. Usado por Task 4 (ruta `POST /jornada/abrir`).
- Produces: `jornadaDeHoy(db, now = new Date())` — devuelve la fila de `operational_days` de la fecha local de hoy, o `null`. Usado por Task 4 (`GET /jornada/hoy`).

- [ ] **Step 1: Escribir los tests (fallan, `lib/jornada.js` no existe)**

Agregar a `test/jornada.test.js`:

```js
import { fechaLocalHoy, abrirJornada, jornadaDeHoy } from '../lib/jornada.js';
import { ensureTables } from '../routes/preparacion.js'; // si no está exportada, ver nota abajo

describe('abrirJornada', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DB);
    ensureTablesJornada(db);
    // pedidos_cache la crea preparacionRouter; para no depender de ese router en este test,
    // se crea acá mínimamente igual que en preparacion.js.
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
      clave TEXT PRIMARY KEY, canal TEXT NOT NULL, wc_order_id INTEGER, ml_order_id TEXT,
      numero_pedido TEXT, comprador TEXT, fecha TEXT, estado_envio TEXT NOT NULL,
      estado_wc TEXT, espejo_ml INTEGER NOT NULL DEFAULT 0, logistic_type TEXT,
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL
    )`).run();
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  function insertarPedido(clave, canal, fecha, extra = {}) {
    db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, comprador, fecha, estado_envio, espejo_ml, items_json, actualizado_en)
      VALUES (?,?,?,?,?,'pendiente',?,'[]',?)`)
      .run(clave, canal, clave, 'Cliente', fecha, extra.espejo_ml ? 1 : 0, new Date().toISOString());
  }

  it('crea la jornada y congela la ola inicial con los pedidos elegibles en ese instante', () => {
    insertarPedido('ml:1', 'ml', '2026-09-01T10:00:00Z');
    insertarPedido('web:1', 'web', '2026-09-01T09:00:00Z');
    const now = new Date('2026-09-01T13:00:00Z');
    const r = abrirJornada(db, { usuario: 'tester' }, now);
    expect(r.ok).toBe(true);
    expect(r.jornada.fecha).toBe(fechaLocalHoy(now));
    expect(r.olaInicial.tipo).toBe('inicial');
    expect(r.olaInicial.estado).toBe('congelada');
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(r.olaInicial.id).map(x => x.pedido_clave);
    expect(items).toEqual(['ml:1', 'web:1']);
  });

  it('un pedido insertado DESPUÉS de abrir la jornada no entra en la ola inicial', () => {
    const now = new Date('2026-09-01T13:00:00Z');
    const r = abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('web:2', 'web', '2026-09-01T14:00:00Z');
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(r.olaInicial.id);
    expect(items).toHaveLength(0);
  });

  it('doble apertura el mismo día local devuelve 409 lógico sin crear una segunda fila', () => {
    const now = new Date('2026-09-01T13:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    const r2 = abrirJornada(db, { usuario: 'otro' }, new Date('2026-09-01T15:00:00Z'));
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('OPERATIONAL_DAY_EXISTS');
    const filas = db.prepare('SELECT COUNT(*) c FROM operational_days').get().c;
    expect(filas).toBe(1);
  });

  it('jornadaDeHoy devuelve null si no se abrió y la fila si se abrió', () => {
    const now = new Date('2026-09-01T13:00:00Z');
    expect(jornadaDeHoy(db, now)).toBeNull();
    abrirJornada(db, { usuario: 'tester' }, now);
    expect(jornadaDeHoy(db, now).fecha).toBe(fechaLocalHoy(now));
  });
});
```

Nota: si `ensureTables` no está exportada desde `routes/preparacion.js`, no la importes — el bloque de arriba ya crea `pedidos_cache` a mano dentro del test, que es autosuficiente. Borrar el import de `ensureTables` si `routes/preparacion.js` no lo exporta (verificar con `grep -n "^export.*ensureTables" routes/preparacion.js` antes de escribir el archivo final; a la fecha de este plan NO está exportada, así que el import debe omitirse).

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: FAIL — `lib/jornada.js` no existe.

- [ ] **Step 3: Crear `lib/jornada.js`**

```js
import { pedidosElegiblesOrdenados } from './preparacion.js';

const ZONA = 'America/Argentina/Buenos_Aires';

export function fechaLocalHoy(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function jornadaDeHoy(db, now = new Date()) {
  const fecha = fechaLocalHoy(now);
  return db.prepare('SELECT * FROM operational_days WHERE fecha=?').get(fecha) || null;
}

export function abrirJornada(db, { usuario, horaCorteWeb = null, ventanaMlJson = null }, now = new Date()) {
  const fecha = fechaLocalHoy(now);
  const existente = db.prepare('SELECT * FROM operational_days WHERE fecha=?').get(fecha);
  if (existente) return { ok: false, code: 'OPERATIONAL_DAY_EXISTS', jornada: existente };

  const ts = now.toISOString();
  const tx = db.transaction(() => {
    const dayInfo = db.prepare(`INSERT INTO operational_days
      (fecha, estado, hora_corte_web, ventana_ml_json, abierta_por, abierta_en)
      VALUES (?,?,?,?,?,?)`).run(fecha, 'abierta', horaCorteWeb, ventanaMlJson, usuario, ts);
    const dayId = dayInfo.lastInsertRowid;

    const waveInfo = db.prepare(`INSERT INTO pick_waves
      (operational_day_id, tipo, estado, creada_en, congelada_en, congelada_por)
      VALUES (?,'inicial','congelada',?,?,?)`).run(dayId, ts, ts, usuario);
    const waveId = waveInfo.lastInsertRowid;

    const elegibles = pedidosElegiblesOrdenados(db);
    const insertItem = db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)');
    for (const pedido of elegibles) insertItem.run(waveId, pedido.clave, ts);

    return {
      jornada: db.prepare('SELECT * FROM operational_days WHERE id=?').get(dayId),
      olaInicial: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId),
    };
  });
  const { jornada, olaInicial } = tx();
  return { ok: true, jornada, olaInicial };
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS, todos los tests (los 4 de esquema de Task 2 + los 4 nuevos).

- [ ] **Step 5: Commit**

```bash
cd /tmp/fusion-e1-current
git add lib/jornada.js test/jornada.test.js
git commit -m "feat(jornada): abrirJornada con snapshot de ola inicial"
```

---

### Task 4: Rutas `POST /jornada/abrir` y `GET /jornada/hoy`

**Files:**
- Modify: `routes/jornada.js`
- Modify: `server.js` (montar el router nuevo)
- Test: `test/jornada.test.js`

**Interfaces:**
- Consumes: `abrirJornada`, `jornadaDeHoy` de `lib/jornada.js` (Task 3).
- Produces: rutas HTTP montadas en `/api/jornada` (namespace propio, separado de `/api/preparacion` para no engordar más ese router).

- [ ] **Step 1: Escribir los tests HTTP (fallan, las rutas no existen)**

Agregar a `test/jornada.test.js`:

```js
import express from 'express';
import request from 'supertest';
import { jornadaRouter } from '../routes/jornada.js';

describe('rutas /api/jornada', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DB);
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
      clave TEXT PRIMARY KEY, canal TEXT NOT NULL, wc_order_id INTEGER, ml_order_id TEXT,
      numero_pedido TEXT, comprador TEXT, fecha TEXT, estado_envio TEXT NOT NULL,
      estado_wc TEXT, espejo_ml INTEGER NOT NULL DEFAULT 0, logistic_type TEXT,
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL
    )`).run();
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  function appConUsuario(usuario) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 1 }; next(); });
    app.use('/api/jornada', jornadaRouter(db, {}));
    return app;
  }

  it('POST /abrir crea la jornada y responde la ola inicial', async () => {
    const r = await request(appConUsuario('tester')).post('/api/jornada/abrir').send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.jornada.estado).toBe('abierta');
    expect(r.body.olaInicial.tipo).toBe('inicial');
  });

  it('POST /abrir sin usuario autenticado responde 401', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/jornada', jornadaRouter(db, {}));
    const r = await request(app).post('/api/jornada/abrir').send({});
    expect(r.status).toBe(401);
  });

  it('doble POST /abrir el mismo día responde 409 OPERATIONAL_DAY_EXISTS', async () => {
    const app = appConUsuario('tester');
    await request(app).post('/api/jornada/abrir').send({});
    const r2 = await request(app).post('/api/jornada/abrir').send({});
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('OPERATIONAL_DAY_EXISTS');
  });

  it('GET /hoy devuelve null antes de abrir y la jornada después', async () => {
    const app = appConUsuario('tester');
    const antes = await request(app).get('/api/jornada/hoy');
    expect(antes.body.jornada).toBeNull();
    await request(app).post('/api/jornada/abrir').send({});
    const despues = await request(app).get('/api/jornada/hoy');
    expect(despues.body.jornada.estado).toBe('abierta');
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: FAIL — las rutas no existen (404).

- [ ] **Step 3: Agregar las rutas a `routes/jornada.js`**

Reemplazar `jornadaRouter` en `routes/jornada.js`:

```js
import { abrirJornada, jornadaDeHoy } from '../lib/jornada.js';

export function jornadaRouter(db, cfg) {
  ensureTablesJornada(db);
  const router = express.Router();

  router.post('/abrir', (req, res) => {
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    const { horaCorteWeb = null, ventanaMlJson = null } = req.body || {};
    const r = abrirJornada(db, { usuario: req.user.username, horaCorteWeb, ventanaMlJson });
    if (!r.ok) return res.status(409).json({ ok: false, code: r.code, jornada: r.jornada });
    res.json({ ok: true, jornada: r.jornada, olaInicial: r.olaInicial });
  });

  router.get('/hoy', (req, res) => {
    res.json({ ok: true, jornada: jornadaDeHoy(db) });
  });

  return router;
}
```

- [ ] **Step 4: Montar el router en `server.js`**

Cerca de la línea 331 (`app.use('/api/preparacion', preparacionRouter(db, {...}))`), agregar el import (`import { jornadaRouter } from './routes/jornada.js';` junto a los demás imports de routers) y:

```js
app.use('/api/jornada', jornadaRouter(db, {}));
```

- [ ] **Step 5: Correr para verificar que pasa**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS, todos los tests del archivo.

- [ ] **Step 6: Commit**

```bash
cd /tmp/fusion-e1-current
git add routes/jornada.js server.js test/jornada.test.js
git commit -m "feat(jornada): endpoints POST /abrir y GET /hoy"
```

---

### Task 5: Claim de ola con aviso de vencimiento (`por_vencer`) y freeze atómico

**Files:**
- Modify: `lib/jornada.js`
- Modify: `routes/jornada.js`
- Test: `test/jornada.test.js`

**Interfaces:**
- Consumes: tabla `pick_wave_claims` (Task 2).
- Produces: `anotarVencimiento(claim, ahora = new Date(), avisoMs = 10 * 60 * 1000)` — `lib/jornada.js`. Agrega `por_vencer` y `segundos_restantes` a un objeto claim `{expires_at, ...}`.
- Produces: `reclamarOla(db, pickWaveId, usuario, { ttlMs = 15 * 60 * 1000 } = {}, now = new Date())` — `lib/jornada.js`. Devuelve `{ ok: true, claim, olaCongelada, olaNueva }` (si la ola era `mini`/`abierta`, la congela y abre una nueva del mismo `tipo='mini'`), o `{ ok: true, claim }` (si ya estaba `congelada`/`en_picking`, solo toma el claim sin re-congelar), o `{ ok: false, code: 'WAVE_CLAIMED', claim }`.
- Produces: ruta `POST /api/jornada/ola/:id/reclamar`.

- [ ] **Step 1: Escribir los tests (fallan, las funciones no existen)**

Agregar a `test/jornada.test.js`:

```js
import { anotarVencimiento, reclamarOla } from '../lib/jornada.js';

describe('anotarVencimiento', () => {
  it('por_vencer es false lejos del vencimiento y true dentro de los 10 minutos', () => {
    const claim = { expires_at: new Date('2026-09-01T12:15:00Z').toISOString() };
    const lejos = anotarVencimiento(claim, new Date('2026-09-01T12:00:00Z'));
    expect(lejos.por_vencer).toBe(false);
    expect(lejos.segundos_restantes).toBe(900);
    const cerca = anotarVencimiento(claim, new Date('2026-09-01T12:06:00Z'));
    expect(cerca.por_vencer).toBe(true);
    expect(cerca.segundos_restantes).toBe(540);
  });

  it('segundos_restantes nunca es negativo si ya venció', () => {
    const claim = { expires_at: new Date('2026-09-01T12:00:00Z').toISOString() };
    const r = anotarVencimiento(claim, new Date('2026-09-01T12:05:00Z'));
    expect(r.segundos_restantes).toBe(0);
    expect(r.por_vencer).toBe(true);
  });
});

describe('reclamarOla', () => {
  let db, dayId, waveId;
  beforeEach(() => {
    db = openDb(TEST_DB);
    ensureTablesJornada(db);
    const ts = new Date().toISOString();
    dayId = db.prepare(`INSERT INTO operational_days (fecha, estado, abierta_por, abierta_en) VALUES (?,?,?,?)`)
      .run('2026-09-01', 'abierta', 'tester', ts).lastInsertRowid;
    waveId = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
      .run(dayId, ts).lastInsertRowid;
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`).run(waveId, 'ml:1', ts);
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('congela la ola con exactamente sus items y abre una mini-ola nueva vacía', () => {
    const r = reclamarOla(db, waveId, 'op1');
    expect(r.ok).toBe(true);
    expect(r.olaCongelada.estado).toBe('en_picking');
    expect(r.olaNueva.tipo).toBe('mini');
    expect(r.olaNueva.estado).toBe('abierta');
    const itemsCongelados = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(r.olaCongelada.id);
    expect(itemsCongelados.map(i => i.pedido_clave)).toEqual(['ml:1']);
  });

  it('un pedido agregado después del claim cae en la ola nueva, no en la congelada', () => {
    const r = reclamarOla(db, waveId, 'op1');
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)`).run(r.olaNueva.id, 'web:2', ts);
    const enCongelada = db.prepare('SELECT COUNT(*) c FROM pick_wave_items WHERE pick_wave_id=? AND pedido_clave=?').get(r.olaCongelada.id, 'web:2').c;
    expect(enCongelada).toBe(0);
  });

  it('un segundo claim del mismo usuario mientras el primero sigue vigente no crea una segunda ola nueva', () => {
    const r1 = reclamarOla(db, waveId, 'op1');
    const r2 = reclamarOla(db, r1.olaCongelada.id, 'op1');
    expect(r2.ok).toBe(true);
    const totalOlas = db.prepare('SELECT COUNT(*) c FROM pick_waves WHERE operational_day_id=?').get(dayId).c;
    expect(totalOlas).toBe(2); // la congelada original + la nueva abierta por el primer claim, sin una tercera
  });

  it('claim de otro usuario mientras está vigente responde WAVE_CLAIMED', () => {
    reclamarOla(db, waveId, 'op1');
    const r2 = reclamarOla(db, waveId, 'op2');
    // la ola ya no está en estado 'abierta' tras el primer claim; el segundo reclamo sobre
    // la MISMA ola original ahora es sobre una ola en_picking tomada por op1.
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('WAVE_CLAIMED');
  });

  it('anota por_vencer/segundos_restantes en el claim devuelto', () => {
    const r = reclamarOla(db, waveId, 'op1', {}, new Date('2026-09-01T12:00:00Z'));
    expect(r.claim).toHaveProperty('por_vencer', false);
    expect(r.claim).toHaveProperty('segundos_restantes', 900);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: FAIL — `anotarVencimiento`/`reclamarOla` no existen.

- [ ] **Step 3: Implementar en `lib/jornada.js`**

Agregar al final de `lib/jornada.js`:

```js
const CLAIM_TTL_DEFAULT_MS = 15 * 60 * 1000;
const AVISO_VENCIMIENTO_MS = 10 * 60 * 1000;

export function anotarVencimiento(claim, ahora = new Date(), avisoMs = AVISO_VENCIMIENTO_MS) {
  const restanteMs = new Date(claim.expires_at).getTime() - ahora.getTime();
  return {
    ...claim,
    segundos_restantes: Math.max(0, Math.round(restanteMs / 1000)),
    por_vencer: restanteMs <= avisoMs,
  };
}

export function reclamarOla(db, pickWaveId, usuario, { ttlMs = CLAIM_TTL_DEFAULT_MS } = {}, now = new Date()) {
  const at = now.toISOString();
  const expires = new Date(now.getTime() + ttlMs).toISOString();

  const tx = db.transaction(() => {
    const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(pickWaveId);
    if (!ola) return { ok: false, code: 'WAVE_NOT_FOUND' };

    const claimActual = db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(pickWaveId);
    if (claimActual && claimActual.usuario !== usuario && claimActual.expires_at > at) {
      return { ok: false, code: 'WAVE_CLAIMED', claim: anotarVencimiento(claimActual, now) };
    }

    const claimedAt = claimActual && claimActual.usuario === usuario ? claimActual.claimed_at : at;
    if (claimActual) {
      db.prepare('UPDATE pick_wave_claims SET usuario=?, claimed_at=?, expires_at=?, renovado_en=? WHERE pick_wave_id=?')
        .run(usuario, claimedAt, expires, at, pickWaveId);
    } else {
      db.prepare('INSERT INTO pick_wave_claims (pick_wave_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)')
        .run(pickWaveId, usuario, claimedAt, expires, at);
    }
    const claim = anotarVencimiento({ usuario, claimed_at: claimedAt, expires_at: expires }, now);

    // Freeze solo la primera vez que esta ola pasa de 'abierta' a tomada — un segundo claim
    // del mismo usuario (renovación) sobre una ola ya 'en_picking' no debe volver a congelar
    // ni abrir una tercera ola.
    if (ola.estado !== 'abierta') {
      return { ok: true, claim, olaCongelada: ola };
    }

    db.prepare(`UPDATE pick_waves SET estado='en_picking', congelada_en=?, congelada_por=? WHERE id=?`)
      .run(at, usuario, pickWaveId);
    const olaCongelada = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(pickWaveId);

    let olaNueva = null;
    if (ola.tipo === 'mini') {
      const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
        .run(ola.operational_day_id, at);
      olaNueva = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(info.lastInsertRowid);
    }

    return { ok: true, claim, olaCongelada, olaNueva };
  });
  return tx();
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS, todos los tests del archivo.

- [ ] **Step 5: Agregar la ruta HTTP en `routes/jornada.js`**

```js
import { abrirJornada, jornadaDeHoy, reclamarOla } from '../lib/jornada.js';

// ... dentro de jornadaRouter, después de las rutas existentes:
router.post('/ola/:id/reclamar', (req, res) => {
  if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
  const r = reclamarOla(db, id, req.user.username);
  if (!r.ok) {
    const status = r.code === 'WAVE_NOT_FOUND' ? 404 : 409;
    return res.status(status).json({ ok: false, code: r.code, claim: r.claim || null });
  }
  res.json({ ok: true, claim: r.claim, olaCongelada: r.olaCongelada, olaNueva: r.olaNueva });
});
```

- [ ] **Step 6: Test HTTP para la ruta de reclamo**

Agregar a `test/jornada.test.js`, dentro de `describe('rutas /api/jornada', ...)`:

```js
it('POST /ola/:id/reclamar congela y devuelve olaNueva', async () => {
  const app = appConUsuario('op1');
  const abrir = await request(app).post('/api/jornada/abrir').send({});
  const waveId = abrir.body.olaInicial.id;
  const r = await request(app).post(`/api/jornada/ola/${waveId}/reclamar`).send({});
  expect(r.status).toBe(200);
  expect(r.body.claim).toHaveProperty('por_vencer');
});
```

- [ ] **Step 7: Correr todo el archivo para verificar que pasa**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS, archivo completo.

- [ ] **Step 8: Commit**

```bash
cd /tmp/fusion-e1-current
git add lib/jornada.js routes/jornada.js test/jornada.test.js
git commit -m "feat(jornada): claim de ola con freeze atómico y aviso de vencimiento"
```

---

### Task 6: Mini-ola acumulativa por reconciliación + mini-ola ML urgente

**Files:**
- Modify: `lib/jornada.js`
- Modify: `routes/jornada.js`
- Test: `test/jornada.test.js`

**Interfaces:**
- Consumes: `pedidosElegiblesOrdenados(db)` (Task 1), `jornadaDeHoy(db, now)` (Task 3).
- Produces: `sincronizarMiniOlas(db, now = new Date())` — `lib/jornada.js`. Para la jornada de hoy (si existe y está `abierta`): a) cualquier pedido elegible que NO esté todavía en `pick_wave_items` de ningún wave del día se agrega; b) si el pedido es ML urgente (canal ml/espejo_ml=1 y `fecha_despacho` = fecha local de hoy), se crea una `ml_urgente` propia y congelada al toque para ese pedido; c) el resto va a la `mini` `abierta` (se crea si no hay ninguna). Devuelve `{ ok: true, agregados: number }` o `{ ok: true, agregados: 0, motivo: 'sin_jornada_abierta' }` si no hay jornada abierta hoy.
- Produces: ruta `GET /api/jornada/olas` — llama primero a `sincronizarMiniOlas` y después lista las olas del día con sus items.

**Nota de diseño (no estaba en el spec original, decisión tomada al implementar — permitida explícitamente por la sección "Riesgos / decisiones que toma quien implementar" del spec):** en vez de enganchar la inserción a `syncPedidosCache` (cron cada 5 min, archivo grande y sensible), la reconciliación se hace en el momento en que se lee/reclama el estado de las olas. Es idempotente (el índice único de `pick_wave_items.pedido_clave` lo garantiza) y no requiere tocar el sync existente.

- [ ] **Step 1: Escribir los tests**

Agregar a `test/jornada.test.js`:

```js
import { sincronizarMiniOlas } from '../lib/jornada.js';

describe('sincronizarMiniOlas', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DB);
    ensureTablesJornada(db);
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
      clave TEXT PRIMARY KEY, canal TEXT NOT NULL, wc_order_id INTEGER, ml_order_id TEXT,
      numero_pedido TEXT, comprador TEXT, fecha TEXT, fecha_despacho TEXT, estado_envio TEXT NOT NULL,
      estado_wc TEXT, espejo_ml INTEGER NOT NULL DEFAULT 0, logistic_type TEXT,
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL
    )`).run();
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  function insertarPedido(clave, canal, { espejo_ml = 0, fecha_despacho = null } = {}) {
    db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, comprador, fecha, fecha_despacho, estado_envio, espejo_ml, items_json, actualizado_en)
      VALUES (?,?,?,?,?,?,'pendiente',?,'[]',?)`)
      .run(clave, canal, clave, 'Cliente', new Date().toISOString(), fecha_despacho, espejo_ml, new Date().toISOString());
  }

  it('sin jornada abierta hoy, no hace nada', () => {
    const r = sincronizarMiniOlas(db, new Date('2026-09-01T12:00:00Z'));
    expect(r).toEqual({ ok: true, agregados: 0, motivo: 'sin_jornada_abierta' });
  });

  it('agrega pedidos web/ml no urgentes a una única mini-ola abierta', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('web:1', 'web');
    insertarPedido('web:2', 'web');
    const r = sincronizarMiniOlas(db, now);
    expect(r.agregados).toBe(2);
    const minis = db.prepare("SELECT * FROM pick_waves WHERE tipo='mini' AND estado='abierta'").all();
    expect(minis).toHaveLength(1);
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(minis[0].id);
    expect(items.map(i => i.pedido_clave).sort()).toEqual(['web:1', 'web:2']);
  });

  it('un pedido ML con fecha_despacho de hoy crea su propia mini-ola ml_urgente congelada', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('ml:1', 'ml', { fecha_despacho: fechaLocalHoy(now) });
    sincronizarMiniOlas(db, now);
    const urgente = db.prepare("SELECT * FROM pick_waves WHERE tipo='ml_urgente'").get();
    expect(urgente).toBeTruthy();
    expect(urgente.estado).toBe('congelada');
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(urgente.id);
    expect(items.map(i => i.pedido_clave)).toEqual(['ml:1']);
  });

  it('un pedido ML con fecha_despacho de mañana NO es urgente, cae en la mini-ola acumulativa', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('ml:2', 'ml', { fecha_despacho: '2026-09-02' });
    sincronizarMiniOlas(db, now);
    const urgente = db.prepare("SELECT * FROM pick_waves WHERE tipo='ml_urgente'").get();
    expect(urgente).toBeUndefined();
    const mini = db.prepare("SELECT * FROM pick_waves WHERE tipo='mini' AND estado='abierta'").get();
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(mini.id);
    expect(items.map(i => i.pedido_clave)).toEqual(['ml:2']);
  });

  it('llamar dos veces seguidas no duplica items (idempotente)', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    insertarPedido('web:1', 'web');
    sincronizarMiniOlas(db, now);
    const r2 = sincronizarMiniOlas(db, now);
    expect(r2.agregados).toBe(0);
    const total = db.prepare('SELECT COUNT(*) c FROM pick_wave_items').get().c;
    expect(total).toBe(1);
  });

  it('un pedido ya incluido en la ola inicial no se vuelve a agregar a la mini-ola', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    insertarPedido('web:1', 'web');
    abrirJornada(db, { usuario: 'tester' }, now); // web:1 entra en la inicial
    const r = sincronizarMiniOlas(db, now);
    expect(r.agregados).toBe(0);
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: FAIL — `sincronizarMiniOlas` no existe.

- [ ] **Step 3: Implementar en `lib/jornada.js`**

Agregar al final:

```js
function pedidoEsMlUrgente(pedido, fechaHoy) {
  const esMl = pedido.canal === 'ml' || Number(pedido.espejo_ml) === 1;
  return esMl && pedido.fecha_despacho === fechaHoy;
}

export function sincronizarMiniOlas(db, now = new Date()) {
  const jornada = jornadaDeHoy(db, now);
  if (!jornada || jornada.estado !== 'abierta') {
    return { ok: true, agregados: 0, motivo: 'sin_jornada_abierta' };
  }
  const at = now.toISOString();
  const fechaHoy = fechaLocalHoy(now);

  const tx = db.transaction(() => {
    const yaAsignados = new Set(
      db.prepare(`SELECT pi.pedido_clave FROM pick_wave_items pi
        JOIN pick_waves pw ON pw.id = pi.pick_wave_id
        WHERE pw.operational_day_id = ?`).all(jornada.id).map(r => r.pedido_clave)
    );
    const pendientes = pedidosElegiblesOrdenados(db).filter(p => !yaAsignados.has(p.clave));
    if (pendientes.length === 0) return 0;

    let miniAbierta = db.prepare(
      "SELECT * FROM pick_waves WHERE operational_day_id=? AND tipo='mini' AND estado='abierta'"
    ).get(jornada.id);

    let agregados = 0;
    for (const pedido of pendientes) {
      if (pedidoEsMlUrgente(pedido, fechaHoy)) {
        const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en, congelada_en) VALUES (?,'ml_urgente','congelada',?,?)`)
          .run(jornada.id, at, at);
        db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)')
          .run(info.lastInsertRowid, pedido.clave, at);
        agregados += 1;
        continue;
      }
      if (!miniAbierta) {
        const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
          .run(jornada.id, at);
        miniAbierta = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(info.lastInsertRowid);
      }
      db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en) VALUES (?,?,?)')
        .run(miniAbierta.id, pedido.clave, at);
      agregados += 1;
    }
    return agregados;
  });
  return { ok: true, agregados: tx() };
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS, todos los tests del archivo.

- [ ] **Step 5: Agregar `GET /olas` en `routes/jornada.js`**

```js
import { abrirJornada, jornadaDeHoy, reclamarOla, sincronizarMiniOlas } from '../lib/jornada.js';

// dentro de jornadaRouter:
router.get('/olas', (req, res) => {
  sincronizarMiniOlas(db);
  const jornada = jornadaDeHoy(db);
  if (!jornada) return res.json({ ok: true, jornada: null, olas: [] });
  const olas = db.prepare('SELECT * FROM pick_waves WHERE operational_day_id=? ORDER BY id').all(jornada.id)
    .map(ola => ({
      ...ola,
      items: db.prepare('SELECT pedido_clave, agregado_en FROM pick_wave_items WHERE pick_wave_id=?').all(ola.id),
    }));
  res.json({ ok: true, jornada, olas });
});
```

- [ ] **Step 6: Test HTTP para `GET /olas`**

Agregar a `test/jornada.test.js`:

```js
it('GET /olas sincroniza y devuelve las olas del día con sus items', async () => {
  const app = appConUsuario('tester');
  await request(app).post('/api/jornada/abrir').send({});
  db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, comprador, fecha, estado_envio, espejo_ml, items_json, actualizado_en)
    VALUES ('web:9','web','9','Cliente',?,'pendiente',0,'[]',?)`).run(new Date().toISOString(), new Date().toISOString());
  const r = await request(app).get('/api/jornada/olas');
  expect(r.status).toBe(200);
  const mini = r.body.olas.find(o => o.tipo === 'mini');
  expect(mini.items.map(i => i.pedido_clave)).toEqual(['web:9']);
});
```

- [ ] **Step 7: Correr todo el archivo**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS, archivo completo.

- [ ] **Step 8: Commit**

```bash
cd /tmp/fusion-e1-current
git add lib/jornada.js routes/jornada.js test/jornada.test.js
git commit -m "feat(jornada): mini-ola acumulativa por reconciliación y mini-ola ml_urgente"
```

---

### Task 7: Cierre de jornada y anotación de `pick_wave_id` en `GET /pendientes`

**Files:**
- Modify: `lib/jornada.js`
- Modify: `routes/jornada.js`
- Modify: `routes/preparacion.js` (agregar `pick_wave_id`/`pick_wave_tipo` a la respuesta de `/pendientes`, sin cambiar el orden ni el resto del contrato)
- Modify: `docs/api-contrato.md` (documentar los campos nuevos y los endpoints de jornada)
- Test: `test/jornada.test.js`, `test/preparacion.test.js`

**Interfaces:**
- Produces: `cerrarJornada(db, usuario, now = new Date())` — `lib/jornada.js`. Solo permitido si hay jornada `abierta` hoy; no exige completar nada (maestro §2.2: "pendientes se arrastran con alerta"). Devuelve `{ ok: true, jornada }` o `{ ok: false, code: 'NO_OPEN_DAY' }`.
- Produces: ruta `POST /api/jornada/cerrar` — requiere `is_admin` o el mismo criterio de permiso de supervisor/despacho que ya usa el resto de este router (usar `req.user?.is_admin` como gate mínimo consistente con lo ya presente en el proyecto; no se introduce un rol nuevo en este plan).

- [ ] **Step 1: Escribir los tests de `cerrarJornada`**

Agregar a `test/jornada.test.js`:

```js
import { cerrarJornada } from '../lib/jornada.js';

describe('cerrarJornada', () => {
  let db;
  beforeEach(() => {
    db = openDb(TEST_DB);
    ensureTablesJornada(db);
    db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
      clave TEXT PRIMARY KEY, canal TEXT NOT NULL, wc_order_id INTEGER, ml_order_id TEXT,
      numero_pedido TEXT, comprador TEXT, fecha TEXT, fecha_despacho TEXT, estado_envio TEXT NOT NULL,
      estado_wc TEXT, espejo_ml INTEGER NOT NULL DEFAULT 0, logistic_type TEXT,
      substatus TEXT, items_json TEXT NOT NULL, actualizado_en TEXT NOT NULL
    )`).run();
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('cierra la jornada abierta y no exige olas completadas', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    abrirJornada(db, { usuario: 'tester' }, now);
    const r = cerrarJornada(db, 'supervisor', now);
    expect(r.ok).toBe(true);
    expect(r.jornada.estado).toBe('cerrada');
    expect(r.jornada.cerrada_por).toBe('supervisor');
  });

  it('sin jornada abierta hoy responde NO_OPEN_DAY', () => {
    const r = cerrarJornada(db, 'supervisor', new Date('2026-09-01T12:00:00Z'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_OPEN_DAY');
  });
});
```

- [ ] **Step 2: Correr para verificar que falla**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: FAIL — `cerrarJornada` no existe.

- [ ] **Step 3: Implementar `cerrarJornada` en `lib/jornada.js`**

```js
export function cerrarJornada(db, usuario, now = new Date()) {
  const jornada = jornadaDeHoy(db, now);
  if (!jornada || jornada.estado !== 'abierta') return { ok: false, code: 'NO_OPEN_DAY' };
  const at = now.toISOString();
  db.prepare('UPDATE operational_days SET estado=?, cerrada_por=?, cerrada_en=? WHERE id=?')
    .run('cerrada', usuario, at, jornada.id);
  return { ok: true, jornada: db.prepare('SELECT * FROM operational_days WHERE id=?').get(jornada.id) };
}
```

- [ ] **Step 4: Correr para verificar que pasa**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js --reporter=dot`
Expected: PASS.

- [ ] **Step 5: Ruta `POST /cerrar` en `routes/jornada.js`**

```js
import { abrirJornada, jornadaDeHoy, reclamarOla, sincronizarMiniOlas, cerrarJornada } from '../lib/jornada.js';

// dentro de jornadaRouter:
router.post('/cerrar', (req, res) => {
  if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
  if (!req.user.is_admin) return res.status(403).json({ ok: false, error: 'Requiere permiso de supervisor/despacho', code: 'FORBIDDEN' });
  const r = cerrarJornada(db, req.user.username);
  if (!r.ok) return res.status(409).json({ ok: false, code: r.code });
  res.json({ ok: true, jornada: r.jornada });
});
```

- [ ] **Step 6: Test HTTP para `/cerrar`**

Agregar a `test/jornada.test.js`:

```js
it('POST /cerrar requiere is_admin y cierra la jornada', async () => {
  const appNoAdmin = express();
  appNoAdmin.use(express.json());
  appNoAdmin.use((req, _res, next) => { req.user = { username: 'op1', is_admin: 0 }; next(); });
  appNoAdmin.use('/api/jornada', jornadaRouter(db, {}));
  const noPermitido = await request(appNoAdmin).post('/api/jornada/cerrar').send({});
  expect(noPermitido.status).toBe(403);

  const appAdmin = appConUsuario('supervisor');
  await request(appAdmin).post('/api/jornada/abrir').send({});
  const r = await request(appAdmin).post('/api/jornada/cerrar').send({});
  expect(r.status).toBe(200);
  expect(r.body.jornada.estado).toBe('cerrada');
});
```

- [ ] **Step 7: Anotar `pick_wave_id`/`pick_wave_tipo` en `GET /api/preparacion/pendientes`**

En `routes/preparacion.js`, importar `sincronizarMiniOlas` y `pedidosElegiblesOrdenados` ya está importado desde Task 1. Agregar el import: `import { sincronizarMiniOlas } from '../lib/jornada.js';`. Dentro de `router.get('/pendientes', ...)`, antes de armar `data`, llamar `sincronizarMiniOlas(db)` (envuelto en try/catch para no romper la lectura de pendientes si la jornada no está abierta o algo falla — fail-open, es metadata auxiliar, igual que el patrón ya usado en `registrarEvento` con `failClosed=false`):

```js
try { sincronizarMiniOlas(db); } catch (e) { console.error('[preparacion] error sincronizando mini-olas:', e.message); }
```

Y en cada objeto devuelto en `.map(({ row, prep }) => {...})`, agregar antes de cerrar el objeto:

```js
const waveItem = db.prepare(`SELECT pw.id, pw.tipo FROM pick_wave_items pi JOIN pick_waves pw ON pw.id = pi.pick_wave_id WHERE pi.pedido_clave = ?`).get(row.clave);
```

y sumar `pick_wave_id: waveItem?.id || null, pick_wave_tipo: waveItem?.tipo || null` a ambos objetos de retorno (`canal:'web'` y `canal:'ml'`).

- [ ] **Step 8: Test de regresión en `test/preparacion.test.js`**

Agregar cerca de los tests existentes de `/pendientes`:

```js
it('/pendientes incluye pick_wave_id y pick_wave_tipo cuando hay jornada abierta', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'tester', is_admin: 1 }; next(); });
  app.use('/api/jornada', jornadaRouter(db, {}));
  app.use('/api/preparacion', preparacionRouter(db, { woo: {}, ml: {}, colaFotos: { disparoInmediato: false } }));
  await request(app).post('/api/jornada/abrir').send({});
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO pedidos_cache (clave, canal, wc_order_id, numero_pedido, comprador, fecha, estado_envio, espejo_ml, items_json, actualizado_en)
    VALUES ('web:77', 'web', 77, '77', 'Cliente', ?, 'pendiente', 0, '[]', ?)`).run(ts, ts);
  const r = await request(app).get('/api/preparacion/pendientes');
  const fila = r.body.data.find(d => d.wc_order_id === 77);
  expect(fila.pick_wave_tipo).toBe('mini');
  expect(fila.pick_wave_id).toEqual(expect.any(Number));
});
```

Agregar el import `import { jornadaRouter } from '../routes/jornada.js';` al inicio de `test/preparacion.test.js` si no está.

- [ ] **Step 9: Correr ambos archivos**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js test/preparacion.test.js --reporter=dot`
Expected: PASS en ambos archivos, sin regresiones en los tests preexistentes de `/pendientes`.

- [ ] **Step 10: Documentar en `docs/api-contrato.md`**

Agregar una sección nueva después de la que ya documenta `GET /api/preparacion/pendientes` (cerca de la línea 956, ver el commit `026a116` de esta misma rama):

```markdown
### GET/POST /api/jornada/* (E1: apertura, ola y mini-olas)

- `POST /api/jornada/abrir` — requiere sesión. 200 con `{jornada, olaInicial}`; 409
  `OPERATIONAL_DAY_EXISTS` con `{jornada}` si ya se abrió hoy (fecha local Buenos Aires).
- `GET /api/jornada/hoy` — `{jornada: null}` si no se abrió.
- `GET /api/jornada/olas` — sincroniza mini-olas y devuelve `{jornada, olas: [{...pick_wave, items}]}`.
- `POST /api/jornada/ola/:id/reclamar` — requiere sesión. Congela la ola (si estaba
  `abierta`) y abre una mini-ola nueva si correspondía. 200 con `{claim, olaCongelada,
  olaNueva}`; `claim` incluye `por_vencer`/`segundos_restantes`. 409 `WAVE_CLAIMED` si otro
  usuario la tiene tomada.
- `POST /api/jornada/cerrar` — requiere `is_admin`. No exige olas completadas (maestro §2.2).

`GET /api/preparacion/pendientes` ahora suma `pick_wave_id`/`pick_wave_tipo` (`null` si
todavía no hay jornada abierta hoy) a cada fila de `data`, sin alterar el orden ya
documentado arriba.
```

- [ ] **Step 11: Commit**

```bash
cd /tmp/fusion-e1-current
git add lib/jornada.js routes/jornada.js routes/preparacion.js docs/api-contrato.md test/jornada.test.js test/preparacion.test.js
git commit -m "feat(jornada): cierre de jornada y pick_wave_id/tipo en /pendientes"
```

---

### Task 8: Corrida final del archivo de tests de la entrega y actualización de la ficha E1

**Files:**
- Modify: `docs/superpowers/deliveries/E1.md`

- [ ] **Step 1: Correr los dos archivos de test de la entrega juntos**

Run: `cd /tmp/fusion-e1-current && npx vitest run test/jornada.test.js test/preparacion.test.js --reporter=dot`
Expected: PASS, todos verdes. Anotar el conteo exacto y la duración para la ficha.

- [ ] **Step 2: Actualizar `docs/superpowers/deliveries/E1.md`**

Actualizar "Estado y evidencia actual" para reflejar que apertura/ola inicial/mini-olas/mini-ola ml_urgente/claim con aviso quedaron implementados y con tests unitarios/integración verdes en el worktree, pero SIN revisión independiente todavía, SIN suite global corrida, SIN UI, SIN piloto ni jornada observada — sigue en `desarrollo`, no pasa a `candidata` hasta el gate del maestro (§20). Actualizar "Tests exactos" con el comando y resultado exacto del Step 1. Actualizar "Próxima acción reproducible" a: "Revisión independiente de este cambio (routes/jornada.js, lib/jornada.js, extracción en lib/preparacion.js); si aprueba, correr la suite global serial una sola vez y evaluar si el panel de preparación (UI) necesita mostrar jornada/olas antes de pilotar, o si el piloto arranca solo por API mientras se diseña la UI."

No marcar ningún gate como cumplido que no se haya ejecutado realmente (regla del maestro §17: "código existente no equivale a entrega terminada").

- [ ] **Step 3: Commit**

```bash
cd /tmp/fusion-e1-current
git add docs/superpowers/deliveries/E1.md
git commit -m "docs(e1): registrar implementación de apertura/ola/mini-ola, pendiente de revisión"
```
