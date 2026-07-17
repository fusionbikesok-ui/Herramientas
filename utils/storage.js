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
