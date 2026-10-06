#!/usr/bin/env node
/**
 * E1 T4 — verifica un informe firmado (manifiesto o reporte) sin depender del VPS ni de la base.
 *
 *   npm run verificar-informe -- <archivo.json> [--publica <kid>=<ruta.pem>]
 *
 * Sin `--publica`, busca la clave pública por el `kid` del sobre en
 * `docs/superpowers/specs/e1/firma-informes/<kid>.pub`: rotar la clave es agregar un archivo, y los informes
 * viejos se siguen verificando con la pública anterior. Imprime `válido (kid …)` y sale con 0, o
 * `inválido: <motivo>` y sale con 1.
 *
 * Usa la misma verificación que firma la plataforma (`plataforma/src/informes/firma.ts`, JCS + Ed25519):
 * Node 24 ejecuta TypeScript sin compilar.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verificar } from '../plataforma/src/informes/firma.ts';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR_PUBLICAS = join(RAIZ, 'docs/superpowers/specs/e1/firma-informes');

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--publica');
if (!archivo) {
  console.error('uso: npm run verificar-informe -- <archivo.json> [--publica <kid>=<ruta.pem>]');
  process.exit(2);
}

let sobre;
try {
  sobre = JSON.parse(readFileSync(archivo, 'utf8'));
} catch (e) {
  console.log(`inválido: no se pudo leer el archivo como JSON (${e.message})`);
  process.exit(1);
}

const publicas = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '--publica') continue;
  const [kid, ruta] = String(args[i + 1] ?? '').split('=');
  if (!kid || !ruta) { console.error('--publica espera <kid>=<ruta.pem>'); process.exit(2); }
  publicas[kid] = readFileSync(ruta, 'utf8');
}
if (!Object.keys(publicas).length && typeof sobre?.kid === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(sobre.kid)) {
  const ruta = join(DIR_PUBLICAS, `${sobre.kid}.pub`);
  if (existsSync(ruta)) publicas[sobre.kid] = readFileSync(ruta, 'utf8');
}

const r = verificar(sobre, publicas);
if (r.valido) {
  console.log(`válido (kid ${sobre.kid})`);
  process.exit(0);
}
console.log(`inválido: ${r.motivo}`);
process.exit(1);
