# Rediseño de la página principal (home) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar `public/home/index.html` para que muestre primero lo que requiere
atención (agrupado por severidad, con acción directa), después el progreso como contexto, y
las tarjetas de herramientas al final; arreglar el bug de HTML de "Cobertura de Catálogo";
y hacer que los chips de "reactivables" y "SKUs por escribir en ML" lleven a una vista
enfocada con el botón de arreglo a mano (patrón `sync-detalle`), en vez de a un dashboard
completo o a una herramienta que exige pasos previos.

**Architecture:** Node/Express ESM + better-sqlite3 en el backend; HTML/CSS/JS plano sin
framework en `public/`. Se agrega UN endpoint de solo lectura nuevo (listado de SKUs
pendientes de escribir en ML) reusando una query ya existente; el resto es reordenar/extender
frontend reusando endpoints que ya existen (`/api/sync/reactivables`, `/api/sync/reactivar`,
`/api/sync/atencion/:cat`, `/api/matcher/push-skus-pendientes`).

**Tech Stack:** Express, better-sqlite3, vitest (tests del endpoint nuevo), HTML/CSS/JS
plano (sin build tools), `public/lib/theme.css` (tokens compartidos), `public/lib/api.js`/
`format.js` (helpers ya usados por `sync-detalle`).

## Global Constraints

- Contenido y comentarios en español.
- No tocar `.env`, `data/`, `uploads/`, `*.db`, `*.sqlite`.
- `hard-worker-backend` es dueño de `routes/`; `hard-worker-frontend` es dueño de `public/`.
  Ninguno cruza la frontera del otro.
- Tokens de color: usar los definidos en `public/lib/theme.css` (agregados en la Task 2),
  nunca hardcodear hex nuevos en HTML/JS de páginas.
- Todo endpoint nuevo es de **solo lectura** (GET) — no se agrega escritura nueva; la
  escritura en lote de "SKUs por escribir" reusa el `POST /api/matcher/push-skus-pendientes`
  ya existente tal cual.
- Al final de cada tarea que toque `routes/`, correr `npm test` y confirmar que la suite
  completa sigue verde.
- Las tareas de frontend (`public/`) no tienen test vitest — se verifican con
  `probador-e2e` en una etapa posterior del pipeline (fuera del alcance de este plan de
  subagent-driven-development; el plan solo cubre implementación + `npm test` del backend).

---

## Task 1: Endpoint de listado de SKUs pendientes de escribir en ML

**Files:**
- Modify: `routes/matcher.js` (agregar endpoint nuevo, cerca de `/push-skus-pendientes/count`)
- Test: `test/matcher.test.js` (agregar tests para el endpoint nuevo)

**Interfaces:**
- Produces: `GET /api/matcher/push-skus-pendientes/list` → `{ ok: true, data: [{ clave, sku, titulo, thumbnail, item_id }] }`, reusando el mismo filtro `wherePend` que ya usan `/push-skus-pendientes` (POST) y `/push-skus-pendientes/count` (GET), definidos en `routes/matcher.js:487-494` y `routes/matcher.js:518-523`.
- Consumes: nada de otras tareas.

- [ ] **Step 1: Escribir el test que falla**

En `test/matcher.test.js`, agregar (después del último `describe` del archivo, siguiendo el mismo estilo de setup que ya usa el archivo — `openDb`, `seedDecision`, `seedCache`):

```javascript
describe('GET /matcher/push-skus-pendientes/list', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    app = express();
    app.use(express.json());
    app.use('/matcher', matcherRouter(db, ML_CFG));
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('devuelve las decisiones pendientes de escribir en ML con datos para mostrar una fila', async () => {
    seedCache(db, { clave: 'MLA1|', itemId: 'MLA1', titulo: 'Bici Roja', status: 'active', sellerSku: '' });
    seedDecision(db, { clave: 'MLA1|', sku: 'FB-100', accion: 'asignar' });

    const res = await request(app).get('/matcher/push-skus-pendientes/list');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ clave: 'MLA1|', sku: 'FB-100', titulo: 'Bici Roja', item_id: 'MLA1' });
  });

  it('no incluye decisiones ya escritas en ML (seller_sku ya coincide)', async () => {
    seedCache(db, { clave: 'MLA2|', itemId: 'MLA2', titulo: 'Bici Azul', status: 'active', sellerSku: 'FB-200' });
    seedDecision(db, { clave: 'MLA2|', sku: 'FB-200', accion: 'asignar' });

    const res = await request(app).get('/matcher/push-skus-pendientes/list');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('no incluye decisiones de publicaciones pausadas/inactivas', async () => {
    seedCache(db, { clave: 'MLA3|', itemId: 'MLA3', titulo: 'Bici Verde', status: 'paused', sellerSku: '' });
    seedDecision(db, { clave: 'MLA3|', sku: 'FB-300', accion: 'confirmar' });

    const res = await request(app).get('/matcher/push-skus-pendientes/list');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr el test para confirmar que falla**

Run: `npx vitest run test/matcher.test.js -t "push-skus-pendientes/list"`
Expected: FAIL — `Cannot GET /matcher/push-skus-pendientes/list` (404) o similar, porque la ruta no existe todavía.

- [ ] **Step 3: Implementar el endpoint**

En `routes/matcher.js`, ubicar el bloque del endpoint `GET '/push-skus-pendientes/count'` (líneas 514-523 aprox.) y agregar el endpoint nuevo justo después:

```javascript
  // Listado (solo lectura) de las decisiones pendientes de escribir en ML — mismo filtro
  // que /push-skus-pendientes (POST) y /count, pero sin ejecutar la escritura. Para una
  // vista enfocada que muestre qué falta antes de disparar la acción en lote.
  router.get('/push-skus-pendientes/list', (req, res) => {
    const rows = db.prepare(`
      SELECT d.clave, d.sku, p.titulo, p.thumbnail, p.item_id
      FROM sku_matcher_decisiones d
      JOIN ml_publicaciones_cache p ON p.clave = d.clave
      WHERE d.accion IN ('asignar','confirmar') AND d.sku LIKE 'FB-%'
        AND p.status = 'active' AND COALESCE(p.seller_sku,'') <> d.sku
      ORDER BY d.actualizado_en DESC
    `).all();
    res.json({ ok: true, data: rows });
  });

```

- [ ] **Step 4: Correr el test para confirmar que pasa**

Run: `npx vitest run test/matcher.test.js -t "push-skus-pendientes/list"`
Expected: PASS — 3 tests verdes.

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: toda la suite pasa (462+3 tests verdes, ningún archivo roto).

- [ ] **Step 6: Commit**

```bash
git add routes/matcher.js test/matcher.test.js
git commit -m "Agregar GET /api/matcher/push-skus-pendientes/list para vista enfocada del home"
```

---

## Task 2: Tokens de severidad en `theme.css`

**Files:**
- Modify: `public/lib/theme.css`

**Interfaces:**
- Produces: variables CSS `--radius-pill`, `--critical`/`--critical-bg`/`--critical-bd`, `--warning`/`--warning-bg`/`--warning-bd`, `--success`/`--success-bg`/`--success-bd`, `--focus-color`, y una regla `:focus-visible` global — consumidas por la Task 4 (home).

- [ ] **Step 1: Leer el archivo actual para ubicar el punto de inserción exacto**

Leer `public/lib/theme.css` completo y ubicar el cierre de `:root { ... }` y confirmar los nombres exactos ya existentes (`--red`, `--red-bg`, `--red-bd`, `--amber`, `--amber-bg`, `--amber-bd`, `--green`, `--green-bg`, `--green-bd`, `--accent`, `--radius-lg`) para que los alias apunten a los nombres reales del archivo (pueden no ser idénticos a los citados por `disenador-ui`; usar los que existan de verdad en el archivo, es la fuente de verdad).

- [ ] **Step 2: Agregar los tokens nuevos**

Insertar, justo antes del `}` que cierra el bloque `:root`, estas líneas (ajustando los nombres del lado derecho a los que confirmaste en el Step 1 si difieren):

```css
  --radius-pill: 999px;

  /* Severidad semántica (panel "Requiere tu atención" del home).
     Aliases sobre colores existentes — el significado no depende del nombre del color. */
  --critical:    var(--red);
  --critical-bg: var(--red-bg);
  --critical-bd: var(--red-bd);
  --warning:     var(--amber);
  --warning-bg:  var(--amber-bg);
  --warning-bd:  var(--amber-bd);
  --success:     var(--green);
  --success-bg:  var(--green-bg);
  --success-bd:  var(--green-bd);

  /* Foco visible (WCAG 2.2 — 2.4.7 / 2.4.13) */
  --focus-color: var(--accent);
```

- [ ] **Step 3: Agregar la regla de foco visible global**

Agregar, después del cierre de `:root { ... }` (fuera del bloque, a nivel de hoja de estilos):

```css
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--focus-color);
  outline-offset: 2px;
  border-radius: 4px;
}
```

- [ ] **Step 4: Verificar que el CSS no tiene errores de sintaxis**

Run: `node -e "const fs=require('fs');const c=fs.readFileSync('public/lib/theme.css','utf8');const open=(c.match(/{/g)||[]).length;const close=(c.match(/}/g)||[]).length;if(open!==close)throw new Error('llaves desbalanceadas: '+open+' vs '+close);console.log('CSS balanceado: '+open+' bloques')"`

Expected: `CSS balanceado: N bloques` sin error (no lanza excepción).

- [ ] **Step 5: Commit**

```bash
git add public/lib/theme.css
git commit -m "Agregar tokens de severidad semántica y foco visible a theme.css"
```

---

## Task 3: Categorías `reactivables` y `push_pendientes` en `sync-detalle`

**Files:**
- Modify: `public/sync-detalle/index.html`

**Interfaces:**
- Consumes: `GET /api/sync/reactivables`, `POST /api/sync/reactivar` (ya existen, sin cambios — ver `routes/sync.js:1118-1176`); `GET /api/matcher/push-skus-pendientes/list` (Task 1), `POST /api/matcher/push-skus-pendientes` (ya existe, sin cambios — `routes/matcher.js:487-512`).
- Produces: `sync-detalle/index.html` acepta `?cat=reactivables` y `?cat=push_pendientes` además de las 4 categorías existentes.

- [ ] **Step 1: Agregar las dos categorías al diccionario `CATS`**

En `public/sync-detalle/index.html`, ubicar el objeto `var CATS={...}` (línea 84 aprox.) y agregar dos entradas nuevas, con `modo` propio para cada una (no reusan `mapeo`/`diagnostico`/`info` porque su render es distinto):

```javascript
var CATS={
  sin_mapeo:{modo:'mapeo',titulo:'Ventas sin SKU mapeado',desc:'Publicaciones que se vendieron en MercadoLibre pero no están vinculadas a un SKU de WooCommerce. Buscá el producto por SKU o nombre y asignáselo. El stock se sincroniza solo en el próximo ciclo. Si la publicación ya no existe o la venta no es relevante, podés descartarla.'},
  remapeo_requerido:{modo:'mapeo',titulo:'Variaciones a re-mapear',desc:'La variación mapeada ya no existe en ML (se editó o recreó la publicación). Si la venta sigue siendo válida, asignale el SKU correcto a la variación actual desde el Matcher. Si esa variación vieja ya no aplica, descartala: nunca vas a poder re-mapearla con esta clave exacta.'},
  requiere_atencion_ml:{modo:'info',titulo:'Exceso de fotos en ML',desc:'ML no permite actualizar estas publicaciones hasta que bajes la cantidad de fotos en tu cuenta de MercadoLibre. Abrí cada una, quitá fotos y el sync se reanuda solo.'},
  errores:{modo:'diagnostico',titulo:'Errores de sincronización',desc:'Cada fallo se diagnostica en vivo contra MercadoLibre y se ofrece la acción que lo resuelve: reactivar (pausada con stock web), desvincular (la variación ya no existe), descartar (sin stock real / pausada a mano) o reintentar.'},
  reactivables:{modo:'reactivables',titulo:'Publicaciones pausadas reactivables',desc:'ML pausó estas publicaciones por quedarse sin stock, pero ya tenés stock en la web. Reactivarlas les empuja el stock actual y las vuelve a poner activas en ML (si el neto cubre el precio de contado).'},
  push_pendientes:{modo:'push_pendientes',titulo:'SKUs pendientes de escribir en ML',desc:'Estas publicaciones tienen SKU asignado en el Matcher pero todavía no se escribió en MercadoLibre. Escribilas en lote para que ML quede con el SKU correcto.'}
};
```

- [ ] **Step 2: Agregar la rama de carga para los dos modos nuevos**

En la función `cargar()` (línea 114 aprox.), después de `if(!d.ok)throw new Error(d.error||'error');`, la línea actual es `cont.innerHTML=render(d.data||[]);` seguida de `if(CFG.modo==='mapeo')wireMapeo();`. Reemplazar toda la función `cargar()` por:

```javascript
async function cargar(){
  var cont=document.getElementById('cuerpo');
  cont.innerHTML='<div class="loading">Cargando…</div>';
  try{
    if(CFG.modo==='reactivables'){ await cargarReactivables(cont); return; }
    if(CFG.modo==='push_pendientes'){ await cargarPushPendientes(cont); return; }
    var r=await fetch('/api/sync/atencion/'+encodeURIComponent(CAT));
    var d=await r.json();
    if(!d.ok)throw new Error(d.error||'error');
    cont.innerHTML=render(d.data||[]);
    if(CFG.modo==='mapeo')wireMapeo();
  }catch(err){
    cont.innerHTML='<div class="loading" style="color:var(--red)">No se pudo cargar: '+esc(err.message)+'</div>';
  }
}
```

- [ ] **Step 3: Agregar el modo `reactivables` — carga y render**

Agregar, después de la función `render(rows)` (después de la línea que cierra esa función, antes de la sección `// ── Búsqueda acotada de SKU...`), el bloque portado de `public/sync-ml/index.html:120-250` (funciones `cargarReactivables`, `renderReactivables`, `toggleAll`, `cancelarReactivar`, `reactivarSel`), adaptado a la firma `cont` en vez de `box` global:

```javascript
// ── Modo reactivables (portado de sync-ml/index.html) ────────────────────────
var LABELS_PRECIO={bajo:'Neto bajo',alto:'Neto alto',sin_precio:'Sin precio',ok:'OK'};

async function cargarReactivables(cont){
  cont.innerHTML='<div class="loading">Verificando publicaciones pausadas…</div>';
  try{
    try{
      var rc=await fetch('/api/sync/reactivables/conteo');
      var dc=await rc.json();
      if(dc.ok){
        var loading=cont.querySelector('.loading');
        if(loading){
          loading.textContent=dc.totalPublicaciones>0
            ? ('Evaluando '+n(dc.totalPublicaciones)+' publicación(es) — verificando precios en ML (puede tardar unos segundos)…')
            : 'Verificando publicaciones pausadas…';
        }
      }
    }catch(e){/* el conteo es cosmético: si falla, seguimos al detalle igual */}
    var r=await fetch('/api/sync/reactivables');
    var d=await r.json();
    if(!d.ok)throw new Error(d.error||'error');
    cont.innerHTML=renderReactivables(d);
  }catch(err){
    cont.innerHTML='<div class="loading" style="color:var(--red)">No se pudo cargar: '+esc(err.message)+'</div>';
  }
}

function renderReactivables(d){
  var pubs=d.data||[];
  if(!pubs.length){
    return '<div class="tbl-wrap"><div class="loading" style="color:var(--green)">✓ Nada para reactivar por ahora.</div></div>';
  }
  var h='<p class="sub" style="margin-bottom:10px">'+n(d.totalPublicaciones)+' publicaciones ('+n(d.totalVariaciones)+' variaciones) que ML pausó por quedarse sin stock y ya tienen stock en la web.</p>';
  h+='<div class="tbl-wrap"><table><thead><tr>';
  h+='<th><input type="checkbox" id="chk-all" checked onclick="toggleAll(this)"></th>';
  h+='<th>Publicación</th><th>SKU(s)</th><th>Stock web</th><th>Precio ML</th><th>Neto</th><th>Precio contado</th><th>Estado</th></tr></thead><tbody>';
  pubs.forEach(function(p){
    var skus=[...new Set(p.variaciones.map(function(v){return v.sku;}).filter(Boolean))];
    var stockTotal=p.variaciones.reduce(function(a,v){return a+(v.stock_disponible_ml||0);},0);
    var thumb=p.thumbnail?'<img class="pub-thumb" src="'+esc(p.thumbnail)+'" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">':'<div class="pub-thumb"></div>';
    var estado=p.estado||'sin_precio';
    h+='<tr>';
    h+='<td><input type="checkbox" class="chk-item" value="'+esc(p.item_id)+'" checked></td>';
    h+='<td><div class="pub-cell">'+thumb+'<div class="pub-txt"><div class="pub-tit">'+esc(p.titulo||p.item_id)+'</div>'
      +'<div class="pub-meta">'+esc(p.item_id)+' · '+p.variaciones.length+' var.</div></div></div></td>';
    h+='<td class="mono">'+esc(skus.slice(0,3).join(', '))+(skus.length>3?(' +'+(skus.length-3)):'')+'</td>';
    h+='<td>'+n(stockTotal)+'</td>';
    h+='<td>'+money(p.precio_ml)+'</td>';
    h+='<td><b>'+money(p.neto)+'</b></td>';
    h+='<td>'+money(p.precio_web)+'</td>';
    h+='<td><span class="tag '+(estado==='ok'?'ok':'paused')+'">'+esc(LABELS_PRECIO[estado]||estado)+'</span></td>';
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  h+='<div class="acc-btns" style="margin-top:12px"><button class="btn" id="btn-react" onclick="reactivarSel()">Reactivar seleccionadas</button>'
   +'<button class="btn sec" id="btn-react-cancel" onclick="cancelarReactivar()" style="display:none">Cancelar</button></div>';
  h+='<div class="msg" id="react-msg"></div>';
  return h;
}

function toggleAll(cb){document.querySelectorAll('.chk-item').forEach(function(x){x.checked=cb.checked;});}

var reactivarCtrl=null;
function cancelarReactivar(){ if(reactivarCtrl)reactivarCtrl.abort(); }

async function reactivarSel(){
  var sel=[...document.querySelectorAll('.chk-item:checked')].map(function(x){return x.value;});
  var msg=document.getElementById('react-msg');
  if(!sel.length){msg.style.color='var(--amber)';msg.textContent='No seleccionaste ninguna publicación.';return;}
  if(!confirm('Vas a reactivar '+sel.length+' publicación(es) en MercadoLibre.\n\nSe les empuja el stock actual de la web y pasan a estado activo. ¿Confirmás?'))return;
  var btn=document.getElementById('btn-react');btn.disabled=true;
  var btnCancel=document.getElementById('btn-react-cancel');
  if(btnCancel){btnCancel.style.display='';btnCancel.disabled=false;}
  reactivarCtrl=new AbortController();
  var CHUNK=10,okTotal=0,errTotal=0,omitTotal=0,noProcTotal=0,fallos=[],omitidos=[];
  var cancelado=false;
  msg.style.color='var(--muted)';
  try{
    for(var i=0;i<sel.length;i+=CHUNK){
      if(reactivarCtrl.signal.aborted){cancelado=true;noProcTotal=sel.length-i;break;}
      msg.textContent='Reactivando… '+Math.min(i+CHUNK,sel.length)+'/'+sel.length+' (podés cancelar; los que ya se están procesando terminan)';
      try{
        var r=await fetch('/api/sync/reactivar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemIds:sel.slice(i,i+CHUNK)}),signal:reactivarCtrl.signal});
        var d=await r.json();
        if(!d.ok)throw new Error(d.error||'error');
        (d.resultados||[]).forEach(function(x){
          if(x.ok){okTotal++;}
          else if(x.omitido){omitTotal++;if(omitidos.length<8)omitidos.push(x.item_id+': '+(x.motivo||'omitida'));}
          else{errTotal++;if(fallos.length<8)fallos.push(x.item_id+': '+(x.error||'error'));}
        });
      }catch(e){
        if(e.name==='AbortError'){cancelado=true;noProcTotal=sel.length-i;break;}
        throw e;
      }
    }
    var hayPend=(errTotal||omitTotal||noProcTotal);
    msg.style.color=hayPend?'var(--amber)':'var(--green)';
    msg.textContent=(cancelado?'⚠ Cancelado. ':'✓ ')+'Reactivadas '+okTotal
      +(omitTotal?(' · '+omitTotal+' omitida(s): '+omitidos.join(' | ')):'')
      +(errTotal?(' · '+errTotal+' con error: '+fallos.join(' | ')):'')
      +(noProcTotal?(' · '+noProcTotal+' sin procesar por cancelación'):'')
      +'. Actualizando estado…';
    var cont=document.getElementById('cuerpo');
    await cargarReactivables(cont);
  }catch(err){
    msg.style.color='var(--red)';msg.textContent='✗ '+err.message;
  }finally{
    reactivarCtrl=null;
    btn.disabled=false;
    if(btnCancel){btnCancel.style.display='none';btnCancel.disabled=false;}
  }
}
```

- [ ] **Step 4: Agregar el modo `push_pendientes` — carga, render y escritura en lote**

Agregar, después del bloque anterior:

```javascript
// ── Modo push_pendientes (escribir SKUs pendientes en ML) ────────────────────
async function cargarPushPendientes(cont){
  try{
    var r=await fetch('/api/matcher/push-skus-pendientes/list');
    var d=await r.json();
    if(!d.ok)throw new Error(d.error||'error');
    cont.innerHTML=renderPushPendientes(d.data||[]);
  }catch(err){
    cont.innerHTML='<div class="loading" style="color:var(--red)">No se pudo cargar: '+esc(err.message)+'</div>';
  }
}

function renderPushPendientes(rows){
  if(!rows.length){
    return '<div class="tbl-wrap"><div class="loading" style="color:var(--green)">✓ No hay SKUs pendientes de escribir en ML.</div></div>';
  }
  var h='<p class="sub" style="margin-bottom:10px">'+n(rows.length)+' SKU(s) pendiente(s) de escribir en ML.</p>';
  h+='<div class="tbl-wrap"><table><thead><tr><th>Publicación</th><th>SKU a escribir</th></tr></thead><tbody>';
  rows.forEach(function(row){
    var thumb=row.thumbnail?'<img class="pub-thumb" src="'+esc(row.thumbnail)+'" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">':'<div class="pub-thumb"></div>';
    h+='<tr><td><div class="pub-cell">'+thumb+'<div class="pub-txt"><div class="pub-tit">'+esc(row.titulo||row.item_id)+'</div>'
      +'<div class="pub-meta">'+esc(row.item_id||row.clave)+'</div></div></div></td>';
    h+='<td class="mono">'+esc(row.sku)+'</td></tr>';
  });
  h+='</tbody></table></div>';
  h+='<div class="acc-btns" style="margin-top:12px"><button class="btn" id="btn-push" onclick="escribirPendientes()">Escribir '+rows.length+' SKU(s) en ML</button></div>';
  h+='<div class="msg" id="push-msg"></div>';
  return h;
}

async function escribirPendientes(){
  var btn=document.getElementById('btn-push');
  var msg=document.getElementById('push-msg');
  if(!confirm('Vas a escribir estos SKUs en MercadoLibre. ¿Confirmás?'))return;
  btn.disabled=true;
  var totalEscritos=0,totalErrores=0;
  msg.style.color='var(--muted)';
  try{
    var restantes=1;
    while(restantes>0){
      msg.textContent='Escribiendo… (llevás '+totalEscritos+' escritos)';
      var r=await fetch('/api/matcher/push-skus-pendientes',{method:'POST'});
      var d=await r.json();
      if(!d.ok)throw new Error(d.error||'error');
      totalEscritos+=d.escritos||0;
      totalErrores+=d.errores||0;
      restantes=d.restantes||0;
      if((d.procesados||0)===0)break;
    }
    msg.style.color=totalErrores?'var(--amber)':'var(--green)';
    msg.textContent='✓ Escritos '+totalEscritos+(totalErrores?(' · '+totalErrores+' con error'):'')+'. Actualizando…';
    var cont=document.getElementById('cuerpo');
    await cargarPushPendientes(cont);
  }catch(err){
    msg.style.color='var(--red)';msg.textContent='✗ '+err.message;
  }finally{
    btn.disabled=false;
  }
}
```

- [ ] **Step 5: Verificar balance de llaves del JS agregado**

Run: `node --check public/sync-detalle/index.html 2>&1 || node -e "
const fs=require('fs');
const html=fs.readFileSync('public/sync-detalle/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s,i)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`

Expected: `scripts inline OK: N` sin excepción de sintaxis (el primer intento con `node --check` fallará porque el archivo es HTML, no JS puro — usar el segundo comando, que extrae y valida cada bloque `<script>` inline).

- [ ] **Step 6: Commit**

```bash
git add public/sync-detalle/index.html
git commit -m "Agregar categorías reactivables y push_pendientes a sync-detalle"
```

---

## Task 4: Rediseño de `public/home/index.html`

**Files:**
- Modify: `public/home/index.html`

**Interfaces:**
- Consumes: tokens de la Task 2 (`--critical`, `--warning`, `--success`, `--focus-color`), categorías nuevas de la Task 3 (`?cat=reactivables`, `?cat=push_pendientes`).

- [ ] **Step 1: Arreglar el bug de HTML de "Cobertura de Catálogo"**

En `public/home/index.html`, localizar el bloque huérfano (líneas 490-508 en el estado actual):

```html
      <a class="card card-control" href="/herramientas/cobertura/" data-admin-only>
        ...
      </a>
    </div>
  </section>

  <!-- CONTROL -->
  <section class="category">
```

Mover la card de Cobertura DENTRO de la sección "CONTROL" existente, como primera card de esa sección (antes de "Contador de Inventario"), y eliminar el `</div></section>` sobrante que quedaba después de la card huérfana. El resultado: la sección "INGRESO" cierra normalmente en su `</section>` (sin la card de Cobertura ni el div/section extra), y la sección "CONTROL" arranca con Cobertura como primera card, seguida de Inventario, Consulta de Precios, Códigos, Etiquetas.

- [ ] **Step 2: Enlazar `theme.css` y eliminar duplicación de tokens**

Reemplazar el bloque `:root { ... }` (líneas 10-25) por una carga de `theme.css` más los overrides de categoría propios del home que no están en el tema compartido:

```html
<link rel="stylesheet" href="../lib/theme.css">
<style>
:root {
  --blue:       #60A5FA;
  --blue-dim:   rgba(96,165,250,.10);
  --purple:     #A78BFA;
  --purple-dim: rgba(167,139,250,.10);
}
```

(el resto del `<style>` sigue igual — este paso solo reemplaza el `<style>` de apertura y el bloque `:root`, cambiando `--muted` para que venga de `theme.css` en vez de la definición local `#7A87A3`; confirmar que `theme.css` expone `--muted`, `--green`, `--accent`, `--accent-dim`, `--bg`, `--surface`, `--surface2`, `--border`, `--text` con los mismos nombres que ya usa este archivo, ya que son los que el resto del CSS de home referencia sin cambios).

- [ ] **Step 3: Reordenar el `<main>` — atención primero, luego progreso, luego tarjetas**

El `<section id="panel-estado">` (línea 407 aprox.) hoy contiene barras (`#pe-barras`) y atención (`#pe-atencion`) en ese orden. Separar en dos secciones y reordenar: la franja de atención va primero (inmediatamente después de `.page-header`), las barras de progreso van después, antes de las tarjetas:

```html
  <!-- REQUIERE TU ATENCIÓN -->
  <section id="panel-atencion" style="display:none;margin-bottom:22px">
    <div class="attn-header">
      <span class="attn-title">Requiere tu atención</span>
      <span class="attn-updated" id="attn-updated"></span>
    </div>
    <div id="pe-atencion"></div>
  </section>

  <!-- PROGRESO -->
  <section id="panel-progreso" style="display:none;margin-bottom:26px">
    <div id="pe-barras" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px"></div>
  </section>
```

Esto reemplaza el único `<section id="panel-estado">...</section>` de antes por estas dos secciones nuevas, ubicadas antes de `<!-- INGRESO -->`.

- [ ] **Step 4: Agregar CSS de la franja de atención (severidad multi-canal, no solo color)**

Agregar al final del bloque `<style>` (antes de `</style>`), usando los tokens de la Task 2:

```css
/* ── Franja "Requiere tu atención" ── */
.attn-header { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:12px; }
.attn-title { font-size:.95rem; font-weight:800; letter-spacing:-.01em; color:var(--text); }
.attn-updated { font-size:.7rem; color:var(--muted); }

.attn-group { margin-bottom:10px; }
.attn-glabel { font-size:.68rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:7px; display:flex; align-items:center; gap:6px; }
.attn-chips { display:flex; gap:10px; flex-wrap:wrap; }

.chip { display:inline-flex; align-items:center; gap:10px; min-height:52px; padding:9px 16px; border-radius:14px; text-decoration:none; cursor:pointer; transition:transform .12s, border-color .15s; }
.chip:hover { transform:translateY(-1px); }
.chip-num { font-size:1.35rem; font-weight:800; font-variant-numeric:tabular-nums; line-height:1; }
.chip-label { font-size:.8rem; color:var(--text); line-height:1.25; }

.chip.crit { background:var(--critical-bg); border:1px solid var(--critical-bd); }
.chip.crit .chip-num { color:var(--critical); }
.chip.warn { background:var(--surface2); border:1px solid var(--warning-bd); }
.chip.warn .chip-num { color:var(--warning); }

.attn-ok { display:inline-flex; align-items:center; gap:8px; background:var(--success-bg); border:1px solid var(--success-bd); border-radius:12px; padding:10px 16px; font-size:.83rem; color:var(--success); font-weight:600; }
.attn-error { display:inline-flex; align-items:center; gap:8px; background:var(--critical-bg); border:1px solid var(--critical-bd); border-radius:12px; padding:10px 16px; font-size:.83rem; color:var(--critical); }
.attn-error button { background:transparent; border:1px solid var(--critical-bd); color:var(--critical); border-radius:6px; padding:3px 9px; font-size:.75rem; cursor:pointer; margin-left:4px; }

.prog-item { background:transparent; border:1px solid var(--border); border-radius:12px; padding:13px 15px; }
.prog-top { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; }
.prog-label { font-size:.75rem; color:var(--muted); }
.prog-pct { font-size:.95rem; font-weight:700; font-variant-numeric:tabular-nums; }
.prog-bar { height:7px; border-radius:6px; background:var(--surface2); overflow:hidden; }
.prog-fill { height:100%; border-radius:6px; transition:width .8s cubic-bezier(.16,1,.3,1); }
.prog-sub { font-size:.7rem; color:var(--muted); margin-top:7px; }
```

- [ ] **Step 5: Reescribir la lógica JS del panel — jerarquía, agrupación por severidad, filtro por permiso, error visible**

Reemplazar por completo las funciones `peBarra`, `peChip`, `peMostrar` y el bloque `if (!tienePermiso('sync-ml') && tienePermiso('matcher')) { ... } else if (tienePermiso('sync-ml')) { ... }` (líneas 726-778 del archivo actual) por:

```javascript
  // ── Progreso (contexto, subordinado) ──
  function peBarra(label, valor, total, colorVar, sub) {
    var pct = total > 0 ? Math.round(valor / total * 100) : 0;
    return '<div class="prog-item">'
      + '<div class="prog-top"><span class="prog-label">' + label + '</span>'
      + '<span class="prog-pct" style="color:var(' + colorVar + ')">' + pct + '%</span></div>'
      + '<div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%;background:var(' + colorVar + ')"></div></div>'
      + '<div class="prog-sub">' + sub + '</div></div>';
  }

  // Chip de atención. severidad: 'crit' | 'warn'. tool: id de herramienta destino (para
  // filtrar por permiso) o null si no aplica el filtro (ej. ya viene de un fetch acotado
  // por permiso, como el chip de matcher-only).
  function peChip(num, label, severidad, href, tool) {
    if (!num) return null;
    if (tool && !tienePermiso(tool)) return null; // no ofrecer un destino que el usuario no puede abrir
    return { num: num, label: label, severidad: severidad, href: href };
  }

  function renderChips(chips) {
    var crit = chips.filter(function(c) { return c.severidad === 'crit'; });
    var warn = chips.filter(function(c) { return c.severidad === 'warn'; });
    var h = '';
    if (crit.length) {
      h += '<div class="attn-group"><div class="attn-glabel">⚠ Bloquea sync / plata</div><div class="attn-chips">'
        + crit.map(chipHtml).join('') + '</div></div>';
    }
    if (warn.length) {
      h += '<div class="attn-group"><div class="attn-glabel">◔ Pendiente</div><div class="attn-chips">'
        + warn.map(chipHtml).join('') + '</div></div>';
    }
    return h;
  }
  function chipHtml(c) {
    return '<a class="chip ' + c.severidad + '" href="' + c.href + '">'
      + '<span class="chip-num">' + c.num.toLocaleString('es-AR') + '</span>'
      + '<span class="chip-label">' + c.label + '</span></a>';
  }

  function peMostrarAtencion() { document.getElementById('panel-atencion').style.display = 'block'; }
  function peMostrarProgreso() { document.getElementById('panel-progreso').style.display = 'block'; }

  function peError(mensaje, reintentar) {
    document.getElementById('pe-atencion').innerHTML =
      '<div class="attn-error">✗ ' + mensaje + ' <button onclick="(' + reintentar + ')()">Reintentar ↻</button></div>';
    peMostrarAtencion();
  }

  function cargarPanelSoloMatcher() {
    fetch('/api/matcher/push-skus-pendientes/count').then(function(r){return r.json();}).then(function(d){
      if (!d.ok) return;
      var chips = [peChip(d.pendientes, 'SKUs por escribir en ML', 'warn', '/herramientas/sync-detalle/?cat=push_pendientes', null)].filter(Boolean);
      document.getElementById('pe-atencion').innerHTML = chips.length ? renderChips(chips)
        : '<span class="attn-ok">✓ Todo al día — nada requiere tu atención.</span>';
      peMostrarAtencion();
    }).catch(function(){ peError('No se pudo cargar el estado.', 'cargarPanelSoloMatcher'); });
  }

  function cargarPanelSync() {
    fetch('/api/sync/dashboard').then(function(r){return r.json();}).then(function(d){
      if (!d.ok) return;
      var st = d.stock || {}, at = d.atencion || {}, sk = d.skus || { escritos: 0, pendientes: 0 };
      var activPend = Math.max(0, (st.pendientes || 0) - (st.pendientesPausadas || 0));
      var totalActiv = (st.sincronizadas || 0) + activPend;

      document.getElementById('pe-barras').innerHTML = [
        peBarra('Stock sincronizado a ML', st.sincronizadas || 0, totalActiv, '--success',
          (st.sincronizadas || 0).toLocaleString('es-AR') + ' publicaciones · ' + (st.pendientesPausadas || 0).toLocaleString('es-AR') + ' pausadas no sincronizan'),
        peBarra('SKUs cargados en ML', sk.escritos, sk.escritos + sk.pendientes, '--accent',
          sk.pendientes.toLocaleString('es-AR') + ' pendientes de escribir en ML')
      ].join('');
      peMostrarProgreso();

      var chips = [
        peChip(at.errores_reales, 'errores de sync', 'crit', '/herramientas/sync-detalle/?cat=errores', 'sync-ml'),
        peChip(at.requiere_atencion_ml, 'con exceso de fotos', 'crit', '/herramientas/sync-detalle/?cat=requiere_atencion_ml', 'sync-ml'),
        peChip(d.reactivables, 'publicaciones pausadas · reactivar', 'warn', '/herramientas/sync-detalle/?cat=reactivables', 'sync-ml'),
        peChip(sk.pendientes, 'SKUs por escribir en ML', 'warn', '/herramientas/sync-detalle/?cat=push_pendientes', 'matcher'),
        peChip(at.sin_mapeo, 'ventas sin mapear', 'warn', '/herramientas/sync-detalle/?cat=sin_mapeo', 'sync-ml'),
        peChip(at.remapeo_requerido, 'a re-mapear', 'warn', '/herramientas/sync-detalle/?cat=remapeo_requerido', 'sync-ml')
      ].filter(Boolean);
      document.getElementById('pe-atencion').innerHTML = chips.length ? renderChips(chips)
        : '<span class="attn-ok">✓ Todo al día — nada requiere tu atención.</span>';
      document.getElementById('attn-updated').textContent = 'actualizado ' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      peMostrarAtencion();
    }).catch(function(){ peError('No se pudo cargar el estado de ML.', 'cargarPanelSync'); });
  }

  if (!tienePermiso('sync-ml') && tienePermiso('matcher')) {
    cargarPanelSoloMatcher();
  } else if (tienePermiso('sync-ml')) {
    cargarPanelSync();
  }
```

Nota: el chip "SKUs por escribir en ML" dentro de `cargarPanelSync` pasa `'matcher'` como tool de permiso (el destino `push_pendientes` requiere ese permiso), aunque el usuario ya tiene `sync-ml` — si no tiene además `matcher`, ese chip específico no se muestra, evitando el callejón sin salida que señaló `disenador-ux`.

- [ ] **Step 6: Verificar balance de llaves y ausencia de referencias a la función vieja**

Run: `grep -n "peMostrar()" public/home/index.html`
Expected: sin salida (la función vieja `peMostrar()` ya no existe, se reemplazó por `peMostrarAtencion()`/`peMostrarProgreso()`).

Run: `node -e "
const fs=require('fs');
const html=fs.readFileSync('public/home/index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s)=>{ new Function(s); });
console.log('scripts inline OK: '+scripts.length);
"`
Expected: `scripts inline OK: N` sin excepción.

- [ ] **Step 7: Verificar que el HTML de Cobertura quedó bien anidado**

Run: `grep -n 'card-control.*cobertura\|section class="category"' public/home/index.html`
Expected: la card de Cobertura aparece dentro de la sección Control (entre el `<section class="category">` de Control y su `</section>` de cierre), y solo hay 3 aperturas de `<section class="category"` en todo el archivo (Ingreso, Control, Sincronización) — confirmar visualmente contando la salida.

- [ ] **Step 8: Commit**

```bash
git add public/home/index.html
git commit -m "Rediseñar home: jerarquía atención>progreso>tarjetas, fix bug Cobertura, migrar a theme.css"
```

---

## Self-Review

1. **Cobertura del spec/UX/UI:** bug de Cobertura (Task 4 Step 1) ✓; jerarquía atención→progreso→tarjetas (Task 4 Step 3) ✓; chips agrupados por severidad con multi-canal (Task 4 Steps 4-5) ✓; reactivables y push_pendientes con acción a mano (Task 3) ✓; filtro de chips por permiso (Task 4 Step 5, `peChip` con parámetro `tool`) ✓; error visible en vez de catch silencioso (Task 4 Step 5, `peError`) ✓; barras con absoluto + % (Task 4 Step 5, `peBarra` con `sub`) ✓; migración a `theme.css` (Task 4 Step 2) ✓; tokens WCAG (Task 2) ✓.
2. **Placeholders:** ninguno — cada paso trae el código exacto a insertar/reemplazar.
3. **Consistencia de nombres:** `renderReactivables`/`toggleAll`/`reactivarSel`/`cancelarReactivar` en Task 3 usan los mismos nombres que la fuente portada (`sync-ml/index.html`) para minimizar riesgo de transcripción; `peChip`/`peBarra`/`peMostrarAtencion`/`peMostrarProgreso`/`peError` en Task 4 son consistentes entre su definición y su uso dentro del mismo Step 5.
