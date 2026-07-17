#!/usr/bin/env node
// Sembrar / actualizar un usuario admin (o normal) desde la consola.
//
// Uso:
//   node scripts/seed-usuarios.mjs <usuario> <password> [--admin]
//
// Si el usuario ya existe, actualiza su contraseña (y el flag admin si se pasa).
// Las credenciales NO pasan por el chat: se corren por SSH en el VPS.
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from '../db/index.js';
import { hashPassword } from '../lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , username, password, ...flags] = process.argv;
if (!username || !password) {
  console.error('Uso: node scripts/seed-usuarios.mjs <usuario> <password> [--admin]');
  process.exit(1);
}
if (password.length < 6) {
  console.error('La contraseña debe tener al menos 6 caracteres.');
  process.exit(1);
}
const isAdmin = flags.includes('--admin') ? 1 : 0;

const dbPath = process.env.DB_PATH || './data/fusion.sqlite';
const db = openDb(dbPath);
const ahora = new Date().toISOString();

const existente = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
if (existente) {
  db.prepare('UPDATE users SET pass_hash = ?, is_admin = ?, activo = 1, actualizado_en = ? WHERE id = ?')
    .run(hashPassword(password), isAdmin, ahora, existente.id);
  console.log(`Usuario "${username}" actualizado (admin=${!!isAdmin}).`);
} else {
  db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
              VALUES (?, ?, ?, 1, ?, ?)`)
    .run(username.trim(), hashPassword(password), isAdmin, ahora, ahora);
  console.log(`Usuario "${username}" creado (admin=${!!isAdmin}).`);
}
