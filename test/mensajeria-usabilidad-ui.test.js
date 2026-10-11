// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { shouldSendOnEnter, requestTimeout, contactInitials, internationalPhone, recordingMime, recordingError, microphoneError, createAudioCapture, templateParameters, templatePreviewText, errorMessage } from '../public/mensajeria/app.js';

describe('Tiempo de espera de operaciones', () => {
  it('espera la conversión de audio solamente en /upload, sin prolongar envíos ni lecturas', () => {
    expect(requestTimeout('/upload')).toBe(70000);
    for (const path of ['/command', '/start', '/status', '/thread?key=test', '/templates?number_id=1', '/template-preview', '/upload/otro']) expect(requestTimeout(path)).toBe(25000);
  });
});

describe('Atajos de composición', () => {
  it('Enter envía texto; Shift+Enter conserva el salto de línea', () => {
    expect(shouldSendOnEnter({ key: 'Enter' })).toBe(true);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
  });
  it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }])('no dispara envíos durante composición, repetición o modificadores: %j', flags => {
    expect(shouldSendOnEnter({ key: 'Enter', ...flags })).toBe(false);
  });
  it.each([{ disabled: true }, { pending: true }, { audio: true }])('no permite Enter si el estado requiere esperar o un envío explícito: %j', state => {
    expect(shouldSendOnEnter({ key: 'Enter' }, state)).toBe(false);
  });
  it('otros caracteres no envían', () => { expect(shouldSendOnEnter({ key: 'a' })).toBe(false); });
});

describe('Identidad visual y número internacional', () => {
  it('muestra iniciales legibles y los últimos dígitos si sólo se conoce el teléfono', () => {
    expect(contactInitials(' José Pérez ')).toBe('JP');
    expect(contactInitials('Santiago')).toBe('S');
    expect(contactInitials('+54 9 351 123-4567')).toBe('67');
    expect(contactInitials('')).toBe('?');
  });
  it('normaliza únicamente teléfonos internacionales explícitos, sin inventar país ni agregar el 9', () => {
    expect(internationalPhone('+54 9 (351) 123-4567')).toBe('+5493511234567');
    expect(internationalPhone('+1 212 555 0199')).toBe('+12125550199');
    for (const value of ['3511234567', '005491234567', '+05491234567', '+123', '+1234567890123456', '+54ext3511234567', 'javascript:123', '+54 9 351 123 4567#1']) expect(internationalPhone(value)).toBe('');
  });
});

describe('Grabaciones compatibles y errores', () => {
  it('elige Opus WebM primero y MP4 si el navegador no permite Opus', () => {
    expect(recordingMime({ isTypeSupported: mime => ['audio/webm;codecs=opus', 'audio/mp4'].includes(mime) })).toBe('audio/webm;codecs=opus');
    expect(recordingMime({ isTypeSupported: mime => mime === 'audio/mp4' })).toBe('audio/mp4');
    expect(recordingMime(undefined)).toBe('');
  });
  it('rechaza grabaciones vacías, formatos ajenos y mayores de 16 MB', () => {
    expect(recordingError({ type: 'audio/webm;codecs=opus', size: 100 })).toBe('');
    expect(recordingError({ type: 'audio/mp4', size: 16 * 1024 * 1024 })).toBe('');
    expect(recordingError({ type: 'video/webm', size: 100 })).toContain('compatible');
    expect(recordingError({ type: 'audio/ogg', size: 0 })).toContain('No se grabó');
    expect(recordingError({ type: 'audio/mp4', size: 16 * 1024 * 1024 + 1 })).toContain('16 MB');
  });
  it('explica denegación, ausencia y micrófono ocupado sin filtrar códigos internos', () => {
    expect(microphoneError({ name: 'NotAllowedError' })).toContain('Permití');
    expect(microphoneError({ name: 'NotFoundError' })).toContain('No se encontró');
    expect(microphoneError({ name: 'NotReadableError' })).toContain('otras aplicaciones');
    for (const code of ['recording_too_long', 'recording_converter_busy', 'template_opt_in_required', 'template_changed']) expect(errorMessage({ code })).not.toContain(code);
  });
});

function recordingHarness({ permission, supported = true } = {}) {
  let recorder; let time = 0; let tick;
  const stopTrack = vi.fn(); const stream = { getTracks: () => [{ stop: stopTrack }] };
  class Recorder {
    static isTypeSupported() { return supported; }
    constructor(incoming, options) { this.stream = incoming; this.mimeType = options.mimeType; this.state = 'inactive'; recorder = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    emit(bytes = 80) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) }); }
  }
  const onReady = vi.fn(), onError = vi.fn(), onState = vi.fn(), clear = vi.fn();
  const getUserMedia = vi.fn(permission || (() => Promise.resolve(stream)));
  const capture = createAudioCapture({ Recorder, mediaDevices: { getUserMedia }, onReady, onError, onState, now: () => time, every: callback => { tick = callback; return 7; }, clear });
  return { capture, onReady, onError, onState, stopTrack, getUserMedia, clear, stream, recorder: () => recorder, advance: seconds => { time += seconds * 1000; tick?.(); } };
}

describe('Ciclo del micrófono y preview local', () => {
  it('no solicita permisos al crear el controlador y no produce audio listo hasta detener', async () => {
    const test = recordingHarness();
    expect(test.getUserMedia).not.toHaveBeenCalled();
    await test.capture.start(); expect(test.getUserMedia).toHaveBeenCalledWith({ audio: true });
    test.recorder().emit(); test.advance(4); expect(test.onReady).not.toHaveBeenCalled();
    test.capture.stop(); expect(test.onReady).toHaveBeenCalledTimes(1);
    expect(test.onReady.mock.calls[0][0]).toMatchObject({ seconds: 4, mime: 'audio/webm;codecs=opus' });
    expect(test.stopTrack).toHaveBeenCalled(); expect(test.clear).toHaveBeenCalledWith(7);
    // onReady is a local Blob callback; this controller has no upload/send transport.
    expect(test.onReady.mock.calls[0][0].blob).toBeInstanceOf(Blob);
  });
  it('cancelar durante una grabación libera micrófono y nunca prepara un envío', async () => {
    const test = recordingHarness(); await test.capture.start(); test.recorder().emit(); test.capture.cancel();
    expect(test.stopTrack).toHaveBeenCalled(); expect(test.onReady).not.toHaveBeenCalled(); expect(test.onError).not.toHaveBeenCalled();
  });
  it('cancelar con el permiso pendiente libera el stream cuando el navegador lo entregue', async () => {
    let resolve; const permission = new Promise(done => { resolve = done; });
    const test = recordingHarness({ permission: () => permission }); const starting = test.capture.start();
    test.capture.cancel(); resolve(test.stream); await starting;
    expect(test.stopTrack).toHaveBeenCalled(); expect(test.recorder()).toBeUndefined(); expect(test.onReady).not.toHaveBeenCalled();
  });
  it('impide solicitudes duplicadas de micrófono', async () => {
    const test = recordingHarness(); await Promise.all([test.capture.start(), test.capture.start()]);
    expect(test.getUserMedia).toHaveBeenCalledTimes(1); test.capture.cancel();
  });
  it('se detiene a los 5 minutos y deja una vista previa sin enviar', async () => {
    const test = recordingHarness(); await test.capture.start(); test.recorder().emit(); test.advance(300);
    expect(test.onReady).toHaveBeenCalledTimes(1); expect(test.onReady.mock.calls[0][0].seconds).toBe(300); expect(test.stopTrack).toHaveBeenCalled();
  });
  it('descarta una grabación que excede 16 MB y detiene el dispositivo', async () => {
    const test = recordingHarness(); await test.capture.start(); test.recorder().emit(16 * 1024 * 1024 + 1);
    expect(test.onReady).not.toHaveBeenCalled(); expect(test.onError).toHaveBeenCalledWith(expect.stringContaining('16 MB')); expect(test.stopTrack).toHaveBeenCalled();
  });
  it('no pide permiso si falta un formato soportado y muestra una alternativa', async () => {
    const test = recordingHarness({ supported: false }); await test.capture.start();
    expect(test.getUserMedia).not.toHaveBeenCalled(); expect(test.onError).toHaveBeenCalledWith(expect.stringContaining('adjuntar'));
  });
  it('comunica permiso denegado y permite una nueva acción manual', async () => {
    const test = recordingHarness({ permission: () => Promise.reject({ name: 'NotAllowedError' }) }); await test.capture.start(); await test.capture.start();
    expect(test.getUserMedia).toHaveBeenCalledTimes(2); expect(test.onError).toHaveBeenCalledWith(expect.stringContaining('Permití'));
  });
  it('una grabación vacía no se presenta como lista', async () => {
    const test = recordingHarness(); await test.capture.start(); test.capture.stop();
    expect(test.onReady).not.toHaveBeenCalled(); expect(test.onError).toHaveBeenCalledWith(expect.stringContaining('No se grabó'));
  });
});

describe('Preparación de plantillas', () => {
  it('usa sólo variables esperadas y conserva su orden por sección', () => {
    const template = { variables: { header: ['1'], body: ['1', '2'] } };
    expect(templateParameters(template, { header: [' Cliente '], body: ['Pedido 10', ' Bicicleta ', 'no incluido'] })).toEqual({ header: ['Cliente'], body: ['Pedido 10', 'Bicicleta'] });
    expect(templateParameters(template)).toEqual({ header: [''], body: ['', ''] });
  });
  it('una plantilla sin variables produce parámetros vacíos, sin texto libre adicional', () => {
    expect(templateParameters({ variables: { header: [], body: [] } }, { body: ['no permitido'] })).toEqual({ header: [], body: [] });
  });
  it('la vista previa conserva el contenido autorizado del servidor', () => {
    expect(templatePreviewText('Hola.\n\nFusion Bikes')).toBe('Hola.\n\nFusion Bikes');
    expect(templatePreviewText({ header: 'Hola', body: 'Pedido 10', footer: 'Fusion Bikes', unrelated: 'No' })).toBe('Hola\n\nPedido 10\n\nFusion Bikes');
    expect(templatePreviewText(undefined)).toBe('');
  });
});
