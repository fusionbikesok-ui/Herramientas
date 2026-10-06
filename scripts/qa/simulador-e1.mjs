// Arranque del simulador de canales con el fixture en memoria del tramo 2 de E1.
// No usa SQLite ni credenciales: lee un JSON de fixture, resuelve sus marcas de tiempo relativas y
// escucha en SIM_PORT. Se usa desde `npm run test:e1` (servicio `simulator` del compose de ensayo).
//
//   SIM_FIXTURE=/qa/fixtures/e1-t2.json SIM_PORT=8080 SIM_SELLER=777 node scripts/qa/simulador-e1.mjs
//
// Marcas admitidas dentro del fixture:
//   "@-2h" / "@-30m"    → instante ISO con Z, relativo al arranque
//   "@gmt-2h"           → mismo instante sin zona (forma `*_gmt` de WooCommerce)
//   "{{seller}}"        → id de vendedor de SIM_SELLER
import { readFileSync } from 'node:fs';
import { crearSimulador } from './simulador-canales.mjs';

const RELATIVO = /^@(gmt)?-(\d+)([hm])$/;

function resolver(valor, ahora, seller) {
  if (typeof valor === 'string') {
    const m = RELATIVO.exec(valor);
    if (m) {
      const ms = Number(m[2]) * (m[3] === 'h' ? 3_600_000 : 60_000);
      const iso = new Date(ahora.getTime() - ms).toISOString();
      return m[1] ? iso.slice(0, 19) : iso;
    }
    return valor.replaceAll('{{seller}}', seller);
  }
  if (Array.isArray(valor)) return valor.map((v) => resolver(v, ahora, seller));
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, resolver(v, ahora, seller)]));
  }
  return valor;
}

const ruta = process.env.SIM_FIXTURE;
if (!ruta) { console.error('Falta SIM_FIXTURE'); process.exit(2); }
const seller = process.env.SIM_SELLER || '777';
const fixture = resolver(JSON.parse(readFileSync(ruta, 'utf8')), new Date(), seller);

const puerto = Number(process.env.SIM_PORT) || 8080;
crearSimulador({ fixture }).listen(puerto, '0.0.0.0', () => {
  const cuentas = Object.entries(fixture).flatMap(([canal, grupos]) =>
    Object.entries(grupos).map(([nombre, valor]) => `${canal}.${nombre}=${Array.isArray(valor) ? valor.length : Object.keys(valor).length}`));
  console.log(`simulador E1 en http://0.0.0.0:${puerto} vendedor ${seller} fixture ${cuentas.join(' ')}`);
});
