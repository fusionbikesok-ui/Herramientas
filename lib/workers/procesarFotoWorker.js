// Worker thread dedicado a procesar UNA foto de preparación (conversión HEIC + rotación +
// achicado). Corre fuera del hilo principal a propósito: heic-convert es libheif compilado a
// JavaScript puro (el sharp/libvips de este VPS no trae decoder HEIC/HEIF, excluido por la
// licencia HEVC) y bloquea el hilo que lo ejecuta 3-7 segundos enteros por foto (medido en
// este VPS con fotos reales de iPhone, ver docs/superpowers/plans/2026-08-12-fotos-
// preparacion.md). Si esto corriera en el hilo principal de Express, cada foto de iPhone
// dejaría a TODOS los usuarios sin respuesta ese tiempo. Verificado con medición real: el
// mismo trabajo en un worker deja el hilo principal con ~9ms de atraso máximo (vs. ~5900ms
// bloqueado corriendo en línea).
//
// No importa nada de routes/ ni recibe la conexión a la base — solo buffers/rutas de archivo,
// que es lo único que puede cruzar el postMessage sin acoplar este worker al resto de la app.
import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

// Lado largo de la versión "liviana": 1600px. Medido en este VPS (ver plan): sharp resuelve
// un resize a 1600px en ~86ms sobre una foto de iPhone de 4032×3024, y ese tamaño ya cubre de
// sobra el uso real (mirar en el teléfono qué se empacó, incluyendo detalle fino tipo
// etiquetas/números de serie) sin cargar con el peso completo de 3-4MB de la foto original.
const ANCHO_LIVIANA = 1600;
const CALIDAD_LIVIANA = 78;

async function procesar() {
  const { rutaEntrada, rutaSalida, esHeic } = workerData;
  const buffer = fs.readFileSync(rutaEntrada);
  // Mismo criterio que antes en routes/preparacion.js: decodificar HEIC/HEIF a JPEG con
  // heic-convert ANTES de pasarlo a sharp, que se encarga del resto del pipeline (auto-
  // rotación EXIF + resize + reencode).
  const entrada = esHeic
    ? await heicConvert({ buffer, format: 'JPEG', quality: 0.92 })
    : buffer;
  const liviana = await sharp(entrada)
    .rotate()
    .resize({ width: ANCHO_LIVIANA, withoutEnlargement: true })
    .jpeg({ quality: CALIDAD_LIVIANA })
    .toBuffer();
  fs.writeFileSync(rutaSalida, liviana);
}

procesar()
  .then(() => parentPort.postMessage({ ok: true }))
  .catch((e) => {
    // Se propaga solo el mensaje (nunca el buffer/contenido) — mismo criterio de logging que
    // el resto del repo: contexto de qué pasó, no el contenido del archivo del cliente.
    parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  });
