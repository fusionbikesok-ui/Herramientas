# Heurística de kit_transmision — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir fijar el perfil de fotos de un producto puntual por SKU exacto, con
prioridad sobre la regla de categoría (substring) y la heurística de nombre existentes,
sin tocar ninguna de esas dos.

**Architecture:** Node/Express ESM + better-sqlite3 (`routes/preparacion.js`). Frontend:
`public/preparacion/index.html`, tab "Perfiles de foto" (segunda sección).

## Global Constraints

- Contenido y comentarios en español.
- No tocar `resolverPerfil` (`lib/preparacion.js`) ni la resolución por categoría
  existente — el SKU se agrega como nivel de prioridad más alto, no como reemplazo.
- Orden final: **SKU exacto → categoría (substring) → heurística de nombre**.
- Al final, correr `npm test` completo y confirmar suite verde.

---

## Task 1: Backend — tabla, prioridad de resolución, endpoints

**Files:**
- Modify: `routes/preparacion.js` (`ensureTables`, `perfilParaItem`,
  `requisitosParaItem`, nuevos endpoints, y el call-site en `crearPreparacion`)
- Test: `test/preparacion.test.js` (o `preparacion-contrato.test.js`, seguir el patrón
  del archivo donde ya estén los tests de `resolverPerfil`/`requisitosFoto` — revisar
  antes de elegir)

**Interfaces:**
- Produce: `GET /perfiles-sku` → `{ ok, data: [...] }`.
- Produce: `PUT /perfiles-sku/:sku` → upsert `{ sku, perfil, requisitos_json? }`.
- Produce: `DELETE /perfiles-sku/:sku`.
- Cambia: `perfilParaItem`/`requisitosParaItem` ahora reciben `sku` y lo chequean
  primero.

- [ ] **Step 1: Escribir los tests que fallan**

Primero, ubicar dónde viven hoy los tests de `perfilParaItem`/reglas de categoría (son
funciones internas no exportadas de `routes/preparacion.js` — probablemente probadas de
forma indirecta vía `crearPreparacion` + lectura de `preparacion_items.perfil`, o vía el
endpoint `GET /perfiles`). Agregar en el archivo de test correspondiente:

```js
describe('override de perfil por SKU', () => {
  it('un SKU con regla propia tiene prioridad sobre la regla de categoría', async () => {
    const db2 = db; // usar el db de este describe/beforeEach
    // Sembrar una regla de categoría que diría 'sellado' para 'ACCESORIOS'...
    db2.prepare(`INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)`).run(new Date().toISOString());
    // ...pero un SKU puntual de esa categoría es en realidad un kit de transmisión:
    db2.prepare(`INSERT INTO preparacion_perfiles_sku (sku, perfil, actualizado_en) VALUES ('KIT-777','kit_transmision',?)`).run(new Date().toISOString());

    const id = crearPreparacion(db2, {
      canal: 'web', wcOrderId: 950, numeroPedido: '950', comprador: 'X',
      items: [{ line_item_id: 1, product_id: 1, sku: 'KIT-777', nombre: 'Producto genérico', categoria: 'ACCESORIOS', cantidad: 1 }],
    });
    const item = db2.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
    expect(item.perfil).toBe('kit_transmision');
  });

  it('sin regla de SKU, sigue aplicando la regla de categoría como hasta ahora', async () => {
    db.prepare(`INSERT INTO preparacion_perfiles (categoria, perfil, actualizado_en) VALUES ('ACCESORIOS','sellado',?)`).run(new Date().toISOString());
    const id = crearPreparacion(db, {
      canal: 'web', wcOrderId: 951, numeroPedido: '951', comprador: 'X',
      items: [{ line_item_id: 1, product_id: 1, sku: 'CUALQUIERA', nombre: 'Otro producto', categoria: 'ACCESORIOS', cantidad: 1 }],
    });
    const item = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').get(id);
    expect(item.perfil).toBe('sellado');
  });

  it('GET /perfiles-sku devuelve las reglas guardadas', async () => {
    const r0 = await request(app).get('/api/preparacion/perfiles-sku');
    expect(r0.body.data).toEqual([]);
    await request(app).put('/api/preparacion/perfiles-sku/ABC-1').send({ perfil: 'kit_transmision' });
    const r1 = await request(app).get('/api/preparacion/perfiles-sku');
    expect(r1.body.data).toHaveLength(1);
    expect(r1.body.data[0]).toMatchObject({ sku: 'ABC-1', perfil: 'kit_transmision' });
  });

  it('PUT /perfiles-sku/:sku normaliza a mayúsculas y hace upsert (no duplica)', async () => {
    await request(app).put('/api/preparacion/perfiles-sku/xyz-9').send({ perfil: 'bici' });
    await request(app).put('/api/preparacion/perfiles-sku/XYZ-9').send({ perfil: 'kit_transmision' });
    const r = await request(app).get('/api/preparacion/perfiles-sku');
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].perfil).toBe('kit_transmision');
  });

  it('PUT /perfiles-sku/:sku con perfil inválido → 400', async () => {
    const r = await request(app).put('/api/preparacion/perfiles-sku/ABC-2').send({ perfil: 'invalido' });
    expect(r.status).toBe(400);
  });

  it('DELETE /perfiles-sku/:sku borra la regla', async () => {
    await request(app).put('/api/preparacion/perfiles-sku/DEL-1').send({ perfil: 'bici' });
    await request(app).delete('/api/preparacion/perfiles-sku/DEL-1');
    const r = await request(app).get('/api/preparacion/perfiles-sku');
    expect(r.body.data).toHaveLength(0);
  });
});
```

(Adaptar los nombres `db`/`app`/`crearPreparacion` al `describe` donde se inserten,
siguiendo el patrón ya usado en ese archivo — leer el `beforeEach` del bloque elegido
antes de escribir para no asumir nombres de variables.)

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run -t "override de perfil por SKU"`
Expected: FAIL — tabla/endpoints no existen.

- [ ] **Step 3: Tabla nueva en `ensureTables`**

```js
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_perfiles_sku (
    sku             TEXT PRIMARY KEY,
    perfil          TEXT NOT NULL,
    requisitos_json TEXT,
    actualizado_en  TEXT NOT NULL
  )`).run();
```

(Junto a la creación de `preparacion_perfiles`, sin seed — arranca vacía, ver Decisión 5
del spec.)

- [ ] **Step 4: `perfilParaItem` y `requisitosParaItem` chequean SKU primero**

```js
function perfilParaItem(db, { sku, categoria, nombre }) {
  const skuNorm = String(sku || '').trim().toUpperCase();
  if (skuNorm) {
    const reglaSku = db.prepare('SELECT perfil FROM preparacion_perfiles_sku WHERE sku=?').get(skuNorm);
    if (reglaSku) return reglaSku.perfil;
  }
  const cats = String(categoria || '').toUpperCase();
  if (cats) {
    const reglas = db.prepare('SELECT categoria, perfil FROM preparacion_perfiles ORDER BY LENGTH(categoria) DESC').all();
    for (const r of reglas) {
      if (cats.includes(r.categoria.toUpperCase())) return r.perfil;
    }
  }
  return resolverPerfil({ categorias: categoria, nombre });
}
```

```js
function requisitosParaItem(db, item) {
  const skuNorm = String(item.sku || '').trim().toUpperCase();
  if (skuNorm) {
    const reglaSku = db.prepare('SELECT requisitos_json FROM preparacion_perfiles_sku WHERE sku=? AND requisitos_json IS NOT NULL').get(skuNorm);
    if (reglaSku) {
      try {
        const custom = JSON.parse(reglaSku.requisitos_json);
        const slots = custom[item.estado_embalaje || 'default'] || custom.default;
        if (Array.isArray(slots) && slots.length) return slots;
      } catch (_) { /* JSON inválido: sigue con categoría/default */ }
    }
  }
  // ...resto de la función igual que hoy (categoría, después default)...
}
```

(Insertar el bloque de SKU antes del bloque de categoría ya existente en
`requisitosParaItem` — no reescribir el resto de la función.)

- [ ] **Step 5: Pasar `sku` en el call-site de `crearPreparacion`**

En el loop de `crearPreparacion` (donde hoy dice
`perfilParaItem(db, { categoria: it.categoria, nombre: it.nombre })`):

```js
const perfil = perfilParaItem(db, { sku: it.sku, categoria: it.categoria, nombre: it.nombre });
```

- [ ] **Step 6: Endpoints, calcados de `/perfiles/:categoria`**

Junto a los endpoints existentes de `/perfiles`:

```js
  router.get('/perfiles-sku', (req, res) => {
    const rows = db.prepare('SELECT * FROM preparacion_perfiles_sku ORDER BY sku').all();
    res.json({ ok: true, data: rows });
  });

  router.put('/perfiles-sku/:sku', (req, res) => {
    const sku = String(req.params.sku || '').trim().toUpperCase();
    const { perfil, requisitos_json = null } = req.body || {};
    if (!sku || !['bici', 'kit_transmision', 'sellado'].includes(perfil)) {
      return res.status(400).json({ ok: false, error: 'sku y perfil válidos requeridos' });
    }
    db.prepare(`INSERT INTO preparacion_perfiles_sku (sku, perfil, requisitos_json, actualizado_en)
      VALUES (?,?,?,?)
      ON CONFLICT(sku) DO UPDATE SET perfil=excluded.perfil, requisitos_json=excluded.requisitos_json, actualizado_en=excluded.actualizado_en`)
      .run(sku, perfil, requisitos_json ? JSON.stringify(requisitos_json) : null, now());
    res.json({ ok: true });
  });

  router.delete('/perfiles-sku/:sku', (req, res) => {
    db.prepare('DELETE FROM preparacion_perfiles_sku WHERE sku=?').run(String(req.params.sku || '').trim().toUpperCase());
    res.json({ ok: true });
  });
```

- [ ] **Step 7: Correr y confirmar que pasan**

Run: `npm test`
Expected: PASS (toda la suite).

- [ ] **Step 8: Commit**

```bash
git add routes/preparacion.js test/*.test.js
git commit -m "Preparación: override de perfil por SKU exacto (prioridad sobre categoría)"
```

---

## Task 2: Frontend — segunda sección en "Perfiles de foto"

**Files:**
- Modify: `public/preparacion/index.html` (`cargarPerfiles`)
- No hace falta test automatizado — se verifica con Playwright antes de mergear.

- [ ] **Step 1: Agregar la sección de SKU debajo de la de categoría**

En `cargarPerfiles()`, después de armar `html` con las reglas de categoría (antes de
`c.innerHTML=html;`), agregar una segunda sección que carga y renderiza
`preparacion_perfiles_sku` con el mismo patrón exacto que la de categoría — pedir
ambos listados (`/perfiles` y `/perfiles-sku`) en paralelo con `Promise.all` al
principio de la función, en vez de un segundo `await` secuencial:

```js
var [rPerf, rSku] = await Promise.all([api('/perfiles'), api('/perfiles-sku')]);
if(!rPerf.body.ok)throw new Error(rPerf.body.error||'error');
if(!rSku.body.ok)throw new Error(rSku.body.error||'error');
var rows=rPerf.body.data||[];
var rowsSku=rSku.body.data||[];
```

(Reemplaza el `var r=await api('/perfiles'); ... var rows=r.body.data||[];` actual por
lo de arriba.)

Al final de `html` (antes de `c.innerHTML=html;`), agregar:

```js
html+='<div style="margin-top:24px;border-top:1px dashed var(--border);padding-top:14px">'
  +'<p class="sub">Reglas por <b>SKU exacto</b> — tienen prioridad sobre las reglas por categoría de arriba. Para un producto puntual mal clasificado por la heurística.</p>'
  +rowsSku.map(function(p){
    return '<div class="perf-row">'
      +'<input value="'+esc(p.sku)+'" disabled style="flex:1;min-width:150px;font-family:monospace">'
      +'<select id="perfsku-'+esc(p.sku)+'">'
      +['bici','kit_transmision','sellado'].map(function(v){return '<option'+(p.perfil===v?' selected':'')+'>'+v+'</option>';}).join('')
      +'</select>'
      +'<button class="btn mini" onclick="guardarPerfilSku(\''+esc(p.sku)+'\')">Guardar</button>'
      +'<button class="btn danger mini" onclick="borrarPerfilSku(\''+esc(p.sku)+'\')">Borrar</button>'
      +'</div>';
  }).join('')
  +'<div class="perf-row" style="margin-top:14px">'
  +'<input id="perfsku-nuevo-sku" placeholder="SKU exacto (ej: FB-52590)" style="flex:1;min-width:150px;font-family:monospace">'
  +'<select id="perfsku-nuevo-perfil"><option>bici</option><option>kit_transmision</option><option selected>sellado</option></select>'
  +'<button class="btn mini" onclick="agregarPerfilSku()">Agregar</button></div>'
  +'</div>';
```

- [ ] **Step 2: Funciones de guardar/borrar/agregar, calcadas de las de categoría**

```js
async function guardarPerfilSku(sku){
  var perfil=document.getElementById('perfsku-'+sku).value;
  await api('/perfiles-sku/'+encodeURIComponent(sku),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({perfil:perfil})});
  cargarPerfiles();
}
async function borrarPerfilSku(sku){
  if(!confirm('¿Borrar la regla del SKU "'+sku+'"?'))return;
  await api('/perfiles-sku/'+encodeURIComponent(sku),{method:'DELETE'});
  cargarPerfiles();
}
async function agregarPerfilSku(){
  var sku=document.getElementById('perfsku-nuevo-sku').value.trim();
  var perfil=document.getElementById('perfsku-nuevo-perfil').value;
  if(!sku)return;
  await api('/perfiles-sku/'+encodeURIComponent(sku),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({perfil:perfil})});
  cargarPerfiles();
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

- [ ] **Step 4: Commit**

```bash
git add public/preparacion/index.html
git commit -m "Preparación: sección de reglas por SKU en Perfiles de foto"
```

## Self-Review

1. **Cobertura del spec**: tabla nueva ✓; prioridad SKU > categoría > heurística ✓;
   endpoints calcados del patrón existente ✓; UI con mismo look ✓; sin tocar
   `resolverPerfil` ✓.
2. **Chequeo de redundancia**: no se duplica la lógica de categoría — el bloque de SKU
   se antepone, el resto de ambas funciones queda igual.
3. **Placeholders**: ninguno, salvo la instrucción explícita de revisar el `describe`
   exacto donde insertar los tests antes de asumir nombres de variables.
