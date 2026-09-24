#!/usr/bin/env node
/*
 * scripts/calibracion-e3.mjs — métricas de calibración del motor de identidad (E3 corte 1 T7).
 * Uso: DATABASE_URL=… node --experimental-strip-types plataforma/scripts/calibracion-e3.mjs <empresa-uuid> [desde ISO] [hasta ISO]
 * Corre `calibrar` sobre la muestra congelada + decisiones humanas de la ventana, imprime JSON y
 * escribe docs/superpowers/evidence/e3/<fecha>-calibracion.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { calibrar } from '../src/identidad/calibracion.ts';

const [empresa, desde, hasta] = process.argv.slice(2);
if (!empresa || !process.env.DATABASE_URL) { console.error('uso: DATABASE_URL=… calibracion-e3.mjs <empresa> [desde] [hasta]'); process.exit(2); }
const aqui = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(aqui, '../test/identidad/fixtures/muestra-30.json'), 'utf8'));
const muestra = fx.casos.map((c) => ({ clave: c.clave, ml: c.ml, skuVerdad: c.sku_verdad ?? null }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const ahora = new Date();
  const m = await calibrar(pool, {
    empresa, muestra, catalogo: fx.catalogo,
    desde: desde ? new Date(desde) : new Date(ahora.getTime() - 30 * 864e5), hasta: hasta ? new Date(hasta) : ahora,
  });
  console.log(JSON.stringify(m, null, 2));
  const fecha = ahora.toISOString().slice(0, 10);
  const out = path.join(aqui, `../../docs/superpowers/evidence/e3/${fecha}-calibracion.md`);
  fs.writeFileSync(out, `# Calibración E3 — ${fecha}\n\nengine_version \`${m.engineVersion}\`, muestra n=${m.muestra.n}, ventana n=${m.ventana.n}\n\n\`\`\`json\n${JSON.stringify(m, null, 2)}\n\`\`\`\n\nTiempo mediano = tiempo de resolución (abierto_en → decisión humana).\n`);
  console.error('escrito', out);
} finally { await pool.end(); }
