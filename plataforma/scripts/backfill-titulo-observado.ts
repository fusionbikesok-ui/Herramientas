#!/usr/bin/env node
/*
 * scripts/backfill-titulo-observado.ts — una sola vez: llena external_representations.titulo_observado de ML
 * con el último payload ya guardado (cifrado) en integrations.inbox_messages. No llama a MercadoLibre.
 *
 * Por qué: el barrido completo ml.items#5441 vio 4215 ítems pero sólo 82 traían versión nueva; el resto se
 * deduplicó y nunca pasó por el proyector, que es quien llena titulo_observado. La lógica vive en
 * src/catalogo/backfill-titulo-observado.ts y reusa la extracción del proyector.
 *
 * Uso:
 *   DATABASE_URL=… CATALOGO_KEYRING_FILE=/ruta/sobres.json node scripts/backfill-titulo-observado.ts [--lote N] [--apply]
 * Por defecto es dry-run: cuenta y muestra, no escribe. --apply escribe por lotes, cada lote en su transacción.
 *
 * NO correr --apply en producción sin el OK de José sobre el dry-run revisado.
 */
import pg from 'pg';
import { backfillTituloObservado } from '../src/catalogo/backfill-titulo-observado.ts';
import { cargarKeyring } from '../src/seguridad/keyring.ts';

let lote = 200; let dryRun = true;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') dryRun = false;
  else if (args[i] === '--lote') lote = Number(args[++i]);
  else { console.error(`argumento desconocido: ${args[i]}`); process.exit(2); }
}
if (!Number.isInteger(lote) || lote < 1 || lote > 1000) { console.error('--lote debe ser un entero entre 1 y 1000'); process.exit(2); }
if (!process.env.DATABASE_URL || !process.env.CATALOGO_KEYRING_FILE) {
  console.error('faltan DATABASE_URL y/o CATALOGO_KEYRING_FILE'); process.exit(2);
}

const keyring = cargarKeyring(process.env.CATALOGO_KEYRING_FILE);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const r = await backfillTituloObservado(pool, keyring, { lote, dryRun });
  console.log(`modo: ${dryRun ? 'DRY-RUN (no escribe)' : 'APPLY'}  lote: ${lote}`);
  console.log(`candidatos:   ${r.candidatos}`);
  console.log(`llenaría:     ${r.llenaria}`);
  console.log(`llenadas:     ${r.llenadas}`);
  console.log(`sin payload:  ${r.sinPayload}`);
  console.log(`título vacío: ${r.tituloVacio}`);
  console.log(`rechazados:   ${r.rechazados}`);
  console.log(`errores:      ${r.errores.length}`);
  for (const e of r.errores.slice(0, 20)) console.log(`  error ${e.recurso}: ${e.motivo}`);
  for (const m of r.muestras) console.log(`  muestra ${m.recurso}: ${m.titulo}`);
  if (r.errores.length) process.exitCode = 1;
} finally {
  await pool.end();
}
