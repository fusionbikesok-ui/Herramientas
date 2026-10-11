#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { purgarFotosBorradas } from '../routes/preparacion.js';
import { prepararReduccionHistorica, procesarColaFotos } from '../lib/fotosPreparacionCola.js';
import { rutaAbsoluta, estaDentroDeUploads } from '../utils/storage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aplicar = process.argv.includes('--aplicar');
const posicional = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const dbPath = path.resolve(root, posicional || process.env.DB_PATH || 'data/fusion.sqlite');
const limite = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const db = new Database(dbPath);

function resumen() {
  return db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN p.creado_en < ? AND h.preparacion_id IS NULL THEN 1 ELSE 0 END) AS vencidas,
      SUM(CASE WHEN p.creado_en >= ? AND f.url NOT LIKE '%-reducida.jpg' THEN 1 ELSE 0 END) AS por_reducir,
      SUM(CASE WHEN h.preparacion_id IS NOT NULL THEN 1 ELSE 0 END) AS protegidas
    FROM preparacion_fotos f
    JOIN preparaciones p ON p.id=f.preparacion_id
    LEFT JOIN preparacion_fotos_holds h ON h.preparacion_id=p.id`).get(limite, limite);
}

function archivosHuerfanos() {
  const referenciadas = new Set();
  for (const fila of db.prepare('SELECT url,url_liviana FROM preparacion_fotos').all()) {
    if (fila.url) referenciadas.add(path.resolve(rutaAbsoluta(fila.url)));
    if (fila.url_liviana) referenciadas.add(path.resolve(rutaAbsoluta(fila.url_liviana)));
  }
  const base = path.resolve(root, 'uploads', 'preparacion');
  const encontrados = [];
  const visitar = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visitar(abs);
      else if (entry.isFile() && !referenciadas.has(abs) && !entry.name.includes('.tmp-')) encontrados.push(abs);
    }
  };
  visitar(base);
  return encontrados.filter(estaDentroDeUploads);
}

try {
  const antes = resumen();
  const huerfanos = archivosHuerfanos();
  console.log(JSON.stringify({ modo: aplicar ? 'aplicar' : 'dry-run', db: dbPath, limite, ...antes, huerfanos: huerfanos.length }));
  if (!aplicar) {
    console.log('Dry-run: usá --aplicar para purgar, reducir y reemplazar los originales.');
    process.exitCode = 0;
  } else {
    const purgadas = purgarFotosBorradas(db);
    for (const abs of huerfanos) {
      try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const { encoladas } = prepararReduccionHistorica(db);
    let procesadas = 0;
    while (true) {
      const r = await procesarColaFotos(db);
      procesadas += r.procesadas || 0;
      if (!r.procesadas) break;
      if (procesadas % 50 === 0) console.log(`Procesadas ${procesadas}/${encoladas}`);
    }
    const pendientes = db.prepare("SELECT COUNT(*) n FROM preparacion_fotos WHERE estado_proceso IN ('pendiente','procesando')").get().n;
    const errores = db.prepare("SELECT COUNT(*) n FROM preparacion_fotos WHERE estado_proceso='error'").get().n;
    console.log(JSON.stringify({ ok: pendientes === 0 && errores === 0, purgadas, huerfanos_borrados: huerfanos.length, encoladas, procesadas, pendientes, errores, despues: resumen() }));
    if (pendientes || errores) process.exitCode = 1;
  }
} finally {
  db.close();
}
