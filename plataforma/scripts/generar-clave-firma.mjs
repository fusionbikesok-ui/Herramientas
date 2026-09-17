#!/usr/bin/env node
/*
 * scripts/generar-clave-firma.mjs — genera el par Ed25519 de los informes EN EL VPS.
 * Uso: node plataforma/scripts/generar-clave-firma.mjs <kid> <ruta.pem> <ruta.pub>
 * La privada se escribe a un temporal con modo 0600, se hace fsync y se renombra: un corte de luz no
 * puede dejar media clave. La pública se commitea; la privada nunca.
 */
import { generateKeyPairSync } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs';

const [kid, rutaPem, rutaPub] = process.argv.slice(2);
if (!kid || !rutaPem || !rutaPub) { console.error('uso: generar-clave-firma.mjs <kid> <ruta.pem> <ruta.pub>'); process.exit(2); }
if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) { console.error('kid inválido'); process.exit(2); }

const par = generateKeyPairSync('ed25519');
const tmp = `${rutaPem}.tmp`;
const fd = openSync(tmp, 'wx', 0o600);
try {
  writeSync(fd, `kid: ${kid}\n${par.privateKey.export({ type: 'pkcs8', format: 'pem' })}`);
  fsyncSync(fd);
} finally { closeSync(fd); }
renameSync(tmp, rutaPem);
writeFileSync(rutaPub, par.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
console.log(`privada en ${rutaPem} (0600) y pública en ${rutaPub}; kid ${kid}`);
