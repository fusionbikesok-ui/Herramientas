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
**Este plan ya está corregido** con la evaluación externa de su primera versión
(`docs/superpowers/evidence/e1/2026-09-17-E1-T4-revision-plan-codex.md`, sobre el commit `00c374a`), que
encontró 23 problemas. Los de fondo y las decisiones de José del 2026-09-17 que los cierran:

| Problema encontrado | Cómo queda |
|---|---|
| La máquina de estados lineal daba por "avisado" un artefacto que nunca se subió | **Dos estados independientes** por artefacto: uno de subida y uno de aviso (tareas 4 y 5) |
| `audit_daily_manifests.retention_mode` sólo acepta `governance` | Se **migra la restricción** para aceptar los dos modos; producción usa compliance (tarea 4) |
| La retención iba firmada adentro del manifiesto, calculada antes de subir | **Sale del contenido firmado**: se fija al confirmar la subida (tareas 6 y 8) |
| Los incidentes de informes no tenían dónde vivir en la plataforma | Los abre **el legado**, vía el vigilante, con el sistema de alertas que ya existe (tarea 11) |
| El plan mandaba escribir un cliente SMTP a mano | Se usa **`nodemailer`**, la misma librería de `lib/mailer.js` (tarea 9) |
| Los tests usaban columnas y tablas que no existen | Nombres verificados contra las migraciones reales; **helper de fixtures** compartido (tarea 0) |
| Tests que comparten estado y dependen del reloj | **Base limpia por caso y reloj inyectado** en todos (todas las tareas) |
| `verify_chain(NULL)` no verificaba hasta el extremo congelado | La función acepta `(desde, hasta)`: se pasa el `chain_seq` capturado (tarea 6) |
| `migraciones.test.ts` compara la lista de migraciones literal | Cada tarea que agrega una migración actualiza ese test en el mismo commit |
| El test de doble llave recorría una lista que mantiene la implementación | Se inspeccionan **las rutas que Fastify registró** de verdad (tarea 12) |

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
- **Cada migración nueva actualiza `plataforma/test/migraciones.test.ts`** en el mismo commit: ese test compara
  la lista de archivos **literal** (`0001…0008` hoy), así que agregar una sin tocarlo lo rompe.
- **Cada caso de test limpia lo suyo y recibe la hora como parámetro.** Nada de estado compartido entre `it`
  del mismo archivo ni de `new Date()` dentro del código probado: se inyecta `ahora`.
- **Nombres reales del esquema**, verificados el 2026-09-17 contra `plataforma/migrations/`:
  - `core.companies (id, legal_name, …)`; `core.channel_accounts (id, company_id, channel IN
    ('mercadolibre','woocommerce'), external_account, is_primary, …)`.
  - `security.users (id, company_id, username, email_ciphertext, email_blind_index, status, …)`. **No** existen
    `email` ni `display_name`, y el email va cifrado con índice ciego.
  - `integrations.reconciliation_signals (id, channel_account_id, topic, resource_id, notification_id,
    fingerprint, source IN ('webhook_copy','ml_missed_feed'), status IN ('pending','claimed','succeeded',
    'retryable','dead_lettered','excluded'), attempts, …, error_detail, correlation_id, received_at,
    finished_at)`. **No** existen `channel` ni `exclusion_reason`, y el estado es `dead_lettered`.
  - `audit.verify_chain(desde bigint DEFAULT NULL, hasta bigint DEFAULT NULL) RETURNS bigint`.
  - `audit.audit_events` exige `company_id` con FK válida y `correlation_id` **uuid**.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `plataforma/test/soporte/fixtures.ts` | siembra empresa, cuenta de canal y usuario para los tests |
| `plataforma/migrations/0009_informes_entregas.sql` | esquema `informes`, tabla `entregas`, `GRANT` propios, y el `CHECK` de `retention_mode` ampliado |
| `plataforma/migrations/0010_webauthn_desafios.sql` | `security.webauthn_challenges` y la fila `passkeys.real` en `false` |
| `plataforma/migrations/0011_intentos_recuperacion.sql` | `security.recovery_attempts` para el límite de intentos |
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

Un commit por tarea, de la 0 a la 16. Ninguna sale a internet ni toca producción, salvo la **16**, que cambia
el VPS y **necesita autorización explícita de José**, igual que C10 de T3. Las migraciones son tres: 0009
(entregas y el `CHECK` de la retención), 0010 (desafíos de WebAuthn) y 0011 (intentos de recuperación).

---

### Tarea 0: Helper de fixtures para los tests

Sin esto, los tests de las tareas 6, 7, 12 y 13 no pueden insertar nada: `audit_events` exige una empresa con
FK válida, las señales exigen una cuenta de canal, y `security.users` pide `company_id` y `username`.

**Archivos:**
- Crear: `plataforma/test/soporte/fixtures.ts`
- Test: se prueba a sí mismo en `plataforma/test/soporte/fixtures.test.ts`

**Interfaces:**
- Consume: `crearBaseDePrueba()` de `test/soporte/base.ts`.
- Produce:
  - `sembrar(pool): Promise<Semilla>` con `Semilla = { companyId: string; cuentaWoo: string; cuentaMl: string; userId: string }`
  - `limpiar(pool, tablas: string[]): Promise<void>` — `TRUNCATE` de las tablas indicadas, para que cada caso
    arranque limpio sin recrear la base.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './base.ts';
import { limpiar, sembrar } from './fixtures.ts';

describe('fixtures', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('siembra empresa, las dos cuentas de canal y un usuario', async () => {
    const s = await sembrar(pool);
    expect(s.companyId).toMatch(/^[0-9a-f-]{36}$/);
    const cuentas = await pool.query(`SELECT channel FROM core.channel_accounts WHERE company_id = $1 ORDER BY channel`, [s.companyId]);
    expect(cuentas.rows.map((r) => r.channel)).toEqual(['mercadolibre', 'woocommerce']);
    const u = await pool.query(`SELECT company_id, username, status FROM security.users WHERE id = $1`, [s.userId]);
    expect(u.rows[0]).toMatchObject({ company_id: s.companyId, username: 'prueba' });
  });

  it('sembrar dos veces no choca con las restricciones de unicidad', async () => {
    const a = await sembrar(pool); const b = await sembrar(pool);
    expect(b.companyId).not.toBe(a.companyId);
  });

  it('limpiar vacía las tablas pedidas y deja las demás', async () => {
    const s = await sembrar(pool);
    await pool.query(`INSERT INTO integrations.reconciliation_signals
      (channel_account_id, topic, resource_id, fingerprint, source) VALUES ($1,'woo.orders','1','ev:a','webhook_copy')`, [s.cuentaWoo]);
    await limpiar(pool, ['integrations.reconciliation_signals']);
    expect((await pool.query('SELECT COUNT(*)::int n FROM integrations.reconciliation_signals')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int n FROM core.companies')).rows[0].n).toBeGreaterThan(0);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/soporte/fixtures.test.ts`
Esperado: FALLA con "Cannot find module './fixtures.ts'".

- [ ] **Paso 3: implementación mínima**

```ts
/*
 * test/soporte/fixtures.ts — la semilla mínima que exigen las FK del esquema.
 *
 * `audit.audit_events` pide una empresa que exista y un correlation_id uuid; las señales piden una cuenta de
 * canal; `security.users` pide company_id y username (no hay columna `email`: va cifrada con índice ciego).
 * Sin esta semilla, los tests fallan por la FK antes de probar lo que quieren probar.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface Semilla { companyId: string; cuentaWoo: string; cuentaMl: string; userId: string }

export async function sembrar(pool: pg.Pool): Promise<Semilla> {
  const sufijo = randomUUID().slice(0, 8);
  const empresa = await pool.query<{ id: string }>(
    `INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`Prueba ${sufijo}`]);
  const companyId = empresa.rows[0]!.id;
  const cuenta = async (channel: string) => (await pool.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account, is_primary)
     VALUES ($1, $2, $3, true) RETURNING id`, [companyId, channel, `${channel}-${sufijo}`])).rows[0]!.id;
  const cuentaWoo = await cuenta('woocommerce');
  const cuentaMl = await cuenta('mercadolibre');
  const usuario = await pool.query<{ id: string }>(
    `INSERT INTO security.users (company_id, username, status) VALUES ($1, 'prueba', 'active') RETURNING id`,
    [companyId]);
  return { companyId, cuentaWoo, cuentaMl, userId: usuario.rows[0]!.id };
}

const TABLAS_PERMITIDAS = /^[a-z_]+\.[a-z_]+$/;

export async function limpiar(pool: pg.Pool, tablas: string[]): Promise<void> {
  for (const t of tablas) if (!TABLAS_PERMITIDAS.test(t)) throw new Error(`limpiar: tabla inválida ${t}`);
  if (tablas.length) await pool.query(`TRUNCATE ${tablas.join(', ')} CASCADE`);
}
```

Si el rol `plataforma_app` no puede hacer `TRUNCATE`, usar `DELETE FROM` en el mismo orden y anotarlo.

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/soporte/fixtures.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/test/soporte/fixtures.ts plataforma/test/soporte/fixtures.test.ts
git commit -m "test(plataforma): helper de fixtures con la semilla mínima del esquema

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

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

  it('rechaza texto con un surrogate suelto, en clave y en valor', () => {
    // RFC 8785 §3.2.2.2 exige fallar: al pasar a UTF-8, Node lo reemplazaría por U+FFFD y la firma dejaría
    // de corresponder al texto original.
    expect(() => canonizar({ t: '\ud800' })).toThrow(/surrogate/);
    expect(() => canonizar({ '\udc00': 1 })).toThrow(/surrogate/);
    expect(canonizar({ t: '\ud83d\ude00' })).toBe('{"t":"😀"}');
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
  // Un surrogate sin par no tiene representación UTF-8: hay que fallar, no dejar que Node lo cambie por
  // U+FFFD, porque entonces la firma no correspondería al texto recibido.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) {
    throw new Error('canonizar: hay un surrogate UTF-16 sin par');
  }
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
- Modificar: `plataforma/test/migraciones.test.ts` (sumar `0009_informes_entregas.sql` a la lista literal)
- Test: `plataforma/test/informes/entregas-esquema.test.ts`

**Interfaces:**
- Consume: nada.
- Produce: la tabla `informes.entregas` con `tipo` (`manifiesto`|`reporte`), `fecha`, `hash_contenido`, `kid`,
  y **dos estados independientes**: `estado_deposito` (`generado`|`firmado`|`subido`) y `estado_aviso`
  (`pendiente`|`avisado`), cada uno con sus intentos. Más `ruta_pendiente`, `b2_object_key`,
  `b2_version_id`, `retention_until`, `testigo`, `lease_hasta` y los `*_en` de cada transición.
  También amplía el `CHECK` de `audit.audit_daily_manifests.retention_mode`.

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
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, hash_contenido) VALUES ('reporte','2026-09-16', repeat('a',64))`);
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, hash_contenido) VALUES ('reporte','2026-09-16', repeat('b',64))`))
      .rejects.toThrow(/duplicate key/);
  });

  it('rechaza estados y tipos desconocidos', async () => {
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido) VALUES ('reporte','2026-09-15','enviado', repeat('a',64))`))
      .rejects.toThrow(/entregas_estado_deposito_check/);
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido) VALUES ('otro','2026-09-15','generado', repeat('a',64))`))
      .rejects.toThrow(/entregas_tipo_check/);
  });

  it('el aviso es independiente de la subida: se puede avisar sin haber subido', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, estado_aviso, hash_contenido)
      VALUES ('manifiesto','2026-09-11','firmado','avisado', repeat('a',64))`);
    const fila = (await pool.query(`SELECT estado_deposito, estado_aviso FROM informes.entregas WHERE fecha='2026-09-11'`)).rows[0];
    expect(fila).toEqual({ estado_deposito: 'firmado', estado_aviso: 'avisado' });
  });

  it('subido exige clave de objeto y versión', async () => {
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido)
      VALUES ('reporte','2026-09-10','subido', repeat('a',64))`)).rejects.toThrow(/entregas_subido_check/);
  });

  it('audit_daily_manifests acepta compliance', async () => {
    const r = await pool.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid = 'audit.audit_daily_manifests'::regclass AND conname LIKE '%retention_mode%'`);
    expect(r.rows[0].d).toMatch(/compliance/);
  });

  it('el rol de la aplicación puede leer, insertar y actualizar, pero no borrar', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido) VALUES ('manifiesto','2026-09-09','generado', repeat('c',64))`);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM informes.entregas WHERE fecha='2026-09-09'`)).rows[0].n).toBe(1);
    await pool.query(`UPDATE informes.entregas SET intentos_deposito = intentos_deposito + 1 WHERE fecha = '2026-09-09'`);
    await expect(pool.query(`DELETE FROM informes.entregas WHERE fecha = '2026-09-09'`)).rejects.toThrow(/permission denied/);
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

-- Dos estados independientes, no una cadena: con un solo camino, un email enviado daba por terminado un
-- artefacto que nunca se subió, y el reintento de B2 moría ahí (hallazgo 1 de la revisión del plan).
CREATE TABLE informes.entregas (
  tipo              text NOT NULL CHECK (tipo IN ('manifiesto', 'reporte')),
  fecha             date NOT NULL,
  estado_deposito   text NOT NULL DEFAULT 'generado' CHECK (estado_deposito IN ('generado', 'firmado', 'subido')),
  estado_aviso      text NOT NULL DEFAULT 'pendiente' CHECK (estado_aviso IN ('pendiente', 'avisado')),
  hash_contenido    text NOT NULL CHECK (hash_contenido ~ '^[0-9a-f]{64}$'),
  kid               text,
  ruta_pendiente    text,
  b2_object_key     text,
  b2_version_id     text,
  -- La retención se fija al confirmar la subida, no al armar el contenido: si se calculara sobre el día
  -- reportado, recuperar días viejos dejaría menos de 365 días reales (hallazgo 3).
  retention_until   timestamptz,
  intentos_deposito integer NOT NULL DEFAULT 0 CHECK (intentos_deposito >= 0),
  intentos_aviso    integer NOT NULL DEFAULT 0 CHECK (intentos_aviso >= 0),
  ultimo_error      text,
  -- El candado de sesión del scheduler no alcanza: al perder la conexión, el proceso viejo puede seguir
  -- subiendo y enviando. Cada efecto se reclama con este testigo, verificado antes y después.
  testigo           uuid,
  lease_hasta       timestamptz,
  generado_en       timestamptz NOT NULL DEFAULT now(),
  firmado_en        timestamptz,
  subido_en         timestamptz,
  avisado_en        timestamptz,
  PRIMARY KEY (tipo, fecha),
  CONSTRAINT entregas_subido_check CHECK (
    (estado_deposito = 'subido') = (b2_object_key IS NOT NULL AND b2_version_id IS NOT NULL AND retention_until IS NOT NULL))
);

CREATE INDEX entregas_deposito_pendiente ON informes.entregas (fecha) WHERE estado_deposito <> 'subido';
CREATE INDEX entregas_aviso_pendiente ON informes.entregas (fecha) WHERE estado_aviso = 'pendiente';

-- El esquema de T1 fijaba `retention_mode = 'governance'`, que contradice la decisión de José del 2026-09-17
-- (compliance: que nadie, ni con la clave maestra, pueda acortar la retención). Se amplía el CHECK y se deja
-- compliance como el modo de producción. No hay filas que convertir: la tabla nunca se usó.
ALTER TABLE audit.audit_daily_manifests DROP CONSTRAINT audit_daily_manifests_retention_mode_check;
ALTER TABLE audit.audit_daily_manifests
  ADD CONSTRAINT audit_daily_manifests_retention_mode_check CHECK (retention_mode IN ('governance', 'compliance'));

-- Los GRANT por defecto de 0002_permisos.sql cubren core, security, audit e integrations: un esquema nuevo
-- necesita los suyos. Sin DELETE: una entrega es evidencia de lo que pasó ese día.
GRANT USAGE ON SCHEMA informes TO plataforma_app;
GRANT SELECT, INSERT, UPDATE ON informes.entregas TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA informes GRANT SELECT, INSERT, UPDATE ON TABLES TO plataforma_app;
```

- [ ] **Paso 4: sumar la migración a la lista literal del test de migraciones**

En `plataforma/test/migraciones.test.ts` agregar `'0009_informes_entregas.sql'` al array esperado (aparece dos
veces en el archivo: en la línea ~24 y en la ~59). Sin esto el test falla por la lista, no por un error real.

- [ ] **Paso 5: correr los tests y verificar que pasan**

Run: `cd plataforma && npx vitest run test/informes/entregas-esquema.test.ts test/migraciones.test.ts`
Esperado: PASA, incluida la prueba de migraciones.

- [ ] **Paso 6: reflejar la tabla en el esquema de referencia**

Agregar el mismo `CREATE TABLE` a `docs/superpowers/specs/e1/schema.sql` con su comentario, y corregir ahí el
`CHECK` de `retention_mode` para que diga lo mismo que la migración.

- [ ] **Paso 7: commit**

```bash
git add plataforma/migrations/0009_informes_entregas.sql plataforma/test/informes/entregas-esquema.test.ts plataforma/test/migraciones.test.ts docs/superpowers/specs/e1/schema.sql
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
    — crea la fila si no existe y devuelve `{ tipo, fecha, testigo, deposito, aviso }`, o `null` si otro
    proceso tiene el `lease` vigente, si ya está todo hecho, **o si el hash del contenido no coincide con el
    de la fila** (mismo día con contenido distinto: se anota el conflicto y no se toca lo ya firmado).
  - `avanzarDeposito(db, reclamo, estado: 'firmado'|'subido', datos?): Promise<boolean>`
  - `avanzarAviso(db, reclamo): Promise<boolean>`
    — ambas devuelven `false` si el testigo cambió, si el `lease` ya venció, o si la transición no es la
    siguiente válida: el llamador se detiene sin escribir.
  - `anotarFallo(db, reclamo, cual: 'deposito'|'aviso', error: string): Promise<void>`
  - `pendientesVencidas(db, ahora: Date, horas?: number): Promise<Array<{ tipo: string; fecha: string; estado_deposito: string; estado_aviso: string; intentos_deposito: number }>>`
    — las que llevan más de `horas` (24 por omisión) sin cerrar **la subida**, para el incidente crítico.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { anotarFallo, avanzarAviso, avanzarDeposito, pendientesVencidas, reclamar } from '../../src/informes/entregas.ts';
import { limpiar } from '../soporte/fixtures.ts';

describe('entregas', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  const HASH = 'a'.repeat(64);
  const AHORA = new Date('2026-09-17T10:00:00Z');
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });
  // Cada caso arranca con la tabla vacía: si compartieran filas, el orden decidiría el resultado.
  beforeEach(async () => { await limpiar(pool, ['informes.entregas']); });

  const SUBIDA = { b2_object_key: 'e1/reportes/2026-09-16.json', b2_version_id: 'v1', retention_until: new Date('2027-09-20T00:00:00Z') };

  it('reclama, sube y avisa; los dos estados avanzan por separado', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-16', { hash: HASH, ahora: AHORA });
    expect(r).toMatchObject({ deposito: 'generado', aviso: 'pendiente' });
    expect(await avanzarDeposito(pool, r!, 'firmado', { kid: 'k1', ruta_pendiente: '/tmp/x.json' })).toBe(true);
    expect(await avanzarDeposito(pool, r!, 'subido', SUBIDA)).toBe(true);
    expect(await avanzarAviso(pool, r!)).toBe(true);
    const fila = (await pool.query(`SELECT estado_deposito, estado_aviso, kid, b2_version_id, avisado_en FROM informes.entregas WHERE fecha='2026-09-16'`)).rows[0];
    expect(fila).toMatchObject({ estado_deposito: 'subido', estado_aviso: 'avisado', kid: 'k1', b2_version_id: 'v1' });
    expect(fila.avisado_en).not.toBeNull();
  });

  it('avisar sin haber subido deja la subida pendiente y reclamable', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-16', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado');
    expect(await avanzarAviso(pool, r!)).toBe(true);
    await pool.query('UPDATE informes.entregas SET lease_hasta = NULL');
    // Justamente lo que el plan viejo rompía: el email no da por terminada la subida.
    const otra = await reclamar(pool, 'manifiesto', '2026-09-16', { hash: HASH, ahora: AHORA });
    expect(otra).toMatchObject({ deposito: 'firmado', aviso: 'avisado' });
  });

  it('no deja saltear ni retroceder estados', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH, ahora: AHORA });
    expect(await avanzarDeposito(pool, r!, 'subido', SUBIDA)).toBe(false);
    await avanzarDeposito(pool, r!, 'firmado');
    await avanzarDeposito(pool, r!, 'subido', SUBIDA);
    expect(await avanzarDeposito(pool, r!, 'firmado')).toBe(false);
    expect((await pool.query(`SELECT estado_deposito FROM informes.entregas WHERE fecha='2026-09-15'`)).rows[0].estado_deposito).toBe('subido');
  });

  it('un segundo proceso no puede reclamar mientras el lease está vigente', async () => {
    expect(await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH, leaseMs: 60_000, ahora: AHORA })).not.toBeNull();
    expect(await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH, ahora: AHORA })).toBeNull();
  });

  it('cuando el lease vence, el nuevo dueño invalida al viejo', async () => {
    const viejo = await reclamar(pool, 'reporte', '2026-09-14', { hash: HASH, leaseMs: -1, ahora: AHORA });
    const nuevo = await reclamar(pool, 'reporte', '2026-09-14', { hash: HASH, ahora: AHORA });
    expect(nuevo!.testigo).not.toBe(viejo!.testigo);
    // El proceso viejo sigue vivo y cree que le toca: no debe poder escribir.
    expect(await avanzarDeposito(pool, viejo!, 'firmado')).toBe(false);
    expect((await pool.query(`SELECT estado_deposito FROM informes.entregas WHERE fecha='2026-09-14'`)).rows[0].estado_deposito).toBe('generado');
  });

  it('con el lease ya vencido, el dueño tampoco escribe', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-13', { hash: HASH, leaseMs: -1, ahora: AHORA });
    expect(await avanzarDeposito(pool, r!, 'firmado')).toBe(false);
  });

  it('una entrega subida y avisada no se vuelve a reclamar', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-13', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado');
    await avanzarDeposito(pool, r!, 'subido', SUBIDA);
    await avanzarAviso(pool, r!);
    await pool.query('UPDATE informes.entregas SET lease_hasta = NULL');
    expect(await reclamar(pool, 'manifiesto', '2026-09-13', { hash: HASH, ahora: AHORA })).toBeNull();
  });

  it('el mismo día con otro contenido no pisa lo ya firmado', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-12', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado');
    await pool.query('UPDATE informes.entregas SET lease_hasta = NULL');
    expect(await reclamar(pool, 'reporte', '2026-09-12', { hash: 'b'.repeat(64), ahora: AHORA })).toBeNull();
    const fila = (await pool.query(`SELECT hash_contenido, ultimo_error FROM informes.entregas WHERE fecha='2026-09-12'`)).rows[0];
    expect(fila.hash_contenido).toBe(HASH);
    expect(fila.ultimo_error).toMatch(/hash/);
  });

  it('anotarFallo cuenta los intentos de cada camino por separado', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-12', { hash: HASH, ahora: AHORA });
    await anotarFallo(pool, r!, 'deposito', 'B2 no responde');
    await anotarFallo(pool, r!, 'aviso', 'SMTP 451');
    const fila = (await pool.query(`SELECT intentos_deposito, intentos_aviso, ultimo_error FROM informes.entregas WHERE fecha='2026-09-12' AND tipo='manifiesto'`)).rows[0];
    expect(fila).toMatchObject({ intentos_deposito: 1, intentos_aviso: 1, ultimo_error: 'SMTP 451' });
  });

  it('pendientesVencidas encuentra las que llevan más de 24 h sin subir', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-11', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado');
    await pool.query(`UPDATE informes.entregas SET generado_en = $1::timestamptz - interval '30 hours' WHERE fecha='2026-09-11'`, [AHORA]);
    const vencidas = await pendientesVencidas(pool, AHORA);
    expect(vencidas).toHaveLength(1);
    expect(vencidas[0]).toMatchObject({ tipo: 'manifiesto', estado_deposito: 'firmado' });
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/entregas.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

Puntos que los tests fijan y que la primera versión del plan no cumplía:
- `reclamar` compara el hash recibido con `hash_contenido` y, si difieren, anota el conflicto en
  `ultimo_error` y devuelve `null`; no reclama cuando `estado_deposito='subido'` **y** `estado_aviso='avisado'`.
- `avanzarDeposito` y `avanzarAviso` exigen en el `WHERE` el testigo, `lease_hasta > $ahora` y el estado
  **anterior** correcto (`generado`→`firmado`→`subido`; `pendiente`→`avisado`), así no se saltea ni retrocede.
- `anotarFallo` recibe cuál de los dos caminos falló e incrementa sólo ese contador.
- Ninguna función usa `new Date()` adentro: la hora entra por parámetro.

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
export type EstadoDeposito = 'generado' | 'firmado' | 'subido';
export type EstadoAviso = 'pendiente' | 'avisado';
export interface Reclamo { tipo: TipoEntrega; fecha: string; testigo: string; deposito: EstadoDeposito; aviso: EstadoAviso }

const LEASE_MS = 10 * 60_000;
const HORAS_INCIDENTE = 24;
const ANTERIOR: Record<Exclude<EstadoDeposito, 'generado'>, EstadoDeposito> = { firmado: 'generado', subido: 'firmado' };
const DATOS_PERMITIDOS = new Set(['kid', 'ruta_pendiente', 'b2_object_key', 'b2_version_id', 'retention_until']);

export async function reclamar(
  db: Consultable, tipo: TipoEntrega, fecha: string,
  opciones: { hash: string; leaseMs?: number; ahora?: Date },
): Promise<Reclamo | null> {
  const ahora = opciones.ahora ?? new Date();
  const testigo = randomUUID();
  const hasta = new Date(ahora.getTime() + (opciones.leaseMs ?? LEASE_MS));
  const r = await db.query<{ estado_deposito: EstadoDeposito; estado_aviso: EstadoAviso }>(
    `INSERT INTO informes.entregas (tipo, fecha, hash_contenido, testigo, lease_hasta)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tipo, fecha) DO UPDATE
       SET testigo = $4, lease_hasta = $5
       WHERE informes.entregas.hash_contenido = $3
         AND NOT (informes.entregas.estado_deposito = 'subido' AND informes.entregas.estado_aviso = 'avisado')
         AND (informes.entregas.lease_hasta IS NULL OR informes.entregas.lease_hasta <= $6)
     RETURNING estado_deposito, estado_aviso`,
    [tipo, fecha, opciones.hash, testigo, hasta, ahora],
  );
  const fila = r.rows[0];
  if (fila) return { tipo, fecha, testigo, deposito: fila.estado_deposito, aviso: fila.estado_aviso };
  // Puede haber sido el lease de otro, o un contenido distinto para el mismo día: eso último se anota, porque
  // significa que alguien va a subir algo que no corresponde al sobre ya firmado.
  await db.query(
    `UPDATE informes.entregas SET ultimo_error = 'hash distinto del ya firmado para este día'
      WHERE tipo = $1 AND fecha = $2 AND hash_contenido <> $3`,
    [tipo, fecha, opciones.hash],
  );
  return null;
}

export async function avanzarDeposito(
  db: Consultable, reclamo: Reclamo, estado: Exclude<EstadoDeposito, 'generado'>,
  datos: Record<string, unknown> = {}, ahora: Date = new Date(),
): Promise<boolean> {
  const extra = Object.keys(datos).filter((k) => DATOS_PERMITIDOS.has(k));
  const columna = estado === 'firmado' ? 'firmado_en' : 'subido_en';
  const valores = [reclamo.tipo, reclamo.fecha, reclamo.testigo, estado, ANTERIOR[estado], ahora, ...extra.map((k) => datos[k])];
  const asignaciones = extra.map((k, i) => `${k} = $${7 + i}`).join(', ');
  const r = await db.query(
    `UPDATE informes.entregas
        SET estado_deposito = $4, ${columna} = $6${asignaciones ? `, ${asignaciones}` : ''}
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3
        AND estado_deposito = $5 AND lease_hasta > $6`,
    valores,
  );
  return (r.rowCount ?? 0) === 1;
}

export async function avanzarAviso(db: Consultable, reclamo: Reclamo, ahora: Date = new Date()): Promise<boolean> {
  const r = await db.query(
    `UPDATE informes.entregas SET estado_aviso = 'avisado', avisado_en = $4
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3 AND estado_aviso = 'pendiente' AND lease_hasta > $4`,
    [reclamo.tipo, reclamo.fecha, reclamo.testigo, ahora],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function anotarFallo(
  db: Consultable, reclamo: Reclamo, cual: 'deposito' | 'aviso', error: string,
): Promise<void> {
  const columna = cual === 'deposito' ? 'intentos_deposito' : 'intentos_aviso';
  await db.query(
    `UPDATE informes.entregas SET ${columna} = ${columna} + 1, ultimo_error = $4, lease_hasta = NULL
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3`,
    [reclamo.tipo, reclamo.fecha, reclamo.testigo, error.slice(0, 500)],
  );
}

export async function pendientesVencidas(
  db: Consultable, ahora: Date, horas: number = HORAS_INCIDENTE,
): Promise<Array<{ tipo: string; fecha: string; estado_deposito: string; estado_aviso: string; intentos_deposito: number }>> {
  const r = await db.query<{ tipo: string; fecha: string; estado_deposito: string; estado_aviso: string; intentos_deposito: number }>(
    `SELECT tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha, estado_deposito, estado_aviso, intentos_deposito
       FROM informes.entregas
      WHERE estado_deposito <> 'subido' AND generado_en <= $1::timestamptz - make_interval(hours => $2)
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
  `{ tipo: 'manifiesto'; fecha; ventana: { desde: string; hasta: string }; primer_chain_seq: string | null; ultimo_chain_seq: string | null; ultimo_hash: string; eventos: number; cadena: { integra: boolean; roto_en: string | null } }`.
  El `hash` viaja en hexadecimal. **`retention_until` NO viaja acá:** se fija al confirmar la subida (tarea 8),
  porque calcularla sobre el día reportado deja menos de 365 días reales al recuperar días viejos.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { randomUUID } from 'node:crypto';
import { armarManifiesto } from '../../src/informes/manifiesto.ts';
import { registrarEvento } from '../../src/audit/auditoria.ts';
import { sembrar } from '../soporte/fixtures.ts';

// `audit_events` exige una empresa que exista y un correlation_id uuid: los dos salen de la semilla.
const evento = (companyId: string, n: number) => ({
  companyId, actorType: 'system' as const, actorId: 'test',
  action: `prueba.${n}`, aggregateType: 'prueba', aggregateId: String(n), correlationId: randomUUID(),
});

describe('armarManifiesto', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let companyId: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp);
    companyId = (await sembrar(pool)).companyId;
  });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('E1-AUD-04 cuenta los eventos del día y fija los extremos exactos de la cadena', async () => {
    // Los eventos se fechan a mano dentro de un día fijo: leer "hoy ART" y comparar después puede cruzar
    // la medianoche y hacer fallar el test de madrugada.
    const a = await registrarEvento(pool, evento(companyId, 1));
    const b = await registrarEvento(pool, evento(companyId, 2));
    await pool.query(`UPDATE audit.audit_events SET occurred_at = '2026-09-16T15:00:00Z' WHERE chain_seq IN ($1, $2)`,
      [a.chainSeq, b.chainSeq]);
    const m = await armarManifiesto(pool, '2026-09-16');
    expect(m.eventos).toBe(2);
    expect(m.primer_chain_seq).toBe(a.chainSeq);
    expect(m.ultimo_chain_seq).toBe(b.chainSeq);
    expect(m.ultimo_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.cadena).toEqual({ integra: true, roto_en: null });
    expect(m.ventana).toEqual({ desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' });
    // La retención no es parte del contenido firmado: la fija la subida.
    expect(m).not.toHaveProperty('retention_until');
  });

  it('E1-AUD-04 un día sin eventos se emite con extremos nulos y el último hash conocido', async () => {
    const m = await armarManifiesto(pool, '2026-01-05');
    expect(m).toMatchObject({ eventos: 0, primer_chain_seq: null, ultimo_chain_seq: null });
    expect(m.ultimo_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('E1-AUD-04 verifica la cadena sólo hasta el extremo del día, no más allá', async () => {
    // Un evento posterior al día reportado no puede cambiar el veredicto de ese día.
    const c = await registrarEvento(pool, evento(companyId, 3));
    await pool.query(`UPDATE audit.audit_events SET occurred_at = '2026-09-20T15:00:00Z' WHERE chain_seq = $1`, [c.chainSeq]);
    const m = await armarManifiesto(pool, '2026-09-16');
    expect(m.ultimo_chain_seq).not.toBe(c.chainSeq);
    expect(m.cadena.integra).toBe(true);
  });

  it('E1-AUD-04 un día sin eventos y sin cadena previa usa el hash cero', async () => {
    const vacia = await crearBaseDePrueba();
    const p2 = crearPool(vacia.urlApp);
    try {
      expect((await armarManifiesto(p2, '2026-01-05')).ultimo_hash).toBe('0'.repeat(64));
    } finally { await p2.end(); await vacia.borrar(); }
  });

  it('E1-AUD-04 si la cadena está rota lo informa en lugar de fallar', async () => {
    const sucia = await crearBaseDePrueba();
    const admin = crearPool(sucia.urlAdmin); const app = crearPool(sucia.urlApp);
    try {
      const semilla = await sembrar(app);
      await registrarEvento(app, evento(semilla.companyId, 1));
      await registrarEvento(app, evento(semilla.companyId, 2));
      // Sólo un superusuario puede saltear el trigger; es exactamente el ataque que el manifiesto detecta.
      await admin.query(`ALTER TABLE audit.audit_events DISABLE TRIGGER ALL`);
      await admin.query(`UPDATE audit.audit_events SET payload = '{"tocado":true}' WHERE chain_seq = 1`);
      await admin.query(`UPDATE audit.audit_events SET occurred_at = '2026-09-16T15:00:00Z'`);
      const m = await armarManifiesto(app, '2026-09-16');
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
  ventana: { desde: string; hasta: string };
  primer_chain_seq: string | null;
  ultimo_chain_seq: string | null;
  ultimo_hash: string;
  eventos: number;
  cadena: { integra: boolean; roto_en: string | null };
}

const HASH_CERO = '0'.repeat(64);

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
    // La función real es verify_chain(desde, hasta): se verifica hasta el extremo capturado, no toda la
    // cadena, para que un evento posterior no cambie el veredicto del día (hallazgo 10 de la revisión).
    const roto = await cliente.query<{ roto: string | null }>(
      'SELECT audit.verify_chain(NULL::bigint, $1::bigint) AS roto', [ultimo]);
    const rotoEn = roto.rows[0]?.roto ?? null;
    await cliente.query('COMMIT');

    return {
      tipo: 'manifiesto', fecha, ventana: { desde: desde.toISOString(), hasta: hasta.toISOString() },
      primer_chain_seq: primero, ultimo_chain_seq: ultimo,
      ultimo_hash: hash.rows[0]?.hash ?? HASH_CERO, eventos: Number(n),
      cadena: { integra: rotoEn === null, roto_en: rotoEn },
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
Esperado: PASA.

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
  Motivos aceptados como explicación: `recurso_borrado`, `fuera_de_ventana`, `sin_historial`,
  `descartada_contada`. El motivo se lee de `error_detail`, que es la columna real (**no** existe
  `exclusion_reason`), y los estados reales son `succeeded`, `excluded`, `dead_lettered`, `retryable`,
  `pending` y `claimed`.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { armarReporte, MOTIVOS_EXPLICADOS } from '../../src/informes/reporte.ts';
import { limpiar, sembrar, type Semilla } from '../soporte/fixtures.ts';

describe('armarReporte', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let s: Semilla;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); s = await sembrar(pool); });
  afterAll(async () => { await pool.end(); await base.borrar(); });
  // Sin esto, las señales de un caso cuentan en el siguiente y el resultado depende del orden.
  beforeEach(async () => { await limpiar(pool, ['integrations.reconciliation_signals', 'informes.entregas']); });

  const senal = (extra: Record<string, unknown>) => pool.query(
    `INSERT INTO integrations.reconciliation_signals
       (channel_account_id, topic, resource_id, fingerprint, source, status, error_detail, received_at)
     VALUES ($1, $2, $3, $4, 'webhook_copy', $5, $6, $7)`,
    [extra.cuenta ?? s.cuentaWoo, extra.topic, extra.resource, extra.fingerprint, extra.status, extra.motivo ?? null, extra.recibida],
  );

  it('E1-REC-01 un día sin actividad da verde y cero faltantes', async () => {
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.semaforo).toBe('verde');
    expect(r.faltantes_sin_explicar).toBe(0);
    expect(r.ventana).toEqual({ desde: '2026-09-16T03:00:00.000Z', hasta: '2026-09-17T03:00:00.000Z' });
  });

  it('E1-REC-01 sólo cuenta señales dentro de la ventana del día', async () => {
    await senal({ topic: 'woo.orders', resource: '1', fingerprint: 'ev:a', status: 'succeeded', recibida: '2026-09-16T12:00:00Z' });
    await senal({ topic: 'woo.orders', resource: '2', fingerprint: 'ev:b', status: 'succeeded', recibida: '2026-09-17T12:00:00Z' });
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.topicos['woo.orders']!.senales_nucleo).toBe(1);
  });

  it('E1-REC-01 un faltante con motivo registrado no rompe', async () => {
    expect(MOTIVOS_EXPLICADOS).toContain('recurso_borrado');
    await senal({ topic: 'woo.products', resource: '3', fingerprint: 'ev:c', status: 'excluded', motivo: 'recurso_borrado', recibida: '2026-09-16T12:00:00Z' });
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.faltantes_sin_explicar).toBe(0);
    expect(r.semaforo).toBe('verde');
  });

  it('E1-REC-01 un faltante con motivo fuera de la lista pinta rojo', async () => {
    await senal({ topic: 'woo.products', resource: '4', fingerprint: 'ev:d', status: 'dead_lettered', motivo: 'porque_si', recibida: '2026-09-16T12:00:00Z' });
    const r = await armarReporte(pool, '2026-09-16');
    expect(r.faltantes_sin_explicar).toBe(1);
    expect(r.semaforo).toBe('rojo');
  });

  it('E1-REC-01 un faltante sin motivo también pinta rojo', async () => {
    await senal({ topic: 'ml.orders', resource: '5', fingerprint: 'ev:e', status: 'dead_lettered', recibida: '2026-09-16T12:00:00Z', cuenta: s.cuentaMl });
    expect((await armarReporte(pool, '2026-09-16')).semaforo).toBe('rojo');
  });

  it('E1-REC-01 una cadena de auditoría rota pinta rojo aunque no haya faltantes', async () => {
    const r = await armarReporte(pool, '2026-09-15', {
      manifiesto: { tipo: 'manifiesto', fecha: '2026-09-15',
        ventana: { desde: '2026-09-15T03:00:00.000Z', hasta: '2026-09-16T03:00:00.000Z' },
        primer_chain_seq: null, ultimo_chain_seq: null, ultimo_hash: '0'.repeat(64), eventos: 0,
        cadena: { integra: false, roto_en: '7' } },
    });
    expect(r.semaforo).toBe('rojo');
  });

  it('E1-REC-01 numera el día de campaña y recuerda el reporte anterior', async () => {
    await pool.query(`INSERT INTO informes.entregas
      (tipo, fecha, estado_deposito, estado_aviso, hash_contenido, b2_object_key, b2_version_id, retention_until)
      VALUES ('reporte','2026-09-14','subido','avisado', repeat('a',64),
              'e1/reportes/2026-09-14.json', 'v1', '2027-09-20T00:00:00Z')`);
    const r = await armarReporte(pool, '2026-09-15');
    expect(r.reporte_anterior).toBe('2026-09-14');
    expect(r.dia_campana).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/informes/reporte.test.ts`
Esperado: FALLA por módulo inexistente. Las columnas de `reconciliation_signals` ya están verificadas contra
`plataforma/migrations/0005_senales.sql` (ahí nace la tabla, no en `0001`).

- [ ] **Paso 3: implementación mínima**

Escribir `reporte.ts` con:
- `ventana` calculada con `medianocheArt` y **todas** las consultas acotadas a `[desde, hasta)`. No se lee
  `integrations.shadow_daily_summaries`: mide ventanas móviles de 24 h y se sobrescribe, así que no
  representa un día cerrado (hallazgo 17 de la revisión externa).
- `export const MOTIVOS_EXPLICADOS = ['recurso_borrado', 'fuera_de_ventana', 'sin_historial', 'descartada_contada'] as const;`
- por tópico: `senales_legado` (recibos del legado importados), `senales_nucleo` (`status='succeeded'`),
  `faltantes` (`status IN ('dead_lettered','retryable','pending','claimed','excluded')` sin resultado),
  `faltantes_sin_explicar` (de esos, los que tienen `error_detail` fuera de `MOTIVOS_EXPLICADOS` o en `NULL`),
  `cobertura` (resueltas sobre recibidas), `convergencia` (recursos cuyo estado coincide sobre barridos, o
  `null` en tópicos sin historial), `descartadas`.
- el tópico se agrupa por `topic`, y el canal se obtiene por `JOIN core.channel_accounts` cuando hace falta:
  la tabla de señales **no** tiene columna `channel`.
- `armarReporte` recibe `ahora` opcional y no llama a `new Date()` para decidir nada del contenido.
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
  - `Deposito.subir(clave: string, cuerpo: string, ahora: Date): Promise<{ versionId: string; retencion: string }>`
    — la retención la calcula **acá**, sobre `ahora` (el momento del PUT) más 365 días y el margen, no la
    recibe del contenido firmado.
  - `Deposito.consultar(clave: string): Promise<{ versionId: string; retencion: string; modo: string } | null>`
  - `Deposito.limpiarPendiente(ruta: string): Promise<void>`

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearDeposito } from '../../src/informes/deposito.ts';

const CFG = (dir: string, fetchSimulado: typeof fetch) => ({
  endpoint: 'https://s3.us-west-000.backblazeb2.com', region: 'us-west-000', bucket: 'fusion-e1-pruebas',
  prefijo: 'e1/', escritura: { id: 'w', clave: 'kw' }, lectura: { id: 'r', clave: 'kr' },
  dirPendientes: dir, fetch: fetchSimulado,
});

// Reimplementación independiente de SigV4 sólo para el test: si el código y el test comparten la
// implementación, el test no prueba nada.
function firmaEsperada(pedido: { url: string; headers: Record<string, string> }): string {
  // ... derivar la clave (AWS4 + secreto → fecha → región → s3 → aws4_request) y firmar la canonical request
  // armada desde `pedido`, siguiendo la especificación de SigV4.
  throw new Error('implementar en la tarea 8, paso 1');
}

describe('deposito', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dep-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('la retención se calcula sobre el momento del PUT, no sobre el día reportado', async () => {
    const pedidos: Array<Record<string, string>> = [];
    const fetchSimulado = (async (_u: string | URL, init: RequestInit = {}) => {
      pedidos.push(Object.fromEntries(new Headers(init.headers).entries()));
      return new Response('', { status: 200, headers: { 'x-amz-version-id': 'v1' } });
    }) as unknown as typeof fetch;
    // Se sube el 2026-09-20 un informe del 2026-09-14: la retención cuenta desde la subida.
    await crearDeposito(CFG(dir, fetchSimulado)).subir('e1/reportes/2026-09-14.json', '{}', new Date('2026-09-20T10:00:00Z'));
    const retener = Date.parse(pedidos[0]!['x-amz-object-lock-retain-until-date']!);
    expect(retener - Date.parse('2026-09-20T10:00:00Z')).toBeGreaterThanOrEqual(365 * 86400e3);
  });

  it('la subida manda Object Lock en modo COMPLIANCE y firma bien con SigV4', async () => {
    const pedidos: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchSimulado = (async (url: string | URL, init: RequestInit = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      pedidos.push({ url: String(url), headers });
      return new Response('', { status: 200, headers: { 'x-amz-version-id': 'v42' } });
    }) as unknown as typeof fetch;
    const dep = crearDeposito(CFG(dir, fetchSimulado));
    const r = await dep.subir('e1/reportes/2026-09-16.json', '{"a":1}', new Date('2026-09-17T10:00:00Z'));
    expect(r.versionId).toBe('v42');
    expect(pedidos[0]!.url).toBe('https://s3.us-west-000.backblazeb2.com/fusion-e1-pruebas/e1/reportes/2026-09-16.json');
    expect(pedidos[0]!.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    // SHA-256 de '{"a":1}', para que un cuerpo mal hasheado no pase el test.
    expect(pedidos[0]!.headers['x-amz-content-sha256'])
      .toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(pedidos[0]!.headers['x-amz-date']).toBe('20260917T100000Z');
    // La firma se recalcula acá de forma independiente: comparar sólo el prefijo dejaba pasar un scope,
    // una canonical request o unos SignedHeaders mal armados (hallazgo 12 de la revisión del plan).
    const auth = pedidos[0]!.headers.authorization!;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=w\/20260917\/us-west-000\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-object-lock-mode;x-amz-object-lock-retain-until-date, Signature=[0-9a-f]{64}$/);
    expect(auth).toContain(`Signature=${firmaEsperada(pedidos[0]!)}`);
  });

  it('una subida fallida se propaga con el cuerpo del error', async () => {
    const fetchSimulado = (async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as unknown as typeof fetch;
    await expect(crearDeposito(CFG(dir, fetchSimulado)).subir('e1/x.json', '{}', new Date()))
      .rejects.toThrow(/403.*AccessDenied/s);
  });

  it('consultar pide ?retention con la credencial de lectura y devuelve el modo', async () => {
    const vistos: Array<{ url: string; auth: string }> = [];
    const fetchSimulado = (async (url: string | URL, init: RequestInit = {}) => {
      vistos.push({ url: String(url), auth: new Headers(init.headers).get('authorization') ?? '' });
      return String(url).includes('falta')
        ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        : new Response('<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>2027-09-18T00:00:00Z</RetainUntilDate></Retention>',
            { status: 200, headers: { 'x-amz-version-id': 'v42' } });
    }) as unknown as typeof fetch;
    const dep = crearDeposito(CFG(dir, fetchSimulado));
    expect(await dep.consultar('e1/reportes/2026-09-16.json'))
      .toEqual({ versionId: 'v42', retencion: '2027-09-18T00:00:00Z', modo: 'COMPLIANCE' });
    expect(vistos[0]!.url).toBe('https://s3.us-west-000.backblazeb2.com/fusion-e1-pruebas/e1/reportes/2026-09-16.json?retention=');
    // La de lectura, no la de escritura: si se filtra una, que no sirva para lo otro.
    expect(vistos[0]!.auth).toMatch(/Credential=r\//);
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
  hexadecimal, `x-amz-date` y `authorization` con `AWS4-HMAC-SHA256`. La versión sale del header
  `x-amz-version-id`. La ruta se codifica **por segmentos** (`/` no se escapa).
- `RETENCION_DIAS = 365` y `MARGEN_DIAS = 2`, aplicados sobre el `ahora` recibido.
- `GET {endpoint}/{bucket}/{clave}?retention=` firmado con la credencial de **lectura**, devolviendo también el
  modo leído; 404 devuelve `null`.
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
    con `CfgCorreo = { host; puerto; seguro; usuario; clave; desde; para; timeoutMs?; tamanoMaxBytes?; transporte?: Transporte }`,
    donde `Transporte = { sendMail(opciones): Promise<unknown> }` es el de `nodemailer` (el mismo que usa
    `lib/mailer.js` en el legado) y en los tests se reemplaza por uno falso.

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

  it('manda el adjunto por nodemailer y no filtra la clave', async () => {
    const visto: Array<Record<string, unknown>> = [];
    await enviar({ ...CFG, transporte: { async sendMail(m: Record<string, unknown>) { visto.push(m); return {}; } } },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'reporte.json', contenido: '{"a":1}' }] });
    expect(visto[0]).toMatchObject({ from: 'a@b', to: 'c@d', subject: 'x' });
    expect(visto[0]!.attachments).toEqual([{ filename: 'reporte.json', content: '{"a":1}', contentType: 'application/json' }]);
    expect(JSON.stringify(visto)).not.toContain('c');  // la clave SMTP no viaja en el mensaje
  });

  it('rechaza un adjunto más grande que el tope', async () => {
    await expect(enviar({ ...CFG, tamanoMaxBytes: 10, transporte: { async sendMail() { return {}; } } },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'r.json', contenido: 'z'.repeat(50) }] }))
      .rejects.toThrow(/tama/);
  });

  it('rechaza saltos de línea en el asunto y en el nombre del adjunto', async () => {
    const transporte = { async sendMail() { return {}; } };
    await expect(enviar({ ...CFG, transporte }, { asunto: 'x\r\nBcc: otro@d', texto: 'y', adjuntos: [] }))
      .rejects.toThrow(/encabezado/);
    await expect(enviar({ ...CFG, transporte },
      { asunto: 'x', texto: 'y', adjuntos: [{ nombre: 'r\n.json', contenido: '{}' }] })).rejects.toThrow(/encabezado/);
  });

  it('un rechazo del servidor se propaga', async () => {
    await expect(enviar({ ...CFG, transporte: { async sendMail() { throw new Error('451 try later'); } } },
      { asunto: 'x', texto: 'y', adjuntos: [] })).rejects.toThrow(/451/);
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
- `enviar`: **`nodemailer`**, agregado a `plataforma/package.json` con la misma versión que el legado
  (`^9.0.3`). Escribir un cliente SMTP a mano era trabajo de más y riesgo gratis: EHLO multilínea, STARTTLS,
  AUTH, respuestas 4xx/5xx, dot-stuffing y MIME ya están resueltos ahí (hallazgo 22 de la revisión del plan).
  El transporte se crea con `createTransport({ host, port, secure, auth, connectionTimeout, greetingTimeout,
  socketTimeout })`; en los tests entra uno falso por `cfg.transporte`.
- El asunto y los nombres de adjunto se pasan por `nodemailer`, que ya escapa los encabezados; igual se
  rechaza cualquier `\r` o `\n` en asunto y nombre de archivo antes de enviar.
- `timeoutMs` por omisión 20 s y `tamanoMaxBytes` por omisión 5 MiB.
- Ningún log incluye `cfg.clave` ni el cuerpo del adjunto.

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/informes/correo.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/src/informes/correo.ts plataforma/test/informes/correo.test.ts plataforma/package.json plataforma/package-lock.json
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
- Produce: `vueltaDeInformes(pool, cfg: CfgInformes, ahora?: Date): Promise<{ hechos: string[]; fallados: string[]; atrasadas: Array<{ tipo: string; fecha: string }> }>`.
  **No abre incidentes**: los devuelve y los expone por la ruta interna, y el legado es el que alerta
  (tarea 11), porque la plataforma no tiene tabla de incidentes ni dónde verlos hasta E4.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { vueltaDeInformes } from '../../src/informes/vuelta.ts';
import { verificar } from '../../src/informes/firma.ts';
import { limpiar, sembrar } from '../soporte/fixtures.ts';

describe('vueltaDeInformes', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let dir: string;
  let subidas: Array<{ clave: string; cuerpo: string; retener: Date }>; let emails: Array<{ asunto: string }>;
  let cfg: Parameters<typeof vueltaDeInformes>[1];

  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); await sembrar(pool); });
  afterAll(async () => { await pool.end(); await base.borrar(); });
  beforeEach(async () => {
    // Sin limpiar, el primer caso deja el día cerrado y los siguientes no ejercitan ningún camino.
    await limpiar(pool, ['informes.entregas', 'integrations.reconciliation_signals']);
    dir = mkdtempSync(join(tmpdir(), 'vuelta-'));
    subidas = []; emails = [];
    cfg = {
      // La clave se genera en el test con el script de la tarea 2; el helper la deja en `dir`.
      clave: { kid: 'k1', privada: crearClaveDePrueba() },
      publicas: { k1: publicaDePrueba() },
      deposito: {
        async subir(clave: string, cuerpo: string, ahora: Date) {
          const retener = new Date(ahora.getTime() + 367 * 86400e3);
          subidas.push({ clave, cuerpo, retener });
          return { versionId: 'v1', retencion: retener.toISOString() };
        },
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
    const filas = (await pool.query(`SELECT tipo, estado_deposito, estado_aviso FROM informes.entregas ORDER BY tipo`)).rows;
    expect(filas).toEqual([
      { tipo: 'manifiesto', estado_deposito: 'subido', estado_aviso: 'avisado' },
      { tipo: 'reporte', estado_deposito: 'subido', estado_aviso: 'avisado' },
    ]);
  });

  it('correrla dos veces no sube ni manda de nuevo', async () => {
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:05:00Z'));
    expect(r.hechos).toEqual([]);
    expect(subidas).toHaveLength(2);
    expect(emails).toHaveLength(1);
  });

  it('si B2 falla, el email igual sale y la subida queda pendiente y reintentable', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.fallados).toContain('manifiesto:2026-09-16');
    expect(emails).toHaveLength(1);
    const fila = (await pool.query(`SELECT estado_deposito, estado_aviso, intentos_deposito, ruta_pendiente FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0];
    // El aviso salió, pero la subida sigue en 'firmado': es lo que el plan viejo daba por terminado.
    expect(fila).toMatchObject({ estado_deposito: 'firmado', estado_aviso: 'avisado', intentos_deposito: 1 });
    expect(fila.ruta_pendiente).not.toBeNull();
  });

  it('la vuelta siguiente reintenta sólo la subida pendiente, sin re-avisar', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    subidas = [];
    cfg.deposito.subir = async (clave: string, cuerpo: string, ahora: Date) => {
      subidas.push({ clave, cuerpo, retener: ahora }); return { versionId: 'v2', retencion: ahora.toISOString() };
    };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T11:00:00Z'));
    expect(subidas).toHaveLength(2);
    expect(emails).toHaveLength(1);
    const filas = (await pool.query(`SELECT estado_deposito FROM informes.entregas`)).rows;
    expect(filas.every((f) => f.estado_deposito === 'subido')).toBe(true);
  });

  it('el pendiente en disco se limpia sólo después de confirmar la subida', async () => {
    const limpiados: string[] = [];
    cfg.deposito.limpiarPendiente = async (ruta: string) => { limpiados.push(ruta); };
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(limpiados).toHaveLength(0);
  });

  it('ante una subida en duda consulta en lugar de volver a subir', async () => {
    cfg.deposito.subir = async () => { throw new Error('timeout'); };
    cfg.deposito.consultar = async () => ({ versionId: 'v9', retencion: '2027-09-18T00:00:00Z', modo: 'COMPLIANCE' });
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    const fila = (await pool.query(`SELECT estado_deposito, b2_version_id FROM informes.entregas WHERE tipo='manifiesto'`)).rows[0];
    expect(fila).toMatchObject({ estado_deposito: 'subido', b2_version_id: 'v9' });
  });

  it('recupera varios días caídos, del más viejo al más nuevo', async () => {
    await pool.query(`INSERT INTO informes.entregas
      (tipo, fecha, estado_deposito, estado_aviso, hash_contenido, b2_object_key, b2_version_id, retention_until)
      VALUES ('reporte','2026-09-13','subido','avisado', repeat('a',64), 'e1/reportes/2026-09-13.json','v1','2027-09-20T00:00:00Z'),
             ('manifiesto','2026-09-13','subido','avisado', repeat('a',64), 'e1/manifiestos/2026-09-13.json','v1','2027-09-20T00:00:00Z')`);
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    expect(r.hechos.filter((h) => h.startsWith('reporte'))).toEqual(['reporte:2026-09-14', 'reporte:2026-09-15', 'reporte:2026-09-16']);
  });

  it('informa las entregas que llevan más de 24 h sin subir', async () => {
    cfg.deposito.subir = async () => { throw new Error('sin red'); };
    await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:00:00Z'));
    await pool.query(`UPDATE informes.entregas SET generado_en = '2026-09-16T04:00:00Z'`);
    const r = await vueltaDeInformes(pool, cfg, new Date('2026-09-17T10:10:00Z'));
    // La plataforma no abre incidentes: los expone y el legado los convierte en alerta (tarea 11).
    expect(r.atrasadas.map((a) => `${a.tipo}:${a.fecha}`)).toContain('manifiesto:2026-09-16');
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
3. si el estado es `generado`: firmar y `avanzarDeposito` a `firmado`, guardando la ruta del pendiente;
4. si el estado es `firmado`: `subir` con `ahora` (la retención la calcula el depósito). Ante error,
   `consultar` una vez: si el objeto está, `avanzarDeposito` a `subido` con esa versión y retención; si no,
   `anotarFallo(… 'deposito' …)`. Recién con `subido` confirmado se llama a `limpiarPendiente`;
5. si `estado_aviso` es `pendiente`: un solo email por día con el reporte adjunto, y `avanzarAviso` de los dos
   artefactos. **El email sale aunque la subida haya fallado**, porque avisar no depende de B2;
6. al final, `pendientesVencidas` y devolverlas en `atrasadas`.

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
  - `revisarInformeDelDia(db, { url, keyringFile, fetch, ahora })` en el legado: si no hay informe del día a
    las 09:00 ART, o si la plataforma informa entregas atrasadas, abre un incidente y manda la alerta por el
    canal existente; idempotente por día. Firma el pedido con HMAC reusando `lib/emisorSombra.js`, que ya
    resuelve keyring, `kid`, fecha y firma: no se escribe otro emisor.

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

  it('firma el pedido con HMAC y con informe del día no abre nada', async () => {
    const fetchSimulado = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ultimo: '2026-09-16', atrasadas: [] }) });
    const r = await revisarInformeDelDia(db, { url: 'http://x/informes', fetch: fetchSimulado, ahora });
    expect(r).toMatchObject({ estado: 'ok' });
    const cabeceras = fetchSimulado.mock.calls[0][1].headers;
    expect(cabeceras['x-fusion-key-id']).toBeTruthy();
    expect(cabeceras['x-fusion-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigilante_informes'").get().n).toBe(0);
  });

  it('con entregas atrasadas abre incidente aunque el informe del día exista', async () => {
    const fetchSimulado = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ultimo: '2026-09-16', atrasadas: [{ tipo: 'manifiesto', fecha: '2026-09-15' }] }) });
    expect(await revisarInformeDelDia(db, { url: 'http://x/informes', fetch: fetchSimulado, ahora })).toMatchObject({ estado: 'atrasadas' });
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE proceso='vigilante_informes' AND estado='activo'").get().n).toBe(1);
  });

  it('sin informe del día abre incidente una sola vez', async () => {
    const fetchSimulado = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ultimo: '2026-09-14', atrasadas: [] }) });
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
- La ruta que consulta es un `GET /internal/v1/informes/estado` nuevo en la API de la plataforma, que devuelve
  `{ ultimo: 'YYYY-MM-DD' | null, atrasadas: [{ tipo, fecha }] }` leyendo `informes.entregas`. La verificación
  HMAC existente (`src/api/senales.ts`) está armada para un POST con cuerpo crudo: se extrae a una función
  reusable la parte que verifica firma y nonce, y se la aplica a este GET con la cadena a firmar formada por
  método, ruta y fecha. La opción se declara en `OpcionesApi` igual que `senales`, así la ruta **no existe**
  (404) si no se configura.
- `package.json` de la raíz: `"verificar-informe": "node scripts/verificar-informe.mjs"`.
- `server.js`: llamar al vigilante desde el cron que ya corre cada hora.

- [ ] **Paso 4: correr los tests y verificar que pasan**

Run: `npx vitest run test/verificarInforme.test.js test/vigilanteInformes.test.js && cd plataforma && npx vitest run test/api.test.ts`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add scripts/verificar-informe.mjs lib/vigilanteInformes.js package.json server.js test/verificarInforme.test.js test/vigilanteInformes.test.js plataforma/src/api plataforma/test/api.test.ts
git commit -m "feat(informes): verificación independiente y vigilante del legado

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 12: Desafíos de WebAuthn y el interruptor de doble llave

**Archivos:**
- Crear: `plataforma/migrations/0010_webauthn_desafios.sql`, `plataforma/src/auth/passkeys.ts`,
  `plataforma/src/api/passkeys.ts`
- Modificar: `plataforma/package.json` (dependencia `@simplewebauthn/server` `14.0.2`),
  `plataforma/src/api/app.ts` (registrar el grupo de rutas), `plataforma/test/migraciones.test.ts` (sumar
  `0010_webauthn_desafios.sql` a los dos arrays literales)
- Crear también: `plataforma/test/soporte/webauthn.ts` (autenticador virtual)
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

  it('E1-WA-01 con el interruptor apagado responden 503 TODAS las rutas que Fastify registró', async () => {
    const api = await levantarApi(pool);   // helper local: crearApi como en test/api.test.ts
    // Se le pregunta a Fastify qué rutas existen de verdad, en vez de confiar en una lista que mantiene la
    // misma implementación: así una ruta nueva sin guarda hace fallar el test (hallazgo 15 de la revisión).
    const registradas = rutasDe(api.printRoutes({ commonPrefix: false })).filter((r) => r.startsWith('/api/v2/auth/'));
    expect(registradas.length).toBeGreaterThanOrEqual(6);
    expect(new Set(RUTAS_PASSKEYS)).toEqual(new Set(registradas));
    for (const ruta of registradas) {
      const r = await api.inject({ method: 'POST', url: ruta, payload: {} });
      expect(r.statusCode, ruta).toBe(503);
      expect(r.json(), ruta).toMatchObject({ error: 'passkeys_deshabilitadas' });
    }
    await api.close();
  });

  it('E1-WA-01 las cuatro etapas funcionan con el autenticador virtual', async () => {
    // Con las dos llaves encendidas: registro → login → reautenticación → recuperación, cada etapa
    // verificando lo que devolvió la anterior, contra `crearAutenticador({ rpID, origin })` de
    // test/soporte/webauthn.ts.
  });

  it('E1-WA-01 un desafío se usa una sola vez', async () => {
    // Se completa un registro y se reenvía la misma respuesta: la segunda vez falla y la fila queda usada.
  });

  it('E1-WA-01 un desafío vencido se rechaza', async () => {
    // Se fuerza `vence_en` al pasado con un UPDATE y la verificación falla.
  });

  it('E1-WA-01 un desafío de registro no sirve para un login', async () => {
    // Se pasa el desafío de propósito 'registro' a la verificación de login: falla por propósito.
  });
});
```

Completar los cuatro últimos `it` al implementar: el autenticador virtual va en
`plataforma/test/soporte/webauthn.ts` (no existe todavía), `levantarApi` levanta la API con `crearApi` como
hace `test/api.test.ts` con `rpID: 'localhost'` y origen `http://localhost`, y `rutasDe` parsea la salida de
`printRoutes`. Lo que cada prueba demuestra está en su comentario: ninguna puede quedar vacía.

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

`src/auth/passkeys.ts` con:
- `passkeysHabilitadas` (las dos llaves);
- las cuatro ceremonias sobre `@simplewebauthn/server` 14.0.2: `generateRegistrationOptions`,
  `verifyRegistrationResponse`, `generateAuthenticationOptions` y `verifyAuthenticationResponse`, con
  `expectedRPID` y `expectedOrigin` desde la configuración (nunca del pedido) y verificación de usuario
  exigida;
- el desafío se guarda al generar las opciones y se consume en la **misma transacción** que lo verifica
  (`UPDATE … SET usado_en = $ahora WHERE desafio = $1 AND usado_en IS NULL AND vence_en > $ahora`), así dos
  pedidos simultáneos no lo pueden usar los dos;
- al registrar se guardan `credential_id` y `public_key` como `bytea`, más `transports`, `aaguid`,
  `backup_eligible` y `backup_state`; al autenticar se actualizan `sign_count` y las banderas de respaldo en la
  misma transacción, con la regla de la librería, que sólo exige avance cuando alguno de los contadores es
  mayor que cero (hay autenticadores que informan siempre 0);
- registrar una credencial exige una sesión ya autenticada; en los tests la sesión entra por el proveedor
  inyectable que ya existe (`src/auth/sesion.ts`), que es lo único que E1 tiene.

`src/api/passkeys.ts` con `RUTAS_PASSKEYS` y **un solo** `preHandler` registrado en el plugin del grupo, de
modo que toda ruta del prefijo quede cubierta por construcción.

- [ ] **Paso 4: sumar la migración a la lista literal del test de migraciones**

Agregar `'0010_webauthn_desafios.sql'` a los dos arrays de `plataforma/test/migraciones.test.ts`.

- [ ] **Paso 5: correr los tests y verificar que pasan**

Run: `cd plataforma && npx vitest run test/passkeys.test.ts test/migraciones.test.ts test/api.test.ts && npm run typecheck`
Esperado: PASA.

- [ ] **Paso 5: commit**

```bash
git add plataforma/migrations/0010_webauthn_desafios.sql plataforma/src/auth/passkeys.ts plataforma/src/api plataforma/package.json plataforma/package-lock.json plataforma/test/passkeys.test.ts plataforma/test/soporte/webauthn.ts plataforma/test/migraciones.test.ts docs/superpowers/specs/e1/schema.sql
git commit -m "feat(passkeys): desafíos persistentes y interruptor de doble llave

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Tarea 13: Recuperación de acceso con límite de intentos

**Archivos:**
- Crear: `plataforma/migrations/0011_intentos_recuperacion.sql`, `plataforma/src/auth/recuperacion.ts`
- Modificar: `plataforma/src/api/passkeys.ts` (la ruta de recuperación),
  `plataforma/test/migraciones.test.ts` (sumar `0011_intentos_recuperacion.sql`)
- Test: `plataforma/test/recuperacion.test.ts`

**Interfaces:**
- Consume: `passkeysHabilitadas` (tarea 12), `security.recovery_codes`.
- Produce:
  - `emitirCodigos(db, userId: string, cantidad?: number): Promise<string[]>` — 10 códigos de 128 bits; el
    claro sólo existe en el valor devuelto.
  - `usarCodigo(db, userId: string, codigo: string, opciones: { ip: string; ahora: Date }): Promise<{ ok: boolean; motivo?: 'invalido'|'limite' }>`
    — `ahora` es obligatorio: nada de `Date.now()` adentro.
  - La tabla `security.recovery_attempts (id, user_id, ip, intentado_en, exitoso)`, que es dónde se cuenta el
    límite: `security.recovery_codes` no tiene intentos.
  - **No** cierra sesiones: E1 no tiene sesiones reales (`src/auth/sesion.ts` sólo provee una inyectable para
    tests). El uso de un código deja su evento de auditoría, y la invalidación de sesiones queda anotada como
    parte de E4, cuando existan.

- [ ] **Paso 1: escribir el test que falla**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';
import { emitirCodigos, usarCodigo } from '../src/auth/recuperacion.ts';
import { limpiar, sembrar } from './soporte/fixtures.ts';

describe('recuperación', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let userId: string;
  const AHORA = new Date('2026-09-17T10:00:00Z');
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });
  // Cada caso arranca con su propio usuario y sin intentos previos: el límite de uno no puede afectar al otro.
  beforeEach(async () => {
    await limpiar(pool, ['security.recovery_attempts', 'security.recovery_codes']);
    userId = (await sembrar(pool)).userId;
  });

  it('emite 10 códigos de 128 bits y no los guarda en claro', async () => {
    const codigos = await emitirCodigos(pool, userId);
    expect(codigos).toHaveLength(10);
    expect(new Set(codigos).size).toBe(10);
    for (const c of codigos) expect(c).toMatch(/^[0-9a-z]{26,32}$/);
    const filas = await pool.query(`SELECT code_hash FROM security.recovery_codes WHERE user_id = $1`, [userId]);
    expect(filas.rows).toHaveLength(10);
    expect(JSON.stringify(filas.rows)).not.toContain(codigos[0]!);
  });

  it('un código sirve una sola vez y deja su evento de auditoría', async () => {
    const [codigo] = await emitirCodigos(pool, userId, 1);
    expect(await usarCodigo(pool, userId, codigo!, { ip: '1.2.3.4', ahora: AHORA })).toMatchObject({ ok: true });
    expect(await usarCodigo(pool, userId, codigo!, { ip: '1.2.3.4', ahora: AHORA })).toMatchObject({ ok: false, motivo: 'invalido' });
    const eventos = await pool.query(`SELECT COUNT(*)::int n FROM audit.audit_events WHERE action = 'security.recovery_code.used'`);
    expect(eventos.rows[0].n).toBe(1);
  });

  it('corta a los 5 intentos fallidos por cuenta en una hora', async () => {
    for (let i = 0; i < 5; i += 1) await usarCodigo(pool, userId, 'nosirve', { ip: `10.0.0.${i}`, ahora: AHORA });
    // Cinco IP distintas: el que corta acá es el límite por cuenta.
    expect(await usarCodigo(pool, userId, 'nosirve', { ip: '10.0.0.9', ahora: AHORA })).toMatchObject({ ok: false, motivo: 'limite' });
    const despues = new Date(AHORA.getTime() + 61 * 60_000);
    expect(await usarCodigo(pool, userId, 'nosirve', { ip: '10.0.0.9', ahora: despues })).toMatchObject({ ok: false, motivo: 'invalido' });
  });

  it('corta también por IP, con cuentas distintas', async () => {
    for (let i = 0; i < 5; i += 1) {
      const otro = (await sembrar(pool)).userId;
      await usarCodigo(pool, otro, 'nosirve', { ip: '7.7.7.7', ahora: AHORA });
    }
    expect(await usarCodigo(pool, userId, 'nosirve', { ip: '7.7.7.7', ahora: AHORA })).toMatchObject({ ok: false, motivo: 'limite' });
  });

  it('un código válido no sirve si la cuenta ya está frenada', async () => {
    const [codigo] = await emitirCodigos(pool, userId, 1);
    for (let i = 0; i < 5; i += 1) await usarCodigo(pool, userId, 'nosirve', { ip: '8.8.8.8', ahora: AHORA });
    expect(await usarCodigo(pool, userId, codigo!, { ip: '8.8.8.8', ahora: AHORA })).toMatchObject({ ok: false, motivo: 'limite' });
  });

  it('responde igual exista o no el usuario', async () => {
    const inexistente = '00000000-0000-0000-0000-0000000000ff';
    expect(await usarCodigo(pool, inexistente, 'nosirve', { ip: '5.5.5.5', ahora: AHORA })).toEqual(
      await usarCodigo(pool, userId, 'nosirve', { ip: '6.6.6.6', ahora: AHORA }),
    );
  });
});
```

- [ ] **Paso 2: correr el test y verificar que falla**

Run: `cd plataforma && npx vitest run test/recuperacion.test.ts`
Esperado: FALLA por módulo inexistente.

- [ ] **Paso 3: implementación mínima**

Primero la migración:

```sql
-- E1 T4 · tarea 13: los intentos de recuperación, que son donde vive el límite.
-- `security.recovery_codes` guarda los códigos, no los intentos: sin esta tabla el límite de 5 por hora no
-- tiene dónde contarse (hallazgo 8 de la revisión del plan).
CREATE TABLE security.recovery_attempts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid REFERENCES security.users(id),   -- nulo si el usuario no existe: igual se cuenta por IP
  ip           inet NOT NULL,
  intentado_en timestamptz NOT NULL DEFAULT now(),
  exitoso      boolean NOT NULL DEFAULT false
);
CREATE INDEX recovery_attempts_cuenta ON security.recovery_attempts (user_id, intentado_en DESC);
CREATE INDEX recovery_attempts_ip ON security.recovery_attempts (ip, intentado_en DESC);
```

Los `GRANT` los hereda de `ALTER DEFAULT PRIVILEGES` de `0002_permisos.sql`, porque el esquema `security` ya
está cubierto; el test de permisos de la tarea 4 no aplica acá.

`recuperacion.ts` con: códigos de 16 bytes en base32 sin caracteres ambiguos; hash HMAC-SHA256 con la clave del
keyring; comparación en tiempo constante; límites de 5 por hora por cuenta, 5 por hora por IP y un tope global,
contados sobre `recovery_attempts` con el `ahora` recibido; y el uso del código en **una sola transacción** que
registra el intento, marca `used_at` y deja el evento de auditoría `security.recovery_code.used`. La respuesta
no distingue usuario inexistente de código equivocado, y el límite se evalúa **antes** de comparar el código.

- [ ] **Paso 4: correr el test y verificar que pasa**

Run: `cd plataforma && npx vitest run test/recuperacion.test.ts test/migraciones.test.ts && npm run typecheck`
Esperado: PASA. Recordá sumar `'0011_intentos_recuperacion.sql'` a los dos arrays del test de migraciones.

- [ ] **Paso 5: commit**

```bash
git add plataforma/migrations/0011_intentos_recuperacion.sql plataforma/src/auth/recuperacion.ts plataforma/src/api/passkeys.ts plataforma/test/recuperacion.test.ts plataforma/test/migraciones.test.ts docs/superpowers/specs/e1/schema.sql
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

- [ ] **Paso 3: nombrar las pruebas con sus IDs y exigir la cantidad mínima**

Los `it(...)` de las tareas 6, 7, 10, 12 y 13 ya nacen con su ID en el título. Como el gate sólo busca el ID en
títulos que pasaron, un único `it` alcanzaría para pintarlo verde: por eso `scripts/qa/gate-e1.mjs` pasa a
exigir, para el tramo 4, **un mínimo de pruebas por ID** (`E1-AUD-04`: 4; `E1-REC-01`: 6; `E1-WA-01`: 6) y a
fallar si falta alguna de las nombradas en `test-e1.md`. Y en `scripts/test-e1.sh`, el tramo 4 agrega la clave
de firma efímera generada con el script de la tarea 2, el simulador S3 y el SMTP simulado.

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

- [ ] **Paso 1: José crea en B2** tres cosas. El bucket de producción con Object Lock habilitado (se usará en
  modo compliance). El bucket de verificación, **con Object Lock habilitado pero que se usa en modo
  governance**: sin Object Lock no se puede probar retención en absoluto (B2 rechaza esas cabeceras), y en
  governance lo que se sube se puede borrar con la clave maestra, así que no queda basura inmutable hasta 2027.
  Y las credenciales por CLI: escritura sin `deleteFiles` ni `bypassGovernance`, y lectura sólo con `readFiles`
  y `readFileRetentions`, ambas acotadas al bucket y al prefijo `e1/`. Deja los cuatro valores en
  `/opt/fusionbikes/plataforma-prod/secretos/`, 0600.
- [ ] **Paso 2: generar la clave de firma** en el VPS con `plataforma/scripts/generar-clave-firma.mjs`,
  commitear sólo la pública, y guardar el respaldo de la privada fuera del VPS.
- [ ] **Paso 3: backup** de `data/fusion.sqlite` y de `.env`, y `pg_dump` de la base `plataforma`.
- [ ] **Paso 4: aplicar las migraciones** 0009, 0010 y 0011 con `npm run migrar`, y verificar que `passkeys.real`
  quedó en `false` y que `PASSKEYS_HABILITADAS` **no** existe en el entorno.
- [ ] **Paso 5: recrear los contenedores** con los montajes nuevos y verificar `/api/v2/health`.
- [ ] **Paso 6: verificación única contra B2 real**, primero en el bucket de verificación (governance): subir un
  objeto, leer su retención y su modo, comprobar que la credencial de escritura no puede borrar ni acortar, y
  después borrarlo con la clave maestra. Recién entonces una subida de prueba al bucket de producción
  (compliance), sabiendo que queda un año. Pegar toda la salida como evidencia en
  `docs/superpowers/evidence/e1/`.
- [ ] **Paso 7: un envío real de email** y confirmación de que llegó con el adjunto.
- [ ] **Paso 8: arrancar la campaña de 7 días** y registrar cada día en la evidencia.

---

## Autorrevisión

**Cobertura de la spec:** §4 firma → tareas 1, 2 y 11; §5 manifiesto → 6; §6 reporte y email → 7, 9 y 11;
§7 B2 → 8 y 16; §7 bis entregas → 4, 5 y 10; §8 passkeys → 12 y 13; §9 campaña → 16; §9 bis secretos → 10 y
16; §10 bordes → repartidos en los tests de 5, 8 y 10; §11 gate → 14. La semilla que exigen las FK está en la
tarea 0, y las tres migraciones en las tareas 4, 12 y 13.

**Los 23 hallazgos de la revisión del plan, uno por uno:** 1 → tareas 4 y 5 (dos estados); 2 → tarea 10
(`afterEach` importado y limpieza por caso); 3 → tareas 6 y 8 (la retención sale del contenido firmado y se
calcula al subir); 4 → tarea 7 (columnas y estados reales); 5 → tareas 0 y 6 (semilla y `correlationId` uuid);
6 → tareas 0 y 13 (usuario con `company_id` y `username`); 7 → tareas 4, 12 y 13 (la lista literal de
migraciones); 8 → tarea 13 (migración 0011, y las sesiones quedan para E4); 9 → tarea 5 (transiciones válidas,
`lease` vigente y hash comparado); 10 → tarea 6 (`verify_chain(desde, hasta)`); 11 → tarea 4 (el `CHECK` de
`retention_mode`); 12 → tarea 8 (firma SigV4 recalculada en el test, y `?retention=`); 13 → tarea 16 (el bucket
de verificación sí tiene Object Lock, en governance); 14 → tarea 12 (autenticador virtual propio y llamadas de
14.0.2); 15 → tarea 12 (se inspeccionan las rutas que Fastify registró); 16 → tarea 11 (HMAC reusando el emisor
del legado); 17 → tarea 10 (la plataforma informa y el legado alerta); 18 → tarea 14 (mínimo de pruebas por
ID); 19 → tarea 1 (surrogates sueltos); 20 → tarea 6 (fechas fijas y extremos afirmados); 21 → tareas 5, 7 y 13
(limpieza por caso y reloj inyectado); 22 → tarea 9 (`nodemailer`); 23 → tarea 4 (se prueban `SELECT`,
`INSERT`, `UPDATE` y el `DELETE` denegado).

**Marcadores:** ninguna tarea dice "TBD" ni "agregar manejo de errores": cada paso trae el test y el código, o
la lista exacta de lo que el archivo tiene que contener cuando es más largo que lo razonable para un plan
(tareas 7, 8, 9, 10, 12 y 13, donde los tests fijan el contrato). Quedan a propósito dos cuerpos por completar
al implementar, con lo que deben demostrar escrito en su comentario: `firmaEsperada` en la tarea 8 (la
reimplementación de SigV4 del test, que no puede compartir código con la implementación) y las cuatro
ceremonias de la tarea 12, que dependen del autenticador virtual que esa misma tarea crea.

**Consistencia de tipos:** `Reclamo`, `Sobre`, `Manifiesto`, `Reporte`, `Semilla` y `CfgDeposito` se definen una
vez y se citan igual en las tareas siguientes; `canonizar`, `firmar`, `verificar`, `huella`, `sembrar`,
`limpiar`, `reclamar`, `avanzarDeposito`, `avanzarAviso`, `anotarFallo`, `pendientesVencidas`,
`armarManifiesto`, `armarReporte`, `armarCuerpo`, `enviar`, `vueltaDeInformes`, `passkeysHabilitadas`,
`emitirCodigos` y `usarCodigo` conservan su nombre y su firma en todo el plan. `Manifiesto` ya **no** lleva
`retention_until`, y la tabla de entregas usa `estado_deposito`/`estado_aviso` en todas las tareas que la tocan.
