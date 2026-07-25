# Concurrencia y refresh automático — Preparación de Pedidos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avisar (sin bloquear) cuando dos operarios abren la misma preparación al mismo
tiempo, y refrescar automáticamente la cola de Pendientes cada ~25s para que no haga falta
recargar la página a mano.

**Architecture:** Node/Express ESM + better-sqlite3 en backend (`routes/preparacion.js`,
ya existente); HTML/JS plano en `public/preparacion/index.html`. Tabla nueva de presencia
sin limpieza explícita (TTL implícito por filtro de antigüedad en la query).

**Tech Stack:** Express, better-sqlite3, vitest.

## Global Constraints

- Contenido y comentarios en español.
- No tocar `.env`, `data/`, `uploads/`, `*.db`, `*.sqlite`.
- `hard-worker-backend` dueño de `routes/`; `hard-worker-frontend` dueño de `public/`.
- **No bloquear**: el heartbeat es informativo, nunca impide abrir/operar una preparación.
- **Refresh automático solo en la cola de Pendientes**, no dentro del detalle de una
  preparación en curso (decisión ya tomada, ver spec).
- Al final de la tarea que toca `routes/`, correr `npm test` y confirmar suite verde.

---

## Task 1: Tabla `preparacion_vistas` + `POST /:id/heartbeat`

**Files:**
- Modify: `routes/preparacion.js`
- Modify: `test/preparacion.test.js`

**Interfaces:**
- Produces: `POST /:id/heartbeat` → `{ok:true, otros:[{usuario, visto_en}]}`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `test/preparacion.test.js`, después de `buildTestApp` (agregar esta variante que
acepta `usuario`, sin tocar `buildTestApp` que ya usan otros tests):

```javascript
function buildTestAppComo(db, usuario) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0 }; next(); });
  app.use('/api/preparacion', preparacionRouter(db, { woo: null, ml: null, andreaniStatus: 'lpaandreani' }));
  return app;
}

describe('POST /:id/heartbeat', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('registra la presencia y no devuelve a nadie si sos el único viendo la preparación', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 900, numeroPedido: '900', comprador: 'Juan', items: [] });

    const res = await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.otros).toEqual([]);
  });

  it('devuelve a otro usuario que mandó heartbeat en los últimos 30s, sin incluirse a sí mismo', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 901, numeroPedido: '901', comprador: 'Ana', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.body.otros).toHaveLength(1);
    expect(res.body.otros[0].usuario).toBe('juan');
  });

  it('no devuelve un heartbeat viejo (más de 30s)', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 902, numeroPedido: '902', comprador: 'Ana', items: [] });
    const viejo = new Date(Date.now() - 60000).toISOString(); // hace 60s
    db.prepare('INSERT INTO preparacion_vistas (preparacion_id, usuario, visto_en) VALUES (?,?,?)').run(prepId, 'juan', viejo);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepId}/heartbeat`);

    expect(res.body.otros).toEqual([]);
  });

  it('actualiza (no duplica) el heartbeat del mismo usuario en la misma preparación', async () => {
    const prepId = crearPreparacion(db, { canal: 'web', wcOrderId: 903, numeroPedido: '903', comprador: 'Ana', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepId}/heartbeat`);

    const filas = db.prepare('SELECT * FROM preparacion_vistas WHERE preparacion_id=?').all(prepId);

    expect(filas).toHaveLength(1);
  });

  it('no mezcla presencia entre preparaciones distintas', async () => {
    const prepA = crearPreparacion(db, { canal: 'web', wcOrderId: 904, numeroPedido: '904', comprador: 'X', items: [] });
    const prepB = crearPreparacion(db, { canal: 'web', wcOrderId: 905, numeroPedido: '905', comprador: 'Y', items: [] });
    await request(buildTestAppComo(db, 'juan')).post(`/api/preparacion/${prepA}/heartbeat`);

    const res = await request(buildTestAppComo(db, 'ana')).post(`/api/preparacion/${prepB}/heartbeat`);

    expect(res.body.otros).toEqual([]);
  });

  it('404 si la preparación no existe', async () => {
    const res = await request(buildTestAppComo(db, 'juan')).post('/api/preparacion/999999/heartbeat');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Correr los tests para confirmar que fallan**

Run: `npx vitest run test/preparacion.test.js -t "heartbeat"`
Expected: FAIL — la ruta no existe.

- [ ] **Step 3: Implementar**

En `routes/preparacion.js`, dentro de `ensureTables(db)` (junto a las demás tablas de este
módulo), agregar:

```javascript
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_vistas (
    preparacion_id INTEGER NOT NULL,
    usuario        TEXT NOT NULL,
    visto_en       TEXT NOT NULL,
    PRIMARY KEY (preparacion_id, usuario)
  )`).run();
```

Agregar el endpoint, cerca del handler `GET /:id` (después de `router.get('/:id', ...)`):

```javascript
  // ── Heartbeat de presencia: "estoy viendo esta preparación ahora" ──
  // No bloquea nada — solo informa quién más la está viendo, para que los operarios
  // coordinen entre sí si se están por pisar. Sin limpieza explícita de filas viejas:
  // solo se consideran "activos" los últimos 30s, así que una fila vieja deja de contar
  // sola sin que haga falta borrarla (se sobreescribe con el próximo heartbeat de ese
  // mismo usuario, gracias a la PRIMARY KEY compuesta).
  router.post('/:id/heartbeat', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const usuario = req.user?.username;
    const ahora = now();

    db.prepare(`
      INSERT INTO preparacion_vistas (preparacion_id, usuario, visto_en) VALUES (?,?,?)
      ON CONFLICT(preparacion_id, usuario) DO UPDATE SET visto_en=excluded.visto_en
    `).run(prep.id, usuario, ahora);

    const hace30s = new Date(Date.now() - 30000).toISOString();
    const otros = db.prepare(
      'SELECT usuario, visto_en FROM preparacion_vistas WHERE preparacion_id=? AND usuario<>? AND visto_en > ?'
    ).all(prep.id, usuario, hace30s);

    res.json({ ok: true, otros });
  });
```

- [ ] **Step 4: Correr los tests para confirmar que pasan**

Run: `npx vitest run test/preparacion.test.js -t "heartbeat"`
Expected: PASS — 6 tests verdes.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa.

- [ ] **Step 6: Commit**

```bash
git add routes/preparacion.js test/preparacion.test.js
git commit -m "Agregar tabla preparacion_vistas y POST /:id/heartbeat"
```

---

## Task 2: Frontend — heartbeat con banner + refresh automático de Pendientes

**Files:**
- Modify: `public/preparacion/index.html`

**Interfaces:**
- Consumes: `GET /api/auth/me` (patrón ya usado en el resto del proyecto, nuevo en este
  archivo), `POST /api/preparacion/:id/heartbeat` (Task 1).

- [ ] **Step 1: Agregar `GET /api/auth/me` al cargar la página**

Cerca del arranque del script (donde se declara `var VISTA='pendientes', PREP=null,
PEND_CACHE=[];`, línea ~156), agregar una variable `USERNAME=null` y, en el punto de
arranque de la página (buscar dónde se llama por primera vez a `ir('pendientes')` o
equivalente al cargar), agregar:

```javascript
fetch('/api/auth/me').then(function(r){ return r.json(); }).then(function(d){
  if (d && d.ok) USERNAME = d.user || d.username;
}).catch(function(){});
```

(Usar el nombre de campo real que devuelve `/api/auth/me` — confirmar contra
`routes/auth.js` o contra otra página que ya lo consuma, ej. `public/home/index.html`, en
vez de asumir `user` vs `username`.)

- [ ] **Step 2: Heartbeat periódico con banner en el detalle**

En `abrirDetalle(id)` (línea ~235), después de `renderDetalle()`, agregar el disparo del
heartbeat y el `setInterval`:

```javascript
var heartbeatTimer=null;
function iniciarHeartbeat(id){
  detenerHeartbeat();
  heartbeat(id);
  heartbeatTimer=setInterval(function(){ heartbeat(id); }, 15000);
}
function detenerHeartbeat(){
  if(heartbeatTimer){ clearInterval(heartbeatTimer); heartbeatTimer=null; }
}
async function heartbeat(id){
  try{
    var r=await api('/'+id+'/heartbeat',{method:'POST'});
    if(r.body.ok) renderBannerPresencia(r.body.otros||[]);
  }catch(e){/* no bloqueante: si falla, simplemente no se muestra el banner */}
}
function renderBannerPresencia(otros){
  var el=document.getElementById('banner-presencia');
  if(!el)return;
  if(!otros.length){ el.style.display='none'; return; }
  var nombres=otros.map(function(o){return esc(o.usuario);}).join(', ');
  el.textContent=(otros.length===1?nombres+' también está':nombres+' también están')+' preparando este pedido ahora.';
  el.style.display='block';
}
```

Llamar `iniciarHeartbeat(id)` al final de `abrirDetalle(id)`.

Agregar el contenedor del banner en `renderDetalle()` (dentro del `html` que arma la
pantalla, cerca del `<h1>` del pedido — usar un `<div id="banner-presencia"
class="aviso" style="display:none"></div>` con el mismo patrón visual de aviso ya usado en
otras partes de este mismo archivo, ej. la clase `.loading.err` o `.badge b-dep`, adaptando
a un tono neutro de "información", no de error).

- [ ] **Step 3: Cortar el heartbeat al salir del detalle**

En la función `ir(v)` (línea ~156-166, la que centraliza el cambio de vista), agregar
`detenerHeartbeat();` al principio, antes de reasignar `VISTA`/`PREP` — así al navegar a
cualquier otra pestaña (Pendientes, Etiquetas, etc.) se corta el `setInterval` sin
importar desde cuál vista se sale.

- [ ] **Step 4: Refresh automático de la cola de Pendientes**

Cerca de `cargarPendientes()` (línea ~185), agregar:

```javascript
var pendientesTimer=null, pendientesEnVuelo=false;
function iniciarPollingPendientes(){
  detenerPollingPendientes();
  pendientesTimer=setInterval(function(){
    if(VISTA==='pendientes' && !pendientesEnVuelo) cargarPendientesSilencioso();
  }, 25000);
}
function detenerPollingPendientes(){
  if(pendientesTimer){ clearInterval(pendientesTimer); pendientesTimer=null; }
}
async function cargarPendientesSilencioso(){
  // Igual que cargarPendientes() pero sin el "Cargando pedidos…" intermedio, para no
  // hacer parpadear la pantalla en cada refresh automático de fondo.
  pendientesEnVuelo=true;
  try{
    var r=await api('/pendientes');
    if(r.body.ok){ PEND_CACHE=r.body.data; renderPendientes(); }
  }catch(e){/* silencioso: un fallo de refresh en background no debe interrumpir al usuario */}
  finally{ pendientesEnVuelo=false; }
}
```

(Ajustar `renderPendientes()` al nombre real de la función que renderiza `PEND_CACHE` en
`cargarPendientes()` — leer el cuerpo completo de `cargarPendientes()` antes de escribir
esto, ya que el brief no tiene el nombre exacto confirmado.)

Iniciar el polling una sola vez al cargar la página (mismo punto donde se agregó el fetch
de `/api/auth/me` en el Step 1), y llamar `detenerPollingPendientes()` también dentro de
`ir(v)` cuando `v!=='pendientes'` — reiniciarlo cuando se vuelve a esa vista (`ir('pendientes')`
ya llama a `cargarPendientes()`, agregar `iniciarPollingPendientes()` ahí también).

- [ ] **Step 5: Verificación de sintaxis**

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/preparacion/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: `scripts inline OK: N` sin excepción.

- [ ] **Step 6: Commit**

```bash
git add public/preparacion/index.html
git commit -m "Preparación de Pedidos: heartbeat de presencia + refresh automático de Pendientes"
```

---

## Self-Review

1. **Cobertura del spec**: heartbeat no bloqueante (Task 1) ✓; banner de presencia (Task 2
   Step 2) ✓; corte del heartbeat al cambiar de vista (Task 2 Step 3) ✓; polling solo en
   Pendientes (Task 2 Step 4) ✓; sin refresh dentro del detalle más allá del heartbeat
   (respetado, no se agregó re-render periódico de `PREP`) ✓.
2. **Chequeo de redundancia**: heartbeat (cada 15s, solo en detalle) y polling de
   Pendientes (cada 25s, solo en la cola) son dos mecanismos con propósitos y alcance
   distintos, activos en vistas mutuamente excluyentes (nunca corren los dos a la vez,
   `ir(v)` corta uno al entrar al otro) — no son la misma operación repetida.
3. **Placeholders**: ninguno, salvo dos puntos donde el brief pide explícitamente
   confirmar contra el código real antes de escribir (nombre del campo de usuario en
   `/api/auth/me`, nombre de la función de render de Pendientes) en vez de asumir — no es
   un placeholder sin resolver, es una instrucción de verificación previa.
4. **Consistencia de nombres**: `iniciarHeartbeat`/`detenerHeartbeat`/`heartbeat`/
   `renderBannerPresencia` y `iniciarPollingPendientes`/`detenerPollingPendientes`/
   `cargarPendientesSilencioso` se usan consistentes entre su definición y su punto de
   enganche en `ir(v)`/`abrirDetalle(id)`.
