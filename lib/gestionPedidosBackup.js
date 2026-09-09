import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Crea un backup SQLite y lo verifica abriendo la copia e integridad_check. */
export async function crearBackupVerificado(db, destino) {
  const archivo = path.resolve(String(destino));
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
  await db.backup(archivo);
  const copia = new Database(archivo, { readonly: true });
  try {
    const integridad = copia.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integridad !== 'ok') throw new Error(`integridad SQLite inválida: ${integridad}`);
    const pedidos = copia.prepare('SELECT COUNT(*) AS n FROM gestion_pedidos').get().n;
    return { ok: true, archivo, integridad, pedidos };
  } finally { copia.close(); }
}
