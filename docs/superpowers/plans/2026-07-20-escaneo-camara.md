# Escaneo de códigos por cámara — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar lectura de códigos (EAN/SKU) por cámara del celular a Preparación de pedidos (ya tiene un botón de cámara solo-Android, hay que hacerlo funcionar también en iPhone) y a Conteo de stock (no tiene cámara hoy).

**Architecture:** Un módulo compartido `public/lib/scanner.js` (ES module, sin build step) que usa `BarcodeDetector` nativo cuando existe (Android/Chrome) y si no, carga bajo demanda una librería vendorizada `public/vendor/zxing.min.js` (@zxing/library, fallback para Safari/iPhone). La lógica de "no contar de más al sostener el mismo código quieto" (modo continuo de conteo de stock) vive en un módulo puro separado, `public/lib/scannerGate.js`, testeable con vitest sin DOM ni cámara.

**Tech Stack:** Node/Express (ESM) sirviendo HTML+JS estático sin build step. vitest + supertest para tests existentes. `@zxing/library` v0.23.0 (Apache-2.0) vendorizada, sin CDN.

## Global Constraints

- Sitio ya sirve por HTTPS (`https://herramientas.fusionbikes.com.ar`) — no es necesario resolver contexto seguro para `getUserMedia`.
- Dispositivos de uso real: Android e iPhone — el fallback ZXing es obligatorio, no opcional.
- Vendorizar la librería de fallback en el repo (`public/vendor/`), no usar CDN externo.
- Preparación: cámara en modo **single** (detecta un código, se cierra sola) — comportamiento ya existente, no cambiarlo, solo hacerlo funcionar en más navegadores.
- Conteo de stock: cámara en modo **continuous** — queda abierta, cada lectura muestra un toast breve, no se cierra sola.
- Modo continuo: un código solo se re-arma para volver a disparar cuando la cámara deja de verlo (no por timeout fijo) — evita duplicar al sostener el código quieto.
- Reusar la paleta y clases CSS (`.modal`/`.modal-box` en preparación; `--panel`/`--line`/`--azul`/`--ok` en inventario) ya existentes en cada página — no crear una hoja de estilos nueva.
- No hay infraestructura de tests de frontend (sin jsdom, sin mocks de cámara) — no fabricarla. La lógica de cámara/DOM se verifica manualmente (ver Task 6); solo `scannerGate.js` (lógica pura) tiene tests automatizados.
- `npm test` hoy (2026-07-20) pasa limpio: 24 archivos, 208 tests, 0 fallos. Cualquier fallo nuevo tras un cambio es de ese cambio.

---

### Task 1: Vendorizar ZXing y servir `/vendor`

**Files:**
- Create: `public/vendor/zxing.min.js`
- Modify: `server.js:53-61`
- Modify: `test/server.test.js:34-47`

**Interfaces:**
- Produces: archivo estático servido en `GET /vendor/zxing.min.js`, que al cargarse en un navegador define el global `window.ZXing` (con `window.ZXing.BrowserMultiFormatReader`, usado por Task 3).

- [ ] **Step 1: Escribir el test que falla (RED)**

Editar `test/server.test.js`, dentro del test `'serves static pages without credentials (auth is on /api only)'`:

```js
  it('serves static pages without credentials (auth is on /api only)', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const stock = await request(app).get('/stock/');
    const etiquetas = await request(app).get('/etiquetas/');
    const inventario = await request(app).get('/inventario/');
    const login = await request(app).get('/login/');
    const matcher = await request(app).get('/matcher/');
    const vendorZxing = await request(app).get('/vendor/zxing.min.js');
    expect(stock.status).toBe(200);
    expect(etiquetas.status).toBe(200);
    expect(inventario.status).toBe(200);
    expect(login.status).toBe(200);
    expect(matcher.status).toBe(200);
    expect(vendorZxing.status).toBe(200);
  });
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx vitest run test/server.test.js -t "serves static pages"`
Expected: FAIL — `expected 404 to be 200` en `vendorZxing.status` (la carpeta `public/vendor/` todavía no existe).

- [ ] **Step 3: Descargar y vendorizar la librería**

```bash
mkdir -p /tmp/zxing-vendor && cd /tmp/zxing-vendor
npm pack @zxing/library@0.23.0
tar xzf zxing-library-0.23.0.tgz
```

Expected: queda `/tmp/zxing-vendor/package/umd/index.min.js` (build UMD que expone el global `window.ZXing`, confirmado con `head -c 200 package/umd/index.min.js` — el wrapper termina en `...(t="undefined"!=typeof globalThis?globalThis:t||self).ZXing={})}`).

Volver al repo y armar el archivo final con cabecera de atribución:

```bash
cd /opt/fusionbikes/herramientas
mkdir -p public/vendor
{
  printf '%s\n' \
    '/*! Vendorizado de @zxing/library v0.23.0 (Apache-2.0) — https://github.com/zxing-js/library' \
    ' * Fallback de decodificación de códigos cuando el navegador no soporta BarcodeDetector nativo (Safari/iPhone).' \
    ' * No editar a mano; para actualizar, repetir el proceso de vendoring documentado en' \
    ' * docs/superpowers/plans/2026-07-20-escaneo-camara.md (Task 1). */'
  cat /tmp/zxing-vendor/package/umd/index.min.js
} > public/vendor/zxing.min.js
```

- [ ] **Step 4: Agregar el mount estático en server.js**

En `server.js`, después de la línea `app.use('/reset-password', express.static(path.join(__dirname, 'public/reset-password')));` (línea 61), agregar:

```js
  app.use('/vendor', express.static(path.join(__dirname, 'public/vendor')));
```

- [ ] **Step 5: Correr el test y confirmar que pasa (GREEN)**

Run: `npx vitest run test/server.test.js -t "serves static pages"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/vendor/zxing.min.js server.js test/server.test.js
git commit -m "Vendorizar @zxing/library como fallback de escaneo por cámara"
```

---

### Task 2: Lógica de re-armado para modo continuo (`scannerGate.js`)

**Files:**
- Create: `public/lib/scannerGate.js`
- Test: `test/scannerGate.test.js`
- Modify: `server.js:53-62`
- Modify: `test/server.test.js:34-49`

**Interfaces:**
- Produces: `createContinuousGate()` → `{ frame(code: string|null): string|null }`. `frame(code)` devuelve el código si corresponde disparar `onCode` (transición de "no visto" a "visto"), o `null` si no corresponde disparar todavía. Usado por Task 3 (`scanner.js`).

- [ ] **Step 1: Escribir los tests que fallan (RED)**

Crear `test/scannerGate.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createContinuousGate } from '../public/lib/scannerGate.js';

describe('createContinuousGate', () => {
  it('dispara la primera vez que ve un código', () => {
    const gate = createContinuousGate();
    expect(gate.frame('7791234567890')).toBe('7791234567890');
  });

  it('no vuelve a disparar mientras sigue viendo el mismo código', () => {
    const gate = createContinuousGate();
    gate.frame('7791234567890');
    expect(gate.frame('7791234567890')).toBeNull();
    expect(gate.frame('7791234567890')).toBeNull();
  });

  it('vuelve a disparar el mismo código después de perderlo de vista', () => {
    const gate = createContinuousGate();
    gate.frame('7791234567890');
    gate.frame(null); // se retiró el producto de cuadro
    expect(gate.frame('7791234567890')).toBe('7791234567890');
  });

  it('dispara inmediatamente al cambiar a un código distinto, sin necesitar un frame vacío', () => {
    const gate = createContinuousGate();
    gate.frame('AAA');
    expect(gate.frame('BBB')).toBe('BBB');
  });

  it('frames vacíos consecutivos no disparan nada', () => {
    const gate = createContinuousGate();
    expect(gate.frame(null)).toBeNull();
    expect(gate.frame(null)).toBeNull();
    expect(gate.frame('')).toBeNull();
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `npx vitest run test/scannerGate.test.js`
Expected: FAIL — `Cannot find module '../public/lib/scannerGate.js'`.

- [ ] **Step 3: Implementar `public/lib/scannerGate.js`**

```js
export function createContinuousGate() {
  let currentCode = null;
  return {
    frame(code) {
      if (!code) {
        currentCode = null;
        return null;
      }
      if (code === currentCode) return null;
      currentCode = code;
      return code;
    },
  };
}

if (typeof window !== 'undefined') {
  window.ScannerGate = { createContinuousGate };
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan (GREEN)**

Run: `npx vitest run test/scannerGate.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Servir `/lib` y extender el test de páginas estáticas (segundo ciclo RED/GREEN)**

En `test/server.test.js`, agregar dentro del mismo test del Task 1:

```js
    const vendorZxing = await request(app).get('/vendor/zxing.min.js');
    const scannerGate = await request(app).get('/lib/scannerGate.js');
    expect(stock.status).toBe(200);
    expect(etiquetas.status).toBe(200);
    expect(inventario.status).toBe(200);
    expect(login.status).toBe(200);
    expect(matcher.status).toBe(200);
    expect(vendorZxing.status).toBe(200);
    expect(scannerGate.status).toBe(200);
```

Run: `npx vitest run test/server.test.js -t "serves static pages"`
Expected: FAIL (404 en `/lib/scannerGate.js`, todavía no hay mount).

En `server.js`, junto al mount de `/vendor` agregado en Task 1, agregar:

```js
  app.use('/lib', express.static(path.join(__dirname, 'public/lib')));
```

Run: `npx vitest run test/server.test.js -t "serves static pages"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/lib/scannerGate.js test/scannerGate.test.js server.js test/server.test.js
git commit -m "Agregar lógica pura de re-armado para escaneo continuo (scannerGate)"
```

---

### Task 3: Módulo `Scanner` (orquestación de cámara)

**Files:**
- Create: `public/lib/scanner.js`
- Modify: `test/server.test.js:34-51`

**Interfaces:**
- Consumes: `createContinuousGate()` de `public/lib/scannerGate.js` (Task 2).
- Produces: `window.Scanner = { open, close }`.
  - `Scanner.open({ video: HTMLVideoElement, mode: 'single'|'continuous', onCode: (codigo: string) => void, onError: (mensaje: string) => void }): Promise<void>`
  - `Scanner.close(): void`

- [ ] **Step 1: Escribir el test que falla (RED)**

En `test/server.test.js`, el test queda así (se agrega `scanner` a lo ya armado en las Tasks 1 y 2):

```js
  it('serves static pages without credentials (auth is on /api only)', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const stock = await request(app).get('/stock/');
    const etiquetas = await request(app).get('/etiquetas/');
    const inventario = await request(app).get('/inventario/');
    const login = await request(app).get('/login/');
    const matcher = await request(app).get('/matcher/');
    const vendorZxing = await request(app).get('/vendor/zxing.min.js');
    const scannerGate = await request(app).get('/lib/scannerGate.js');
    const scanner = await request(app).get('/lib/scanner.js');
    expect(stock.status).toBe(200);
    expect(etiquetas.status).toBe(200);
    expect(inventario.status).toBe(200);
    expect(login.status).toBe(200);
    expect(matcher.status).toBe(200);
    expect(vendorZxing.status).toBe(200);
    expect(scannerGate.status).toBe(200);
    expect(scanner.status).toBe(200);
  });
```

Run: `npx vitest run test/server.test.js -t "serves static pages"`
Expected: FAIL (404, `/lib/scanner.js` no existe todavía).

- [ ] **Step 2: Implementar `public/lib/scanner.js`**

```js
import { createContinuousGate } from './scannerGate.js';

let stream = null;
let detectTimer = null;
let zxingReader = null;
let zxingLoadPromise = null;

function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  if (zxingLoadPromise) return zxingLoadPromise;
  zxingLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/zxing.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('No se pudo cargar el lector de códigos.'));
    document.head.appendChild(script);
  });
  return zxingLoadPromise;
}

function stopAll() {
  if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
  if (zxingReader) { try { zxingReader.reset(); } catch (_e) { /* ya estaba detenido */ } zxingReader = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

function feed(gate, onCode, text) {
  if (gate) {
    const fired = gate.frame(text || null);
    if (fired) onCode(fired);
  } else if (text) {
    onCode(text);
  }
}

function openWithBarcodeDetector(video, gate, onCode) {
  const detector = new window.BarcodeDetector();
  detectTimer = setInterval(async () => {
    try {
      const codes = await detector.detect(video);
      feed(gate, onCode, codes.length ? codes[0].rawValue : null);
    } catch (_e) { /* frame sin código detectable, se ignora */ }
  }, 350);
}

async function openWithZXing(video, gate, onCode) {
  await loadZXing();
  zxingReader = new window.ZXing.BrowserMultiFormatReader();
  await zxingReader.decodeFromStream(stream, video, (result) => {
    feed(gate, onCode, result ? result.getText() : null);
  });
}

export async function open({ video, mode, onCode, onError }) {
  stopAll();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    onError('Este navegador no soporta escaneo por cámara. Usá el lector físico o tipeá el código.');
    return;
  }
  const gate = mode === 'continuous' ? createContinuousGate() : null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    onError('No se pudo acceder a la cámara: ' + e.message);
    return;
  }
  video.srcObject = stream;

  try {
    if ('BarcodeDetector' in window) {
      openWithBarcodeDetector(video, gate, onCode);
    } else {
      await openWithZXing(video, gate, onCode);
    }
  } catch (e) {
    onError('No se pudo iniciar el lector de códigos: ' + e.message);
    stopAll();
  }
}

export function close() {
  stopAll();
}

if (typeof window !== 'undefined') {
  window.Scanner = { open, close };
}
```

Nota de diseño: `loadZXing()` carga `zxing.min.js` (356KB) recién cuando hace falta (navegador sin `BarcodeDetector`, ej. iPhone) — en Android no se descarga nunca, para no pesar la carga de página en ninguno de los dos casos.

- [ ] **Step 3: Correr el test y confirmar que pasa (GREEN)**

Run: `npx vitest run test/server.test.js -t "serves static pages"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add public/lib/scanner.js test/server.test.js
git commit -m "Agregar módulo Scanner: BarcodeDetector nativo con fallback ZXing"
```

---

### Task 4: Cámara en Preparación de pedidos

**Files:**
- Modify: `public/preparacion/index.html:432-457` (lógica de cámara)
- Modify: `public/preparacion/index.html:605-607` (script tag, antes de `</body>`)

**Interfaces:**
- Consumes: `window.Scanner.open(...)`, `window.Scanner.close()` (Task 3).

- [ ] **Step 1: Reemplazar la implementación de cámara**

En `public/preparacion/index.html`, reemplazar el bloque (líneas 432-457):

```js
// ─── Cámara (BarcodeDetector nativo) ─────────────────────────────────────────

var _camStream=null,_camTimer=null;
async function abrirCamara(){
  if(!('BarcodeDetector' in window)){alert('Este navegador no soporta escaneo por cámara. Usá el lector físico o tipeá el código.');return;}
  var modal=document.getElementById('cam-modal'),video=document.getElementById('cam-video');
  modal.classList.add('open');
  try{
    _camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    video.srcObject=_camStream;
    var det=new BarcodeDetector();
    _camTimer=setInterval(async function(){
      try{
        var codes=await det.detect(video);
        if(codes.length){var v=codes[0].rawValue;cerrarCamara();escanear(v);}
      }catch(_){}
    },350);
  }catch(e){
    document.getElementById('cam-msg').textContent='No se pudo abrir la cámara: '+e.message;
  }
}
function cerrarCamara(){
  clearInterval(_camTimer);
  if(_camStream){_camStream.getTracks().forEach(function(t){t.stop();});_camStream=null;}
  document.getElementById('cam-modal').classList.remove('open');
}
```

por:

```js
// ─── Cámara (módulo Scanner compartido: BarcodeDetector nativo o ZXing) ──────

function abrirCamara(){
  var modal=document.getElementById('cam-modal'),video=document.getElementById('cam-video');
  modal.classList.add('open');
  document.getElementById('cam-msg').textContent='Apuntá al código de barras…';
  window.Scanner.open({
    video:video,
    mode:'single',
    onCode:function(v){cerrarCamara();escanear(v);},
    onError:function(msg){document.getElementById('cam-msg').textContent=msg;}
  });
}
function cerrarCamara(){
  window.Scanner.close();
  document.getElementById('cam-modal').classList.remove('open');
}
```

- [ ] **Step 2: Agregar el script del módulo**

Al final del archivo, reemplazar:

```html
cargarPendientes();
</script>
</body>
</html>
```

por:

```html
cargarPendientes();
</script>
<script type="module" src="/lib/scanner.js"></script>
</body>
</html>
```

- [ ] **Step 3: Regresión — confirmar que el backend/contrato de preparación sigue intacto**

Run: `npx vitest run test/preparacion.test.js test/preparacion-contrato.test.js`
Expected: PASS (este cambio es solo frontend; estos tests no deberían moverse).

- [ ] **Step 4: Commit**

```bash
git add public/preparacion/index.html
git commit -m "Preparación: usar el módulo Scanner compartido (funciona también en iPhone)"
```

---

### Task 5: Cámara en Conteo de stock

**Files:**
- Modify: `public/inventario/index.html` (CSS, botón, modal, JS, script tag)

**Interfaces:**
- Consumes: `window.Scanner.open(...)`, `window.Scanner.close()` (Task 3); `processScan(codigo)` ya existente en este archivo (línea 388).

- [ ] **Step 1: Agregar estilos del modal de cámara y del toast**

En `public/inventario/index.html`, dentro del bloque `<style>`, después de la regla `.catbadge.miss{background:rgba(255,91,91,.18);color:var(--warn)}` (línea 82) y antes de `@media (max-width:640px)` (línea 83), agregar:

```css
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;z-index:50;padding:16px;}
  .modal.open{display:flex;}
  .modal-box{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;max-width:480px;width:100%;position:relative;}
  .modal-box video{width:100%;border-radius:10px;background:#000;display:block;}
  .modal-box .sub{color:var(--muted);font-size:13px;margin:10px 0;text-align:center;}
  .modal-box .cerrarcam{margin-top:6px;width:100%;font-size:14px;font-weight:700;padding:10px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);cursor:pointer;}
  .cam-toast{position:absolute;left:16px;right:16px;top:26px;background:rgba(52,211,153,.94);color:#06231A;font-weight:800;font-size:15px;text-align:center;padding:8px 10px;border-radius:9px;pointer-events:none;opacity:0;transition:opacity .2s;}
  .cam-toast.show{opacity:1;}
```

- [ ] **Step 2: Agregar el botón de cámara a la barra de herramientas**

En el mismo archivo, en `.toolbar` (dentro de `<header>`), reemplazar:

```html
    <button id="bImport">⬆ Importar mapa (JSON)</button>
    <button id="bMute" class="mute">🔊 Sonido</button>
```

por:

```html
    <button id="bImport">⬆ Importar mapa (JSON)</button>
    <button id="bCam">📷 Cámara</button>
    <button id="bMute" class="mute">🔊 Sonido</button>
```

- [ ] **Step 3: Agregar el modal de cámara al final del `<main>`**

Reemplazar:

```html
  <div class="empty" id="empty">Sin escaneos en esta sesión.</div>
</main>
```

por:

```html
  <div class="empty" id="empty">Sin escaneos en esta sesión.</div>
</main>
<div class="modal" id="cam-modal">
  <div class="modal-box">
    <video id="cam-video" autoplay playsinline muted></video>
    <div class="cam-toast" id="cam-toast"></div>
    <p class="sub" id="cam-msg">Apuntá al código de barras…</p>
    <button class="cerrarcam" id="bCamCerrar">Cerrar</button>
  </div>
</div>
```

- [ ] **Step 4: Agregar la lógica de cámara y el toast**

Dentro del `<script>` principal (el IIFE que empieza en la línea 151), después de la función `beep()` (antes de la sección `// ----- Catálogo WooCommerce -----`), agregar:

```js
  // ----- Cámara (módulo Scanner compartido: BarcodeDetector nativo o ZXing) -----
  var camToastTimer = null;
  function mostrarToastCam(codigo){
    var t = document.getElementById('cam-toast');
    if(!t) return;
    t.textContent = '✓ ' + codigo + ' leído';
    t.classList.add('show');
    clearTimeout(camToastTimer);
    camToastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2200);
  }
  function abrirCamara(){
    var modal = document.getElementById('cam-modal'), video = document.getElementById('cam-video');
    modal.classList.add('open');
    document.getElementById('cam-msg').textContent = 'Apuntá al código de barras…';
    window.Scanner.open({
      video: video,
      mode: 'continuous',
      onCode: function(codigo){ processScan(codigo); mostrarToastCam(codigo); },
      onError: function(msg){ document.getElementById('cam-msg').textContent = msg; }
    });
  }
  function cerrarCamara(){
    window.Scanner.close();
    document.getElementById('cam-modal').classList.remove('open');
    scan.focus();
  }
```

Y junto a los demás listeners de botones (cerca de la línea 482-491, donde está `document.getElementById('bUndo').addEventListener(...)`), agregar:

```js
  document.getElementById('bCam').addEventListener('click', abrirCamara);
  document.getElementById('bCamCerrar').addEventListener('click', cerrarCamara);
```

- [ ] **Step 5: Agregar el script del módulo**

Al final del archivo, reemplazar:

```html
})();
</script>

<script>
(function(){
  var seg = (location.pathname.match(/\/herramientas\/([a-z0-9-]+)\//)||[])[1] || '';
```

por:

```html
})();
</script>
<script type="module" src="/lib/scanner.js"></script>

<script>
(function(){
  var seg = (location.pathname.match(/\/herramientas\/([a-z0-9-]+)\//)||[])[1] || '';
```

- [ ] **Step 6: Regresión — confirmar que la página sigue sirviéndose bien**

Run: `npx vitest run test/server.test.js -t "serves static pages"`
Expected: PASS (ya cubre `GET /inventario/` → 200; el cambio no toca el backend).

- [ ] **Step 7: Commit**

```bash
git add public/inventario/index.html
git commit -m "Conteo de stock: agregar escaneo por cámara en modo continuo con toast"
```

---

### Task 6: Verificación final y deploy a staging

**Files:** ninguno (solo comandos de verificación y deploy).

- [ ] **Step 1: Suite completa**

Run: `npm test`
Expected: PASS — 25 archivos de test, 213 tests, 0 fallos (208 preexistentes + 5 nuevos de `scannerGate.test.js`).

- [ ] **Step 2: Smoke check en navegador real (Playwright)**

Abrir `/herramientas/preparacion/` y `/herramientas/inventario/` con el navegador disponible (herramienta Playwright de este entorno), confirmar:
- Sin errores en la consola al cargar (los `<script type="module">` nuevos cargan bien).
- El botón de cámara abre el modal y dispara el prompt de permiso de cámara del navegador (confirma que `Scanner.open` corre sin excepciones hasta ahí).
- Si se deniega el permiso, el mensaje de error aparece en el modal (`#cam-msg`) sin romper el resto de la página.

Esto **no** reemplaza la prueba con un código real: un navegador automatizado sin cámara física no puede confirmar que un EAN o QR real se decodifica correctamente. Ese último paso queda para el Step 4.

- [ ] **Step 3: Merge a `master` y restart en staging**

Este VPS es el entorno de staging real (`https://herramientas.fusionbikes.com.ar`) donde el usuario prueba antes de replicar a mano en producción — no hay remoto de git. Desde el checkout principal (no el worktree):

```bash
cd /opt/fusionbikes/herramientas
git status
git merge --no-ff worktree-escaneo-camara -m "Merge: escaneo de códigos por cámara en preparación y conteo de stock"
npm test
pm2 restart herramientas
```

Expected: merge sin conflictos, `npm test` sigue en 0 fallos, `pm2 restart herramientas` deja el proceso `online`.

- [ ] **Step 4: Pedir al usuario la prueba con dispositivos reales**

Avisar al usuario que ya está desplegado en staging y pedirle que confirme en Android y en iPhone reales (según la matriz de pruebas de la spec, `docs/superpowers/specs/2026-07-20-escaneo-camara-design.md`, sección Testing):
1. Preparación en Android/Chrome y en iPhone/Safari: escanear un EAN real.
2. Conteo de stock en ambos: abrir cámara, escanear una SKU, ver el toast, confirmar que sumó.
3. Conteo de stock: sostener el mismo código quieto 3-4 segundos → debe sumar 1 sola vez.
4. Conteo de stock: escanear el mismo código dos veces con el producto retirado en el medio → debe sumar 2.
5. Denegar el permiso de cámara en ambas pantallas → debe mostrar mensaje sin romper el resto.

Recién después de esa confirmación, el usuario decide cuándo replicarlo a mano en producción (fuera del alcance de este plan).
