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

export async function open({ video, mode, onCode, onError, dropoutMs }) {
  stopAll();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    onError('Este navegador no soporta escaneo por cámara. Usá el lector físico o tipeá el código.');
    return;
  }
  const gate = mode === 'continuous' ? createContinuousGate({ dropoutMs }) : null;

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
