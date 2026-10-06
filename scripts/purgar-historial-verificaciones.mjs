#!/usr/bin/env node
/**
 * Purga las repeticiones de `identidad_verificada` del historial de identidad.
 *
 * Hasta el 2026-09-06 se anotaba una fila por clave verificada en cada auditoría —~1.130 por
 * corrida, unas 81.000 por día—, así que 176.444 de las 177.286 filas de la tabla eran el mismo
 * evento repetido. El emisor ya está arreglado; esto limpia lo que quedó acumulado.
 *
 * Conserva la primera y la última verificación de cada caso: la primera dice desde cuándo esa
 * identidad está verificada, la última hasta cuándo se la vio bien. Ningún otro evento se toca
 * —decisiones, conflictos y archivados quedan intactos—.
 *
 * Uso:
 *   node scripts/purgar-historial-verificaciones.mjs            # simula
 *   node scripts/purgar-historial-verificaciones.mjs --aplicar  # borra
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { purgarHistorialVerificaciones } from '../lib/identidadProductos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aplicar = process.argv.includes('--aplicar');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'fusion.sqlite');
const db = new Database(dbPath, { readonly: !aplicar });

const otros = db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento<>'identidad_verificada'").get().n;
const r = purgarHistorialVerificaciones(db, { simular: !aplicar });
console.log(`identidad_verificada: ${r.total}`);
console.log(`  se conservan (primera y última de cada caso): ${r.conservados}`);
console.log(`  ${aplicar ? 'borradas' : 'a borrar'}: ${aplicar ? r.borrados : r.a_borrar}`);
console.log(`otros eventos del historial, intactos: ${otros}`);
if (!aplicar) console.log('\nsimulación: no se borró nada. Volvé a correr con --aplicar para hacerlo.');
db.close();
