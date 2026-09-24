#!/usr/bin/env node
/*
 * scripts/publicar-correccion-manifiestos.mjs — publica (o simula) la corrección firmada del
 * bug de last_hash de manifiesto.ts (commit 58a611d1). Ver src/informes/correccion.ts para el diseño
 * completo: nunca toca ni resube los manifiestos originales, publica un artefacto nuevo aparte.
 *
 * Uso:
 *   node scripts/publicar-correccion-manifiestos.mjs 2026-09-19 2026-09-20 2026-09-21 2026-09-22
 *   node scripts/publicar-correccion-manifiestos.mjs --dry-run 2026-09-19 2026-09-20   (por defecto)
 *   node scripts/publicar-correccion-manifiestos.mjs --publicar 2026-09-19 2026-09-20  (firma y sube de verdad)
 *
 * Requiere la misma configuración de entorno que el scheduler (informes: clave de firma, B2, etc.).
 */
import { readFileSync } from 'node:fs';
import { cargarConfig } from '../src/comun/config.ts';
import { crearPool } from '../src/db/pool.ts';
import { cargarClaveFirma, huella, verificarPar } from '../src/informes/firma.ts';
import { crearDeposito } from '../src/informes/deposito.ts';
import { publicarCorreccion } from '../src/informes/correccion.ts';

const argv = process.argv.slice(2);
const dryRun = !argv.includes('--publicar'); // por defecto true; --publicar es la única forma de desactivarlo
const fechas = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!fechas.length) {
  console.error('uso: publicar-correccion-manifiestos.mjs [--publicar] <fecha> [<fecha> ...]');
  process.exit(2);
}

const config = cargarConfig(process.env);
const i = config.informes;
if (!i) { console.error('la configuración de informes no está presente (INFORMES_* / B2_* / SMTP_*)'); process.exit(1); }

const pool = crearPool(config.pgUrl, { statementTimeoutMs: 10_000 });
const clave = cargarClaveFirma(i.claveFirmaFile);
const publicaPem = readFileSync(i.clavePublicaUbicacion, 'utf8');
verificarPar(clave, publicaPem);
console.log(`clave de firma cargada: kid=${clave.kid} huella=${huella(publicaPem)}`);

const deposito = crearDeposito({ ...i.b2, prefijo: 'e1/', dirPendientes: i.pendientesDir });

const empresa = await pool.query('SELECT id FROM core.companies ORDER BY id LIMIT 1');
const companyId = empresa.rows[0]?.id;
if (!companyId) { console.error('no hay ninguna empresa en core.companies'); process.exit(1); }

const r = await publicarCorreccion(pool, { fechas, clave, deposito, companyId, dryRun });

if (!r.publicado) {
  console.log(`no se publicó (motivo: ${r.motivo}). Días con discrepancia detectados: ${r.dias.length}`);
  console.log(JSON.stringify(r.dias, null, 2));
} else {
  console.log(`publicado: ${r.b2ObjectKey} (versión ${r.b2VersionId}, hash del sobre ${r.hashSobre})`);
  console.log(JSON.stringify(r.dias, null, 2));
}

await pool.end();
