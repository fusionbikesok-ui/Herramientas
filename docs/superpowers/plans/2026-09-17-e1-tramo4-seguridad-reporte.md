# Plan de implementación — E1 tramo 4 (seguridad y reporte)

> **Para agentes:** SUB-SKILL OBLIGATORIA: usá `superpowers:subagent-driven-development` (recomendada) o
> `superpowers:executing-plans` para ejecutar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`).

**Objetivo:** cerrar E1 firmando la evidencia diaria (manifiesto de auditoría y reporte de sombra), guardándola
fuera del VPS en Backblaze B2 con Object Lock inmutable, avisando por email, y dejando las passkeys
implementadas y probadas pero imposibles de habilitar en producción.

**Arquitectura:** un módulo nuevo `plataforma/src/informes/` con piezas de una responsabilidad cada una (firma,
manifiesto, reporte, entregas, depósito, correo), encadenadas por el scheduler una vez por día sobre el día
calendario argentino anterior. Cada efecto externo (subir, enviar) avanza una máquina de estados durable con
`lease`, para que un reintento o un segundo scheduler no dupliquen. Las passkeys viven en `src/auth/` y sus
rutas nacen apagadas por doble llave.

**Stack:** Node 24.21, TypeScript strict, Fastify 5, pg 8, PostgreSQL 18, Vitest 5,
`@simplewebauthn/server` ≥ 14.0.2, API S3 de Backblaze B2, SMTP existente.

**Spec:** `docs/superpowers/specs/2026-09-17-e1-tramo4-seguridad-reporte-design.md` (commit `122050b`).
Evaluación externa que corrigió el diseño: `docs/superpowers/evidence/e1/2026-09-17-E1-T4-revision-codex.md`.

## Restricciones globales

Valen para **todas** las tareas:

- **Producción real.** Ninguna tarea despliega, reinicia PM2, toca `.env`, llama a ML, a Woo o a B2 real, ni
  abre `data/fusion.sqlite` con el helper que aplica migraciones. Los tests no salen a internet.
- **Español** en código, comentarios, mensajes y commits. Cada commit termina con
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **`@simplewebauthn/server` ≥ 14.0.2** exacto en `plataforma/package.json` (la 14.0.1 arrastra dos
  vulnerabilidades moderadas). Ajusta PM-170.
- **Object Lock modo `COMPLIANCE`**, 365 días, en producción. Revisa PM-172 (decía `governance`).
- **Ningún secreto** en logs, en la línea de comando, en `plataforma.env` ni en el repo. Cada secreto en su
  archivo bajo `secretos/`, 0600.
- **Día de referencia:** el día calendario `America/Argentina/Buenos_Aires` anterior, ventana `[desde, hasta)`
  congelada, usada por igual en manifiesto y reporte.
- **Serialización firmada:** JCS (RFC 8785) en UTF-8, firma Ed25519, un solo archivo por artefacto con la firma
  adentro.
- **Antes de correr la suite completa** (`npm test` en la raíz o en `plataforma/`): `pgrep -af "vitest|node.*server"`
  y que no haya nada. Durante el desarrollo se corren archivos sueltos.
- **Migraciones:** archivos `.sql` numerados en `plataforma/migrations/`, siguiendo `0008_resumen_sombra.sql`.
  Los `GRANT` por defecto de `0002_permisos.sql` cubren `core`, `security`, `audit` e `integrations`: un esquema
  **nuevo** necesita sus propios `GRANT` explícitos.
- **Tests de base:** `test/soporte/base.ts` (`crearBaseDePrueba()`) crea una base efímera y aplica migraciones.
  No se escriben tests contra la base de producción.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `plataforma/migrations/0009_informes_entregas.sql` | esquema `informes`, tabla `entregas`, `GRANT` propios |
| `plataforma/migrations/0010_webauthn_desafios.sql` | `security.webauthn_challenges` y la fila `passkeys.real` en `false` |
| `plataforma/src/informes/jcs.ts` | serialización canónica RFC 8785 |
| `plataforma/src/informes/firma.ts` | cargar la clave, firmar y verificar el sobre |
| `plataforma/src/informes/dia.ts` | la ventana del día ART anterior |
| `plataforma/src/informes/manifiesto.ts` | arma el manifiesto del día con snapshot consistente |
| `plataforma/src/informes/reporte.ts` | arma el reporte de sombra del día y el semáforo |
| `plataforma/src/informes/entregas.ts` | máquina de estados durable y `lease` |
| `plataforma/src/informes/deposito.ts` | cliente S3 de B2: subir, leer retención, pendientes en disco |
| `plataforma/src/informes/correo.ts` | cuerpo del email y envío SMTP con adjunto |
| `plataforma/src/informes/vuelta.ts` | encadena todo; lo llama el scheduler |
| `plataforma/src/auth/passkeys.ts` | ceremonias WebAuthn y desafíos |
| `plataforma/src/auth/recuperacion.ts` | códigos de un solo uso y límite de intentos |
| `plataforma/src/api/passkeys.ts` | rutas Fastify y la guarda de doble llave |
| `plataforma/scripts/generar-clave-firma.mjs` | genera el par en el VPS (temporal + fsync + renombre) |
| `scripts/verificar-informe.mjs` | verificación independiente (`npm run verificar-informe`) |
| `lib/vigilanteInformes.js` (legado) | avisa a las 09:00 ART si no hay informe del día |

Tests espejo en `plataforma/test/informes/*.test.ts`, `plataforma/test/passkeys.test.ts` y
`test/vigilanteInformes.test.js`.

---

## Orden y cortes revisables

Un commit por tarea. Las tareas 1 a 5 no tocan la red ni el esquema de producción. La 12 es la única que
cambia el VPS y **necesita autorización explícita de José**, igual que C10 de T3.

---

### Tarea 1: Serialización canónica (JCS)

**Archivos:**
- Crear: `plataforma/src/informes/jcs.ts`
- Test: `plataforma/test/informes/jcs.test.ts`

**Interfaces:**
- Consume: nada.
- Produce: `canonizar(valor: unknown): string` — JSON canónico RFC 8785. Lanza `Error` ante `NaN`,
  `Infinity`, `undefined` en un array, `BigInt`, ciclos o funciones.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect } from 'vitest';
import { canonizar } from '../../src/informes/jcs.ts';

describe('canonizar', () => {
  it('ordena las claves por su código UTF-16 y no deja espacios', () => {
    expect(canonizar({ b: 1, a: 2, 'ä': 3, A: 4 })).toBe('{"A":4,"a":2,"b":1,"ä":3}');
  });

  it('el mismo objeto con las claves en otro orden da los mismos bytes', () => {
    expect(canonizar({ x: { z: 1, y: 2 } })).toBe(canonizar({ x: { y: 2, z: 1 } }));
  });

  it('serializa los números como pide RFC 8785', () => {
    expect(canonizar([1, 1.0, 1e21, 0.000001, -0])).toBe('[1,1,1e+21,0.000001,0]');
  });

  it('escapa sólo lo que exige el estándar', () => {
    expect(canonizar({ t: 'a"\\\né😀' })).toBe('{"t":"a\\"\\\\\\n\\u0007é😀"}');
  });

  it('descarta las claves con undefined y rechaza undefined dentro de un array', () => {
    expect(canonizar({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonizar([undefined])).toThrow(/undefined/);
  });

  it('rechaza lo que no tiene forma canónica', () => {
    expect(() => canonizar(Number.NaN)).toThrow(/finito/);
    expect(() => canonizar({ f: () => 1 })).toThrow(/función/);
    const ciclo: Record<string, unknown> = {}; ciclo.yo = ciclo;
    expect(() => canonizar(ciclo)).toThrow(/ciclo/);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/jcs.test.ts`
Esperado: FALLA con "Cannot find module '../../src/informes/jcs.ts'".

- [ ] **Paso 3: implementación mínima**

```ts
/*
 * src/informes/jcs.ts — JSON canónico (RFC 8785, JCS).
 *
 * Existe porque "claves ordenadas y sin espacios" no alcanza: sin fijar la forma de los números, el
 * escapado y el orden por código UTF-16, dos programas producen bytes distintos para el mismo objeto y la
 * firma deja de ser verificable por terceros (hallazgo 8 de la revisión externa del 2026-09-17).
 */

// RFC 8785 §3.2.2.2: los números usan la forma de ECMAScript, que Number.prototype.toString ya produce,
// salvo el cero negativo, que canoniza a "0".
function numero(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`canonizar: ${n} no es un número finito`);
  return Object.is(n, -0) ? '0' : String(n);
}

const ESCAPES: Record<string, string> = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t',
};

function texto(s: string): string {
  let salida = '"';
  for (const ch of s) {
    const escape = ESCAPES[ch];
    if (escape) { salida += escape; continue; }
    const cp = ch.codePointAt(0)!;
    // Sólo los de control van en \u00xx; el resto viaja como UTF-8 literal (RFC 8785 §3.2.2.2).
    salida += cp < 0x20 ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
  }
  return `${salida}"`;
}

function serializar(valor: unknown, vistos: Set<object>): string {
  if (valor === null) return 'null';
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (typeof valor === 'number') return numero(valor);
  if (typeof valor === 'string') return texto(valor);
  if (typeof valor === 'bigint') throw new Error('canonizar: BigInt no tiene forma canónica en JSON');
  if (typeof valor === 'function') throw new Error('canonizar: una función no es serializable');
  if (typeof valor === 'undefined') throw new Error('canonizar: undefined no es serializable');
  if (typeof valor === 'object') {
    if (vistos.has(valor as object)) throw new Error('canonizar: hay un ciclo en el objeto');
    vistos.add(valor as object);
    try {
      if (Array.isArray(valor)) return `[${valor.map((v) => serializar(v, vistos)).join(',')}]`;
      const entradas = Object.entries(valor as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        // RFC 8785 §3.2.3: se ordena por las unidades de código UTF-16, que es lo que compara `<`.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entradas.map(([k, v]) => `${texto(k)}:${serializar(v, vistos)}`).join(',')}}`;
    } finally {
      vistos.delete(valor as object);
    }
  }
  throw new Error(`canonizar: tipo no soportado ${typeof valor}`);
}

export function canonizar(valor: unknown): string {
  return serializar(valor, new Set());
}
```

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/jcs.test.ts && npm run typecheck`
Esperado: PASA y el typecheck sin errores.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/jcs.ts plataforma/test/informes/jcs.test.ts
git commit -m "feat(informes): JSON canónico RFC 8785 para firmar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 2: Firma Ed25519 y custodia de la clave

**Archivos:**
- Crear: `plataforma/src/informes/firma.ts`, `plataforma/scripts/generar-clave-firma.mjs`
- Test: `plataforma/test/informes/firma.test.ts`

**Interfaces:**
- Consume: `canonizar` de la tarea 1.
- Produce:
  - `cargarClaveFirma(ruta: string, io?: { uidEsperado?: number }): { kid: string; privada: crypto.KeyObject }`
  - `firmar(contenido: unknown, clave: { kid: string; privada: crypto.KeyObject }): Sobre`
  - `verificar(sobre: unknown, publicas: Record<string, string>): { valido: boolean; motivo?: string; contenido?: unknown }`
  - `huella(publicaPem: string): string` — SHA-256 en base64 de la clave pública, para el email.
  - `interface Sobre { version: 1; kid: string; firma: string; contenido: unknown }`

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cargarClaveFirma, firmar, huella, verificar } from '../../src/informes/firma.ts';

describe('firma', () => {
  let dir: string; let ruta: string; let publicaPem: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'firma-'));
    ruta = join(dir, 'firma-informes.pem');
    const par = generateKeyPairSync('ed25519');
    publicaPem = par.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    writeFileSync(ruta, `kid: k1\n${par.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()}`, { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('una firma válida verifica y devuelve el contenido', () => {
    const sobre = firmar({ dia: '2026-09-17', n: 3 }, cargarClaveFirma(ruta));
    expect(sobre).toMatchObject({ version: 1, kid: 'k1' });
    const r = verificar(sobre, { k1: publicaPem });
    expect(r.valido).toBe(true);
    expect(r.contenido).toEqual({ dia: '2026-09-17', n: 3 });
  });

  it('un contenido alterado no verifica', () => {
    const sobre = firmar({ n: 3 }, cargarClaveFirma(ruta));
    const r = verificar({ ...sobre, contenido: { n: 4 } }, { k1: publicaPem });
    expect(r).toMatchObject({ valido: false, motivo: 'firma_invalida' });
  });

  it('el mismo contenido con las claves en otro orden da la misma firma', () => {
    const clave = cargarClaveFirma(ruta);
    expect(firmar({ a: 1, b: 2 }, clave).firma).toBe(firmar({ b: 2, a: 1 }, clave).firma);
  });

  it('un kid desconocido no verifica', () => {
    const sobre = firmar({ n: 1 }, cargarClaveFirma(ruta));
    expect(verificar({ ...sobre, kid: 'otro' }, { k1: publicaPem })).toMatchObject({ valido: false, motivo: 'kid_desconocido' });
  });

  it('rechaza permisos amplios, dueño ajeno, enlace y directorio abierto', () => {
    chmodSync(ruta, 0o640);
    expect(() => cargarClaveFirma(ruta)).toThrow(/legible por grupo u otros/);
    chmodSync(ruta, 0o600);
    expect(() => cargarClaveFirma(ruta, { uidEsperado: 999999 })).toThrow(/dueño/);
    const enlace = join(dir, 'enlace.pem');
    symlinkSync(ruta, enlace);
    expect(() => cargarClaveFirma(enlace)).toThrow(/archivo regular/);
    chmodSync(dir, 0o777);
    expect(() => cargarClaveFirma(ruta)).toThrow(/directorio/);
  });

  it('la huella es estable y no es la clave', () => {
    expect(huella(publicaPem)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(huella(publicaPem)).not.toContain('BEGIN');
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/firma.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

```ts
/*
 * src/informes/firma.ts — firma Ed25519 de la evidencia diaria.
 *
 * La privada nunca sale del VPS y se valida como en `src/seguridad/keyring.ts`, pero más estricto: la
 * revisión externa del 2026-09-17 (hallazgo 7) mostró que mirar sólo los bits de grupo y otros deja pasar
 * un enlace simbólico o un directorio padre escribible por cualquiera.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Sobre { version: 1; kid: string; firma: string; contenido: unknown }
export class ErrorFirma extends Error { override name = 'ErrorFirma'; }

import { canonizar } from './jcs.ts';

const KID = /^[A-Za-z0-9._-]{1,64}$/;

export function cargarClaveFirma(ruta: string, io: { uidEsperado?: number } = {}): { kid: string; privada: KeyObject } {
  const st = lstatSync(ruta);
  if (!st.isFile()) throw new ErrorFirma(`${ruta} no es un archivo regular`);
  if ((st.mode & 0o077) !== 0) throw new ErrorFirma(`la clave ${ruta} es legible por grupo u otros`);
  const uid = io.uidEsperado ?? process.getuid?.() ?? st.uid;
  if (st.uid !== uid) throw new ErrorFirma(`la clave ${ruta} tiene otro dueño (uid ${st.uid})`);
  // Un directorio escribible por otros permite reemplazar la clave entera: no alcanza con el archivo.
  if ((statSync(dirname(ruta)).mode & 0o022) !== 0) throw new ErrorFirma(`el directorio de ${ruta} es escribible por otros`);

  const crudo = readFileSync(ruta, 'utf8');
  const kid = /^kid:\s*(\S+)\s*$/m.exec(crudo)?.[1];
  if (!kid || !KID.test(kid)) throw new ErrorFirma(`la clave ${ruta} no declara un kid válido`);
  const pem = crudo.slice(crudo.indexOf('-----BEGIN'));
  const privada = createPrivateKey(pem);
  if (privada.asymmetricKeyType !== 'ed25519') throw new ErrorFirma('la clave no es Ed25519');
  return { kid, privada };
}

export function firmar(contenido: unknown, clave: { kid: string; privada: KeyObject }): Sobre {
  const bytes = Buffer.from(canonizar(contenido), 'utf8');
  return { version: 1, kid: clave.kid, firma: sign(null, bytes, clave.privada).toString('base64'), contenido };
}

export function verificar(sobre: unknown, publicas: Record<string, string>): { valido: boolean; motivo?: string; contenido?: unknown } {
  if (sobre === null || typeof sobre !== 'object') return { valido: false, motivo: 'sobre_invalido' };
  const { version, kid, firma, contenido } = sobre as Partial<Sobre>;
  if (version !== 1 || typeof kid !== 'string' || typeof firma !== 'string') return { valido: false, motivo: 'sobre_invalido' };
  const pem = publicas[kid];
  if (!pem) return { valido: false, motivo: 'kid_desconocido' };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonizar(contenido), 'utf8'), createPublicKey(pem), Buffer.from(firma, 'base64'));
  } catch { return { valido: false, motivo: 'firma_invalida' }; }
  return ok ? { valido: true, contenido } : { valido: false, motivo: 'firma_invalida' };
}

export function huella(publicaPem: string): string {
  const spki = createPublicKey(publicaPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}
```

Y el generador, que nunca deja una clave a medio escribir:

```js
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
```

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/firma.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: probar el generador en un temporal**

```bash
D=$(mktemp -d); node plataforma/scripts/generar-clave-firma.mjs k1 "$D/f.pem" "$D/f.pub" && stat -c '%a %n' "$D"/f.* && rm -rf "$D"
```
Esperado: `600 …f.pem` y `644 …f.pub`.

- [ ] **Paso 6: commit**

```bash
git add plataforma/src/informes/firma.ts plataforma/scripts/generar-clave-firma.mjs plataforma/test/informes/firma.test.ts
git commit -m "feat(informes): firma Ed25519 con custodia estricta de la clave

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 3: La ventana del día argentino

**Archivos:**
- Crear: `plataforma/src/informes/dia.ts`
- Test: `plataforma/test/informes/dia.test.ts`

**Interfaces:**
- Consume: nada.
- Produce: `ventanaDiaAnterior(ahora: Date): { fecha: string; desde: Date; hasta: Date }` — `fecha` en
  `YYYY-MM-DD`, `desde` inclusive y `hasta` exclusivo; `diasFaltantes(ultima: string | null, ahora: Date): string[]`
  — las fechas pendientes de la más vieja a la más nueva, tope de 30.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect } from 'vitest';
import { diasFaltantes, ventanaDiaAnterior } from '../../src/informes/dia.ts';

describe('ventanaDiaAnterior', () => {
  it('a las 07:00 ART reporta el día calendario anterior completo', () => {
    // 2026-09-17T10:00Z son las 07:00 ART: el día a reportar es el 16.
    const v = ventanaDiaAnterior(new Date('2026-09-17T10:00:00Z'));
    expect(v.fecha).toBe('2026-09-16');
    expect(v.desde.toISOString()).toBe('2026-09-16T03:00:00.000Z');
    expect(v.hasta.toISOString()).toBe('2026-09-17T03:00:00.000Z');
  });

  it('justo después de medianoche ART sigue siendo el día anterior', () => {
    expect(ventanaDiaAnterior(new Date('2026-09-17T03:30:00Z')).fecha).toBe('2026-09-16');
  });

  it('antes de medianoche ART el día anterior es el de ayer ART, no el UTC', () => {
    // 2026-09-17T02:00Z son las 23:00 ART del 16: el anterior es el 15.
    expect(ventanaDiaAnterior(new Date('2026-09-17T02:00:00Z')).fecha).toBe('2026-09-15');
  });
});

describe('diasFaltantes', () => {
  it('sin informes previos devuelve sólo el día anterior', () => {
    expect(diasFaltantes(null, new Date('2026-09-17T10:00:00Z'))).toEqual(['2026-09-16']);
  });

  it('devuelve los días caídos del más viejo al más nuevo', () => {
    expect(diasFaltantes('2026-09-13', new Date('2026-09-17T10:00:00Z')))
      .toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });

  it('al día no agrega nada y nunca devuelve más de 30', () => {
    expect(diasFaltantes('2026-09-16', new Date('2026-09-17T10:00:00Z'))).toEqual([]);
    expect(diasFaltantes('2025-01-01', new Date('2026-09-17T10:00:00Z'))).toHaveLength(30);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/dia.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

```ts
/*
 * src/informes/dia.ts — el día que cubre cada informe.
 *
 * Argentina no tiene horario de verano desde 2009, pero el offset no se escribe a mano: se pregunta a la
 * base de datos de zonas de Node. Manifiesto y reporte usan esta misma ventana; antes uno decía UTC y el
 * otro salía 07:00 ART, así que no quedaba claro qué día se reportaba (hallazgo 16 de la revisión externa).
 */
export const ZONA = 'America/Argentina/Buenos_Aires';
const TOPE_DIAS = 30;

const FORMATO = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

/** La fecha calendario ART de un instante, en YYYY-MM-DD. */
export function fechaArt(instante: Date): string {
  return FORMATO.format(instante);
}

/** El instante UTC de la medianoche ART que abre esa fecha. */
export function medianocheArt(fecha: string): Date {
  // Se prueban los offsets posibles y se acepta el que cae en la fecha pedida a las 00:00.
  for (const offset of [3, 2, 4]) {
    const tentativa = new Date(`${fecha}T0${offset}:00:00.000Z`);
    if (fechaArt(tentativa) === fecha && new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hour12: false }).format(tentativa) === '00') {
      return tentativa;
    }
  }
  throw new Error(`medianocheArt: no se pudo ubicar la medianoche de ${fecha}`);
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function ventanaDiaAnterior(ahora: Date): { fecha: string; desde: Date; hasta: Date } {
  const fecha = sumarDias(fechaArt(ahora), -1);
  return { fecha, desde: medianocheArt(fecha), hasta: medianocheArt(sumarDias(fecha, 1)) };
}

export function diasFaltantes(ultima: string | null, ahora: Date): string[] {
  const objetivo = ventanaDiaAnterior(ahora).fecha;
  if (!ultima) return [objetivo];
  const dias: string[] = [];
  for (let f = sumarDias(ultima, 1); f <= objetivo; f = sumarDias(f, 1)) {
    dias.push(f);
    if (dias.length === TOPE_DIAS) break;
  }
  return dias;
}
```

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/dia.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/dia.ts plataforma/test/informes/dia.test.ts
git commit -m "feat(informes): ventana del día calendario argentino

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 4: Migración del esquema `informes` y la tabla de entregas

**Archivos:**
- Crear: `plataforma/migrations/0009_informes_entregas.sql`
- Test: `plataforma/test/informes/entregas-esquema.test.ts`

**Interfaces:**
- Consume: nada.
- Produce: la tabla `informes.entregas` con columnas `tipo` (`manifiesto`|`reporte`), `fecha`, `estado`
  (`generado`|`firmado`|`subido`|`avisado`), `hash_contenido`, `kid`, `ruta_pendiente`, `intentos`,
  `ultimo_error`, `testigo`, `lease_hasta`, y los `*_en` de cada transición.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('informes.entregas', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('una entrega por tipo y fecha', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado, hash_contenido) VALUES ('reporte','2026-09-16','generado', repeat('a',64))`);
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado, hash_contenido) VALUES ('reporte','2026-09-16','generado', repeat('b',64))`))
      .rejects.toThrow(/duplicate key/);
  });

  it('rechaza estados y tipos desconocidos', async () => {
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado, hash_contenido) VALUES ('reporte','2026-09-15','enviado', repeat('a',64))`))
      .rejects.toThrow(/entregas_estado_check/);
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado, hash_contenido) VALUES ('otro','2026-09-15','generado', repeat('a',64))`))
      .rejects.toThrow(/entregas_tipo_check/);
  });

  it('el rol de la aplicación puede leer y escribir, pero no borrar', async () => {
    await pool.query(`UPDATE informes.entregas SET intentos = intentos + 1 WHERE fecha = '2026-09-16'`);
    await expect(pool.query(`DELETE FROM informes.entregas WHERE fecha = '2026-09-16'`)).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/entregas-esquema.test.ts`
Esperado: FALLA con `schema "informes" does not exist`.

- [ ] **Paso 3: escribir la migración**

```sql
-- E1 T4 · tarea 4: estado durable de cada artefacto firmado.
-- Las tablas de T1 (audit.audit_daily_manifests, integrations.daily_shadow_reports) exigen clave de objeto
-- y versión de B2 NOT NULL, así que no tienen dónde representar "firmado pero todavía no subido". Sin ese
-- estado, un fallo de red obliga a inventar identificadores o a perder la idempotencia (hallazgo 1 de la
-- revisión externa del 2026-09-17).
CREATE SCHEMA informes;

CREATE TABLE informes.entregas (
  tipo            text NOT NULL CHECK (tipo IN ('manifiesto', 'reporte')),
  fecha           date NOT NULL,
  estado          text NOT NULL CHECK (estado IN ('generado', 'firmado', 'subido', 'avisado')),
  hash_contenido  text NOT NULL CHECK (hash_contenido ~ '^[0-9a-f]{64}$'),
  kid             text,
  ruta_pendiente  text,
  b2_object_key   text,
  b2_version_id   text,
  retention_until timestamptz,
  intentos        integer NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_error    text,
  -- El candado de sesión del scheduler no alcanza: al perder la conexión, el proceso viejo puede seguir
  -- subiendo y enviando. Cada efecto se reclama con este testigo, verificado antes y después.
  testigo         uuid,
  lease_hasta     timestamptz,
  generado_en     timestamptz NOT NULL DEFAULT now(),
  firmado_en      timestamptz,
  subido_en       timestamptz,
  avisado_en      timestamptz,
  PRIMARY KEY (tipo, fecha)
);

CREATE INDEX entregas_pendientes ON informes.entregas (estado, fecha) WHERE estado <> 'avisado';

-- Los GRANT por defecto de 0002_permisos.sql cubren core, security, audit e integrations: un esquema nuevo
-- necesita los suyos. Sin DELETE: una entrega es evidencia de lo que pasó ese día.
GRANT USAGE ON SCHEMA informes TO plataforma_app;
GRANT SELECT, INSERT, UPDATE ON informes.entregas TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA informes GRANT SELECT, INSERT, UPDATE ON TABLES TO plataforma_app;
```

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/entregas-esquema.test.ts test/migraciones.test.ts`
Esperado: PASA, incluida la prueba de migraciones existente.

- [ ] **Paso 5: reflejar la tabla en el esquema de referencia**

Agregar el mismo `CREATE TABLE` a `docs/superpowers/specs/e1/schema.sql`, con el comentario de por qué existe.

- [ ] **Paso 6: commit**

```bash
git add plataforma/migrations/0009_informes_entregas.sql plataforma/test/informes/entregas-esquema.test.ts docs/superpowers/specs/e1/schema.sql
git commit -m "feat(informes): esquema informes con la tabla de entregas

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 5: Máquina de estados de entrega con `lease`

**Archivos:**
- Crear: `plataforma/src/informes/entregas.ts`
- Test: `plataforma/test/informes/entregas.test.ts`

**Interfaces:**
- Consume: la tabla de la tarea 4.
- Produce:
  - `reclamar(db, tipo: 'manifiesto'|'reporte', fecha: string, opciones: { hash: string; leaseMs?: number; ahora?: Date }): Promise<Reclamo | null>`
    — crea la fila si no existe y devuelve `{ testigo, estado, fila }`, o `null` si otro proceso tiene el
    `lease` vigente.
  - `avanzar(db, reclamo: Reclamo, estado: 'firmado'|'subido'|'avisado', datos?: Record<string, unknown>): Promise<boolean>`
    — `false` si el testigo cambió (otro proceso tomó la entrega): el llamador se detiene sin escribir.
  - `anotarFallo(db, reclamo: Reclamo, error: string): Promise<void>`
  - `pendientesVencidas(db, ahora: Date, horas?: number): Promise<Array<{ tipo: string; fecha: string; estado: string; intentos: number }>>`
    — las que llevan más de `horas` (24 por omisión) sin llegar a `avisado`, para el incidente crítico.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { anotarFallo, avanzar, pendientesVencidas, reclamar } from '../../src/informes/entregas.ts';

describe('entregas', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  const HASH = 'a'.repeat(64);
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });
  beforeEach(async () => { await pool.query('UPDATE informes.entregas SET lease_hasta = NULL'); });

  it('reclama, avanza y deja la fila en avisado', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-16', { hash: HASH });
    expect(r).not.toBeNull();
    expect(await avanzar(pool, r!, 'firmado', { kid: 'k1' })).toBe(true);
    expect(await avanzar(pool, r!, 'subido', { b2_object_key: 'e1/reportes/2026-09-16.json', b2_version_id: 'v1' })).toBe(true);
    expect(await avanzar(pool, r!, 'avisado')).toBe(true);
    const fila = (await pool.query(`SELECT estado, kid, b2_version_id, avisado_en FROM informes.entregas WHERE fecha='2026-09-16'`)).rows[0];
    expect(fila).toMatchObject({ estado: 'avisado', kid: 'k1', b2_version_id: 'v1' });
    expect(fila.avisado_en).not.toBeNull();
  });

  it('un segundo proceso no puede reclamar mientras el lease está vigente', async () => {
    const primero = await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH, leaseMs: 60_000 });
    expect(primero).not.toBeNull();
    expect(await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH })).toBeNull();
  });

  it('cuando el lease vence, el nuevo dueño invalida al viejo', async () => {
    const viejo = await reclamar(pool, 'reporte', '2026-09-14', { hash: HASH, leaseMs: -1 });
    const nuevo = await reclamar(pool, 'reporte', '2026-09-14', { hash: HASH });
    expect(nuevo).not.toBeNull();
    expect(nuevo!.testigo).not.toBe(viejo!.testigo);
    // El proceso viejo sigue vivo y cree que le toca: no debe poder escribir.
    expect(await avanzar(pool, viejo!, 'subido')).toBe(false);
    expect((await pool.query(`SELECT estado FROM informes.entregas WHERE fecha='2026-09-14'`)).rows[0].estado).toBe('generado');
  });

  it('una entrega ya avisada no se vuelve a reclamar', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-13', { hash: HASH });
    await avanzar(pool, r!, 'firmado'); await avanzar(pool, r!, 'subido'); await avanzar(pool, r!, 'avisado');
    await pool.query('UPDATE informes.entregas SET lease_hasta = NULL');
    expect(await reclamar(pool, 'manifiesto', '2026-09-13', { hash: HASH })).toBeNull();
  });

  it('anotarFallo cuenta intentos y pendientesVencidas encuentra las viejas', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-12', { hash: HASH });
    await anotarFallo(pool, r!, 'B2 no responde');
    const fila = (await pool.query(`SELECT intentos, ultimo_error FROM informes.entregas WHERE fecha='2026-09-12' AND tipo='manifiesto'`)).rows[0];
    expect(fila).toMatchObject({ intentos: 1, ultimo_error: 'B2 no responde' });
    await pool.query(`UPDATE informes.entregas SET generado_en = now() - interval '30 hours' WHERE fecha='2026-09-12'`);
    const vencidas = await pendientesVencidas(pool, new Date());
    expect(vencidas.some((v) => v.fecha.toString().startsWith('2026-09-12'))).toBe(true);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/entregas.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

```ts
/*
 * src/informes/entregas.ts — quién tiene derecho a firmar, subir y avisar cada artefacto.
 *
 * La clave primaria por fecha evita dos filas, pero no dos PUT a B2 ni dos emails: entre el efecto y su
 * registro hay una ventana. Cada efecto se reclama con un testigo (`lease`) que se verifica en el UPDATE
 * posterior; si cambió, el proceso viejo se detiene sin escribir (hallazgos 2 y 3 de la revisión externa).
 */
import { randomUUID } from 'node:crypto';
import type { Consultable } from '../db/pool.ts';

export type TipoEntrega = 'manifiesto' | 'reporte';
export type EstadoEntrega = 'generado' | 'firmado' | 'subido' | 'avisado';
export interface Reclamo { tipo: TipoEntrega; fecha: string; testigo: string; estado: EstadoEntrega }

const LEASE_MS = 10 * 60_000;
const HORAS_INCIDENTE = 24;

export async function reclamar(
  db: Consultable, tipo: TipoEntrega, fecha: string,
  opciones: { hash: string; leaseMs?: number; ahora?: Date },
): Promise<Reclamo | null> {
  const testigo = randomUUID();
  const hasta = new Date((opciones.ahora ?? new Date()).getTime() + (opciones.leaseMs ?? LEASE_MS));
  const r = await db.query<{ estado: EstadoEntrega }>(
    `INSERT INTO informes.entregas (tipo, fecha, estado, hash_contenido, testigo, lease_hasta)
     VALUES ($1, $2, 'generado', $3, $4, $5)
     ON CONFLICT (tipo, fecha) DO UPDATE
       SET testigo = $4, lease_hasta = $5
       WHERE informes.entregas.estado <> 'avisado'
         AND (informes.entregas.lease_hasta IS NULL OR informes.entregas.lease_hasta <= now())
     RETURNING estado`,
    [tipo, fecha, opciones.hash, testigo, hasta],
  );
  const fila = r.rows[0];
  return fila ? { tipo, fecha, testigo, estado: fila.estado } : null;
}

const COLUMNA_FECHA: Record<Exclude<EstadoEntrega, 'generado'>, string> = {
  firmado: 'firmado_en', subido: 'subido_en', avisado: 'avisado_en',
};
const DATOS_PERMITIDOS = new Set(['kid', 'ruta_pendiente', 'b2_object_key', 'b2_version_id', 'retention_until']);

export async function avanzar(
  db: Consultable, reclamo: Reclamo, estado: Exclude<EstadoEntrega, 'generado'>,
  datos: Record<string, unknown> = {},
): Promise<boolean> {
  const extra = Object.keys(datos).filter((k) => DATOS_PERMITIDOS.has(k));
  const valores = [reclamo.tipo, reclamo.fecha, reclamo.testigo, estado, ...extra.map((k) => datos[k])];
  const asignaciones = extra.map((k, i) => `${k} = $${5 + i}`).join(', ');
  const r = await db.query(
    `UPDATE informes.entregas
        SET estado = $4, ${COLUMNA_FECHA[estado]} = now()${asignaciones ? `, ${asignaciones}` : ''}
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3`,
    valores,
  );
  return (r.rowCount ?? 0) === 1;
}

export async function anotarFallo(db: Consultable, reclamo: Reclamo, error: string): Promise<void> {
  await db.query(
    `UPDATE informes.entregas SET intentos = intentos + 1, ultimo_error = $4, lease_hasta = NULL
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3`,
    [reclamo.tipo, reclamo.fecha, reclamo.testigo, error.slice(0, 500)],
  );
}

export async function pendientesVencidas(
  db: Consultable, ahora: Date, horas: number = HORAS_INCIDENTE,
): Promise<Array<{ tipo: string; fecha: string; estado: string; intentos: number }>> {
  const r = await db.query<{ tipo: string; fecha: string; estado: string; intentos: number }>(
    `SELECT tipo, fecha, estado, intentos FROM informes.entregas
      WHERE estado <> 'avisado' AND generado_en <= $1::timestamptz - make_interval(hours => $2)
      ORDER BY fecha`,
    [ahora, horas],
  );
  return r.rows;
}
```

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/entregas.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/entregas.ts plataforma/test/informes/entregas.test.ts
git commit -m "feat(informes): máquina de estados de entrega con lease

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 6: Manifiesto diario de auditoría (`E1-AUD-04`)

**Archivos:**
- Crear: `plataforma/src/informes/manifiesto.ts`
- Test: `plataforma/test/informes/manifiesto.test.ts`

**Interfaces:**
- Consume: `ventanaDiaAnterior` (tarea 3).
- Produce: `armarManifiesto(pool, fecha: string): Promise<Manifiesto>` con
  `{ tipo: 'manifiesto'; fecha; primer_chain_seq: string | null; ultimo_chain_seq: string | null; ultimo_hash: string; eventos: number; cadena: { integra: boolean; roto_en: string | null }; retention_until: string }`.
  El `hash` viaja en hexadecimal.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { armarManifiesto } from '../../src/informes/manifiesto.ts';
import { registrarEvento } from '../../src/audit/auditoria.ts';

const evento = (n: number) => ({
  companyId: '00000000-0000-0000-0000-000000000001', actorType: 'system' as const, actorId: 'test',
  action: `prueba.${n}`, aggregateType: 'prueba', aggregateId: String(n), correlationId: `c-${n}`,
});

describe('armarManifiesto', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('cuenta los eventos del día ART y fija los extremos de la cadena', async () => {
    await registrarEvento(pool, evento(1));
    await registrarEvento(pool, evento(2));
    // Los dos eventos quedan dentro del día ART de hoy: se fecha el manifiesto en ese día.
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
    const m = await armarManifiesto(pool, hoy);
    expect(m.eventos).toBe(2);
    expect(m.ultimo_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.cadena).toEqual({ integra: true, roto_en: null });
    expect(new Date(m.retention_until).getTime() - Date.parse(`${hoy}T00:00:00Z`)).toBeGreaterThan(365 * 86400e3);
  });

  it('un día sin eventos se emite con extremos nulos y el último hash conocido', async () => {
    const m = await armarManifiesto(pool, '2026-01-05');
    expect(m).toMatchObject({ eventos: 0, primer_chain_seq: null, ultimo_chain_seq: null });
    expect(m.ultimo_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un día sin eventos y sin cadena previa usa el hash cero', async () => {
    const vacia = await crearBaseDePrueba();
    const p2 = crearPool(vacia.urlApp);
    try {
      expect((await armarManifiesto(p2, '2026-01-05')).ultimo_hash).toBe('0'.repeat(64));
    } finally { await p2.end(); await vacia.borrar(); }
  });

  it('si la cadena está rota lo informa en lugar de fallar', async () => {
    const sucia = await crearBaseDePrueba();
    const admin = crearPool(sucia.urlAdmin); const app = crearPool(sucia.urlApp);
    try {
      await registrarEvento(app, evento(1));
      await registrarEvento(app, evento(2));
      // Sólo un superusuario puede saltear el trigger; es exactamente el ataque que el manifiesto detecta.
      await admin.query(`ALTER TABLE audit.audit_events DISABLE TRIGGER ALL`);
      await admin.query(`UPDATE audit.audit_events SET payload = '{"tocado":true}' WHERE chain_seq = 1`);
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
      const m = await armarManifiesto(app, hoy);
      expect(m.cadena.integra).toBe(false);
      expect(m.cadena.roto_en).not.toBeNull();
    } finally { await admin.end(); await app.end(); await sucia.borrar(); }
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/manifiesto.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

```ts
/*
 * src/informes/manifiesto.ts — el extremo de la cadena de auditoría de cada día, fuera de la base.
 *
 * La cadena de hashes detecta que alguien modificó o borró un evento del medio, pero no que borró el
 * último: nada apunta al que ya no está. El manifiesto firmado de cada día fija ese extremo afuera.
 *
 * Todo se lee en una transacción REPEATABLE READ que primero fija el último chain_seq y después verifica
 * hasta ese valor: con eventos entrando en paralelo, conteo, extremos y verificación podían describir tres
 * estados distintos (hallazgo 18 de la revisión externa).
 */
import type pg from 'pg';
import { medianocheArt } from './dia.ts';

export interface Manifiesto {
  tipo: 'manifiesto';
  fecha: string;
  primer_chain_seq: string | null;
  ultimo_chain_seq: string | null;
  ultimo_hash: string;
  eventos: number;
  cadena: { integra: boolean; roto_en: string | null };
  retention_until: string;
}

const HASH_CERO = '0'.repeat(64);
const DIAS_RETENCION = 365;
const MARGEN_DIAS = 2; // La retención se fija al subir; el margen cubre la cola y los reintentos.

export async function armarManifiesto(pool: pg.Pool, fecha: string): Promise<Manifiesto> {
  const desde = medianocheArt(fecha);
  const siguiente = new Date(desde.getTime());
  siguiente.setUTCDate(siguiente.getUTCDate() + 1);
  const hasta = medianocheArt(siguiente.toISOString().slice(0, 10));

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const dia = await cliente.query<{ primero: string | null; ultimo: string | null; n: string }>(
      `SELECT MIN(chain_seq)::text AS primero, MAX(chain_seq)::text AS ultimo, COUNT(*)::text AS n
         FROM audit.audit_events WHERE occurred_at >= $1 AND occurred_at < $2`,
      [desde, hasta],
    );
    const { primero, ultimo, n } = dia.rows[0]!;
    // Sin eventos en el día, el extremo que se fija es el último hash conocido hasta el fin del día.
    const hash = await cliente.query<{ hash: string | null }>(
      `SELECT encode(hash, 'hex') AS hash FROM audit.audit_events
        WHERE occurred_at < $1 ORDER BY chain_seq DESC LIMIT 1`,
      [hasta],
    );
    const roto = await cliente.query<{ roto: string | null }>('SELECT audit.verify_chain(NULL) AS roto');
    const rotoEn = roto.rows[0]?.roto ?? null;
    await cliente.query('COMMIT');

    const retencion = new Date(hasta.getTime());
    retencion.setUTCDate(retencion.getUTCDate() + DIAS_RETENCION + MARGEN_DIAS);
    return {
      tipo: 'manifiesto', fecha, primer_chain_seq: primero, ultimo_chain_seq: ultimo,
      ultimo_hash: hash.rows[0]?.hash ?? HASH_CERO, eventos: Number(n),
      cadena: { integra: rotoEn === null, roto_en: rotoEn },
      retention_until: retencion.toISOString(),
    };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
```

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/manifiesto.test.ts && npm run typecheck`
Esperado: PASA. Si `audit.verify_chain` sólo acepta un `bigint`, pasar `NULL::bigint`.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/manifiesto.ts plataforma/test/informes/manifiesto.test.ts
git commit -m "feat(informes): manifiesto diario de auditoría con snapshot consistente

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 7: Reporte diario de sombra y semáforo (`E1-REC-01`)

**Archivos:**
- Crear: `plataforma/src/informes/reporte.ts`
- Test: `plataforma/test/informes/reporte.test.ts`

**Interfaces:**
- Consume: `ventanaDiaAnterior` (tarea 3), `armarManifiesto` (tarea 6).
- Produce: `armarReporte(pool, fecha: string, opciones?: { manifiesto?: Manifiesto }): Promise<Reporte>` con
  `{ tipo: 'reporte'; fecha; ventana: { desde; hasta }; topicos: Record<string, ResumenTopico>; faltantes_sin_explicar: number; alertas: Alerta[]; semaforo: 'verde'|'amarillo'|'rojo'; dia_campana: number | null; reporte_anterior: string | null }`,
  donde `ResumenTopico` es `{ senales_legado: number; senales_nucleo: number; faltantes: number; faltantes_sin_explicar: number; cobertura: number; convergencia: number | null; descartadas: number }`.
  Motivos aceptados como explicación: `recurso_borrado`, `fuera_de_ventana`, `sin_historial`, `descartada_contada`.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { armarReporte, MOTIVOS_EXPLICADOS } from '../../src/informes/reporte.ts';

describe('armarReporte', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('un día sin actividad da verde y cero faltantes', async () => {
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.semaforo).toBe('verde');
    expect(r.faltantes_sin_explicar).toBe(0);
    expect(r.ventana).toEqual({ desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' });
  });

  it('sólo cuenta señales dentro de la ventana del día', async () => {
    await pool.query(`INSERT INTO integrations.reconciliation_signals
      (channel, topic, resource_id, fingerprint, status, received_at)
      VALUES ('woo','woo.orders','1','ev:a','succeeded', '2026-09-16T12:00:00Z'),
             ('woo','woo.orders','2','ev:b','succeeded', '2026-09-17T12:00:00Z')`);
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.topicos['woo.orders']!.senales_nucleo).toBe(1);
  });

  it('un faltante con motivo registrado no rompe; uno sin motivo pinta rojo', async () => {
    expect(MOTIVOS_EXPLICADOS).toContain('recurso_borrado');
    await pool.query(`INSERT INTO integrations.reconciliation_signals
      (channel, topic, resource_id, fingerprint, status, exclusion_reason, received_at)
      VALUES ('woo','woo.products','3','ev:c','excluded','recurso_borrado','2026-09-16T12:00:00Z')`);
    expect((await armarReporte(pool, '2026-09-16')).semaforo).toBe('verde');
    await pool.query(`INSERT INTO integrations.reconciliation_signals
      (channel, topic, resource_id, fingerprint, status, exclusion_reason, received_at)
      VALUES ('woo','woo.products','4','ev:d','dead','porque_si','2026-09-16T12:00:00Z')`);
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.faltantes_sin_explicar).toBe(1);
    expect(r.semaforo).toBe('rojo');
  });

  it('una cadena de auditoría rota pinta rojo aunque no haya faltantes', async () => {
    const r = await armarReporte(pool, '2026-09-15', {
      manifiesto: { tipo: 'manifiesto', fecha: '2026-09-15', primer_chain_seq: null, ultimo_chain_seq: null,
        ultimo_hash: '0'.repeat(64), eventos: 0, cadena: { integra: false, roto_en: '7' },
        retention_until: '2027-09-15T00:00:00.000Z' },
    });
    expect(r.semaforo).toBe('rojo');
  });

  it('numera el día de campaña y recuerda el reporte anterior', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado, hash_contenido)
      VALUES ('reporte','2026-09-14','avisado', repeat('a',64))`);
    const r = await armarReporte(pool, '2026-09-15');
    expect(r.reporte_anterior).toBe('2026-09-14');
    expect(r.dia_campana).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/reporte.test.ts`
Esperado: FALLA por módulo inexistente. Si alguna columna citada (`exclusion_reason`) tiene otro nombre en
`plataforma/migrations/0001_esquema_base.sql`, corregir el test y la consulta con el nombre real **antes** de
implementar.

- [ ] **Paso 3: implementación mínima**

Escribir `reporte.ts` con:
- `ventana` calculada con `medianocheArt` y **todas** las consultas acotadas a `[desde, hasta)`. No se lee
  `integrations.shadow_daily_summaries`: mide ventanas móviles de 24 h y se sobrescribe, así que no
  representa un día cerrado (hallazgo 17 de la revisión externa).
- `export const MOTIVOS_EXPLICADOS = ['recurso_borrado', 'fuera_de_ventana', 'sin_historial', 'descartada_contada'] as const;`
- por tópico: `senales_legado` (recibos del legado importados), `senales_nucleo` (señales resueltas),
  `faltantes` (sin resultado), `faltantes_sin_explicar` (sin resultado y con motivo fuera de la lista, o sin
  motivo), `cobertura` (resueltas sobre recibidas), `convergencia` (recursos cuyo estado coincide sobre
  barridos, o `null` en tópicos sin historial), `descartadas`.
- `semaforo`: `rojo` si hay faltantes sin explicar, alguna alerta alta o la cadena rota; `amarillo` con
  alertas medias; `verde` si no.
- `dia_campana` y `reporte_anterior`: leídos de `informes.entregas` — el anterior es la fecha `avisado` más
  reciente menor a `fecha`, y el día de campaña cuenta hacia atrás los días consecutivos con reporte verde.

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/reporte.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/reporte.ts plataforma/test/informes/reporte.test.ts
git commit -m "feat(informes): reporte diario de sombra con ventana congelada

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 8: Depósito en B2 con Object Lock y pendientes en disco

**Archivos:**
- Crear: `plataforma/src/informes/deposito.ts`
- Test: `plataforma/test/informes/deposito.test.ts`

**Interfaces:**
- Consume: nada de tareas anteriores (recibe el sobre ya firmado como texto).
- Produce:
  - `crearDeposito(cfg: CfgDeposito): Deposito` con
    `CfgDeposito = { endpoint: string; region: string; bucket: string; prefijo: string; escritura: { id: string; clave: string }; lectura: { id: string; clave: string }; dirPendientes: string; fetch?: typeof fetch }`
  - `Deposito.guardarPendiente(clave: string, cuerpo: string): Promise<string>` — escribe a temporal,
    `fsync`, renombra; devuelve la ruta.
  - `Deposito.subir(clave: string, cuerpo: string, retenerHasta: Date): Promise<{ versionId: string; retencion: string }>`
  - `Deposito.consultar(clave: string): Promise<{ versionId: string; retencion: string } | null>`
  - `Deposito.limpiarPendiente(ruta: string): Promise<void>`

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearDeposito } from '../../src/informes/deposito.ts';

const CFG = (dir: string, fetchSimulado: typeof fetch) => ({
  endpoint: 'https://s3.us-west-000.backblazeb2.com', region: 'us-west-000', bucket: 'fusion-e1-pruebas',
  prefijo: 'e1/', escritura: { id: 'w', clave: 'kw' }, lectura: { id: 'r', clave: 'kr' },
  dirPendientes: dir, fetch: fetchSimulado,
});

describe('deposito', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dep-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('la subida manda Object Lock en modo COMPLIANCE y firma con SigV4', async () => {
    const pedidos: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchSimulado = (async (url: string | URL, init: RequestInit = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      pedidos.push({ url: String(url), headers });
      return new Response('', { status: 200, headers: { 'x-amz-version-id': 'v42' } });
    }) as unknown as typeof fetch;
    const dep = crearDeposito(CFG(dir, fetchSimulado));
    const r = await dep.subir('e1/reportes/2026-09-16.json', '{"a":1}', new Date('2027-09-18T00:00:00Z'));
    expect(r.versionId).toBe('v42');
    expect(pedidos[0]!.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    expect(pedidos[0]!.headers['x-amz-object-lock-retain-until-date']).toBe('2027-09-18T00:00:00.000Z');
    expect(pedidos[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=w\//);
    expect(pedidos[0]!.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('una subida fallida se propaga con el cuerpo del error', async () => {
    const fetchSimulado = (async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as unknown as typeof fetch;
    await expect(crearDeposito(CFG(dir, fetchSimulado)).subir('e1/x.json', '{}', new Date()))
      .rejects.toThrow(/403.*AccessDenied/s);
  });

  it('consultar devuelve la retención con la credencial de lectura, y null si no está', async () => {
    const fetchSimulado = (async (url: string | URL) => (String(url).includes('falta')
      ? new Response('', { status: 404 })
      : new Response('<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>2027-09-18T00:00:00Z</RetainUntilDate></Retention>',
          { status: 200, headers: { 'x-amz-version-id': 'v42' } }))) as unknown as typeof fetch;
    const dep = crearDeposito(CFG(dir, fetchSimulado));
    expect(await dep.consultar('e1/reportes/2026-09-16.json')).toEqual({ versionId: 'v42', retencion: '2027-09-18T00:00:00Z' });
    expect(await dep.consultar('e1/reportes/falta.json')).toBeNull();
  });

  it('el pendiente se escribe entero o no se escribe, y se limpia después', async () => {
    const dep = crearDeposito(CFG(dir, (async () => new Response('', { status: 200 })) as unknown as typeof fetch));
    const ruta = await dep.guardarPendiente('e1/reportes/2026-09-16.json', '{"a":1}');
    expect(readFileSync(ruta, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    await dep.limpiarPendiente(ruta);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/deposito.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

`deposito.ts` con SigV4 hecho a mano sobre `fetch` (no se agrega el SDK de AWS por dos verbos):

- `PUT {endpoint}/{bucket}/{clave}` con `x-amz-object-lock-mode: COMPLIANCE`,
  `x-amz-object-lock-retain-until-date` en ISO, `x-amz-content-sha256` con el SHA-256 del cuerpo en
  hexadecimal, y `authorization` con `AWS4-HMAC-SHA256`. La versión sale del header `x-amz-version-id`.
- `GET {endpoint}/{bucket}/{clave}?retention` firmado con la credencial de **lectura**; 404 devuelve `null`.
- Un status fuera de 2xx lanza `Error` con status y cuerpo (recortado a 500 caracteres, sin encabezados de
  autorización).
- `guardarPendiente`: `openSync(tmp,'wx',0o600)` → `writeSync` → `fsyncSync` → `renameSync`.
- Comentario obligatorio arriba: por qué compliance y no governance, y por qué la retención se calcula sobre
  la hora de subida.

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/deposito.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/deposito.ts plataforma/test/informes/deposito.test.ts
git commit -m "feat(informes): depósito en B2 con Object Lock compliance y pendientes en disco

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 9: Email con semáforo y adjunto firmado

**Archivos:**
- Crear: `plataforma/src/informes/correo.ts`
- Test: `plataforma/test/informes/correo.test.ts`

**Interfaces:**
- Consume: `Reporte` (tarea 7), `huella` (tarea 2).
- Produce:
  - `armarCuerpo(reporte: Reporte, datosClave: { kid: string; huella: string; ubicacion: string }): { asunto: string; texto: string }`
  - `enviar(cfg: CfgCorreo, mensaje: { asunto: string; texto: string; adjuntos: Array<{ nombre: string; contenido: string }> }): Promise<void>`
    con `CfgCorreo = { host; puerto; seguro; usuario; clave; desde; para; timeoutMs?; tamanoMaxBytes?; smtp?: ClienteSmtp }`

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect } from 'vitest';
import { armarCuerpo, enviar } from '../../src/informes/correo.ts';

const REPORTE = {
  tipo: 'reporte' as const, fecha: '2026-09-16',
  ventana: { desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' },
  topicos: { 'woo.orders': { senales_legado: 10, senales_nucleo: 10, faltantes: 0, faltantes_sin_explicar: 0, cobertura: 1, convergencia: 1, descartadas: 0 } },
  faltantes_sin_explicar: 0, alertas: [], semaforo: 'verde' as const, dia_campana: 3, reporte_anterior: '2026-09-15',
};
const CLAVE = { kid: 'k1', huella: 'AAAA', ubicacion: 'docs/superpowers/specs/e1/firma-informes.pub' };

describe('armarCuerpo', () => {
  it('el asunto lleva semáforo, fecha y día de campaña', () => {
    expect(armarCuerpo(REPORTE, CLAVE).asunto).toBe('[verde] Sombra E1 2026-09-16 — día 3 de la campaña');
  });

  it('en verde no enumera los tópicos: sólo dice que no hay nada que hacer', () => {
    const { texto } = armarCuerpo(REPORTE, CLAVE);
    expect(texto).toMatch(/Nada que requiera acción/);
    expect(texto).not.toMatch(/woo\.orders/);
  });

  it('en rojo detalla lo que necesita acción', () => {
    const { texto, asunto } = armarCuerpo({
      ...REPORTE, semaforo: 'rojo', faltantes_sin_explicar: 2,
      topicos: { ...REPORTE.topicos, 'ml.orders': { senales_legado: 5, senales_nucleo: 3, faltantes: 2, faltantes_sin_explicar: 2, cobertura: 0.6, convergencia: null, descartadas: 0 } },
      alertas: [{ id: 'senal_vieja', severidad: 'alta', responsable: 'operaciones', umbral: '> 15 min', valor: 1800, runbook: 'sop-sombra.md' }],
    }, CLAVE);
    expect(asunto).toMatch(/^\[rojo\]/);
    expect(texto).toMatch(/ml\.orders.*2 sin explicar/s);
    expect(texto).toMatch(/senal_vieja/);
  });

  it('el cuerpo identifica la clave sin pegarla', () => {
    const { texto } = armarCuerpo(REPORTE, CLAVE);
    expect(texto).toMatch(/k1/); expect(texto).toMatch(/AAAA/);
    expect(texto).not.toMatch(/BEGIN PUBLIC KEY/);
  });

  it('avisa cuando falta el reporte del día anterior', () => {
    expect(armarCuerpo({ ...REPORTE, fecha: '2026-09-16', reporte_anterior: '2026-09-13' }, CLAVE).texto)
      .toMatch(/faltan los reportes del 2026-09-14 al 2026-09-15/);
  });
});

describe('enviar', () => {
  const CFG = { host: 'smtp', puerto: 587, seguro: false, usuario: 'u', clave: 'c', desde: 'a@b', para: 'c@d' };

  it('manda el adjunto y no registra la clave', async () => {
    const visto: unknown[] = [];
    await enviar({ ...CFG, smtp: { async enviar(m: unknown) { visto.push(m); } } },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'reporte.json', contenido: '{"a":1}' }] });
    expect(JSON.stringify(visto)).toContain('reporte.json');
    expect(JSON.stringify(visto)).not.toContain('"clave"');
  });

  it('rechaza un adjunto más grande que el tope', async () => {
    await expect(enviar({ ...CFG, tamanoMaxBytes: 10, smtp: { async enviar() {} } },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'r.json', contenido: 'z'.repeat(50) }] }))
      .rejects.toThrow(/tama/);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/correo.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

`correo.ts` con:
- `armarCuerpo` como lo fijan los tests: asunto `[semáforo] Sombra E1 <fecha> — día N de la campaña`; en
  verde una línea; en amarillo o rojo, los tópicos con faltantes sin explicar y las alertas con su runbook;
  siempre `kid`, huella y ubicación de la pública, **nunca** la clave pegada (hallazgo YAGNI de la revisión).
- `enviar`: cliente SMTP mínimo sobre `node:net`/`node:tls` detrás de la interfaz `ClienteSmtp`
  (`{ enviar(mensaje): Promise<void> }`) para que el test no abra sockets; `timeoutMs` por omisión 20 s y
  `tamanoMaxBytes` por omisión 5 MiB. Mensaje MIME `multipart/mixed` con el sobre firmado como adjunto.
- Ningún log incluye `cfg.clave` ni el cuerpo del adjunto.

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/correo.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/correo.ts plataforma/test/informes/correo.test.ts
git commit -m "feat(informes): email con semáforo y adjunto firmado

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 10: La vuelta diaria y el enganche al scheduler

**Archivos:**
- Crear: `plataforma/src/informes/vuelta.ts`
- Modificar: `plataforma/src/scheduler/scheduler.ts` (agregar `informes()` a la interfaz `Scheduler` y a
  `crearScheduler`), `plataforma/src/scheduler/main.ts` (llamarla en cada vuelta),
  `plataforma/src/comun/config.ts` (leer los secretos y rutas nuevas),
  `plataforma/deploy/compose.yml` y `compose.test.yml` (montajes y variables)
- Test: `plataforma/test/informes/vuelta.test.ts`

**Interfaces:**
- Consume: todo lo anterior.
- Produce: `vueltaDeInformes(pool, cfg: CfgInformes, ahora?: Date): Promise<{ hechos: string[]; fallados: string[]; incidentes: number }>`.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { vueltaDeInformes } from '../../src/informes/vuelta.ts';
import { verificar } from '../../src/informes/firma.ts';

describe('vueltaDeInformes', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let dir: string;
  let subidas: Array<{ clave: string; cuerpo: string; retener: Date }>; let emails: Array<{ asunto: string }>;
  let cfg: Parameters<typeof vueltaDeInformes>[1];

  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vuelta-'));
    subidas = []; emails = [];
    cfg = {
      // La clave se genera en el test con el script de la tarea 2; el helper la deja en `dir`.
      clave: { kid: 'k1', privada: crearClaveDePrueba() },
      publicas: { k1: publicaDePrueba() },
      deposito: {
        async subir(clave: string, cuerpo: string, retener: Date) { subidas.push({ clave, cuerpo, retener }); return { versionId: 'v1', retencion: retener.toISOString() }; },
        async consultar() { return null; },
        async guardarPendiente(_c: string, _b: string) { return join(dir, 'p.json'); },
        async limpiarPendiente() {},
      },
      correo: { async enviar(m: { asunto: string }) { emails.push(m); } },
      datosClave: { kid: 'k1', huella: 'AAAA', ubicacion: 'docs/.../firma-informes.pub' },
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('genera, firma, sube y avisa los dos artefactos del día', async () => {
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.hechos).toEqual(['manifiesto:2026-09-16', 'reporte:2026-09-16']);
    expect(subidas.map((s) => s.clave)).toEqual(['e1/manifiestos/2026-09-16.json', 'e1/reportes/2026-09-16.json']);
    expect(emails).toHaveLength(1);
    expect(verificar(JSON.parse(subidas[1]!.cuerpo), cfg.publicas).valido).toBe(true);
    const filas = (await pool.query(`SELECT tipo, estado FROM informes.entregas ORDER BY tipo`)).rows;
    expect(filas).toEqual([{ tipo: 'manifiesto', estado: 'avisado' }, { tipo: 'reporte', estado: 'avisado' }]);
  });

  it('correrla dos veces no sube ni manda de nuevo', async () => {
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:05:00Z'));
    expect(r.hechos).toEqual([]);
    expect(subidas).toHaveLength(2);
    expect(emails).toHaveLength(1);
  });

  it('si B2 falla, el email igual sale y queda el pendiente', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.fallados).toContain('manifiesto:2026-09-16');
    expect(emails).toHaveLength(1);
    const fila = (await pool.query(`SELECT estado, intentos, ruta_pendiente FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0];
    expect(fila).toMatchObject({ estado: 'firmado', intentos: 1 });
    expect(fila.ruta_pendiente).not.toBeNull();
  });

  it('ante una subida en duda consulta en lugar de volver a subir', async () => {
    cfg.deposito.subir = async () => { throw new Error('timeout'); };
    cfg.deposito.consultar = async () => ({ versionId: 'v9', retencion: '2027-09-18T00:00:00Z' });
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect((await pool.query(`SELECT b2_version_id FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0].b2_version_id).toBe('v9');
  });

  it('recupera varios días caídos, del más viejo al más nuevo', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado, hash_contenido)
      VALUES ('reporte','2026-09-13','avisado', repeat('a',64)), ('manifiesto','2026-09-13','avisado', repeat('a',64))`);
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.hechos.filter((h) => h.startsWith('reporte'))).toEqual(['reporte:2026-09-14', 'reporte:2026-09-15', 'reporte:2026-09-16']);
  });

  it('abre incidente si una entrega lleva más de 24 h sin cerrar', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    await pool.query(`UPDATE informes.entregas SET generado_en = now() - interval '30 hours'`);
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:10:00Z'));
    expect(r.incidentes).toBeGreaterThan(0);
  });
});
```

Agregar en el mismo archivo los helpers `crearClaveDePrueba()` y `publicaDePrueba()` con
`generateKeyPairSync('ed25519')`, para no depender del disco.

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/vuelta.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

`vuelta.ts`, en este orden por cada día faltante (del más viejo al más nuevo) y por cada tipo:
1. armar el contenido (manifiesto y después reporte, que recibe el manifiesto ya armado);
2. `reclamar` con el hash del contenido canónico; si devuelve `null`, seguir con el siguiente;
3. firmar y `avanzar` a `firmado` guardando la ruta del pendiente;
4. `subir`; ante error, `consultar` una vez: si el objeto está, `avanzar` a `subido` con esa versión; si no,
   `anotarFallo` y seguir. **El email sale igual**, porque avisar no depende de B2;
5. enviar un solo email por día con el reporte adjunto, y `avanzar` a `avisado` los dos artefactos;
6. al final, `pendientesVencidas` y un incidente crítico por cada una.

En `scheduler.ts`, agregar `informes(ahora?: Date)` a la interfaz y a `crearScheduler`, con la misma guarda de
"a lo sumo una vez cada X" que usa `observar`, y que sólo corra pasadas las 07:00 ART. En `main.ts`, llamarla
en cada vuelta y registrar el resultado. En `compose.yml` y `compose.test.yml`, montar
`keyring/firma-informes.pem`, el directorio `informes-pendientes` y los secretos de SMTP y B2.

- [ ] **Paso 4: correr los tests y verificar que pasan**

Run: `cd plataforma && npx vitest run test/informes test/scheduler.test.ts && npm run typecheck`
Esperado: PASA todo, incluido el test existente del scheduler.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/vuelta.ts plataforma/src/scheduler plataforma/src/comun/config.ts plataforma/deploy plataforma/test/informes/vuelta.test.ts
git commit -m "feat(informes): vuelta diaria enganchada al scheduler

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 11: Verificación independiente y vigilante del legado

**Archivos:**
- Crear: `scripts/verificar-informe.mjs`, `lib/vigilanteInformes.js`
- Modificar: `package.json` (raíz: script `verificar-informe`), `server.js` (enganchar el vigilante al cron)
- Test: `test/verificarInforme.test.js`, `test/vigilanteInformes.test.js`

**Interfaces:**
- Consume: el formato de sobre de la tarea 2.
- Produce:
  - `npm run verificar-informe <archivo.json>` → imprime `válido` con el kid, o `inválido` con el motivo;
    código de salida 0 o 1.
  - `revisarInformeDelDia(db, { url, fetch, ahora })` en el legado: si no hay informe del día a las 09:00 ART,
    abre un incidente y manda la alerta por el canal existente; idempotente por día.

- [ ] **Paso 1: escribir los tests que fallan**

```js
// test/verificarInforme.test.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const correr = (args) => {
  try { return { salida: execFileSync('node', ['scripts/verificar-informe.mjs', ...args], { encoding: 'utf8' }), codigo: 0 }; }
  catch (e) { return { salida: `${e.stdout ?? ''}${e.stderr ?? ''}`, codigo: e.status }; }
};

describe('verificar-informe', () => {
  it('acepta un sobre válido y rechaza uno alterado', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    const par = generateKeyPairSync('ed25519');
    const pub = join(dir, 'k1.pub');
    writeFileSync(pub, par.publicKey.export({ type: 'spki', format: 'pem' }));
    const contenido = { tipo: 'reporte', fecha: '2026-09-16' };
    const firma = sign(null, Buffer.from('{"fecha":"2026-09-16","tipo":"reporte"}', 'utf8'), par.privateKey).toString('base64');
    const bueno = join(dir, 'b.json'); writeFileSync(bueno, JSON.stringify({ version: 1, kid: 'k1', firma, contenido }));
    expect(correr([bueno, '--publica', `k1=${pub}`])).toMatchObject({ codigo: 0 });
    const malo = join(dir, 'm.json');
    writeFileSync(malo, JSON.stringify({ version: 1, kid: 'k1', firma, contenido: { ...contenido, fecha: '2026-09-17' } }));
    const r = correr([malo, '--publica', `k1=${pub}`]);
    expect(r.codigo).toBe(1);
    expect(r.salida).toMatch(/inválido/);
  });
});
```

```js
// test/vigilanteInformes.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { revisarInformeDelDia } from '../lib/vigilanteInformes.js';

const TEST_DB = './test/vigilante-informes.sqlite';

describe('revisarInformeDelDia', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  const ahora = new Date('2026-09-17T12:30:00Z'); // 09:30 ART

  it('con informe del día no abre nada', async () => {
    const fetchSimulado = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ultimo: '2026-09-16' }) });
    const r = await revisarInformeDelDia(db, { url: 'http://x/informes', fetch: fetchSimulado, ahora });
    expect(r).toMatchObject({ estado: 'ok' });
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigilante_informes'").get().n).toBe(0);
  });

  it('sin informe del día abre incidente una sola vez', async () => {
    const fetchSimulado = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ultimo: '2026-09-14' }) });
    expect(await revisarInformeDelDia(db, { url: 'http://x/informes', fetch: fetchSimulado, ahora })).toMatchObject({ estado: 'falta' });
    await revisarInformeDelDia(db, { url: 'http://x/informes', fetch: fetchSimulado, ahora });
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigilante_informes' AND estado='activo'").get().n).toBe(1);
  });

  it('si la plataforma no responde también avisa', async () => {
    const fetchSimulado = vi.fn().mockRejectedValue(new Error('sin red'));
    expect(await revisarInformeDelDia(db, { url: 'http://x/informes', fetch: fetchSimulado, ahora })).toMatchObject({ estado: 'sin_respuesta' });
  });

  it('antes de las 09:00 ART no hace nada', async () => {
    const fetchSimulado = vi.fn();
    expect(await revisarInformeDelDia(db, { url: 'http://x/informes', fetch: fetchSimulado, ahora: new Date('2026-09-17T10:00:00Z') }))
      .toMatchObject({ estado: 'temprano' });
    expect(fetchSimulado).not.toHaveBeenCalled();
  });
});
```

- [ ] **Paso 2: correr los tests y verificar que fallan**

Run: `npx vitest run test/verificarInforme.test.js test/vigilanteInformes.test.js`
Esperado: FALLAN por módulos inexistentes.

- [ ] **Paso 3: implementación mínima**

- `scripts/verificar-informe.mjs`: sin dependencias del repo (tiene que poder correrse suelto). Reimplementa
  `canonizar` mínimo importándolo por ruta relativa desde `plataforma/src/informes/jcs.ts`, lee el sobre, toma
  las públicas de `--publica kid=ruta` o por omisión de `docs/superpowers/specs/e1/firma-informes.pub`, imprime
  `válido (kid k1)` o `inválido: <motivo>` y sale con 0 o 1.
- `lib/vigilanteInformes.js`: antes de las 09:00 ART devuelve `{ estado: 'temprano' }`; consulta la ruta de la
  plataforma; si el último informe no es el día ART anterior, o no hay respuesta, abre un incidente
  `vigilante_informes` (idempotente por día, como los demás incidentes del legado) y manda la alerta por el
  canal existente.
- La ruta que consulta es un `GET` interno nuevo en la API de la plataforma que devuelve
  `{ ultimo: 'YYYY-MM-DD' | null }` leyendo `informes.entregas`; agregarla junto a las demás internas con la
  misma firma HMAC.
- `package.json` de la raíz: `"verificar-informe": "node scripts/verificar-informe.mjs"`.
- `server.js`: llamar al vigilante desde el cron que ya corre cada hora.

- [ ] **Paso 4: correr los tests y verificar que pasan**

Run: `npx vitest run test/verificarInforme.test.js test/vigilanteInformes.test.js && cd plataforma && npx vitest run test/api.test.ts`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add scripts/verificar-informe.mjs lib/vigilanteInformes.js package.json server.js test/verificarInforme.test.js test/vigilanteInformes.test.js plataforma/src/api
git commit -m "feat(informes): verificación independiente y vigilante del legado

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 12: Desafíos de WebAuthn y el interruptor de doble llave

**Archivos:**
- Crear: `plataforma/migrations/0010_webauthn_desafios.sql`, `plataforma/src/auth/passkeys.ts`,
  `plataforma/src/api/passkeys.ts`
- Modificar: `plataforma/package.json` (dependencia `@simplewebauthn/server` `14.0.2`),
  `plataforma/src/api/app.ts` (registrar el grupo de rutas)
- Test: `plataforma/test/passkeys.test.ts`

**Interfaces:**
- Consume: nada de informes.
- Produce:
  - `passkeysHabilitadas(db, entorno: NodeJS.ProcessEnv): Promise<boolean>` — `true` sólo si la fila
    `passkeys.real` está en `true` **y** `entorno.PASSKEYS_HABILITADAS === '1'`.
  - `iniciarRegistro`, `terminarRegistro`, `iniciarLogin`, `terminarLogin` sobre `security.webauthn_challenges`.
  - `RUTAS_PASSKEYS: string[]` — la lista que el test recorre.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';
import { RUTAS_PASSKEYS, passkeysHabilitadas } from '../src/auth/passkeys.ts';

describe('interruptor de passkeys', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('nace apagado: la migración deja passkeys.real en false', async () => {
    const r = await pool.query(`SELECT enabled FROM security.feature_flags WHERE code = 'passkeys.real'`);
    expect(r.rows[0]).toEqual({ enabled: false });
  });

  it('la fila sola no alcanza sin la variable de entorno', async () => {
    await pool.query(`UPDATE security.feature_flags SET enabled = true WHERE code = 'passkeys.real'`);
    expect(await passkeysHabilitadas(pool, {})).toBe(false);
    expect(await passkeysHabilitadas(pool, { PASSKEYS_HABILITADAS: '1' })).toBe(true);
  });

  it('la variable sola tampoco alcanza sin la fila', async () => {
    await pool.query(`UPDATE security.feature_flags SET enabled = false WHERE code = 'passkeys.real'`);
    expect(await passkeysHabilitadas(pool, { PASSKEYS_HABILITADAS: '1' })).toBe(false);
  });

  it('con el interruptor apagado TODAS las rutas responden 503', async () => {
    expect(RUTAS_PASSKEYS.length).toBeGreaterThanOrEqual(6);
    // Se recorre la lista para que una ruta nueva sin guarda haga fallar el test.
    for (const ruta of RUTAS_PASSKEYS) {
      const r = await pedir(ruta); // helper local que hace POST con cuerpo vacío
      expect(r.statusCode, ruta).toBe(503);
      expect(r.json(), ruta).toMatchObject({ error: 'passkeys_deshabilitadas' });
    }
  });

  it('un desafío se usa una sola vez, vence, y no sirve para otro propósito', async () => {
    // Registro → el mismo desafío no se puede reutilizar
    // Un desafío con vencimiento pasado se rechaza
    // Un desafío creado para 'registro' no verifica un 'login'
  });
});
```

Completar el último `it` con el autenticador virtual y los tres casos; el helper `pedir` levanta la API con
`crearApi` como hace `test/api.test.ts`.

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/passkeys.test.ts`
Esperado: FALLA porque no existe la fila ni el módulo.

- [ ] **Paso 3: escribir la migración y el módulo**

```sql
-- E1 T4 · tarea 12: el desafío de cada ceremonia WebAuthn.
-- SimpleWebAuthn exige pasar el desafío generado como `expectedChallenge` al verificar. En memoria se rompe
-- con dos procesos, un reinicio o dos pedidos a la vez (hallazgo 4 de la revisión externa del 2026-09-17).
CREATE TABLE security.webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  proposito   text NOT NULL CHECK (proposito IN ('registro', 'login', 'reautenticacion')),
  desafio     text NOT NULL UNIQUE,
  user_id     uuid REFERENCES security.users(id),
  creado_en   timestamptz NOT NULL DEFAULT now(),
  vence_en    timestamptz NOT NULL,
  usado_en    timestamptz,
  CHECK (vence_en > creado_en)
);
CREATE INDEX webauthn_challenges_vigentes ON security.webauthn_challenges (vence_en) WHERE usado_en IS NULL;

-- El interruptor nace apagado y es la primera de las dos llaves: la segunda es PASSKEYS_HABILITADAS, que en
-- producción no existe. Con una sola llave, un UPDATE habilitaba autenticación real sin dominio ni HTTPS.
INSERT INTO security.feature_flags (code, enabled, reason)
VALUES ('passkeys.real', false, 'E1: passkeys sólo con autenticador virtual; se habilitan en E4 tras la prueba en dispositivos');
```

`src/auth/passkeys.ts` con `passkeysHabilitadas`, las cuatro ceremonias sobre `@simplewebauthn/server`
(`rpID` y origen desde la configuración, nunca del pedido), consumo único del desafío en la misma transacción
que lo verifica, y actualización de contador y banderas de respaldo con la regla de la librería (que sólo
exige avance cuando alguno de los contadores es mayor que cero). `src/api/passkeys.ts` con `RUTAS_PASSKEYS` y
un único `preHandler` de grupo que responde 503.

- [ ] **Paso 4: correr los tests y verificar que pasan**

Run: `cd plataforma && npx vitest run test/passkeys.test.ts test/migraciones.test.ts test/api.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/migrations/0010_webauthn_desafios.sql plataforma/src/auth/passkeys.ts plataforma/src/api plataforma/package.json plataforma/package-lock.json plataforma/test/passkeys.test.ts docs/superpowers/specs/e1/schema.sql
git commit -m "feat(passkeys): desafíos persistentes y interruptor de doble llave

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 13: Recuperación de acceso con límite de intentos

**Archivos:**
- Crear: `plataforma/src/auth/recuperacion.ts`
- Modificar: `plataforma/src/api/passkeys.ts` (la ruta de recuperación)
- Test: `plataforma/test/recuperacion.test.ts`

**Interfaces:**
- Consume: `passkeysHabilitadas` (tarea 12), `security.recovery_codes`.
- Produce:
  - `emitirCodigos(db, userId: string, cantidad?: number): Promise<string[]>` — 10 códigos de 128 bits; el
    claro sólo existe en el valor devuelto.
  - `usarCodigo(db, userId: string, codigo: string, opciones: { ip: string; ahora?: Date }): Promise<{ ok: boolean; motivo?: 'invalido'|'limite' }>`

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';
import { emitirCodigos, usarCodigo } from '../src/auth/recuperacion.ts';

describe('recuperación', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let userId: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp);
    userId = (await pool.query(`INSERT INTO security.users (email, display_name) VALUES ('a@b.c','Prueba') RETURNING id`)).rows[0].id;
  });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('emite 10 códigos de 128 bits y no los guarda en claro', async () => {
    const codigos = await emitirCodigos(pool, userId);
    expect(codigos).toHaveLength(10);
    expect(new Set(codigos).size).toBe(10);
    for (const c of codigos) expect(c).toMatch(/^[0-9a-z]{26,32}$/);
    const filas = await pool.query(`SELECT code_hash FROM security.recovery_codes WHERE user_id = $1`, [userId]);
    expect(filas.rows).toHaveLength(10);
    expect(JSON.stringify(filas.rows)).not.toContain(codigos[0]!);
  });

  it('un código sirve una sola vez', async () => {
    const [codigo] = await emitirCodigos(pool, userId, 1);
    expect(await usarCodigo(pool, userId, codigo!, { ip: '1.2.3.4' })).toMatchObject({ ok: true });
    expect(await usarCodigo(pool, userId, codigo!, { ip: '1.2.3.4' })).toMatchObject({ ok: false, motivo: 'invalido' });
  });

  it('corta a los 5 intentos fallidos en una hora', async () => {
    for (let i = 0; i < 5; i += 1) await usarCodigo(pool, userId, 'nosirve', { ip: '9.9.9.9' });
    expect(await usarCodigo(pool, userId, 'nosirve', { ip: '9.9.9.9' })).toMatchObject({ ok: false, motivo: 'limite' });
    // Una hora después vuelve a permitir intentos.
    const despues = new Date(Date.now() + 61 * 60_000);
    expect(await usarCodigo(pool, userId, 'nosirve', { ip: '9.9.9.9', ahora: despues })).toMatchObject({ ok: false, motivo: 'invalido' });
  });

  it('responde igual exista o no el usuario', async () => {
    const inexistente = '00000000-0000-0000-0000-0000000000ff';
    expect(await usarCodigo(pool, inexistente, 'nosirve', { ip: '5.5.5.5' })).toEqual(
      await usarCodigo(pool, userId, 'nosirve', { ip: '6.6.6.6' }),
    );
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/recuperacion.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

`recuperacion.ts` con: códigos de 16 bytes en base32 sin ambigüedades; hash HMAC-SHA256 con la clave del
keyring; comparación en tiempo constante; conteo de intentos por cuenta y por IP en la última hora (tabla o
columna nueva si hace falta, con su migración y `GRANT`); uso del código en una sola transacción que lo marca
`used_at`, cierra las sesiones abiertas y deja el evento de auditoría. La respuesta no distingue usuario
inexistente de código equivocado.

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/recuperacion.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/auth/recuperacion.ts plataforma/src/api/passkeys.ts plataforma/test/recuperacion.test.ts
git commit -m "feat(passkeys): recuperación de acceso con límite de intentos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 14: Ampliar el contrato y el gate de escenarios

**Archivos:**
- Modificar: `docs/superpowers/specs/e1/test-e1.md` (ampliar `E1-AUD-04`, `E1-REC-01`, `E1-WA-01` y sumar el
  tramo 4 a la tabla de tramos), `scripts/qa/gate-e1.mjs` (aceptar `E1_TRAMO=4`), `scripts/test-e1.sh`
  (tramo 4: secretos efímeros de firma y simulador S3)
- Test: la propia corrida del ensayo

**Interfaces:**
- Consume: todo lo anterior.
- Produce: `E1_TRAMO=4 npm run test:e1` en verde, con los tres IDs presentes en títulos de pruebas que pasaron.

- [ ] **Paso 1: ampliar los tres escenarios en `test-e1.md`**

Cada ID pasa a exigir, además de lo que ya pedía:
- `E1-AUD-04`: día vacío, cadena rota informada y firmada, snapshot consistente, y que la retención enviada
  sea `COMPLIANCE` con 365 días.
- `E1-REC-01`: ventana del día ART congelada, faltante explicado sólo por motivo registrado, reintento tras
  fallo de B2 sin perder el día, subida en duda resuelta consultando, y email que sale aunque B2 falle.
- `E1-WA-01`: las cuatro etapas con autenticador virtual, desafío de un solo uso, desafío vencido, desafío de
  otro propósito, interruptor de doble llave (fila sin variable → 503) y límite de intentos de recuperación.

- [ ] **Paso 2: correr el gate y verificar que falla**

Run: `E1_TRAMO=4 npm run test:e1`
Esperado: FALLA nombrando los IDs que todavía no aparecen en un título de prueba que pasó.

- [ ] **Paso 3: nombrar las pruebas con sus IDs**

Renombrar los `it(...)` de las tareas 6, 7, 10, 12 y 13 para que incluyan el ID que demuestran, y agregar en
`scripts/test-e1.sh` el tramo 4: clave de firma efímera generada con el script de la tarea 2, simulador S3 y
SMTP simulado.

- [ ] **Paso 4: correr el gate y verificar que pasa**

Run: `E1_TRAMO=4 npm run test:e1`
Esperado: verde, con los tres IDs presentes.

- [ ] **Paso 5: commit**

```bash
git add docs/superpowers/specs/e1/test-e1.md scripts/qa/gate-e1.mjs scripts/test-e1.sh plataforma/test
git commit -m "test(e1): ampliar E1-AUD-04, E1-REC-01 y E1-WA-01 al contrato del tramo 4

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 15: Suite completa, memoria y cierre documental

**Archivos:**
- Modificar: `docs/memory/active.md`, `docs/superpowers/deliveries/E1-fundacion-sombra.md`,
  `docs/superpowers/plan-maestro.md`, `docs/superpowers/decisions/plan-maestro-decisions.md`

- [ ] **Paso 1: verificar que no hay nada corriendo**

Run: `pgrep -af "vitest|node.*server"`
Esperado: sólo el servidor de producción bajo PM2; ningún vitest ni servidor de prueba.

- [ ] **Paso 2: correr las dos suites completas**

Run: `cd plataforma && npm test && npm run typecheck && cd .. && npm test`
Esperado: verde. Ante un fallo en un archivo ajeno al cambio, re-correr ese archivo solo antes de creerle
(CLAUDE.md).

- [ ] **Paso 3: anotar las decisiones que este tramo revisa**

En `plan-maestro-decisions.md`, agregar las entradas nuevas que registran el cambio de PM-172 (governance →
compliance) y el mínimo de PM-170 (14.x → ≥ 14.0.2), citando este plan y la evaluación externa.

- [ ] **Paso 4: actualizar memoria y ficha**

En `docs/memory/active.md` y en la ficha de E1: qué quedó implementado, con qué comando se prueba, y que la
campaña de 7 días y la verificación contra B2 real siguen pendientes.

- [ ] **Paso 5: commit**

```bash
git add docs
git commit -m "docs(e1): cierre documental del tramo 4

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 16: Puesta en producción (requiere autorización explícita de José)

**No se ejecuta sin que José lo autorice en el momento**, igual que C10 de T3. Nada de esta tarea se infiere
de un merge.

- [ ] **Paso 1: José crea en B2** el bucket de producción con Object Lock habilitado, el bucket de pruebas sin
  Object Lock, y las dos credenciales por CLI (escritura sin `deleteFiles` ni `bypassGovernance`; lectura sólo
  con `readFiles` y `readFileRetentions`), acotadas al bucket y al prefijo `e1/`. Deja los cuatro valores en
  `/opt/fusionbikes/plataforma-prod/secretos/`, 0600.
- [ ] **Paso 2: generar la clave de firma** en el VPS con `plataforma/scripts/generar-clave-firma.mjs`,
  commitear sólo la pública, y guardar el respaldo de la privada fuera del VPS.
- [ ] **Paso 3: backup** de `data/fusion.sqlite` y de `.env`, y `pg_dump` de la base `plataforma`.
- [ ] **Paso 4: aplicar las migraciones** 0009 y 0010 con `npm run migrar`, y verificar que `passkeys.real`
  quedó en `false` y que `PASSKEYS_HABILITADAS` **no** existe en el entorno.
- [ ] **Paso 5: recrear los contenedores** con los montajes nuevos y verificar `/api/v2/health`.
- [ ] **Paso 6: verificación única contra B2 real** con el bucket de pruebas primero: subir un objeto, leer su
  retención, comprobar que la credencial de escritura no puede borrar ni acortar, y pegar la salida como
  evidencia en `docs/superpowers/evidence/e1/`.
- [ ] **Paso 7: un envío real de email** y confirmación de que llegó con el adjunto.
- [ ] **Paso 8: arrancar la campaña de 7 días** y registrar cada día en la evidencia.

---

## Autorrevisión

**Cobertura de la spec:** §4 firma → tareas 1, 2 y 11; §5 manifiesto → 6; §6 reporte y email → 7, 9 y 11;
§7 B2 → 8 y 16; §7 bis entregas → 4, 5 y 10; §8 passkeys → 12 y 13; §9 campaña → 16; §9 bis secretos → 10 y
16; §10 bordes → repartidos en los tests de 5, 8 y 10; §11 gate → 14. Las dos migraciones que la revisión
externa detectó son las tareas 4 y 12.

**Marcadores:** ninguna tarea dice "TBD", "implementar después" ni "agregar manejo de errores": cada paso trae
el test y el código, o la lista exacta de lo que el archivo tiene que contener cuando es más largo que lo
razonable para un plan (tareas 7, 8, 9, 10, 12 y 13, donde los tests fijan el contrato).

**Consistencia de tipos:** `Reclamo`, `Sobre`, `Manifiesto`, `Reporte` y `CfgDeposito` se definen una vez y se
citan igual en las tareas siguientes; `canonizar`, `firmar`, `verificar`, `reclamar`, `avanzar`,
`armarManifiesto`, `armarReporte` y `passkeysHabilitadas` conservan su nombre y firma en todo el plan.
