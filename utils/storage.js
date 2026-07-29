import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function sanitize(str) {
  return (str || 'sin_clasificar')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
}

export function guardarArchivo({ buffer, originalname, mimetype, importador, numeroPedido }) {
  const carpetaImp = sanitize(importador);
  const carpetaPed = sanitize(numeroPedido);
  const dir = path.join(UPLOADS_DIR, carpetaImp, carpetaPed);
  fs.mkdirSync(dir, { recursive: true });

  const ts = Date.now();
  const ext = path.extname(originalname) || '';
  const base = path.basename(originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
  const filename = `${ts}-${base}${ext}`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, buffer);

  const url = `/uploads/${carpetaImp}/${carpetaPed}/${filename}`;
  return { url, filename: originalname, filepath };
}

export function rutaAbsoluta(url) {
  return path.join(path.dirname(UPLOADS_DIR), url);
}

// Defensa en profundidad: valida que una ruta absoluta ya calculada caiga dentro de
// UPLOADS_DIR antes de operar sobre el filesystem (ver purgarFotosBorradas). Hoy todo
// `url` en preparacion_fotos pasa por sanitize() en guardarArchivo, pero si algún día
// llegara una url con "../" por otra vía, esto evita borrar algo fuera de uploads/.
export function estaDentroDeUploads(abs) {
  return abs === UPLOADS_DIR || abs.startsWith(UPLOADS_DIR + path.sep);
}

export { UPLOADS_DIR };
