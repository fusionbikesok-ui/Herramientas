// Worker de prueba: simula un procesamiento exitoso sin depender de heic-convert/sharp reales
// (serían lentos/pesados de fixturar en cada test). Escribe un archivo chico en rutaSalida y
// avisa ok:true — lo mismo que hace el worker real, sin el trabajo pesado de decodificar nada.
import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';

fs.writeFileSync(workerData.rutaSalida, Buffer.from('liviana-de-prueba'));
parentPort.postMessage({ ok: true });
