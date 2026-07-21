import { createContinuousGate } from './scannerGate.js';

let stream = null;
let detectTimer = null;
let zxingReader = null;
let zxingLoadPromise = null;

// Estado de zoom digital. iOS Safari no soporta el constraint `zoom` de
// getUserMedia, así que el acercamiento se hace por software: recortando el
// centro del frame de video sobre un canvas offscreen y ampliándolo antes de
// pasarlo al detector. Con zoomLevel === 1 no hay recorte y el comportamiento
// es idéntico al de siempre (cero regresión para quien no toca el slider).
let zoomLevel = 1;
let scannedVideo = null;   // referencia al <video> en pantalla (para el zoom visual)
let frameCanvas = null;    // canvas offscreen donde se dibuja el frame recortado
let frameCtx = null;
let zxingCtx = null;       // { gate, onCode, video } para poder reiniciar el modo ZXing
let zxingUsingLoop = false; // true = leemos por canvas (zoom); false = decodeFromStream (1x)

const CANVAS_MAX_W = 960; // techo de resolución del canvas destino, para no gastar CPU de más

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

function stopAll() {
  if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
  if (zxingReader) { try { zxingReader.reset(); } catch (_e) { /* ya estaba detenido */ } zxingReader = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (scannedVideo) { scannedVideo.style.transform = ''; }
  zxingCtx = null;
  zxingUsingLoop = false;
  frameCanvas = null;
  frameCtx = null;
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

// Dibuja en frameCanvas el rectángulo central del video según zoomLevel, escalado
// para llenar el canvas. Devuelve false si el video todavía no tiene dimensiones.
function drawZoomFrame() {
  const v = scannedVideo;
  if (!v || !frameCtx) return false;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return false;
  if (!frameCanvas.width) {
    const scale = Math.min(1, CANVAS_MAX_W / vw);
    frameCanvas.width = Math.round(vw * scale);
    frameCanvas.height = Math.round(vh * scale);
  }
  const z = zoomLevel > 1 ? zoomLevel : 1;
  const sw = vw / z, sh = vh / z;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  frameCtx.drawImage(v, sx, sy, sw, sh, 0, 0, frameCanvas.width, frameCanvas.height);
  return true;
}

function openWithBarcodeDetector(video, gate, onCode) {
  const detector = new window.BarcodeDetector();
  detectTimer = setInterval(async () => {
    try {
      // Con zoom 1x leemos el <video> directo (idéntico a como funcionaba antes).
      // Con zoom > 1x leemos el canvas recortado, que sí acepta BarcodeDetector.
      const src = (zoomLevel > 1 && drawZoomFrame()) ? frameCanvas : video;
      const codes = await detector.detect(src);
      feed(gate, onCode, codes.length ? codes[0].rawValue : null);
    } catch (_e) { /* frame sin código detectable, se ignora */ }
  }, 350);
}

// Loop de lectura por canvas para ZXing (usado cuando hay zoom). Decodifica de
// bajo nivel desde el canvas recortado vía HTMLCanvasElementLuminanceSource.
function startZxingLoop(gate, onCode) {
  detectTimer = setInterval(() => {
    if (!drawZoomFrame()) { feed(gate, onCode, null); return; }
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

function startZxingStream() {
  return zxingReader.decodeFromStream(stream, zxingCtx.video, (result) => {
    feed(zxingCtx.gate, zxingCtx.onCode, result ? result.getText() : null);
  });
}

async function openWithZXing(video, gate, onCode) {
  await loadZXing();
  zxingReader = new window.ZXing.BrowserMultiFormatReader();
  zxingCtx = { gate, onCode, video };
  if (zoomLevel > 1) {
    zxingUsingLoop = true;
    startZxingLoop(gate, onCode);
  } else {
    zxingUsingLoop = false;
    await startZxingStream();
  }
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

  try {
    // Pedimos mayor resolución nativa para que el recorte del zoom conserve nitidez.
    // `ideal` degrada solo si el dispositivo no lo soporta, no hace falta try/catch extra.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    onError('No se pudo acceder a la cámara: ' + e.message);
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

// Zoom digital 1..4 (paso libre). Actualiza el recorte del próximo frame y el
// zoom visual del <video>. Con ZXing alterna entre decodeFromStream (1x) y el
// loop de canvas (zoom) sin matar el stream de la cámara.
export function setZoom(level) {
  const z = Number(level);
  zoomLevel = (!isNaN(z) && z >= 1) ? z : 1;

  if (scannedVideo) {
    scannedVideo.style.transformOrigin = 'center center';
    scannedVideo.style.transform = zoomLevel > 1 ? 'scale(' + zoomLevel + ')' : '';
  }

  // ZXing: el switch a modo loop es SOLO de ida. Una vez que pasamos al loop de
  // canvas (primer zoom > 1), nos quedamos ahí aunque el usuario vuelva a 1x
  // (drawZoomFrame con zoomLevel === 1 copia el frame entero sin recortar). Así
  // decodeFromStream se llama una única vez por stream: nunca se reintroduce el
  // reset() interno que frenaría los tracks del stream ya vivo.
  if (zxingReader && zoomLevel > 1 && !zxingUsingLoop) {
    zxingUsingLoop = true;
    try { zxingReader.stopContinuousDecode(); } catch (_e) { /* no estaba decodificando */ }
    if (zxingCtx) startZxingLoop(zxingCtx.gate, zxingCtx.onCode);
  }
}

export function close() {
  stopAll();
}

if (typeof window !== 'undefined') {
  window.Scanner = { open, close, setZoom };
}
