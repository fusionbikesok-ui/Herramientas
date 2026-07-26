# Corrección de tracking erróneo — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir corregir un tracking de Andreani mal cargado en un pedido web que ya
está `completed`/`enviadoandreani`, sin reenviar el mail nativo de WooCommerce al cliente,
dejando registro en el feed de Actividad (ciclo 3).

**Architecture:** Node/Express ESM + better-sqlite3 (`routes/preparacion.js`, ya
existente); reusa `registrarEvento` (ciclo 3) y `wooFetch` (`routes/woo.js`). Frontend:
`public/preparacion/index.html`, tab "Cargar seguimientos".

## Global Constraints

- Contenido y comentarios en español.
- No tocar `.env`, `data/`, `uploads/`, `*.db`, `*.sqlite`.
- La corrección NUNCA hace PUT con `status` — solo `meta_data`, para no disparar el mail
  nativo de WooCommerce (que se activa por la transición de status, no por meta).
- No modificar el endpoint existente `POST /seguimientos/:wcOrderId` ni su fail-closed.
- Al final de la tarea que toca `routes/`, correr `npm test` y confirmar suite verde.

---

## Task 1: Backend — lookup + corrección de tracking

**Files:**
- Modify: `routes/preparacion.js` (junto a `POST /seguimientos/:wcOrderId`)
- Test: `test/preparacion.test.js`

**Interfaces:**
- Produce: `GET /seguimientos/:wcOrderId/tracking-actual` →
  `{ ok, status, tracking_actual, corregible }`.
- Produce: `POST /seguimientos/:wcOrderId/corregir-tracking` →
  `{ ok, tracking_anterior, tracking_nuevo }`.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar en `test/preparacion.test.js`, cerca del test existente
`'POST /seguimientos/:wcOrderId valida wcOrderId y tracking'` (usa el mock global de
`wooFetch` ya importado en el archivo, patrón `wooFetch.mockResolvedValueOnce(...)`):

```js
describe('corrección de tracking', () => {
  it('GET /tracking-actual: corregible=true si el pedido está completed/enviadoandreani con tracking', async () => {
    wooFetch.mockResolvedValueOnce({ data: {
      status: 'enviadoandreani',
      meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
    }});
    const r = await request(app).get('/api/preparacion/seguimientos/900/tracking-actual');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'enviadoandreani', tracking_actual: 'AND111', corregible: true });
  });

  it('GET /tracking-actual: corregible=false si el pedido sigue en lpaandreani (todavía no se cargó tracking)', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } });
    const r = await request(app).get('/api/preparacion/seguimientos/901/tracking-actual');
    expect(r.body).toMatchObject({ ok: true, corregible: false });
  });

  it('POST /corregir-tracking: 409 si el pedido no está completed/enviadoandreani', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'lpaandreani', meta_data: [] } });
    const r = await request(app).post('/api/preparacion/seguimientos/902/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(409);
  });

  it('POST /corregir-tracking: 409 si no hay tracking previo cargado', async () => {
    wooFetch.mockResolvedValueOnce({ data: { status: 'completed', meta_data: [] } });
    const r = await request(app).post('/api/preparacion/seguimientos/903/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(409);
  });

  it('POST /corregir-tracking: mismo valor es no-op, no llama PUT', async () => {
    wooFetch.mockResolvedValueOnce({ data: {
      status: 'enviadoandreani',
      meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
    }});
    const r = await request(app).post('/api/preparacion/seguimientos/904/corregir-tracking').send({ tracking: 'AND111' });
    expect(r.body).toMatchObject({ ok: true, tracking_anterior: 'AND111', tracking_nuevo: 'AND111' });
    expect(wooFetch).toHaveBeenCalledTimes(1); // solo el GET, ningún PUT
  });

  it('POST /corregir-tracking: valor distinto hace UN PUT con solo meta_data (sin status) y registra evento', async () => {
    const id = nuevaPrep(); // crea preparacion_items pero no la fila 'web:905'; forzamos clave real:
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, completado_en)
      VALUES ('web','web:905',905,1,'completada',?,?)`).run(new Date().toISOString(), new Date().toISOString());

    wooFetch
      .mockResolvedValueOnce({ data: {
        status: 'enviadoandreani',
        meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
      }})
      .mockResolvedValueOnce({ data: {} }); // el PUT

    const r = await request(app).post('/api/preparacion/seguimientos/905/corregir-tracking').send({ tracking: 'AND999' });
    expect(r.body).toMatchObject({ ok: true, tracking_anterior: 'AND111', tracking_nuevo: 'AND999' });
    expect(wooFetch).toHaveBeenCalledTimes(2);
    const putCall = wooFetch.mock.calls[1];
    expect(putCall[2]).toBe('put');
    expect(putCall[3]).toEqual({ meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND999' }] });
    expect(putCall[3].status).toBeUndefined();

    const ev = db.prepare("SELECT * FROM preparacion_eventos WHERE tipo='tracking_corregido'").get();
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev.detalle_json)).toEqual({ tracking_anterior: 'AND111', tracking_nuevo: 'AND999' });
  });

  it('POST /corregir-tracking: si no existe fila en preparaciones, igual corrige el tracking (evento se saltea fail-open)', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: {
        status: 'completed',
        meta_data: [{ id: 5, key: '_andreani_tracking', value: 'AND111' }],
      }})
      .mockResolvedValueOnce({ data: {} });
    const r = await request(app).post('/api/preparacion/seguimientos/906/corregir-tracking').send({ tracking: 'AND222' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Correr los tests para confirmar que fallan**

Run: `npx vitest run test/preparacion.test.js -t "corrección de tracking"`
Expected: FAIL — las rutas no existen.

- [ ] **Step 3: Implementar**

En `routes/preparacion.js`, justo después del handler `router.post('/seguimientos/:wcOrderId', ...)`:

```js
  // ── Lookup de solo lectura: tracking actual + si es corregible ──
  router.get('/seguimientos/:wcOrderId/tracking-actual', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const status = actual.data?.status;
      const meta = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingActual = String(meta?.value || '').trim();
      const corregible = (status === 'completed' || status === enviadoAndreaniStatus) && !!trackingActual;
      res.json({ ok: true, status, tracking_actual: trackingActual, corregible });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Corregir un tracking ya cargado, sin reenviar el mail nativo (solo meta_data) ──
  router.post('/seguimientos/:wcOrderId/corregir-tracking', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    const trackingNuevo = String(req.body?.tracking || '').trim();
    if (!trackingNuevo) return res.status(400).json({ ok: false, error: 'tracking requerido' });

    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const status = actual.data?.status;
      if (status !== 'completed' && status !== enviadoAndreaniStatus) {
        return res.status(409).json({ ok: false, error: `el pedido está en estado '${status}', no se puede corregir` });
      }
      const metaExistente = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingAnterior = String(metaExistente?.value || '').trim();
      if (!trackingAnterior) {
        return res.status(409).json({ ok: false, error: 'no hay tracking cargado para corregir — usá el flujo normal de seguimientos' });
      }

      if (trackingNuevo === trackingAnterior) {
        return res.json({ ok: true, tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo });
      }

      await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', {
        meta_data: [{ id: metaExistente.id, key: TRACKING_META_KEY, value: trackingNuevo }],
      });

      const prep = db.prepare("SELECT id FROM preparaciones WHERE clave=?").get(`web:${wcOrderId}`);
      if (prep) {
        registrarEvento(db, {
          preparacionId: prep.id, itemId: null, tipo: 'tracking_corregido', usuario: req.user?.username,
          detalle: { tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo },
        });
      }

      res.json({ ok: true, tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
```

- [ ] **Step 4: Correr y confirmar que pasan**

Run: `npx vitest run test/preparacion.test.js`
Expected: PASS (toda la suite).

- [ ] **Step 5: Commit**

```bash
git add routes/preparacion.js test/preparacion.test.js
git commit -m "Preparación: endpoints de lookup y corrección de tracking erróneo"
```

---

## Task 2: Frontend — buscador de corrección en "Cargar seguimientos"

**Files:**
- Modify: `public/preparacion/index.html` (`cargarSeguimientos`)
- No hace falta test automatizado (mismo criterio que Task 7 del ciclo 3) — se verifica
  con una pasada manual de Playwright antes de mergear.

**Interfaces:**
- Consume: `GET .../tracking-actual`, `POST .../corregir-tracking`.

- [ ] **Step 1: Agregar el buscador arriba de la grilla existente**

En `cargarSeguimientos()`, antes de armar `html` con la grilla de `filas`, agregar un
bloque de búsqueda fijo (independiente de si `filas.length` es 0):

```js
var buscador = '<div class="ped" style="margin-bottom:16px">'
  +'<div class="ped-top"><span class="ped-num">Corregir tracking de un pedido ya cargado</span></div>'
  +'<div class="ped-foot">'
  +'<input type="text" placeholder="N° de pedido" id="corr-num" style="flex:1;min-width:120px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text)">'
  +'<button class="btn sec" onclick="buscarParaCorregir()">Buscar</button>'
  +'</div><div id="corr-resultado"></div></div>';
```

Anteponer `buscador` al `html` armado, en ambos casos (con y sin `filas.length`) — no
usar el `return` temprano de `if(!filas.length){...;return;}` sin el buscador; cambiarlo
para que arme `c.innerHTML=buscador+'<div class="loading">No hay pedidos...</div>'` en
vez de retornar antes.

- [ ] **Step 2: Funciones de búsqueda y corrección**

Agregar junto a `guardarSeguimiento`:

```js
async function buscarParaCorregir(){
  var num=document.getElementById('corr-num').value.trim();
  var out=document.getElementById('corr-resultado');
  if(!num){out.innerHTML='';return;}
  out.innerHTML='<p class="sub">Buscando…</p>';
  try{
    var r=await api('/seguimientos/'+num+'/tracking-actual');
    if(!r.body.ok)throw new Error(r.body.error||'error');
    if(!r.body.corregible){
      out.innerHTML='<p class="sub err">Este pedido no tiene un tracking cargado para corregir (estado actual: '+esc(r.body.status)+').</p>';
      return;
    }
    out.innerHTML='<div class="ped-foot" style="margin-top:8px">'
      +'<span class="sub" style="margin:0">Actual: <b>'+esc(r.body.tracking_actual)+'</b></span>'
      +'<input type="text" placeholder="Nuevo N° de seguimiento" id="corr-nuevo" style="flex:1;min-width:140px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text)">'
      +'<button class="btn" onclick="confirmarCorreccion('+JSON.stringify(num)+')">Corregir</button>'
      +'</div>';
  }catch(e){out.innerHTML='<p class="sub err">'+esc(e.message)+'</p>';}
}

async function confirmarCorreccion(num){
  var input=document.getElementById('corr-nuevo');
  var nuevo=(input&&input.value||'').trim();
  if(!nuevo){if(input)input.focus();return;}
  var out=document.getElementById('corr-resultado');
  try{
    var r=await api('/seguimientos/'+num+'/corregir-tracking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tracking:nuevo})});
    if(!r.body.ok)throw new Error(r.body.error||'error');
    out.innerHTML='<p class="sub" style="color:var(--green)">✓ Corregido: '+esc(r.body.tracking_anterior)+' → '+esc(r.body.tracking_nuevo)+'</p>';
  }catch(e){alert('No se pudo corregir: '+e.message);}
}
```

- [ ] **Step 3: Verificación de sintaxis**

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/preparacion/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: sin excepción.

- [ ] **Step 4: Commit**

```bash
git add public/preparacion/index.html
git commit -m "Preparación: buscador de corrección de tracking en Cargar seguimientos"
```

---

## Self-Review

1. **Cobertura del spec**: endpoint de lookup ✓; endpoint de corrección fail-closed en 3
   precondiciones (status, tracking previo, no-op en mismo valor) ✓; solo PUT de
   `meta_data` sin `status` ✓; evento `tracking_corregido` fail-open ✓; buscador en
   frontend ✓.
2. **Chequeo de redundancia**: no se duplica lógica del endpoint existente
   `POST /seguimientos/:wcOrderId` — comparten el mismo `TRACKING_META_KEY` y el mismo
   `wooFetch`, pero las precondiciones y el efecto (status vs. solo meta) son
   deliberadamente distintos.
3. **Placeholders**: ninguno.
