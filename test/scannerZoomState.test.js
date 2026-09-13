import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Este test aísla la MÁQUINA DE ESTADOS de zoom del módulo real
// public/lib/scanner.js (no es un mock de la lógica, es el módulo real
// importado con globals de navegador falsificados a mano, ya que el
// proyecto corre vitest en entorno 'node', sin jsdom).
//
// Desde el ROI (región de interés) siempre activo, el camino ZXing (fallback
// iPhone/Safari sin BarcodeDetector) usa SIEMPRE el loop de canvas: ya no
// existe el modo decodeFromStream directo sobre el <video> (mataba el ROI).
// Objetivo: confirmar que decodeBitmap se invoca repetidamente sin importar
// el nivel de zoom, y que decodeFromStream/stopContinuousDecode ya no forman
// parte de la API interna usada por el módulo.
//
// IMPORTANTE (post-revisión): un <canvas> recién creado con
// document.createElement('canvas') vale 300×150 por especificación del DOM,
// NUNCA 0×0. El mock tiene que ser fiel a eso — con 0×0 un bug real de
// dimensionado (usar "!canvas.width" como guard de "sin dimensionar") pasa
// desapercibido en el test y rompe en el navegador. Por eso makeCanvasMock
// arranca en 300/150, y hay un test dedicado que asierta la geometría real
// de drawImage (los 8 argumentos) para no depender solo de conteos.

function makeCanvasMock() {
  const canvas = {
    width: 300,  // valor real por defecto del DOM, no 0 — ver nota arriba.
    height: 150,
    drawCalls: [],
  };
  canvas.getContext = () => ({
    drawImage: (...args) => { canvas.drawCalls.push(args); },
  });
  return canvas;
}

function makeVideoMock() {
  return {
    videoWidth: 1920,
    videoHeight: 1080,
    style: {},
    srcObject: null,
    play: async () => {},
    // Sin parentElement real: el overlay ROI se protege con try/catch en el
    // módulo (degradando el ROI efectivo a cuadro completo si falla), así
    // que su ausencia no debe afectar la máquina de estados de zoom/lectura
    // en los tests que no verifican geometría.
  };
}

// Mock mínimo de un elemento genérico del DOM (div/span/style), fiel a lo que
// ensureRoiWrap/ensureRoiOverlay necesitan: className/classList, children,
// insertBefore/appendChild, setAttribute, style.
function makeGenericElementMock() {
  const el = {
    children: [],
    style: {},
    className: '',
    classList: { contains(c) { return el.className.split(/\s+/).includes(c); } },
    setAttribute() {},
    appendChild(child) { el.children.push(child); child.parentElement = el; return child; },
    insertBefore(child) { el.children.unshift(child); child.parentElement = el; return child; },
  };
  Object.defineProperty(el, 'innerHTML', { set() {} });
  return el;
}

// Para los tests de geometría del ROI necesitamos que attachRoiOverlay tenga
// éxito (si no, se degrada a ROI 1/1 = cuadro completo, que es justamente el
// fallback que NO queremos ejercitar acá). El <video> necesita un
// parentElement real (mock) para que ensureRoiWrap pueda envolverlo.
function makeVideoMockConOverlay() {
  const video = makeVideoMock();
  const parent = makeGenericElementMock();
  parent.appendChild(video);
  return video;
}

function installFakeBrowserGlobals({ decodeBitmapCalls, canvasRef }) {
  class FakeBrowserMultiFormatReader {
    reset() {}
    decodeBitmap(_bitmap) {
      if (decodeBitmapCalls) decodeBitmapCalls.count += 1;
      return null; // sin código detectado en el frame, no importa para estos tests
    }
  }

  const fakeTrack = { stop: () => {} };
  const fakeStream = { getTracks: () => [fakeTrack] };

  global.window = {
    ZXing: {
      BrowserMultiFormatReader: FakeBrowserMultiFormatReader,
      HTMLCanvasElementLuminanceSource: class { constructor() {} },
      BinaryBitmap: class { constructor() {} },
      HybridBinarizer: class { constructor() {} },
    },
    // BarcodeDetector deliberadamente ausente: fuerza el camino ZXing
    // (fallback de iPhone/Safari).
  };
  global.document = {
    createElement: (tag) => {
      if (tag === 'canvas') {
        const c = makeCanvasMock();
        if (canvasRef) canvasRef.current = c;
        return c;
      }
      return makeGenericElementMock();
    },
    head: { appendChild: () => {} },
    getElementById: () => null,
  };
  // stubGlobal (no asignación directa): desde Node 21 `navigator` es un getter de solo lectura.
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => fakeStream,
    },
  });

  return { fakeStream };
}

describe('scanner.js — máquina de estados de zoom (camino ZXing, fallback iPhone/Safari)', () => {
  const savedGlobals = {};

  beforeEach(() => {
    savedGlobals.window = global.window;
    savedGlobals.document = global.document;
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.window = savedGlobals.window;
    global.document = savedGlobals.document;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('decodifica siempre por el loop de canvas (ROI activo) sin importar el zoom', async () => {
    const decodeBitmapCalls = { count: 0 };
    installFakeBrowserGlobals({ decodeBitmapCalls });

    const { open, setZoom, close } = await import('../public/lib/scanner.js');

    const video = makeVideoMock();
    const onCode = () => {};
    const onError = (msg) => { throw new Error('onError inesperado: ' + msg); };

    await open({ video, mode: 'single', onCode, onError });

    // A zoom 1 ya decodifica por el loop de canvas (ROI siempre activo).
    await vi.advanceTimersByTimeAsync(350);
    expect(decodeBitmapCalls.count).toBeGreaterThan(0);

    const before = decodeBitmapCalls.count;
    setZoom(2);
    await vi.advanceTimersByTimeAsync(350);
    expect(decodeBitmapCalls.count).toBeGreaterThan(before);

    setZoom(1); // volver a 1x no debe romper el loop
    await vi.advanceTimersByTimeAsync(350);
    expect(decodeBitmapCalls.count).toBeGreaterThan(before);

    close();
  });

  it('la API interna ya no expone decodeFromStream/stopContinuousDecode (eliminados junto al modo 1x directo)', async () => {
    installFakeBrowserGlobals({ decodeBitmapCalls: { count: 0 } });
    // Si el módulo llamara a estos métodos inexistentes, open() explotaría.
    const { open, close } = await import('../public/lib/scanner.js');

    const video = makeVideoMock();
    await open({ video, mode: 'single', onCode: () => {}, onError: (msg) => { throw new Error(msg); } });
    await vi.advanceTimersByTimeAsync(350);

    close();
  });

  describe('geometría real de drawRoiFrame (regresión del bug del canvas 300×150)', () => {
    // vw=1920, vh=1080 (el ideal que pide open()); ROI_W=0.92, ROI_H=0.30 y
    // CANVAS_MAX_W=960 son las constantes actuales de scanner.js. Si se
    // recalibran ahí, estos números hay que recalcularlos a mano — es
    // intencional: este test tiene que doler si alguien rompe el sizing.

    it('a zoom 1x, dimensiona el canvas al ROI (nunca se queda en el 300×150 por defecto del DOM) y recorta la banda correcta', async () => {
      const canvasRef = { current: null };
      installFakeBrowserGlobals({ canvasRef });
      const { open, close } = await import('../public/lib/scanner.js');

      const video = makeVideoMockConOverlay();
      await open({ video, mode: 'single', onCode: () => {}, onError: (msg) => { throw new Error(msg); } });
      await vi.advanceTimersByTimeAsync(350);

      const canvas = canvasRef.current;
      // Bug real que este test tiene que cazar: si el guard de sizing usa
      // "!canvas.width" contra un canvas que ya nace en 300×150, este bloque
      // nunca corre y el canvas se queda en 300×150 (ratio 2:1) en vez del
      // ratio real del ROI (~1766:324 ≈ 5.45:1).
      expect(canvas.width).not.toBe(300);
      expect(canvas.height).not.toBe(150);
      expect(canvas.width).toBe(960);   // techo CANVAS_MAX_W
      expect(canvas.height).toBeCloseTo(176, 0);

      expect(canvas.drawCalls.length).toBeGreaterThan(0);
      const [, sx, sy, sw, sh, dx, dy, dw, dh] = canvas.drawCalls[0];
      // Región fuente: banda ROI centrada (92% ancho × 30% alto) del frame completo a 1x.
      expect(sx).toBeCloseTo(76.8, 1);
      expect(sy).toBeCloseTo(378, 1);
      expect(sw).toBeCloseTo(1766.4, 1);
      expect(sh).toBeCloseTo(324, 1);
      // Destino: todo el canvas ya dimensionado.
      expect(dx).toBe(0);
      expect(dy).toBe(0);
      expect(dw).toBe(canvas.width);
      expect(dh).toBe(canvas.height);

      close();
    });

    it('a zoom 3x, el recorte fuente se achica pero el destino sigue siendo el mismo canvas ya dimensionado', async () => {
      const canvasRef = { current: null };
      installFakeBrowserGlobals({ canvasRef });
      const { open, setZoom, close } = await import('../public/lib/scanner.js');

      const video = makeVideoMockConOverlay();
      await open({ video, mode: 'single', onCode: () => {}, onError: (msg) => { throw new Error(msg); } });
      await vi.advanceTimersByTimeAsync(350); // primer frame a 1x, fija el tamaño del canvas

      const canvas = canvasRef.current;
      const sizedWidth = canvas.width, sizedHeight = canvas.height;

      setZoom(3);
      canvas.drawCalls.length = 0; // solo nos interesan los frames posteriores al cambio de zoom
      await vi.advanceTimersByTimeAsync(350);

      expect(canvas.drawCalls.length).toBeGreaterThan(0);
      const [, sx, sy, sw, sh, dx, dy, dw, dh] = canvas.drawCalls[0];
      expect(sx).toBeCloseTo(665.6, 1);
      expect(sy).toBeCloseTo(486, 1);
      expect(sw).toBeCloseTo(588.8, 1);
      expect(sh).toBeCloseTo(108, 1);
      // El canvas NO se redimensiona al cambiar de zoom: se fija una sola vez.
      expect(canvas.width).toBe(sizedWidth);
      expect(canvas.height).toBe(sizedHeight);
      expect(dx).toBe(0);
      expect(dy).toBe(0);
      expect(dw).toBe(sizedWidth);
      expect(dh).toBe(sizedHeight);

      close();
    });
  });
});
