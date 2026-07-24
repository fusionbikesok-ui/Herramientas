# Caché local de pedidos para Preparación de Pedidos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar las llamadas en vivo a WooCommerce/MercadoLibre en `GET
/pendientes` por lectura de una tabla local `pedidos_cache`, sincronizada por un único
cron cada 5 minutos; extender `GET /historial` para incluir pedidos ya enviados que nunca
se prepararon en la app; y ajustar el frontend para reflejar la nueva fuente de datos
(carga instantánea, aviso de frescura, botón "Completar ahora" para pedidos históricos sin
preparar).

**Architecture:** Node/Express ESM + better-sqlite3 en backend; HTML/JS plano en
`public/preparacion/`. Un único sync (`syncPedidosCache`), un único cron, siguiendo el
patrón ya existente de `routes/sync.js` (candado en memoria, `sync_log` para "última
corrida exitosa", `node-cron` registrado en `server.js`).

**Tech Stack:** Express, better-sqlite3, vitest, `node-cron` (ya en el proyecto).

## Global Constraints

- Contenido y comentarios en español.
- No tocar `.env`, `data/`, `uploads/`, `*.db`, `*.sqlite`.
- `hard-worker-backend` es dueño de `routes/`, `server.js`, `lib/`; `hard-worker-frontend`
  es dueño de `public/`.
- **Un solo sync, un solo cron** (decisión ya revisada en el spec): NO crear dos crons
  separados para "pendientes" y "enviados" — es la misma llamada a los mismos endpoints
  externos con distinto filtro de `status`, se hace en una sola función/una sola corrida.
- El endpoint `POST /iniciar` **no se modifica** — sigue haciendo fetch en vivo del pedido
  puntual (acción explícita del usuario, poco frecuente).
- **`test/preparacion-contrato.test.js` fija el contrato de forma del `GET /pendientes`**
  (comentario en el propio archivo: "Deben seguir en verde... después del refactor"). Las
  claves exactas de la respuesta (`canal, comprador, espejo_ml, estado_preparacion,
  estado_wc, etiqueta_lista, fecha, items, numero_pedido, preparacion_id, wc_order_id` para
  web; `canal, comprador, estado_preparacion, fecha, items, logistic_type, ml_order_id,
  numero_pedido, preparacion_id, substatus, wc_order_id` para ml) **no cambian**. Lo que sí
  cambia necesariamente es el MÉTODO de setup de ese test: hoy mockea `wooFetch`/`mlFetch`
  porque el endpoint los llama en vivo; tras este plan, el endpoint ya no los llama (lee de
  `pedidos_cache`), así que el test debe sembrar `pedidos_cache` directamente en vez de
  mockear las APIs. Esto es un cambio de setup esperado y justificado, no una regresión —
  las aserciones sobre la forma de la respuesta se mantienen idénticas.
- Al final de cada tarea que toque `routes/`/`server.js`, correr `npm test` y confirmar
  que la suite completa sigue verde.

---

## Task 1: Tabla `pedidos_cache` + función `syncPedidosCache`

**Files:**
- Modify: `routes/preparacion.js` (agregar tabla, función de sync, candado, log)
- Test: `test/preparacion.test.js` (agregar tests de `syncPedidosCache`)

**Interfaces:**
- Produces: `syncPedidosCache(db, cfg)` — función async exportada, upsert en
  `pedidos_cache`. `cfg` tiene la misma forma que ya recibe `preparacionRouter` (`{ woo,
  ml, andreaniStatus, enviadoAndreaniStatus }`).
- Consumes: `wooFetch` (de `routes/woo.js`), `mlFetch` (de `lib/mlClient.js`),
  `armarPendienteWeb`/`itemsDesdeOrdenMl`/`esEnvioLocal` (ya existentes en el propio
  `routes/preparacion.js`/`lib/preparacion.js`, sin cambios de firma).

- [ ] **Step 1: Escribir el test que falla**

En `test/preparacion.test.js`, agregar al final del archivo (siguiendo el patrón de mocks
de `test/preparacion-contrato.test.js` — hace falta agregar los mismos `vi.mock` al tope
de este archivo si no están ya; verificar antes de duplicar):

```javascript
// Agregar al tope del archivo, junto al vi.mock('heic-convert', ...) ya existente:
vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});
vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));
```

Y al final del archivo:

```javascript
import { wooFetch } from '../routes/woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { syncPedidosCache } from '../routes/preparacion.js';

describe('syncPedidosCache', () => {
  let db;
  const CFG = {
    woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
    ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
    andreaniStatus: 'lpaandreani',
    enviadoAndreaniStatus: 'enviadoandreani',
  };

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('guarda en pedidos_cache un pedido web pendiente (lpaandreani) con estado_envio=pendiente', async () => {
    const orderPend = {
      id: 900, number: '900', status: 'lpaandreani', date_created: '2026-07-01T00:00:00Z',
      billing: { first_name: 'Juan', last_name: 'Perez' }, meta_data: [],
      line_items: [{ id: 1, product_id: 501, variation_id: 0, sku: 'BIKE-1', name: 'Bici', quantity: 1 }],
    };
    wooFetch
      .mockResolvedValueOnce({ data: [orderPend] })  // status=lpaandreani
      .mockResolvedValueOnce({ data: [] })            // status=completed
      .mockResolvedValueOnce({ data: [] });           // status=enviadoandreani
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } }); // pendientesMl (paid)

    await syncPedidosCache(db, CFG);

    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('web:900');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('pendiente');
    expect(row.canal).toBe('web');
    expect(row.numero_pedido).toBe('900');
    expect(JSON.parse(row.items_json)).toHaveLength(1);
  });

  it('guarda en pedidos_cache un pedido web ya enviado (completed) con estado_envio=enviado', async () => {
    const orderEnv = {
      id: 950, number: '950', status: 'completed', date_created: '2026-07-05T00:00:00Z',
      billing: { first_name: 'Ana', last_name: 'Gomez' }, meta_data: [],
      line_items: [{ id: 2, product_id: 502, variation_id: 0, sku: 'CASCO-1', name: 'Casco', quantity: 1 }],
    };
    wooFetch
      .mockResolvedValueOnce({ data: [] })            // status=lpaandreani
      .mockResolvedValueOnce({ data: [orderEnv] })    // status=completed
      .mockResolvedValueOnce({ data: [] });           // status=enviadoandreani
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const row = db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get('web:950');
    expect(row).toBeTruthy();
    expect(row.estado_envio).toBe('enviado');
  });

  it('no duplica candado: si ya hay una corrida en curso, la segunda llamada no hace fetch', async () => {
    wooFetch.mockImplementation(() => new Promise(() => {})); // nunca resuelve, simula corrida larga
    const p1 = syncPedidosCache(db, CFG);
    await syncPedidosCache(db, CFG); // debe retornar de inmediato sin llamar wooFetch de nuevo
    expect(wooFetch).toHaveBeenCalledTimes(1);
    // no esperamos p1 (queda colgada a propósito); el test solo verifica el candado
  });

  it('registra el resultado en sync_log con direccion=pedidos_cache', async () => {
    wooFetch.mockResolvedValue({ data: [] });
    mlFetch.mockResolvedValueOnce({ status: 200, data: { results: [] } });

    await syncPedidosCache(db, CFG);

    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log).toBeTruthy();
    expect(log.estado).toBe('ok');
  });

  it('si wooFetch falla, registra error en sync_log y no revienta el proceso', async () => {
    wooFetch.mockRejectedValueOnce(new Error('WC caído'));

    await expect(syncPedidosCache(db, CFG)).rejects.toThrow('WC caído');

    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1").get();
    expect(log.estado).toBe('error');
    expect(log.error).toContain('WC caído');
  });
});
```

- [ ] **Step 2: Correr los tests para confirmar que fallan**

Run: `npx vitest run test/preparacion.test.js -t "syncPedidosCache"`
Expected: FAIL — `syncPedidosCache is not a function` o similar (no existe todavía).

- [ ] **Step 3: Agregar la tabla `pedidos_cache` a `ensureTables`**

En `routes/preparacion.js`, dentro de `ensureTables(db)` (después del bloque de
`preparacion_perfiles` y su seed, antes del cierre de la función), agregar:

```javascript
  db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
    clave           TEXT PRIMARY KEY,
    canal           TEXT NOT NULL,
    wc_order_id     INTEGER,
    ml_order_id     TEXT,
    numero_pedido   TEXT,
    comprador       TEXT,
    fecha           TEXT,
    estado_envio    TEXT NOT NULL,
    estado_wc       TEXT,
    espejo_ml       INTEGER NOT NULL DEFAULT 0,
    logistic_type   TEXT,
    substatus       TEXT,
    items_json      TEXT NOT NULL,
    actualizado_en  TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pedidos_cache_estado ON pedidos_cache(estado_envio)').run();
```

- [ ] **Step 4: Implementar `syncPedidosCache` y sus helpers**

Agregar al final de `routes/preparacion.js`, antes del `export function preparacionRouter`
o después (no importa el orden relativo, pero debe estar en el mismo módulo para acceder a
`armarPendienteWeb`/`itemsDesdeOrdenMl`/`ensureTables`/`now` ya definidos arriba en el
archivo):

```javascript
// ─── Caché local de pedidos (para GET /pendientes y GET /historial) ──────────

let _pedidosCacheEnCurso = false;

function logSyncPedidos(db, estado, error) {
  db.prepare(`
    INSERT INTO sync_log (direccion, clave, sku, cant_anterior, cant_nueva, estado, error, intentos, creado_en, actualizado_en)
    VALUES ('pedidos_cache', NULL, NULL, NULL, NULL, ?, ?, 0, ?, ?)
  `).run(estado, error ?? null, now(), now());
}

function upsertPedidoCache(db, row) {
  db.prepare(`
    INSERT INTO pedidos_cache
      (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha,
       estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
    VALUES (@clave, @canal, @wc_order_id, @ml_order_id, @numero_pedido, @comprador, @fecha,
       @estado_envio, @estado_wc, @espejo_ml, @logistic_type, @substatus, @items_json, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      numero_pedido=excluded.numero_pedido, comprador=excluded.comprador, fecha=excluded.fecha,
      estado_envio=excluded.estado_envio, estado_wc=excluded.estado_wc, espejo_ml=excluded.espejo_ml,
      logistic_type=excluded.logistic_type, substatus=excluded.substatus,
      items_json=excluded.items_json, actualizado_en=excluded.actualizado_en
  `).run(row);
}

// Un pedido WC (de cualquiera de los 3 estados relevantes) → fila de pedidos_cache.
function filaWebDesdeOrder(db, order, estadoEnvio) {
  const pend = armarPendienteWeb(db, order); // reusa el enriquecido de ítems/comprador ya existente
  return {
    clave: `web:${order.id}`,
    canal: 'web',
    wc_order_id: order.id,
    ml_order_id: null,
    numero_pedido: pend.numero_pedido,
    comprador: pend.comprador,
    fecha: pend.fecha,
    estado_envio: estadoEnvio,
    estado_wc: pend.estado_wc,
    espejo_ml: pend.espejo_ml ? 1 : 0,
    logistic_type: null,
    substatus: null,
    items_json: JSON.stringify(pend.items),
    actualizado_en: now(),
  };
}

export async function syncPedidosCache(db, cfg) {
  ensureTables(db);
  if (_pedidosCacheEnCurso) return;
  _pedidosCacheEnCurso = true;
  try {
    const andreaniStatus = cfg?.andreaniStatus || 'lpaandreani';
    const enviadoAndreaniStatus = cfg?.enviadoAndreaniStatus || 'enviadoandreani';

    // WooCommerce: 3 llamadas, una por estado relevante (mismo endpoint /orders que ya
    // usaban /pendientes, /etiquetas y /seguimientos por separado — acá se hace una sola
    // vez para las 3, en una única función/único cron).
    const [wcPend, wcCompleted, wcEnviado] = await Promise.all([
      wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`),
      wooFetch(cfg.woo, '/orders?status=completed&per_page=100'),
      wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(enviadoAndreaniStatus)}&per_page=100`),
    ]);

    const tx = db.transaction(() => {
      for (const order of wcPend.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'pendiente'));
      for (const order of wcCompleted.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'enviado'));
      for (const order of wcEnviado.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'enviado'));
    });
    tx();

    // MercadoLibre: reusa pendientesMl (ya filtra paid+ready_to_ship+local) para pendientes.
    // Los "enviados" de ML quedan fuera de este alcance (no hay filtro de shipped simple
    // sin otro GET por shipment; el historial de enviados ML se cubre desde el lado Woo,
    // que ya refleja el pedido cuando se cargó el tracking en el tab Seguimientos).
    try {
      const mlPend = await pendientesMl(db, cfg.ml);
      const txMl = db.transaction(() => {
        for (const p of mlPend) {
          upsertPedidoCache(db, {
            clave: `ml:${p.ml_order_id}`,
            canal: 'ml',
            wc_order_id: p.wc_order_id,
            ml_order_id: p.ml_order_id,
            numero_pedido: p.numero_pedido,
            comprador: p.comprador,
            fecha: p.fecha,
            estado_envio: 'pendiente',
            estado_wc: null,
            espejo_ml: 0,
            logistic_type: p.logistic_type,
            substatus: p.substatus,
            items_json: JSON.stringify(p.items),
            actualizado_en: now(),
          });
        }
      });
      txMl();
    } catch (eMl) {
      // ML tolerante a fallas (igual que hoy en GET /pendientes): no aborta el sync de Woo.
      logSyncPedidos(db, 'error', `ML: ${eMl.message}`);
      return;
    }

    logSyncPedidos(db, 'ok', null);
  } catch (e) {
    logSyncPedidos(db, 'error', e.message);
    throw e;
  } finally {
    _pedidosCacheEnCurso = false;
  }
}
```

Nota: `pendientesMl` ya está definida más abajo en el archivo (línea ~677 del estado
actual) — como es una función del mismo módulo, el orden de declaración no importa en
JavaScript por hoisting de `function`, pero si el linter se queja, mover
`syncPedidosCache` después de `pendientesMl` en el archivo.

- [ ] **Step 5: Correr los tests para confirmar que pasan**

Run: `npx vitest run test/preparacion.test.js -t "syncPedidosCache"`
Expected: PASS — 5 tests verdes.

- [ ] **Step 6: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa, sin romper `test/preparacion.test.js` ni
`test/preparacion-contrato.test.js` (ese archivo se ajusta en la Task 3, todavía no debería
verse afectado porque el endpoint `/pendientes` no cambió en esta tarea).

- [ ] **Step 7: Commit**

```bash
git add routes/preparacion.js test/preparacion.test.js
git commit -m "Agregar tabla pedidos_cache y función syncPedidosCache"
```

---

## Task 2: Registrar el cron en `server.js`

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `syncPedidosCache` (Task 1).

- [ ] **Step 1: Importar la función**

En `server.js`, ubicar la línea `import { preparacionRouter } from './routes/preparacion.js';`
(línea 24) y reemplazarla por:

```javascript
import { preparacionRouter, syncPedidosCache } from './routes/preparacion.js';
```

- [ ] **Step 2: Registrar el cron**

Ubicar el bloque de `cron.schedule` existentes (líneas 156-179 del estado actual, el
último es `procesarCancelacionesMl`). Agregar, después del último `cron.schedule(...)` y
antes de `const port = process.env.PORT || 3001;`:

```javascript
    cron.schedule('*/5 * * * *', () => {
      syncPedidosCache(app._db, {
        woo: wooCfg, ml: mlCfg,
        andreaniStatus: process.env.ANDREANI_ORDER_STATUS || 'lpaandreani',
        enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
      }).catch(err => console.error('Error sincronizando pedidos_cache:', err.message));
    });
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check server.js`
Expected: sin salida (sintaxis válida).

- [ ] **Step 4: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa (este cambio no se ejecuta en modo test, ver el guard
`process.argv[1] === ...` que ya envuelve todos los `cron.schedule` existentes).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Registrar cron de sync de pedidos_cache cada 5 minutos"
```

---

## Task 3: Adaptar `GET /pendientes` y `GET /historial` a la caché

**Files:**
- Modify: `routes/preparacion.js`
- Modify: `test/preparacion-contrato.test.js` (cambiar el MÉTODO de setup del test de
  `GET /pendientes`, sin tocar sus aserciones de forma)

**Interfaces:**
- Produces: `GET /pendientes` y `GET /historial` mantienen exactamente la misma forma de
  respuesta que antes (ver Global Constraints), ahora leída de `pedidos_cache` en vez de
  en vivo. Nuevo endpoint `GET /pedidos-cache/estado` → `{ ok: true, actualizado_en,
  ultimo_error }`.

- [ ] **Step 1: Reemplazar `GET /pendientes`**

En `routes/preparacion.js`, reemplazar el handler completo de `router.get('/pendientes', ...)`
(líneas 163-186 del estado actual) por:

```javascript
  // ── Pendientes: lee de pedidos_cache (sincronizada por cron cada 5 min) ──
  router.get('/pendientes', (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM pedidos_cache WHERE estado_envio='pendiente' ORDER BY fecha ASC").all();
      const data = rows.map(row => {
        const prep = db.prepare('SELECT id, estado, etiqueta_lista FROM preparaciones WHERE clave=?').get(row.clave);
        const items = JSON.parse(row.items_json);
        if (row.canal === 'web') {
          return {
            canal: 'web',
            espejo_ml: !!row.espejo_ml,
            wc_order_id: row.wc_order_id,
            numero_pedido: row.numero_pedido,
            comprador: row.comprador,
            fecha: row.fecha,
            estado_wc: row.estado_wc,
            items,
            preparacion_id: prep?.id || null,
            estado_preparacion: prep?.estado || null,
            etiqueta_lista: prep?.etiqueta_lista || 0,
          };
        }
        return {
          canal: 'ml',
          ml_order_id: row.ml_order_id,
          wc_order_id: row.wc_order_id,
          numero_pedido: row.numero_pedido,
          comprador: row.comprador,
          fecha: row.fecha,
          logistic_type: row.logistic_type,
          substatus: row.substatus,
          items,
          preparacion_id: prep?.id || null,
          estado_preparacion: prep?.estado || null,
        };
      });
      const ultimoLog = db.prepare(
        "SELECT creado_en, estado, error FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1"
      ).get();
      res.json({
        ok: true,
        data,
        actualizado_en: ultimoLog?.creado_en || null,
        sync_error: ultimoLog?.estado === 'error' ? ultimoLog.error : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
```

- [ ] **Step 2: Extender `GET /historial`**

Reemplazar el handler de `router.get('/historial', ...)` (líneas 363-373 del estado
actual) por:

```javascript
  // ── Historial: preparaciones ya procesadas + pedidos enviados sin preparar ──
  router.get('/historial', (req, res) => {
    const preparadas = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM preparacion_items WHERE preparacion_id=p.id) AS total_items,
        (SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id) AS total_fotos
      FROM preparaciones p
      WHERE p.estado IN ('completada','pendiente_deposito')
      ORDER BY COALESCE(p.completado_en, p.creado_en) DESC LIMIT 200
    `).all();

    const sinPreparar = db.prepare(`
      SELECT * FROM pedidos_cache pc
      WHERE pc.estado_envio='enviado'
        AND NOT EXISTS (SELECT 1 FROM preparaciones p WHERE p.clave = pc.clave)
      ORDER BY pc.fecha DESC LIMIT 200
    `).all().map(row => ({
      id: null,
      canal: row.canal,
      clave: row.clave,
      wc_order_id: row.wc_order_id,
      ml_order_id: row.ml_order_id,
      numero_pedido: row.numero_pedido,
      comprador: row.comprador,
      estado: 'enviado_sin_preparar',
      creado_en: row.fecha,
      completado_en: null,
      total_items: JSON.parse(row.items_json).length,
      total_fotos: 0,
    }));

    res.json({ ok: true, data: [...preparadas, ...sinPreparar] });
  });
```

- [ ] **Step 3: Agregar `GET /pedidos-cache/estado`**

Agregar, después del handler de `/historial`:

```javascript
  // ── Estado del sync de pedidos_cache (para el aviso de frescura en el frontend) ──
  router.get('/pedidos-cache/estado', (req, res) => {
    const ultimoLog = db.prepare(
      "SELECT creado_en, estado, error FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1"
    ).get();
    res.json({
      ok: true,
      actualizado_en: ultimoLog?.creado_en || null,
      ultimo_error: ultimoLog?.estado === 'error' ? ultimoLog.error : null,
    });
  });
```

- [ ] **Step 4: Ajustar el setup de `test/preparacion-contrato.test.js`**

En `test/preparacion-contrato.test.js`, dentro de `describe('contrato GET /pendientes', ...)`,
reemplazar el cuerpo del `it('un pendiente web y uno ml tienen exactamente la forma que
espera el frontend', ...)` — mismas aserciones, pero sembrando `pedidos_cache` directamente
en vez de mockear `wooFetch`/`mlFetch` (el endpoint ya no los llama):

```javascript
  it('un pendiente web y uno ml tienen exactamente la forma que espera el frontend', async () => {
    const itemsWeb = [{ line_item_id: 1, product_id: 501, variation_id: null, sku: 'BIKE-1', nombre: 'Bici Rodado', categoria: 'Bicicletas', cantidad: 2 }];
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('web:900','web',900,NULL,'900','Juan Perez','2026-07-01T00:00:00Z','pendiente','lpaandreani',0,NULL,NULL,?,?)
    `).run(JSON.stringify(itemsWeb), new Date().toISOString());

    const itemsMl = [{ line_item_id: null, product_id: 601, variation_id: null, sku: 'CASCO-9', nombre: 'Casco L', categoria: 'Cascos', cantidad: 1 }];
    db.prepare(`
      INSERT INTO pedidos_cache (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha, estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
      VALUES ('ml:ORD-ML-1','ml',NULL,'ORD-ML-1','ORD-ML-1','comprador_ml','2026-07-02T00:00:00Z','pendiente',NULL,0,'self_service',NULL,?,?)
    `).run(JSON.stringify(itemsMl), new Date().toISOString());

    const res = await request(buildTestApp(db)).get('/api/preparacion/pendientes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(2);

    const web = res.body.data.find(p => p.canal === 'web');
    expect(Object.keys(web).sort()).toEqual([
      'canal', 'comprador', 'espejo_ml', 'estado_preparacion', 'estado_wc', 'etiqueta_lista',
      'fecha', 'items', 'numero_pedido', 'preparacion_id', 'wc_order_id',
    ].sort());
    expect(web.wc_order_id).toBe(900);
    expect(web.espejo_ml).toBe(false);
    expect(web.comprador).toBe('Juan Perez');
    expect(Object.keys(web.items[0]).sort()).toEqual([
      'cantidad', 'categoria', 'line_item_id', 'nombre', 'product_id', 'sku', 'variation_id',
    ].sort());
    expect(web.items[0]).toMatchObject({ sku: 'BIKE-1', categoria: 'Bicicletas', cantidad: 2 });

    const ml = res.body.data.find(p => p.canal === 'ml');
    expect(Object.keys(ml).sort()).toEqual([
      'canal', 'comprador', 'estado_preparacion', 'fecha', 'items', 'logistic_type',
      'ml_order_id', 'numero_pedido', 'preparacion_id', 'substatus', 'wc_order_id',
    ].sort());
    expect(ml.ml_order_id).toBe('ORD-ML-1');
    expect(ml.comprador).toBe('comprador_ml');
    expect(ml.logistic_type).toBe('self_service');
    expect(Object.keys(ml.items[0]).sort()).toEqual([
      'cantidad', 'categoria', 'line_item_id', 'nombre', 'product_id', 'sku', 'variation_id',
    ].sort());
    expect(ml.items[0]).toMatchObject({ sku: 'CASCO-9', categoria: 'Cascos', cantidad: 1 });
  });
```

También quitar de este `describe` cualquier `vi.mock`/import de `wooFetch`/`mlFetch` que
haya quedado sin uso SOLO si ningún otro `describe` del mismo archivo los sigue usando
(revisar `describe('GET /seguimientos', ...)` más abajo en el archivo — ese sí sigue
llamando a `wooFetch` en vivo, así que el mock del tope del archivo se queda, solo cambia
el setup de este `it` puntual).

- [ ] **Step 5: Correr los tests afectados**

Run: `npx vitest run test/preparacion-contrato.test.js test/preparacion.test.js`
Expected: PASS — todos verdes, incluyendo el test de contrato ajustado.

- [ ] **Step 6: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa.

- [ ] **Step 7: Commit**

```bash
git add routes/preparacion.js test/preparacion-contrato.test.js
git commit -m "Leer /pendientes e /historial de pedidos_cache en vez de APIs en vivo"
```

---

## Task 4: Frontend — carga instantánea, aviso de frescura, completar retroactivo

**Files:**
- Modify: `public/preparacion/index.html`

**Interfaces:**
- Consumes: `GET /pendientes` (ahora con `actualizado_en`/`sync_error`), `GET /historial`
  (ahora con filas `estado: 'enviado_sin_preparar'`, `id: null`), `GET
  /pedidos-cache/estado`, `POST /iniciar` (sin cambios, ya existente).

- [ ] **Step 1: Ubicar `cargarPendientes()`**

Leer `public/preparacion/index.html` y localizar la función `cargarPendientes()` (línea
~686 del estado actual) y el mensaje "Consultando WooCommerce y MercadoLibre…" (línea
~179). Reemplazar el texto de carga por algo neutro tipo "Cargando pedidos…" (ya no es en
vivo, no tiene sentido nombrar las APIs externas).

- [ ] **Step 2: Mostrar aviso de frescura**

Después de que `cargarPendientes()` reciba la respuesta de `GET /pendientes`, usar los
campos nuevos `actualizado_en`/`sync_error` para mostrar, en la cabecera del tab
Pendientes, un texto chico tipo "actualizado hace X min" (calculado en JS con
`Date.now() - new Date(actualizado_en)`), y si `sync_error` no es null, un aviso visible
(no un catch silencioso) tipo "⚠ El último sync falló: {sync_error} — mostrando datos de
hace X min". Seguir el mismo patrón visual ya usado en el rediseño del home
(`public/home/index.html`, función `peError`) para consistencia entre pantallas: fondo
tenue de alerta, texto explicativo, sin bloquear el resto de la pantalla.

- [ ] **Step 3: Botón "Completar ahora" en Historial**

En el render del tab Historial, para las filas donde `estado === 'enviado_sin_preparar'`
(en vez de abrir el detalle de una preparación existente, porque `id` es `null`), mostrar
un botón "Completar ahora" que llame a `POST /api/preparacion/iniciar` con
`{ canal: row.canal, id: row.wc_order_id || row.ml_order_id }` — mismo endpoint que ya usa
`preparar(ix)` para pedidos nuevos de la cola de Pendientes — y al recibir la respuesta
exitosa, navegar al detalle de la preparación recién creada (mismo flujo que ya existe
para iniciar cualquier preparación nueva).

- [ ] **Step 4: Verificar sintaxis**

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/preparacion/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: `scripts inline OK: N` sin excepción.

- [ ] **Step 5: Commit**

```bash
git add public/preparacion/index.html
git commit -m "Preparación de Pedidos: carga desde caché, aviso de frescura, completar retroactivo"
```

---

## Self-Review

1. **Cobertura del spec:** sync combinado único (Task 1) ✓; un solo cron (Task 2) ✓;
   `/pendientes` desde caché con forma de respuesta idéntica (Task 3) ✓; `/historial` con
   pedidos enviados sin preparar (Task 3) ✓; fail-open con aviso visible (Task 3+4) ✓;
   completar retroactivo vía `/iniciar` sin modificarlo (Task 4) ✓; ventana de 60 días
   (implícita en que `pendientesMl` ya filtra 30 días y los estados `completed`/
   `enviadoandreani` de WC no tienen filtro de fecha explícito en este plan — **gap
   detectado en este self-review**: agregar filtro de fecha a las queries WC de `completed`/
   `enviadoandreani` en la Task 1 Step 4 para no traer pedidos de hace años. Corrección
   aplicada abajo).
2. **Placeholders:** ninguno tras la corrección.
3. **Consistencia de nombres:** `syncPedidosCache`, `upsertPedidoCache`, `filaWebDesdeOrder`,
   `logSyncPedidos` se usan consistentes entre su definición (Task 1) y su único punto de
   consumo (Task 2 solo importa `syncPedidosCache`, que es la única función pública).

### Corrección aplicada tras el self-review (ventana de 60 días para WC)

En la Task 1 Step 4, las llamadas `wooFetch(cfg.woo, '/orders?status=completed&per_page=100')`
y la de `enviadoAndreaniStatus` deben acotarse con `after=` (parámetro estándar de la
REST API de WooCommerce, filtra por `date_created` mínimo) a los últimos 60 días. Reemplazar
esas dos líneas dentro del `Promise.all` del Step 4 por:

```javascript
    const hace60Dias = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const [wcPend, wcCompleted, wcEnviado] = await Promise.all([
      wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`),
      wooFetch(cfg.woo, `/orders?status=completed&after=${encodeURIComponent(hace60Dias)}&per_page=100`),
      wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(enviadoAndreaniStatus)}&after=${encodeURIComponent(hace60Dias)}&per_page=100`),
    ]);
```

(Los pendientes en `lpaandreani` no se acotan por fecha — un pedido pendiente de preparar
sigue siendo relevante sin importar hace cuánto se generó, hasta que se procese.)
