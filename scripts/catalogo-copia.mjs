#!/usr/bin/env node
/**
 * E2 T1 — copia consistente del matcher y de los casos de identidad hacia la plataforma, a mano.
 *
 * Es el paso 5 de la puesta en producción (plan de E2 T1, tarea 14): se corre DESPUÉS de encender la captura
 * (OUTBOX_PLATAFORMA_CAPTURA=true) y antes de encender el envío. Usa el destino y el keyring de la sombra.
 * No escribe nada en la base del legado: la lee con una foto de la API de backup.
 *
 * Uso: node scripts/catalogo-copia.mjs
 */
import 'dotenv/config';
import { openDb } from '../db/index.js';
import { copiarCatalogo } from '../lib/catalogoCopia.js';
import { cargarKeyringInternoActivo } from '../lib/internoHmac.js';

const url = process.env.SOMBRA_PLATAFORMA_URL;
const keyringFile = process.env.SOMBRA_KEYRING_FILE;
if (!url || !keyringFile) {
  console.error('faltan SOMBRA_PLATAFORMA_URL o SOMBRA_KEYRING_FILE');
  process.exit(2);
}
const db = openDb(process.env.DB_PATH);
try {
  const r = await copiarCatalogo(db, { url, keyring: cargarKeyringInternoActivo(keyringFile) });
  console.log(JSON.stringify({
    corte: r.corte,
    matcher: { filas: r.matcher.total, ...r.matcher.resultado },
    identidad: { filas: r.identidad.total, ...r.identidad.resultado },
    invalidas: { matcher: r.invalidas.matcher.length, identidad: r.invalidas.identidad.length },
  }, null, 2));
} catch (e) {
  console.error('la copia falló:', e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
