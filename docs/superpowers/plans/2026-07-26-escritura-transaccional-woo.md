# Escritura transaccional a Woo — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un pedido "colgado" (completed con tracking, sin llegar a
enviadoandreani por una falla del PUT 2) se resuelva solo, vía un cron de reintento,
en vez de depender de que un operario note el badge y reintente a mano.

**Architecture:** Node/Express ESM + better-sqlite3 (`routes/preparacion.js`,
`server.js`). Reusa `registrarEvento` (ciclo 3) y `wooFetch` (`routes/woo.js`).

## Global Constraints

- Contenido y comentarios en español.
- **NO tocar** `GET /seguimientos` ni sus tests de contrato — el escaneo de Woo
  `status=completed` sigue siendo la red de seguridad para colgados sin registro local.
- El reintento manual existente (`colgadoCompletado` en `POST /seguimientos/:wcOrderId`)
  no se toca — sigue funcionando igual.
- Al final, correr `npm test` completo y confirmar suite verde.

---

## Task 1: Columna nueva + persistencia antes del PUT 2 + cron de reintento

**Files:**
- Modify: `routes/preparacion.js` (`ensureTables`, `POST /seguimientos/:wcOrderId`,
  nueva función exportada `reintentarColgadosTracking`)
- Modify: `server.js` (registrar el cron)
- Test: `test/preparacion-contrato.test.js`

**Interfaces:**
- Cambia el comportamiento de `POST /seguimientos/:wcOrderId` cuando el PUT 2 falla:
  `502` con `{ok:false, colgado:true, error}` en vez de `500` genérico, y deja un
  registro local (`woo_paso2_pendiente=1`).
- Produce: `reintentarColgadosTracking(db, cfg)` → número de colgados resueltos en la
  corrida.

- [ ] **Step 1: Escribir los tests que fallan**

En `test/preparacion-contrato.test.js`, agregar dentro de
`describe('POST /seguimientos/:wcOrderId', ...)`, después del test
`'preserva el id del meta existente y encadena completed → enviadoandreani'`:

```js
it('si el PUT 2 falla, deja woo_paso2_pendiente=1 y responde 502 con colgado:true (no 500)', async () => {
  wooFetch
    .mockResolvedValueOnce({ data: { id: 910, status: 'lpaandreani', meta_data: [] } }) // GET actual
    .mockResolvedValueOnce({ data: { id: 910, status: 'completed' } }) // PUT paso 1 (ok)
    .mockRejectedValueOnce(new Error('WC caído')); // PUT paso 2 (falla)

  const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/910').send({ tracking: 'AND555' });
  expect(res.status).toBe(502);
  expect(res.body).toMatchObject({ ok: false, colgado: true });

  const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:910'").get();
  expect(prep).toBeTruthy();
  expect(prep.woo_paso2_pendiente).toBe(1);
  expect(prep.estado).not.toBe('completada');

  const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_colgado'").get();
  expect(ev).toBeTruthy();
});
```

Agregar en un nuevo `describe`, al final del archivo (después del último `describe`
existente):

```js
describe('reintentarColgadosTracking', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('reintenta el PUT 2 de cada colgado; si tiene éxito, limpia la bandera y marca completada', async () => {
    buildTestApp(db); // ensureTables
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:920',920,1,'en_preparacion',?,1)`).run(now);

    wooFetch.mockResolvedValueOnce({ data: { id: 920, status: 'enviadoandreani' } });

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(1);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:920'").get();
    expect(prep.estado).toBe('completada');
    expect(prep.woo_paso2_pendiente).toBe(0);

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_recuperado'").get();
    expect(ev).toBeTruthy();
  });

  it('si vuelve a fallar, deja la bandera puesta para la corrida siguiente (fail-open, no lanza)', async () => {
    buildTestApp(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
      VALUES ('web','web:921',921,1,'en_preparacion',?,1)`).run(now);

    wooFetch.mockRejectedValueOnce(new Error('sigue caído'));

    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(0);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:921'").get();
    expect(prep.woo_paso2_pendiente).toBe(1);
    expect(prep.estado).not.toBe('completada');
  });

  it('sin colgados pendientes, no llama a wooFetch y devuelve 0', async () => {
    buildTestApp(db);
    const resueltos = await reintentarColgadosTracking(db, { woo: null, enviadoAndreaniStatus: 'enviadoandreani' });
    expect(resueltos).toBe(0);
    expect(wooFetch).not.toHaveBeenCalled();
  });
});
```

Agregar `reintentarColgadosTracking` al import existente de `../routes/preparacion.js`
en este archivo de test.

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run test/preparacion-contrato.test.js -t "colgado\|reintentarColgados"`
Expected: FAIL.

- [ ] **Step 3: Columna nueva en `ensureTables`**

Junto al bloque `try { ALTER TABLE preparacion_fotos ADD COLUMN borrado_en ... }` en
`routes/preparacion.js`:

```js
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN woo_paso2_pendiente INTEGER NOT NULL DEFAULT 0').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables woo_paso2_pendiente:', e.message);
  }
```

- [ ] **Step 4: Reescribir el final de `POST /seguimientos/:wcOrderId`**

Reemplazar, desde el comentario `// Paso 2: estado final custom...` hasta el
`res.json({ ok: true });` (antes del `catch` externo del handler):

```js
      // Registro local ANTES del paso 2: si el paso 2 falla, igual queda constancia de
      // que el pedido llegó a 'completed' con tracking guardado — sin esto, la única
      // fuente de verdad sería Woo (y solo se detectaría escaneando status=completed).
      db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
        VALUES ('web', ?, ?, 1, 'en_preparacion', ?, 1)
        ON CONFLICT(clave) DO UPDATE SET woo_paso2_pendiente=1`)
        .run(`web:${wcOrderId}`, wcOrderId, now());

      // Paso 2: estado final custom, en una segunda escritura separada. Si falla, no se
      // relanza — queda "colgado" (woo_paso2_pendiente=1) para que reintentarColgadosTracking
      // (cron) o un reintento manual del operario lo resuelvan después.
      try {
        await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', { status: enviadoAndreaniStatus });
      } catch (e) {
        const prep = db.prepare('SELECT id FROM preparaciones WHERE clave=?').get(`web:${wcOrderId}`);
        if (prep) {
          registrarEvento(db, {
            preparacionId: prep.id, itemId: null, tipo: 'tracking_colgado', usuario: req.user?.username,
            detalle: { error: e.message },
          });
        }
        return res.status(502).json({
          ok: false, colgado: true,
          error: 'el tracking se guardó pero no se pudo marcar como enviado (se reintentará solo)',
        });
      }

      db.prepare(`UPDATE preparaciones SET estado='completada', completado_en=?, woo_paso2_pendiente=0 WHERE clave=?`)
        .run(now(), `web:${wcOrderId}`);

      res.json({ ok: true });
```

(Elimina el `INSERT INTO preparaciones ...` que hoy corre al final, después de ambos
PUTs — se reemplaza por el nuevo INSERT de más arriba + el UPDATE final.)

- [ ] **Step 5: Función de reintento**

Agregar junto a `registrarEvento`/`purgarFotosBorradas`:

```js
export async function reintentarColgadosTracking(db, cfg) {
  const pendientes = db.prepare('SELECT * FROM preparaciones WHERE woo_paso2_pendiente=1').all();
  let resueltos = 0;
  for (const prep of pendientes) {
    try {
      await wooFetch(cfg.woo, `/orders/${prep.wc_order_id}`, 'put', { status: cfg.enviadoAndreaniStatus || 'enviadoandreani' });
      db.prepare("UPDATE preparaciones SET estado='completada', completado_en=?, woo_paso2_pendiente=0 WHERE id=?")
        .run(new Date().toISOString(), prep.id);
      registrarEvento(db, { preparacionId: prep.id, itemId: null, tipo: 'tracking_recuperado', usuario: null, detalle: {} });
      resueltos++;
    } catch (e) {
      console.error(`reintentarColgadosTracking: sigue colgado wc_order_id=${prep.wc_order_id}:`, e.message);
    }
  }
  return resueltos;
}
```

- [ ] **Step 6: Correr y confirmar que pasan**

Run: `npx vitest run test/preparacion-contrato.test.js && npx vitest run test/preparacion.test.js`
Expected: PASS (ambos archivos, y toda la suite con `npm test`).

- [ ] **Step 7: Registrar el cron en `server.js`**

Junto a los demás `cron.schedule`, importar `reintentarColgadosTracking` desde
`./routes/preparacion.js` (agregar al import ya existente de ese módulo) y agregar:

```js
      cron.schedule('*/10 * * * *', () => {
        reintentarColgadosTracking(app._db, { woo: wooCfg, enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani' })
          .catch(err => console.error('Error en reintentarColgadosTracking:', err.message));
      });
```

- [ ] **Step 8: Commit**

```bash
git add routes/preparacion.js server.js test/preparacion-contrato.test.js
git commit -m "Preparación: reintento automático de tracking colgado (cron + registro local)"
```

## Self-Review

1. **Cobertura del spec**: columna nueva ✓; registro local antes del PUT 2 ✓; PUT 2 en
   try/catch propio, sin relanzar ✓; 502 + colgado:true ✓; eventos tracking_colgado /
   tracking_recuperado ✓; cron cada 10 min ✓; `GET /seguimientos` intacto ✓.
2. **Chequeo de redundancia**: el cron y el reintento manual del operario resuelven el
   mismo síntoma por caminos distintos (automático vs. a demanda) — no es duplicación,
   es la doble cobertura descrita explícitamente en la Decisión 6 del spec.
3. **Placeholders**: ninguno.
