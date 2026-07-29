import { createContinuousGate } from './scannerGate.js';

// Región de interés (ROI): banda horizontal centrada, como los lectores de
// supermercado. Evita falsos escaneos cuando hay dos o más códigos de barras
// pegados en la misma etiqueta: solo se decodifica lo que cae dentro de la
// banda, sea cual sea el zoom activo. Constantes fáciles de recalibrar:
// ROI_W = fracción del ancho visible que ocupa la banda (deja margen a los lados).
// ROI_H = fracción del alto visible que ocupa la banda. 0.30 es suficiente para
// que un EAN-13 apoyado en la banda entre completo, pero deja afuera el código
// de arriba o abajo si hay varios pegados en la etiqueta.
const ROI_W = 0.92;
const ROI_H = 0.30;

let stream = null;
let detectTimer = null;
let zxingReader = null;
let zxingLoadPromise = null;

// Estado de zoom digital. iOS Safari no soporta el constraint `zoom` de
// getUserMedia, así que el acercamiento se hace por software: recortando el
// centro del frame de video sobre un canvas offscreen y ampliándolo antes de
// pasarlo al detector. Con zoomLevel === 1 no hay recorte adicional de zoom,
// pero el recorte por ROI se aplica siempre (ver drawRoiFrame).
let zoomLevel = 1;
let scannedVideo = null;   // referencia al <video> en pantalla (para el zoom visual)
let frameCanvas = null;    // canvas offscreen donde se dibuja el frame recortado (ROI + zoom)
let frameCtx = null;
let zxingCtx = null;       // { gate, onCode, video } para poder reiniciar el modo ZXing
let roiOverlay = null;     // <div> del overlay visual asociado al video actual
let frameCanvasSized = false; // frameCanvas nace en 300×150 (default del DOM), no en 0×0:
                               // no podemos inferir "todavía sin dimensionar" de canvas.width,
                               // así que lo llevamos con un flag explícito.
let roiActiveW = ROI_W;    // ROI efectivo en uso: si el overlay no se pudo dibujar, se
let roiActiveH = ROI_H;    // degrada a 1/1 (cuadro completo) para no recortar a ciegas.

const CANVAS_MAX_W = 960; // techo del ancho del ROI ya recortado que se manda a decodificar
                           // (no del video crudo), para no gastar CPU de más

const ROI_STYLE_ID = 'scanner-roi-style';
const ROI_WRAP_CLASS = 'scanner-roi-wrap';
const ROI_OVERLAY_CLASS = 'scanner-roi-overlay';

function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  if (zxingLoadPromise) return zxingLoadPromise;
  zxingLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // Resuelto relativo a este módulo para funcionar tanto en localhost (/vendor/…)
    // como detrás del prefijo /herramientas de Nginx (/herramientas/vendor/…).
    script.src = new URL('../vendor/zxing.min.js', import.meta.url).href;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('No se pudo cargar el lector de códigos.'));
    document.head.appendChild(script);
  });
  return zxingLoadPromise;
}

// Inyecta una sola vez el CSS del overlay de la banda de escaneo. Las medidas
// salen de ROI_W/ROI_H (no se hardcodean aparte): si se recalibra el ROI acá
// arriba, el overlay visual acompaña solo. El color del marco usa los tokens
// del sistema visual: --accent (theme.css) con --azul como alias de las
// páginas que todavía no importan theme.css (mismo valor de color, #2DB8E8).
function injectRoiStyleOnce() {
  if (document.getElementById(ROI_STYLE_ID)) return;
  const veilPct = ((1 - ROI_H) / 2) * 100;
  const bandPct = ROI_H * 100;
  const sidePct = ((1 - ROI_W) / 2) * 100;
  const bandWidthPct = ROI_W * 100;
  const style = document.createElement('style');
  style.id = ROI_STYLE_ID;
  style.textContent = `
.${ROI_WRAP_CLASS}{position:relative;overflow:hidden;border-radius:10px;}
.${ROI_OVERLAY_CLASS}{position:absolute;inset:0;pointer-events:none;}
.${ROI_OVERLAY_CLASS}__veil{position:absolute;left:0;right:0;background:rgba(0,0,0,.55);}
.${ROI_OVERLAY_CLASS}__veil--top{top:0;height:${veilPct}%;}
.${ROI_OVERLAY_CLASS}__veil--bottom{bottom:0;height:${veilPct}%;}
.${ROI_OVERLAY_CLASS}__band{position:absolute;top:${veilPct}%;height:${bandPct}%;left:${sidePct}%;width:${bandWidthPct}%;}
.${ROI_OVERLAY_CLASS}__corner{position:absolute;width:22px;height:22px;border-color:var(--accent,var(--azul,#2DB8E8));border-style:solid;}
.${ROI_OVERLAY_CLASS}__corner--tl{top:0;left:0;border-width:3px 0 0 3px;}
.${ROI_OVERLAY_CLASS}__corner--tr{top:0;right:0;border-width:3px 3px 0 0;}
.${ROI_OVERLAY_CLASS}__corner--bl{bottom:0;left:0;border-width:0 0 3px 3px;}
.${ROI_OVERLAY_CLASS}__corner--br{bottom:0;right:0;border-width:0 3px 3px 0;}
`;
  document.head.appendChild(style);
}

// Envuelve el <video> en un contenedor propio con position:relative, donde
// se cuelga el overlay. Se hace ANTES de asignar srcObject: mover un <video>
// en el DOM mientras reproduce lo pausa. Si ya está envuelto de una apertura
// anterior (open() se llama muchas veces por sesión), reutiliza el wrapper
// en vez de anidarlo de nuevo.
function ensureRoiWrap(video) {
  const parent = video.parentElement;
  if (parent && parent.classList && parent.classList.contains(ROI_WRAP_CLASS)) {
    return parent;
  }
  const wrap = document.createElement('div');
  wrap.className = ROI_WRAP_CLASS;
  parent.insertBefore(wrap, video);
  wrap.appendChild(video);
  return wrap;
}

function ensureRoiOverlay(wrap) {
  let overlay = null;
  const children = wrap.children || [];
  for (let i = 0; i < children.length; i++) {
    if (children[i].classList && children[i].classList.contains(ROI_OVERLAY_CLASS)) { overlay = children[i]; break; }
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = ROI_OVERLAY_CLASS;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      `<div class="${ROI_OVERLAY_CLASS}__veil ${ROI_OVERLAY_CLASS}__veil--top"></div>` +
      `<div class="${ROI_OVERLAY_CLASS}__veil ${ROI_OVERLAY_CLASS}__veil--bottom"></div>` +
      `<div class="${ROI_OVERLAY_CLASS}__band">` +
      `<span class="${ROI_OVERLAY_CLASS}__corner ${ROI_OVERLAY_CLASS}__corner--tl"></span>` +
      `<span class="${ROI_OVERLAY_CLASS}__corner ${ROI_OVERLAY_CLASS}__corner--tr"></span>` +
      `<span class="${ROI_OVERLAY_CLASS}__corner ${ROI_OVERLAY_CLASS}__corner--bl"></span>` +
      `<span class="${ROI_OVERLAY_CLASS}__corner ${ROI_OVERLAY_CLASS}__corner--br"></span>` +
      `</div>`;
    wrap.appendChild(overlay);
  }
  overlay.style.display = '';
  return overlay;
}

// Si el DOM del host no tiene la forma esperada (por ejemplo en los tests,
// que simulan un video sin contenedor real) el overlay no debe romper el
// escaneo, que es lo crítico. PERO: nunca hay que seguir recortando por ROI
// sin la guía visual que lo justifica — sería escanear a ciegas contra una
// banda invisible del 30%, peor que no tener ROI. Si el overlay falla,
// degradamos el ROI efectivo a 1/1 (cuadro completo, sin recorte).
function attachRoiOverlay(video) {
  try {
    injectRoiStyleOnce();
    const wrap = ensureRoiWrap(video);
    roiOverlay = ensureRoiOverlay(wrap);
    roiActiveW = ROI_W;
    roiActiveH = ROI_H;
  } catch (e) {
    console.warn('No se pudo dibujar el overlay de la banda de escaneo, se lee el cuadro completo sin recorte por ROI:', e);
    roiOverlay = null;
    roiActiveW = 1;
    roiActiveH = 1;
  }
}

function hideRoiOverlay() {
  if (roiOverlay) { try { roiOverlay.style.display = 'none'; } catch (_e) { /* no-op */ } }
  roiOverlay = null;
}

function stopAll() {
  if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
  if (zxingReader) { try { zxingReader.reset(); } catch (_e) { /* ya estaba detenido */ } zxingReader = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (scannedVideo) { scannedVideo.style.transform = ''; }
  hideRoiOverlay();
  zxingCtx = null;
  frameCanvas = null;
  frameCtx = null;
  frameCanvasSized = false;
  zoomLevel = 1;
  scannedVideo = null;
}

function feed(gate, onCode, text) {
  if (gate) {
    const fired = gate.frame(text || null);
    if (fired) onCode(fired);
  } else if (text) {
    onCode(text);
  }
}

// Dibuja en frameCanvas la banda ROI del video, combinando zoom digital y
// recorte por ROI. Primero se calcula la región visible según el zoom (igual
// que antes: centro del frame a vw/z, vh/z) y DENTRO de esa región se aplican
// las fracciones ROI_W/ROI_H, así la banda en pantalla y la banda decodificada
// coinciden a cualquier nivel de zoom. Devuelve false si el video todavía no
// tiene dimensiones.
function drawRoiFrame() {
  const v = scannedVideo;
  if (!v || !frameCtx) return false;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return false;

  const z = zoomLevel > 1 ? zoomLevel : 1;
  const sw = vw / z, sh = vh / z;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

  const roiW = sw * roiActiveW, roiH = sh * roiActiveH;
  const roiX = sx + (sw - roiW) / 2, roiY = sy + (sh - roiH) / 2;

  if (!frameCanvasSized) {
    // El tamaño del canvas se fija una sola vez (no se reasigna en cada
    // frame) a partir de la relación de aspecto del ROI a zoom 1, que es la
    // misma a cualquier zoom (sw/sh siempre = vw/vh). OJO: un <canvas> recién
    // creado ya vale 300×150 por especificación del DOM (nunca 0×0), así que
    // NO se puede usar "frameCanvas.width === 0" como señal de "todavía sin
    // dimensionar" — de ahí el flag frameCanvasSized explícito.
    const baseRoiW = vw * roiActiveW, baseRoiH = vh * roiActiveH;
    const scale = Math.min(1, CANVAS_MAX_W / baseRoiW);
    frameCanvas.width = Math.round(baseRoiW * scale);
    frameCanvas.height = Math.round(baseRoiH * scale);
    if (!frameCanvas.width || !frameCanvas.height) return false;
    frameCanvasSized = true;
  }

  frameCtx.drawImage(v, roiX, roiY, roiW, roiH, 0, 0, frameCanvas.width, frameCanvas.height);
  return true;
}

function openWithBarcodeDetector(video, gate, onCode) {
  const detector = new window.BarcodeDetector();
  detectTimer = setInterval(async () => {
    try {
      if (!drawRoiFrame()) return;
      const codes = await detector.detect(frameCanvas);
      feed(gate, onCode, codes.length ? codes[0].rawValue : null);
    } catch (_e) { /* frame sin código detectable, se ignora */ }
  }, 350);
}

// Loop de lectura por canvas para ZXing. Siempre se usa este camino (ya no
// existe el modo decodeFromStream directo sobre el <video>), porque el ROI
// tiene que aplicarse siempre. Decodifica de bajo nivel desde el canvas
// recortado vía HTMLCanvasElementLuminanceSource.
function startZxingLoop(gate, onCode) {
  detectTimer = setInterval(() => {
    if (!drawRoiFrame()) { feed(gate, onCode, null); return; }
    let text = null;
    try {
      const source = new window.ZXing.HTMLCanvasElementLuminanceSource(frameCanvas);
      const bitmap = new window.ZXing.BinaryBitmap(new window.ZXing.HybridBinarizer(source));
      const result = zxingReader.decodeBitmap(bitmap);
      text = result ? result.getText() : null;
    } catch (_e) { /* frame sin código: NotFound */ text = null; }
    feed(gate, onCode, text);
  }, 350);
}

async function openWithZXing(video, gate, onCode) {
  await loadZXing();
  zxingReader = new window.ZXing.BrowserMultiFormatReader();
  zxingCtx = { gate, onCode, video };
  startZxingLoop(gate, onCode);
}

export async function open({ video, mode, onCode, onError, dropoutMs }) {
  stopAll();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    onError('Este navegador no soporta escaneo por cámara. Usá el lector físico o tipeá el código.');
    return;
  }
  const gate = mode === 'continuous' ? createContinuousGate({ dropoutMs }) : null;

  zoomLevel = 1;
  scannedVideo = video;
  video.style.transform = '';
  frameCanvas = document.createElement('canvas'); // offscreen, no va al DOM
  frameCtx = frameCanvas.getContext('2d');
  attachRoiOverlay(video); // antes de srcObject: mover el <video> en el DOM lo pausaría

  try {
    // Pedimos mayor resolución nativa para que el recorte del zoom conserve nitidez.
    // `ideal` degrada solo si el dispositivo no lo soporta, no hace falta try/catch extra.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    onError('No se pudo acceder a la cámara: ' + e.message);
    stopAll(); // si no, las bandas oscuras del overlay quedan colgadas sobre el recuadro negro
    return;
  }
  video.srcObject = stream;
  try { await video.play(); } catch (_e) { /* algunos navegadores requieren gesto; el autoplay/attr cubre el resto */ }

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

// Zoom digital 1..4 (paso libre). Actualiza el recorte del próximo frame
// (drawRoiFrame combina zoom + ROI en cada llamada) y el zoom visual del
// <video>. El stream y el lector (BarcodeDetector o el loop de canvas de
// ZXing) siguen corriendo igual: solo cambia el nivel usado para recortar.
export function setZoom(level) {
  const z = Number(level);
  zoomLevel = (!isNaN(z) && z >= 1) ? z : 1;

  if (scannedVideo) {
    scannedVideo.style.transformOrigin = 'center center';
    scannedVideo.style.transform = zoomLevel > 1 ? 'scale(' + zoomLevel + ')' : '';
  }
}

export function close() {
  stopAll();
}

if (typeof window !== 'undefined') {
  window.Scanner = { open, close, setZoom };
}
