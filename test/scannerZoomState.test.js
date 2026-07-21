import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Este test aísla la MÁQUINA DE ESTADOS de zoom del módulo real
// public/lib/scanner.js (no es un mock de la lógica, es el módulo real
// importado con globals de navegador falsificados a mano, ya que el
// proyecto corre vitest en entorno 'node', sin jsdom).
//
// Objetivo: reproducir la secuencia de zoom 1→2→1→3→1 en el camino ZXing
// (fallback iPhone/Safari sin BarcodeDetector) y confirmar que
// decodeFromStream (el método que internamente hace reset() y podía matar
// la cámara) se invoca UNA SOLA VEZ en toda la sesión, y que
// stopContinuousDecode se invoca al menos una vez al pasar a zoom>1.

function makeCanvasMock() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
  };
}

function makeVideoMock() {
  return {
    videoWidth: 1920,
    videoHeight: 1080,
    style: {},
    srcObject: null,
    play: async () => {},
  };
}

function installFakeBrowserGlobals({ decodeFromStreamCalls, stopContinuousDecodeCalls }) {
  class FakeBrowserMultiFormatReader {
    reset() {}
    async decodeFromStream(_stream, _video, _cb) {
      decodeFromStreamCalls.count += 1;
      // No invocamos el callback: no hace falta simular una decodificación
      // real para probar la máquina de estados de zoom.
      return Promise.resolve();
    }
    stopContinuousDecode() {
      stopContinuousDecodeCalls.count += 1;
    }
    decodeBitmap(_bitmap) {
      return null; // sin código detectado en el frame, no importa para este test
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
    // (fallback de iPhone/Safari), que es el que tiene el bug del reset().
  };
  global.document = {
    createElement: (tag) => (tag === 'canvas' ? makeCanvasMock() : {}),
    head: { appendChild: () => {} },
  };
  global.navigator = {
    mediaDevices: {
      getUserMedia: async () => fakeStream,
    },
  };

  return { fakeStream };
}

describe('scanner.js — máquina de estados de zoom (camino ZXing, fallback iPhone/Safari)', () => {
  const savedGlobals = {};

  beforeEach(() => {
    savedGlobals.window = global.window;
    savedGlobals.document = global.document;
    savedGlobals.navigator = global.navigator;
    vi.resetModules();
  });

  afterEach(() => {
    global.window = savedGlobals.window;
    global.document = savedGlobals.document;
    global.navigator = savedGlobals.navigator;
    vi.restoreAllMocks();
  });

  it('la secuencia de zoom 1→2→1→3→1 llama decodeFromStream una sola vez y stopContinuousDecode al menos una vez', async () => {
    const decodeFromStreamCalls = { count: 0 };
    const stopContinuousDecodeCalls = { count: 0 };
    installFakeBrowserGlobals({ decodeFromStreamCalls, stopContinuousDecodeCalls });

    const { open, setZoom, close } = await import('../public/lib/scanner.js');

    const video = makeVideoMock();
    const onCode = () => {};
    const onError = (msg) => { throw new Error('onError inesperado: ' + msg); };

    await open({ video, mode: 'single', onCode, onError });

    // Al abrir con zoom=1 (default) debe usarse decodeFromStream una vez.
    expect(decodeFromStreamCalls.count).toBe(1);
    expect(stopContinuousDecodeCalls.count).toBe(0);

    setZoom(2); // primer paso a zoom>1: switch de una sola vía a modo loop/canvas
    expect(stopContinuousDecodeCalls.count).toBe(1);
    expect(decodeFromStreamCalls.count).toBe(1);

    setZoom(1); // vuelve a 1x: NO debe reactivar decodeFromStream (mataría la cámara)
    expect(decodeFromStreamCalls.count).toBe(1);
    expect(stopContinuousDecodeCalls.count).toBe(1);

    setZoom(3); // sigue en modo loop: no debe volver a llamar stopContinuousDecode
    expect(decodeFromStreamCalls.count).toBe(1);
    expect(stopContinuousDecodeCalls.count).toBe(1);

    setZoom(1); // otra vez a 1x: sigue sin reactivar decodeFromStream
    expect(decodeFromStreamCalls.count).toBe(1);
    expect(stopContinuousDecodeCalls.count).toBe(1);

    close();
  });

  it('si nunca se hace zoom>1, nunca se llama stopContinuousDecode y decodeFromStream se llama una sola vez', async () => {
    const decodeFromStreamCalls = { count: 0 };
    const stopContinuousDecodeCalls = { count: 0 };
    installFakeBrowserGlobals({ decodeFromStreamCalls, stopContinuousDecodeCalls });

    const { open, setZoom, close } = await import('../public/lib/scanner.js');

    const video = makeVideoMock();
    await open({ video, mode: 'single', onCode: () => {}, onError: () => {} });

    setZoom(1);
    setZoom(1);

    expect(decodeFromStreamCalls.count).toBe(1);
    expect(stopContinuousDecodeCalls.count).toBe(0);

    close();
  });
});
