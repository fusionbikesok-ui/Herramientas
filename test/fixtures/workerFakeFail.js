// Worker de prueba: simula un fallo de procesamiento (ej. heic-convert real rechazando el
// buffer) sin depender de un archivo HEIC de verdad.
import { parentPort } from 'worker_threads';

parentPort.postMessage({ ok: false, error: 'fallo simulado de prueba' });
