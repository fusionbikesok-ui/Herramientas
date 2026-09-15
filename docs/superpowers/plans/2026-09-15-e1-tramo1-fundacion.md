# E1 · Tramo 1 — Fundación de la plataforma: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir y verificar en un entorno aislado `plataforma/` (TypeScript sobre Node 24) con migraciones, auditoría encadenada, colas durables, API de salud e incidentes, worker y scheduler en contenedores, y `npm run test:e1` del tramo 1. La puesta en marcha en sombra en el VPS es una decisión y un corte posteriores; este plan no la autoriza.

**Architecture:** Paquete independiente dentro del repo (lockfile propio). Una imagen Docker con tres puntos de entrada (`api`, `worker`, `scheduler`) más `migrate`, conectados al PostgreSQL 18.6 de E0 por la red `fusion-pg_default` con roles sin superusuario. SQL explícito con `pg`; la auditoría y los permisos se garantizan en la base.

**Tech Stack:** Node 24.21 (TypeScript nativo, sin build), TypeScript 7.0.2 (sólo `tsc --noEmit`), Fastify 5.12.4, pg 8.23.0, Zod 4.6.5, Pino 10.3.1, Vitest 5.0.0, @apidevtools/swagger-parser 13.0.0, Ajv 8.20.0 + ajv-formats, Docker Compose.

**Condición de inicio:** E0 fue aceptada por decisión de José y conserva esa aceptación. El maestro exige dependencias aceptadas antes de comenzar una entrega. Esta implementación sólo usa PostgreSQL efímero propio y no conecta con la instancia de E0.

> **Estado de implementación — 2026-09-15:** se completó el código del tramo 1 y se verificó con `npm --prefix plataforma run typecheck`, `npm --prefix plataforma test` (38 pruebas) y `E1_SKIP_UNIT=1 npm run test:e1`. El último ensayo crea una red, secretos, estado y PostgreSQL temporales, y destruye todo al terminar; también verifica que `/api/v2/health` pasa a `503` al detener el worker y vuelve a `200` al reiniciarlo. No se ejecutaron los pasos de VPS de Task 10, no se crearon roles ni tablas en E0, no se generaron secretos reales y E1 sigue `planificada` hasta las aprobaciones y cortes de sus tramos posteriores.

**Spec:** [docs/superpowers/specs/2026-09-15-e1-tramo1-fundacion-design.md](../specs/2026-09-15-e1-tramo1-fundacion-design.md) · [schema.sql](../specs/e1/schema.sql) · [test-e1.md](../specs/e1/test-e1.md) · [openapi/platform-v2.yaml](../../../openapi/platform-v2.yaml)

## Global Constraints

- Node `>=24.21.0`; los `.ts` se ejecutan directamente con `node`; prohibida la sintaxis no borrable (`enum`, `namespace`, parameter properties): `tsconfig` con `erasableSyntaxOnly`.
- Imports relativos siempre con extensión `.ts`; tipos con `import type`.
- Dependencias con versión exacta (`npm install --save-exact`); `plataforma/package-lock.json` versionado.
- PostgreSQL de pruebas y de E0: `postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af` (18.6).
- Imagen de servicios: `node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`, usuario `node`.
- Roles: `plataforma_migrador` (dueño) y `plataforma_app` (datos); ninguno superusuario. Base `plataforma`.
- API sólo publicada en `127.0.0.1:3201`. Ninguna ruta llama a MercadoLibre ni a Woo.
- Pool: `max` 5, `statement_timeout` 5000 ms, `connectionTimeoutMillis` 2000 ms. El migrador sin `statement_timeout`.
- Latidos cada 30 s; vivo si `visto_en` ≤ 120 s. Lease por defecto 60 s. `stop_grace_period` 15 s; apagado interno máx. 10 s.
- `wal_archive`: `ok` si `ok:true` y medido ≤ 900 s; `degraded` si `mas_viejo_s` > 180; `down` si > 300, medido > 900 s o ilegible.
- Estado de E0 en `/opt/fusionbikes/estado-pg/` (sólo `estado-pg.json` y `estado-pg-archivo.json`); nunca montar `/opt/fusionbikes/backups`. Montar carpetas, nunca archivos sueltos.
- Errores HTTP `{code, message, correlation_id}`; `X-Correlation-Id` en toda respuesta; nunca stack ni mensaje interno en 500.
- Logs JSON sin contraseñas, tokens, cookies ni emails.
- En producción no existe forma de sesión: `/api/v2/incidents` responde 401. Los tests inyectan el proveedor de sesión por código.
- La suite del legado (`npm test` en la raíz) no se corre en paralelo con `test:e1` ni con servidores de prueba (CLAUDE.md).

---

## Mapa de archivos

```
vitest.config.js                         (modificar) excluir plataforma/**
eslint.config.js                         (modificar) ignorar plataforma/**
package.json                             (modificar) script test:e1
scripts/plataforma/test-e1.sh            (crear)     orquesta test:e1 y evalúa escenarios del tramo
scripts/postgres/estado-archivo.sh       (modificar) escribe en /opt/fusionbikes/estado-pg
scripts/postgres/backup-diario.sh        (modificar) escribe estado en /opt/fusionbikes/estado-pg
lib/vigiaBackup.js                       (modificar) rutas por defecto nuevas
test/vigiaBackup.test.js                 (modificar) test de rutas por defecto
plataforma/
  package.json, package-lock.json, tsconfig.json, vitest.config.ts, .dockerignore
  migrations/0001_esquema_base.sql       copia literal de docs/superpowers/specs/e1/schema.sql
  migrations/0002_permisos.sql           permisos de plataforma_app
  deploy/alta-base.sql                   base y roles (superusuario, una vez)
  deploy/Dockerfile                      imagen única
  deploy/compose.yml                     manifiesto preparado para producción (red fusion-pg_default); no desplegar sin corte autorizado
  deploy/compose.test.yml                entorno aislado de test:e1
  src/db/pool.ts                         pool y transacciones
  src/db/migrar.ts                       runner de migraciones
  src/db/cli-migrar.ts                   punto de entrada del contenedor migrate
  src/audit/auditoria.ts                 registrar y verificar cadena
  src/colas/errores.ts                   clases de error de procesamiento
  src/colas/colas.ts                     encolar, reclamar, completar, fallar, soltar, liberar
  src/comun/config.ts                    configuración validada con Zod
  src/comun/logger.ts                    Pino con redacción
  src/comun/correlacion.ts               X-Correlation-Id
  src/comun/latido.ts                    latidos
  src/comun/apagado.ts                   SIGTERM
  src/auth/sesion.ts                     proveedor de sesión y capacidades
  src/api/estado-wal.ts                  evaluación de wal_archive
  src/api/salud.ts                       /health
  src/api/cursor.ts                      cursor de incidentes
  src/api/app.ts                         Fastify y rutas
  src/api/main.ts                        entrada del servicio api
  src/worker/worker.ts                   ciclo del worker
  src/worker/main.ts                     entrada del servicio worker
  src/scheduler/exclusion.ts             lock en conexión dedicada
  src/scheduler/scheduler.ts             ciclo del scheduler
  src/scheduler/main.ts                  entrada del servicio scheduler
  test/soporte/global-pg.ts              PostgreSQL temporal (globalSetup)
  test/soporte/base.ts                   una base migrada por archivo de test
  test/*.test.ts                         tests por módulo (nombres con IDs E1-…)
```

---

### Task 1: Paquete `plataforma/` y entorno de tests con PostgreSQL temporal

**Files:**
- Create: `plataforma/package.json`, `plataforma/tsconfig.json`, `plataforma/vitest.config.ts`, `plataforma/.dockerignore`
- Create: `plataforma/src/db/pool.ts`
- Create: `plataforma/test/soporte/global-pg.ts`, `plataforma/test/soporte/base.ts`, `plataforma/test/entorno.test.ts`
- Modify: `vitest.config.js` (raíz), `eslint.config.js` (raíz)

**Interfaces:**
- Produces: `crearPool(url: string, opciones?: { max?: number; statementTimeoutMs?: number }): pg.Pool`; `enTransaccion<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>`; tipo `Consultable = pg.Pool | pg.PoolClient | pg.Client`.
- Produces (tests): `inject('pgAdminUrl')`, `inject('pgHostPort')`; `crearBaseDePrueba(): Promise<BaseDePrueba>` con `{ nombre, urlAdmin, urlMigrador, urlApp, borrar(): Promise<void> }` (Task 2 le agrega la migración).

- [ ] **Step 1: Crear el paquete e instalar dependencias exactas**

```bash
mkdir -p /opt/fusionbikes/herramientas/plataforma && cd /opt/fusionbikes/herramientas/plataforma
cat > package.json <<'EOF'
{
  "name": "fusion-plataforma",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.21.0" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "migrar": "node src/db/cli-migrar.ts"
  }
}
EOF
npm install --save-exact fastify@5.12.4 pg@8.23.0 zod@4.6.5 pino@10.3.1
npm install --save-exact -D typescript@7.0.2 vitest@5.0.0 @types/node@24 @types/pg@8.23.1 @apidevtools/swagger-parser@13.0.0 ajv@8.20.0 ajv-formats
```

- [ ] **Step 2: tsconfig, vitest y .dockerignore**

`plataforma/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`plataforma/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/soporte/global-pg.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
  },
});
```

`plataforma/.dockerignore`:
```
node_modules
test
*.md
```

- [ ] **Step 3: Excluir `plataforma/` de la suite y el lint del legado**

En `vitest.config.js` (raíz) cambiar la línea `exclude`:
```js
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', 'plataforma/**'],
```
En `eslint.config.js` (raíz) cambiar la primera entrada:
```js
  { ignores: ['node_modules/**', 'data/**', 'public/**/vendor/**', 'plataforma/**'] },
```

- [ ] **Step 4: Pool y transacciones**

`plataforma/src/db/pool.ts`:
```ts
import pg from 'pg';

export type Consultable = pg.Pool | pg.PoolClient | pg.Client;

export function crearPool(url: string, opciones: { max?: number; statementTimeoutMs?: number } = {}): pg.Pool {
  const config: pg.PoolConfig = {
    connectionString: url,
    max: opciones.max ?? 5,
    connectionTimeoutMillis: 2000,
  };
  if (opciones.statementTimeoutMs !== undefined) config.statement_timeout = opciones.statementTimeoutMs;
  return new pg.Pool(config);
}

export async function enTransaccion<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    cliente.release();
  }
}
```

- [ ] **Step 5: PostgreSQL temporal para toda la corrida**

`plataforma/test/soporte/global-pg.ts`:
```ts
import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

const IMAGEN = 'postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af';
const NOMBRE = `plataforma-test-${process.pid}`;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgHostPort: string;
    pgContenedor: string;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  docker('run', '-d', '--rm', '--name', NOMBRE, '-e', 'POSTGRES_PASSWORD=admin', '-p', '127.0.0.1::5432', IMAGEN);
  for (let i = 0; i < 60; i++) {
    try { docker('exec', NOMBRE, 'pg_isready', '-U', 'postgres', '-q'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  await new Promise((r) => setTimeout(r, 1500));
  const puerto = docker('port', NOMBRE, '5432/tcp').split(':').pop() ?? '';
  const sql = [
    "CREATE ROLE plataforma_migrador LOGIN PASSWORD 'migrador' NOSUPERUSER NOCREATEDB NOCREATEROLE",
    "CREATE ROLE plataforma_app LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE",
  ];
  for (const s of sql) docker('exec', NOMBRE, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qc', s);
  project.provide('pgAdminUrl', `postgres://postgres:admin@127.0.0.1:${puerto}/postgres`);
  project.provide('pgHostPort', `127.0.0.1:${puerto}`);
  project.provide('pgContenedor', NOMBRE);
  return () => { try { docker('rm', '-f', NOMBRE); } catch { /* ya no existe */ } };
}
```

`plataforma/test/soporte/base.ts`:
```ts
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

export interface BaseDePrueba {
  nombre: string;
  urlAdmin: string;
  urlMigrador: string;
  urlApp: string;
  borrar(): Promise<void>;
}

export async function crearBaseVacia(): Promise<BaseDePrueba> {
  const hostPort = inject('pgHostPort');
  const nombre = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${nombre} OWNER plataforma_migrador`);
  await admin.query(`REVOKE ALL ON DATABASE ${nombre} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${nombre} TO plataforma_app`);
  await admin.end();
  return {
    nombre,
    urlAdmin: `postgres://postgres:admin@${hostPort}/${nombre}`,
    urlMigrador: `postgres://plataforma_migrador:migrador@${hostPort}/${nombre}`,
    urlApp: `postgres://plataforma_app:app@${hostPort}/${nombre}`,
    async borrar() {
      const c = new pg.Client({ connectionString: inject('pgAdminUrl') });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
      await c.end();
    },
  };
}
```

- [ ] **Step 6: Test del entorno**

`plataforma/test/entorno.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearPool, enTransaccion } from '../src/db/pool.ts';
import { crearBaseVacia, type BaseDePrueba } from './soporte/base.ts';

describe('entorno de pruebas', () => {
  let base: BaseDePrueba;
  beforeAll(async () => { base = await crearBaseVacia(); });
  afterAll(async () => { await base.borrar(); });

  it('conecta como migrador a PostgreSQL 18', async () => {
    const pool = crearPool(base.urlMigrador);
    const r = await pool.query<{ v: string }>("select current_setting('server_version_num') as v");
    expect(Number(r.rows[0]?.v)).toBeGreaterThanOrEqual(180000);
    await pool.end();
  });

  it('enTransaccion hace rollback ante error', async () => {
    const pool = crearPool(base.urlMigrador);
    await pool.query('create table tx_prueba(x int)');
    await expect(enTransaccion(pool, async (tx) => { await tx.query('insert into tx_prueba values (1)'); throw new Error('falla'); })).rejects.toThrow('falla');
    const r = await pool.query<{ n: string }>('select count(*) as n from tx_prueba');
    expect(r.rows[0]?.n).toBe('0');
    await pool.end();
  });
});
```

- [ ] **Step 7: Correr tipos y tests; verificar que el legado no los toma**

Run: `cd plataforma && npm run typecheck && npm test`
Expected: typecheck sin errores; `entorno.test.ts` 2 passed.
Run (raíz): `npx vitest list 2>/dev/null | grep -c plataforma || true`
Expected: `0`.

- [ ] **Step 8: Commit**

```bash
git add plataforma/package.json plataforma/package-lock.json plataforma/tsconfig.json plataforma/vitest.config.ts plataforma/.dockerignore plataforma/src/db/pool.ts plataforma/test vitest.config.js eslint.config.js
git commit -m "feat(plataforma): paquete TypeScript y entorno de tests con PostgreSQL 18 temporal"
```

---

### Task 2: Runner de migraciones, migraciones 0001/0002 y alta de base (E1-SCH-01, E1-SCH-02)

**Files:**
- Create: `plataforma/src/db/migrar.ts`, `plataforma/src/db/cli-migrar.ts`
- Create: `plataforma/migrations/0001_esquema_base.sql` (copia literal de `docs/superpowers/specs/e1/schema.sql`), `plataforma/migrations/0002_permisos.sql`
- Create: `plataforma/deploy/alta-base.sql`
- Modify: `plataforma/test/soporte/base.ts` (agregar `crearBaseDePrueba`)
- Test: `plataforma/test/migraciones.test.ts`

**Interfaces:**
- Consumes: `crearPool`, `crearBaseVacia` (Task 1).
- Produces: `migrar(url: string, directorio: string): Promise<string[]>` (nombres aplicados); `class ErrorMigracion extends Error`; `crearBaseDePrueba(): Promise<BaseDePrueba>` (base vacía + migraciones aplicadas); constante `DIR_MIGRACIONES` en `test/soporte/base.ts`.

- [ ] **Step 1: Copiar el esquema y escribir los permisos**

```bash
cd /opt/fusionbikes/herramientas && mkdir -p plataforma/migrations plataforma/deploy
cp docs/superpowers/specs/e1/schema.sql plataforma/migrations/0001_esquema_base.sql
```

`plataforma/migrations/0002_permisos.sql`:
```sql
-- Permisos de plataforma_app (diseño tramo 1 §3). La auditoría sólo admite SELECT e INSERT.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA core, security, audit, integrations TO plataforma_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core, security, integrations TO plataforma_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO plataforma_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core, security, audit, integrations TO plataforma_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA audit TO plataforma_app;
REVOKE ALL ON core.schema_migrations FROM plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA core, security, integrations GRANT SELECT, INSERT, UPDATE ON TABLES TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA core, security, audit, integrations GRANT USAGE ON SEQUENCES TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA audit GRANT EXECUTE ON FUNCTIONS TO plataforma_app;
```

`plataforma/deploy/alta-base.sql` (se ejecuta con `psql -U postgres -v pw_migrador="$(cat …)" -v pw_app="$(cat …)"`):
```sql
\set ON_ERROR_STOP on
SELECT format('CREATE ROLE plataforma_migrador LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw_migrador')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plataforma_migrador') \gexec
SELECT format('CREATE ROLE plataforma_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw_app')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plataforma_app') \gexec
SELECT format('ALTER ROLE plataforma_migrador PASSWORD %L', :'pw_migrador') \gexec
SELECT format('ALTER ROLE plataforma_app PASSWORD %L', :'pw_app') \gexec
SELECT 'CREATE DATABASE plataforma OWNER plataforma_migrador'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'plataforma') \gexec
REVOKE ALL ON DATABASE plataforma FROM PUBLIC;
GRANT CONNECT ON DATABASE plataforma TO plataforma_app;
```

- [ ] **Step 2: Escribir los tests (fallan: no existe `migrar.ts`)**

Agregar al final de `plataforma/test/soporte/base.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { migrar } from '../../src/db/migrar.ts';

export const DIR_MIGRACIONES = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function crearBaseDePrueba(): Promise<BaseDePrueba> {
  const base = await crearBaseVacia();
  await migrar(base.urlMigrador, DIR_MIGRACIONES);
  return base;
}
```

`plataforma/test/migraciones.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, inject } from 'vitest';
import { ErrorMigracion, migrar } from '../src/db/migrar.ts';
import { crearBaseVacia, DIR_MIGRACIONES, type BaseDePrueba } from './soporte/base.ts';

const bases: BaseDePrueba[] = [];
async function nueva(): Promise<BaseDePrueba> { const b = await crearBaseVacia(); bases.push(b); return b; }
afterEach(async () => { while (bases.length) await bases.pop()?.borrar(); });

function esquemaDe(nombre: string): string {
  const salida = execFileSync('docker', ['exec', inject('pgContenedor'), 'pg_dump', '-U', 'postgres', '--schema-only', '--no-owner', '--no-privileges', nombre], { encoding: 'utf8' });
  return salida.split('\n').filter((l) => !l.startsWith('--') && !l.startsWith('\\restrict') && !l.startsWith('\\unrestrict')).join('\n');
}

async function valor<T>(url: string, sql: string): Promise<T> {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { return (await c.query(sql)).rows[0] as T; } finally { await c.end(); }
}

describe('migraciones', () => {
  it('E1-SCH-02 migrar dos bases vacías da el mismo esquema', async () => {
    const a = await nueva(); const b = await nueva();
    expect(await migrar(a.urlMigrador, DIR_MIGRACIONES)).toEqual(['0001_esquema_base.sql', '0002_permisos.sql']);
    await migrar(b.urlMigrador, DIR_MIGRACIONES);
    expect(esquemaDe(a.nombre)).toBe(esquemaDe(b.nombre));
  });

  it('E1-SCH-02 reaplicar no cambia nada', async () => {
    const a = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const antes = esquemaDe(a.nombre);
    expect(await migrar(a.urlMigrador, DIR_MIGRACIONES)).toEqual([]);
    expect(esquemaDe(a.nombre)).toBe(antes);
  });

  it('E1-SCH-02 una migración aplicada alterada frena el arranque', async () => {
    const a = await nueva();
    const dir = mkdtempSync(join(tmpdir(), 'migr-'));
    cpSync(DIR_MIGRACIONES, dir, { recursive: true });
    await migrar(a.urlMigrador, dir);
    writeFileSync(join(dir, '0002_permisos.sql'), readFileSync(join(dir, '0002_permisos.sql'), 'utf8') + '\n-- cambio\n');
    await expect(migrar(a.urlMigrador, dir)).rejects.toBeInstanceOf(ErrorMigracion);
    rmSync(dir, { recursive: true, force: true });
  });

  it('E1-SCH-02 un hueco en la numeración frena el arranque', async () => {
    const a = await nueva();
    const dir = mkdtempSync(join(tmpdir(), 'migr-'));
    cpSync(DIR_MIGRACIONES, dir, { recursive: true });
    writeFileSync(join(dir, '0004_salto.sql'), 'select 1;');
    await expect(migrar(a.urlMigrador, dir)).rejects.toThrow(/numeración/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('E1-SCH-02 dos migradores concurrentes aplican una sola vez', async () => {
    const a = await nueva();
    const [r1, r2] = await Promise.all([migrar(a.urlMigrador, DIR_MIGRACIONES), migrar(a.urlMigrador, DIR_MIGRACIONES)]);
    expect([...r1, ...r2].sort()).toEqual(['0001_esquema_base.sql', '0002_permisos.sql']);
  });

  it('el esquema migrado coincide con la referencia schema.sql', async () => {
    const a = await nueva(); const ref = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const c = new pg.Client({ connectionString: ref.urlMigrador }); await c.connect();
    await c.query(readFileSync(new URL('../../docs/superpowers/specs/e1/schema.sql', import.meta.url), 'utf8'));
    await c.end();
    const sinRegistro = (s: string) => s.split('\n\n').filter((b) => !b.includes('schema_migrations')).join('\n\n');
    expect(sinRegistro(esquemaDe(a.nombre))).toBe(sinRegistro(esquemaDe(ref.nombre)));
  });

  it('E1-SCH-01 restricciones del esquema rechazan datos inválidos', async () => {
    const a = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const c = new pg.Client({ connectionString: a.urlApp }); await c.connect();
    const empresa = (await c.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    const cuenta = (await c.query<{ id: string }>("insert into core.channel_accounts(company_id, channel, external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
    const invalidos: Array<[string, string, unknown[]]> = [
      ['topic fuera de lista', "insert into integrations.inbox_messages(channel_account_id,topic,resource_id,remote_version,source,correlation_id) values ($1,'ml.inventado','r','v','sweep',uuidv7())", [cuenta]],
      ['claimed sin lease', "insert into integrations.inbox_messages(channel_account_id,topic,resource_id,remote_version,source,correlation_id,status) values ($1,'ml.orders','r','v','sweep',uuidv7(),'claimed')", [cuenta]],
      ['parked sin motivo', "insert into integrations.inbox_messages(channel_account_id,topic,resource_id,remote_version,source,correlation_id,status) values ($1,'ml.orders','r2','v','sweep',uuidv7(),'parked')", [cuenta]],
      ['email sin índice ciego', "insert into security.users(company_id,username,email_ciphertext) values ($1,'ana','\\x01')", [empresa]],
    ];
    await c.query("insert into core.channel_accounts(company_id, channel, external_account, is_primary) values ($1,'woocommerce','https://a',true)", [empresa]);
    invalidos.push(['segundo Woo primario', "insert into core.channel_accounts(company_id, channel, external_account, is_primary) values ($1,'woocommerce','https://b',true)", [empresa]]);
    for (const [nombre, sql, params] of invalidos) {
      await expect(c.query(sql, params), nombre).rejects.toThrow();
    }
    await c.end();
  });

  it('plataforma_app no puede crear objetos ni leer el registro de migraciones', async () => {
    const a = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const c = new pg.Client({ connectionString: a.urlApp }); await c.connect();
    await expect(c.query('create table core.intrusa(x int)')).rejects.toThrow(/permission denied/);
    await expect(c.query('create table public.intrusa(x int)')).rejects.toThrow(/permission denied/);
    await expect(c.query('select * from core.schema_migrations')).rejects.toThrow(/permission denied/);
    await c.end();
    expect(await valor<{ p: string }>(a.urlAdmin, "select relpersistence as p from pg_class where oid='core.service_heartbeats'::regclass")).toEqual({ p: 'u' });
  });
});
```

- [ ] **Step 3: Verificar que fallan**

Run: `cd plataforma && npx vitest run test/migraciones.test.ts`
Expected: FAIL — `Cannot find module '../src/db/migrar.ts'`.

- [ ] **Step 4: Implementar el runner**

`plataforma/src/db/migrar.ts`:
```ts
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export class ErrorMigracion extends Error {
  override name = 'ErrorMigracion';
}

const PATRON = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK = "hashtextextended('plataforma.migraciones', 0)";

interface Archivo { nombre: string; numero: number; sql: string; sha256: string }

function leerArchivos(directorio: string): Archivo[] {
  const archivos = readdirSync(directorio).filter((n) => n.endsWith('.sql')).sort().map((nombre) => {
    const m = PATRON.exec(nombre);
    if (!m) throw new ErrorMigracion(`nombre de migración inválido: ${nombre}`);
    const sql = readFileSync(join(directorio, nombre), 'utf8');
    return { nombre, numero: Number(m[1]), sql, sha256: createHash('sha256').update(sql).digest('hex') };
  });
  archivos.forEach((a, i) => {
    if (a.numero !== i + 1) throw new ErrorMigracion(`hueco o repetición en la numeración de migraciones: se esperaba ${String(i + 1).padStart(4, '0')} y está ${a.nombre}`);
  });
  return archivos;
}

export async function migrar(url: string, directorio: string): Promise<string[]> {
  const archivos = leerArchivos(directorio);
  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    await cliente.query(`SELECT pg_advisory_lock(${LOCK})`);
    await cliente.query('CREATE SCHEMA IF NOT EXISTS core');
    await cliente.query(`CREATE TABLE IF NOT EXISTS core.schema_migrations (
      nombre text PRIMARY KEY, sha256 text NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now())`);
    const aplicadas = new Map((await cliente.query<{ nombre: string; sha256: string }>('SELECT nombre, sha256 FROM core.schema_migrations')).rows.map((r) => [r.nombre, r.sha256]));
    for (const [nombre] of aplicadas) {
      if (!archivos.some((a) => a.nombre === nombre)) throw new ErrorMigracion(`la migración aplicada ${nombre} ya no existe en el directorio`);
    }
    const nuevas: string[] = [];
    for (const archivo of archivos) {
      const sha = aplicadas.get(archivo.nombre);
      if (sha !== undefined) {
        if (sha !== archivo.sha256) throw new ErrorMigracion(`la migración ${archivo.nombre} cambió después de aplicarse`);
        continue;
      }
      await cliente.query('BEGIN');
      try {
        await cliente.query(archivo.sql);
        await cliente.query('INSERT INTO core.schema_migrations (nombre, sha256) VALUES ($1, $2)', [archivo.nombre, archivo.sha256]);
        await cliente.query('COMMIT');
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new ErrorMigracion(`falló ${archivo.nombre}: ${(error as Error).message}`);
      }
      nuevas.push(archivo.nombre);
    }
    return nuevas;
  } finally {
    await cliente.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => undefined);
    await cliente.end();
  }
}
```

`plataforma/src/db/cli-migrar.ts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrar } from './migrar.ts';

const clave = readFileSync(process.env.PG_PASSWORD_FILE ?? '', 'utf8').trim();
const url = `postgres://${encodeURIComponent(process.env.PG_USER ?? '')}:${encodeURIComponent(clave)}@${process.env.PG_HOST ?? 'pg'}:${process.env.PG_PORT ?? '5432'}/${process.env.PG_DATABASE ?? 'plataforma'}`;
const dir = fileURLToPath(new URL('../../migrations', import.meta.url));
try {
  const aplicadas = await migrar(url, dir);
  console.log(JSON.stringify({ servicio: 'migrate', aplicadas }));
} catch (error) {
  console.error(JSON.stringify({ servicio: 'migrate', error: (error as Error).message }));
  process.exit(1);
}
```

Nota: el test de concurrencia espera que el segundo migrador vea las migraciones ya registradas al obtener el lock; como la tabla se crea con `IF NOT EXISTS` bajo el lock y la lectura ocurre después, cada nombre se aplica una sola vez.

- [ ] **Step 5: Correr los tests**

Run: `cd plataforma && npm run typecheck && npx vitest run test/migraciones.test.ts`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add plataforma/src/db plataforma/migrations plataforma/deploy/alta-base.sql plataforma/test
git commit -m "feat(plataforma): migraciones sólo hacia adelante con checksum y lock (E1-SCH-01/02)"
```

---

### Task 3: Auditoría encadenada (E1-AUD-01, E1-AUD-02, E1-AUD-03)

**Files:**
- Create: `plataforma/src/audit/auditoria.ts`
- Test: `plataforma/test/auditoria.test.ts`

**Interfaces:**
- Consumes: `Consultable`, `crearPool` (Task 1); `crearBaseDePrueba` (Task 2).
- Produces:
  ```ts
  export interface EventoAuditoria {
    companyId: string; actorType: 'user' | 'system' | 'channel'; actorId: string; action: string;
    aggregateType: string; aggregateId: string; correlationId: string; reason?: string; payload?: Record<string, unknown>;
  }
  export function registrarEvento(db: Consultable, evento: EventoAuditoria): Promise<{ id: string; chainSeq: string }>;
  export function verificarCadena(db: Consultable, desde?: number): Promise<number | null>;
  ```

- [ ] **Step 1: Escribir los tests**

`plataforma/test/auditoria.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registrarEvento, verificarCadena, type EventoAuditoria } from '../src/audit/auditoria.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('auditoría', () => {
  let base: BaseDePrueba; let app: pg.Pool; let empresa: string;
  const evento = (i: number | string, actor = 'test'): EventoAuditoria => ({
    companyId: empresa, actorType: 'system', actorId: actor, action: 'prueba.evento',
    aggregateType: 'prueba', aggregateId: String(i), correlationId: randomUUID(),
  });

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp);
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
  });
  afterAll(async () => { await app.end(); await base.borrar(); });

  it('E1-AUD-01 1.000 eventos forman una cadena íntegra y continua', async () => {
    for (let i = 0; i < 1000; i++) await registrarEvento(app, evento(i));
    expect(await verificarCadena(app)).toBeNull();
    const r = await app.query<{ n: string; max: string }>('select count(*) as n, max(chain_seq) as max from audit.audit_events');
    expect(r.rows[0]).toEqual({ n: '1000', max: '1000' });
  });

  it('E1-AUD-02 plataforma_app no puede modificar, borrar ni vaciar la auditoría', async () => {
    await expect(app.query("update audit.audit_events set reason='x'")).rejects.toThrow(/permission denied/);
    await expect(app.query('delete from audit.audit_events')).rejects.toThrow(/permission denied/);
    await expect(app.query('truncate audit.audit_events')).rejects.toThrow(/permission denied/);
    await expect(app.query('alter table audit.audit_events disable trigger audit_events_no_update')).rejects.toThrow(/must be owner/);
    await expect(app.query('set session_replication_role = replica')).rejects.toThrow(/permission denied/);
  });

  it('E1-AUD-02 el trigger reemplaza hash y chain_seq enviados por la app', async () => {
    const r = await app.query<{ ok: boolean }>(`insert into audit.audit_events(company_id,actor_type,actor_id,action,aggregate_type,aggregate_id,correlation_id,prev_hash,hash,chain_seq)
      values ($1,'user','u','prueba.falsa','x','1',uuidv7(),'\\x00','\\x00',999999) returning (length(hash)=32 and chain_seq < 999999) as ok`, [empresa]);
    expect(r.rows[0]?.ok).toBe(true);
    expect(await verificarCadena(app)).toBeNull();
  });

  it('E1-AUD-02 una alteración directa como superusuario se detecta en la posición exacta', async () => {
    const admin = new pg.Client({ connectionString: base.urlAdmin }); await admin.connect();
    await admin.query('alter table audit.audit_events disable trigger audit_events_no_update');
    await admin.query("update audit.audit_events set reason='manipulado' where chain_seq = 500");
    expect(await verificarCadena(app)).toBe(500);
    await admin.query('update audit.audit_events set reason = null where chain_seq = 500');
    expect(await verificarCadena(app)).toBeNull();
    await admin.query('delete from audit.audit_events where chain_seq = 700');
    expect(await verificarCadena(app)).toBe(700);
    expect(await verificarCadena(app, 701)).toBeNull();
    await admin.end();
  });
});

describe('auditoría concurrente', () => {
  let base: BaseDePrueba; let empresa: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba();
    const c = new pg.Client({ connectionString: base.urlApp }); await c.connect();
    empresa = (await c.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    await c.end();
  });
  afterAll(async () => { await base.borrar(); });

  it('E1-AUD-03 4 conexiones × 500 eventos: cadena íntegra y hashes únicos', async () => {
    const pools = Array.from({ length: 4 }, () => crearPool(base.urlApp, { max: 1 }));
    await Promise.all(pools.map(async (p, w) => {
      for (let i = 0; i < 500; i++) {
        await registrarEvento(p, { companyId: empresa, actorType: 'system', actorId: `w${w}`, action: 'prueba.concurrente', aggregateType: 'x', aggregateId: String(i), correlationId: randomUUID() });
      }
    }));
    const r = await pools[0]!.query<{ n: string; u: string }>('select count(*) as n, count(distinct hash) as u from audit.audit_events');
    expect(r.rows[0]).toEqual({ n: '2000', u: '2000' });
    expect(await verificarCadena(pools[0]!)).toBeNull();
    await Promise.all(pools.map((p) => p.end()));
  });

  it('E1-AUD-03 carrera forzada: un id menor que se encadena después no rompe la cadena', async () => {
    const admin = new pg.Client({ connectionString: base.urlAdmin }); await admin.connect();
    await admin.query(`create function audit.demora_test() returns trigger language plpgsql as $$
      begin if new.actor_id = 'lento' then perform pg_sleep(1.5); end if; return new; end $$`);
    await admin.query('create trigger aaa_demora before insert on audit.audit_events for each row execute function audit.demora_test()');
    const p = crearPool(base.urlApp, { max: 2 });
    const base0 = { companyId: empresa, actorType: 'system' as const, action: 'prueba.carrera', aggregateType: 'x', aggregateId: '1' };
    const lento = registrarEvento(p, { ...base0, actorId: 'lento', correlationId: randomUUID() });
    await new Promise((r) => setTimeout(r, 400));
    const rapido = await registrarEvento(p, { ...base0, actorId: 'rapido', correlationId: randomUUID() });
    const lentoR = await lento;
    expect(BigInt(lentoR.id)).toBeLessThan(BigInt(rapido.id));
    expect(BigInt(lentoR.chainSeq)).toBeGreaterThan(BigInt(rapido.chainSeq));
    expect(await verificarCadena(p)).toBeNull();
    await admin.query('drop trigger aaa_demora on audit.audit_events');
    await admin.end(); await p.end();
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd plataforma && npx vitest run test/auditoria.test.ts`
Expected: FAIL — `Cannot find module '../src/audit/auditoria.ts'`.

- [ ] **Step 3: Implementar**

`plataforma/src/audit/auditoria.ts`:
```ts
import type { Consultable } from '../db/pool.ts';

export interface EventoAuditoria {
  companyId: string;
  actorType: 'user' | 'system' | 'channel';
  actorId: string;
  action: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

// Escribe en la conexión o transacción recibida: el llamador decide la atomicidad con su cambio.
// hash, prev_hash y chain_seq los asigna el trigger de la base (schema.sql).
export async function registrarEvento(db: Consultable, e: EventoAuditoria): Promise<{ id: string; chainSeq: string }> {
  const r = await db.query<{ id: string; chain_seq: string }>(
    `INSERT INTO audit.audit_events
       (company_id, actor_type, actor_id, action, aggregate_type, aggregate_id, correlation_id, reason, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, chain_seq`,
    [e.companyId, e.actorType, e.actorId, e.action, e.aggregateType, e.aggregateId, e.correlationId, e.reason ?? null, JSON.stringify(e.payload ?? {})],
  );
  const fila = r.rows[0];
  if (!fila) throw new Error('registrarEvento: el INSERT no devolvió fila');
  return { id: fila.id, chainSeq: fila.chain_seq };
}

// Devuelve el primer chain_seq donde la cadena se rompe, o null si está íntegra.
export async function verificarCadena(db: Consultable, desde?: number): Promise<number | null> {
  const r = await db.query<{ roto: string | null }>('SELECT audit.verify_chain($1) AS roto', [desde ?? null]);
  const roto = r.rows[0]?.roto ?? null;
  return roto === null ? null : Number(roto);
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd plataforma && npm run typecheck && npx vitest run test/auditoria.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add plataforma/src/audit plataforma/test/auditoria.test.ts
git commit -m "feat(plataforma): auditoría encadenada con verificación y carrera forzada (E1-AUD-01..03)"
```

---

### Task 4: Colas durables (E1-Q-01..06, E1-DUP-01)

**Files:**
- Create: `plataforma/src/colas/errores.ts`, `plataforma/src/colas/colas.ts`
- Test: `plataforma/test/colas.test.ts`

**Interfaces:**
- Consumes: `Consultable`, `enTransaccion`, `crearPool` (Task 1); `registrarEvento` (Task 3); `crearBaseDePrueba` (Task 2).
- Produces:
  ```ts
  // errores.ts
  export class ErrorTransitorio extends Error {}
  export class ErrorIncierto extends Error {}
  export class ErrorLeaseVencido extends Error {}
  // colas.ts
  export type Cola = 'inbox' | 'outbox';
  export interface MensajeEntrada { channelAccountId: string; topic: string; resourceId: string; remoteVersion: string; source: 'webhook_copy' | 'sweep'; correlationId: string; maxAttempts?: number }
  export interface Reclamo { cola: Cola; id: string; token: string; tipo: string; attempts: number; maxAttempts: number; correlationId: string }
  export function encolarInbox(db: Consultable, m: MensajeEntrada): Promise<{ id: string | null; creado: boolean }>;
  export function reclamar(pool: pg.Pool, cola: Cola, tipos: string[], n: number, leaseSegundos?: number): Promise<Reclamo[]>;
  export function completar(pool: pg.Pool, r: Reclamo): Promise<void>;          // ErrorLeaseVencido
  export function fallar(pool: pg.Pool, r: Reclamo, error: unknown): Promise<'retryable' | 'uncertain' | 'dead_lettered'>;
  export function soltarPorApagado(pool: pg.Pool, r: Reclamo): Promise<void>;
  export function liberarVencidos(pool: pg.Pool, cola: Cola): Promise<{ pendientes: number; muertos: number }>;
  export function backoffSegundos(intento: number, azar?: () => number): number;
  ```

- [ ] **Step 1: Escribir los tests**

`plataforma/test/colas.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verificarCadena } from '../src/audit/auditoria.ts';
import { backoffSegundos, completar, encolarInbox, fallar, liberarVencidos, reclamar, soltarPorApagado } from '../src/colas/colas.ts';
import { ErrorIncierto, ErrorLeaseVencido, ErrorTransitorio } from '../src/colas/errores.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('colas', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let cuenta: string;
  const msg = (resourceId: string, remoteVersion = 'v1', maxAttempts?: number) => ({
    channelAccountId: cuenta, topic: 'ml.orders', resourceId, remoteVersion, source: 'sweep' as const, correlationId: randomUUID(),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
  const estado = async (id: string) => (await admin.query<{ status: string; attempts: number; lease_token: string | null }>('select status, attempts, lease_token from integrations.inbox_messages where id=$1', [id])).rows[0]!;

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp, { max: 6 });
    admin = crearPool(base.urlAdmin, { max: 2 });
    const empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    cuenta = (await app.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { await admin.query('delete from integrations.dead_letters; delete from integrations.inbox_messages'); });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('E1-DUP-01 la misma señal 5 veces crea un solo mensaje por versión', async () => {
    const creados = [];
    for (let i = 0; i < 5; i++) creados.push(await encolarInbox(app, msg('r1', 'v1')));
    expect(creados.filter((c) => c.creado)).toHaveLength(1);
    expect((await encolarInbox(app, msg('r1', 'v2'))).creado).toBe(true);
    const r = await app.query<{ n: string }>("select count(*) as n from integrations.inbox_messages where resource_id='r1'");
    expect(r.rows[0]?.n).toBe('2');
  });

  it('E1-Q-01 reclamar toma el mensaje con lease y cuenta el intento', async () => {
    const { id } = await encolarInbox(app, msg('q1'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 10);
    expect(r?.id).toBe(id);
    expect(await estado(id!)).toMatchObject({ status: 'claimed', attempts: 1 });
  });

  it('E1-Q-01 reclamar ignora tópicos no pedidos', async () => {
    await encolarInbox(app, msg('q1b'));
    expect(await reclamar(app, 'inbox', ['woo.orders'], 10)).toEqual([]);
  });

  it('E1-Q-02 completar con lease vigente; con lease vencido no escribe', async () => {
    await encolarInbox(app, msg('q2a')); await encolarInbox(app, msg('q2b'));
    const [a, b] = await reclamar(app, 'inbox', ['ml.orders'], 2);
    await completar(app, a!);
    expect((await estado(a!.id)).status).toBe('succeeded');
    await admin.query("update integrations.inbox_messages set lease_until = now() - interval '1 second' where id=$1", [b!.id]);
    await expect(completar(app, b!)).rejects.toBeInstanceOf(ErrorLeaseVencido);
    expect((await estado(b!.id)).status).toBe('claimed');
  });

  it('E1-Q-03 un resultado incierto queda uncertain, auditado y visible como incidente', async () => {
    await encolarInbox(app, msg('q3'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new ErrorIncierto('respuesta cortada'))).toBe('uncertain');
    expect((await estado(r!.id)).status).toBe('uncertain');
    expect(await reclamar(app, 'inbox', ['ml.orders'], 10)).toEqual([]);
    const inc = await app.query("select 1 from integrations.incidents where source_type='inbox' and status='uncertain'");
    expect(inc.rowCount).toBe(1);
    const aud = await app.query("select 1 from audit.audit_events where action='cola.uncertain' and aggregate_id=$1", [r!.id]);
    expect(aud.rowCount).toBe(1);
    expect(await verificarCadena(app)).toBeNull();
  });

  it('E1-Q-04 transitorio reintenta con backoff y al agotar intentos va a DLQ', async () => {
    await encolarInbox(app, msg('q4', 'v1', 2));
    let [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new ErrorTransitorio('503'))).toBe('retryable');
    await admin.query('update integrations.inbox_messages set available_at = now() where id=$1', [r!.id]);
    [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new ErrorTransitorio('503'))).toBe('dead_lettered');
    const dl = await app.query("select reason_code from integrations.dead_letters where source_type='inbox' and source_id=$1", [r!.id]);
    expect(dl.rows).toEqual([{ reason_code: 'intentos_agotados' }]);
  });

  it('E1-Q-04 un error terminal va directo a DLQ', async () => {
    await encolarInbox(app, msg('q4b'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new Error('403 prohibido'))).toBe('dead_lettered');
  });

  it('E1-Q-05 dos workers sobre 1.000 mensajes: cada uno procesado exactamente una vez', async () => {
    for (let i = 0; i < 1000; i++) await encolarInbox(app, msg(`q5-${i}`));
    const vistos: string[] = [];
    const trabajar = async () => {
      for (;;) {
        const lote = await reclamar(app, 'inbox', ['ml.orders'], 25);
        if (!lote.length) return;
        for (const r of lote) { vistos.push(r.id); await completar(app, r); }
      }
    };
    await Promise.all([trabajar(), trabajar()]);
    expect(vistos).toHaveLength(1000);
    expect(new Set(vistos).size).toBe(1000);
  });

  it('E1-Q-06 un lease vencido vuelve a pending y se procesa una vez', async () => {
    await encolarInbox(app, msg('q6'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    await admin.query("update integrations.inbox_messages set lease_until = now() - interval '1 second' where id=$1", [r!.id]);
    expect(await liberarVencidos(app, 'inbox')).toEqual({ pendientes: 1, muertos: 0 });
    const [otra] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(otra?.id).toBe(r!.id);
    expect(otra?.attempts).toBe(2);
    await completar(app, otra!);
    await expect(completar(app, r!)).rejects.toBeInstanceOf(ErrorLeaseVencido);
  });

  it('E1-Q-06 soltar por apagado devuelve el intento', async () => {
    await encolarInbox(app, msg('q6b'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    await soltarPorApagado(app, r!);
    expect(await estado(r!.id)).toMatchObject({ status: 'pending', attempts: 0, lease_token: null });
  });

  it('backoff exponencial con tope y jitter acotado', () => {
    expect(backoffSegundos(1, () => 0.5)).toBe(10);
    expect(backoffSegundos(3, () => 0.5)).toBe(40);
    expect(backoffSegundos(20, () => 0.5)).toBe(900);
    expect(backoffSegundos(3, () => 0)).toBe(32);
    expect(backoffSegundos(3, () => 1)).toBe(48);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd plataforma && npx vitest run test/colas.test.ts`
Expected: FAIL — `Cannot find module '../src/colas/colas.ts'`.

- [ ] **Step 3: Implementar**

`plataforma/src/colas/errores.ts`:
```ts
// El procesador lanza ErrorTransitorio (408/429/5xx, red) o ErrorIncierto (respuesta perdida tras un
// posible efecto). Cualquier otro error es terminal.
export class ErrorTransitorio extends Error { override name = 'ErrorTransitorio'; }
export class ErrorIncierto extends Error { override name = 'ErrorIncierto'; }
export class ErrorLeaseVencido extends Error { override name = 'ErrorLeaseVencido'; }
```

`plataforma/src/colas/colas.ts`:
```ts
import type pg from 'pg';
import { registrarEvento } from '../audit/auditoria.ts';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { ErrorIncierto, ErrorLeaseVencido, ErrorTransitorio } from './errores.ts';

export type Cola = 'inbox' | 'outbox';

const TABLA: Record<Cola, { tabla: string; tipo: string }> = {
  inbox: { tabla: 'integrations.inbox_messages', tipo: 'topic' },
  outbox: { tabla: 'integrations.outbox_commands', tipo: 'command_type' },
};

export interface MensajeEntrada {
  channelAccountId: string; topic: string; resourceId: string; remoteVersion: string;
  source: 'webhook_copy' | 'sweep'; correlationId: string; maxAttempts?: number;
}

export interface Reclamo {
  cola: Cola; id: string; token: string; tipo: string; attempts: number; maxAttempts: number; correlationId: string;
}

export async function encolarInbox(db: Consultable, m: MensajeEntrada): Promise<{ id: string | null; creado: boolean }> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO integrations.inbox_messages
       (channel_account_id, topic, resource_id, remote_version, source, correlation_id, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel_account_id, topic, resource_id, remote_version) DO NOTHING
     RETURNING id`,
    [m.channelAccountId, m.topic, m.resourceId, m.remoteVersion, m.source, m.correlationId, m.maxAttempts ?? 8],
  );
  const id = r.rows[0]?.id ?? null;
  return { id, creado: id !== null };
}

export async function reclamar(pool: pg.Pool, cola: Cola, tipos: string[], n: number, leaseSegundos = 60): Promise<Reclamo[]> {
  if (!tipos.length) return [];
  const { tabla, tipo } = TABLA[cola];
  const r = await pool.query<{ id: string; lease_token: string; tipo: string; attempts: number; max_attempts: number; correlation_id: string }>(
    `WITH c AS (
       SELECT id FROM ${tabla}
        WHERE status IN ('pending', 'retryable') AND available_at <= now() AND ${tipo} = ANY($1)
        ORDER BY available_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE ${tabla} m
        SET status = 'claimed', lease_token = gen_random_uuid(),
            lease_until = now() + make_interval(secs => $3), attempts = m.attempts + 1
       FROM c WHERE m.id = c.id
     RETURNING m.id, m.lease_token, m.${tipo} AS tipo, m.attempts, m.max_attempts, m.correlation_id`,
    [tipos, n, leaseSegundos],
  );
  return r.rows.map((f) => ({ cola, id: f.id, token: f.lease_token, tipo: f.tipo, attempts: f.attempts, maxAttempts: f.max_attempts, correlationId: f.correlation_id }));
}

// Filtro de lease vigente: sólo quien tiene el token y dentro del plazo puede transicionar.
const VIGENTE = `id = $1 AND status = 'claimed' AND lease_token = $2 AND lease_until > now()`;

export async function completar(pool: pg.Pool, r: Reclamo): Promise<void> {
  const { tabla } = TABLA[r.cola];
  const u = await pool.query(`UPDATE ${tabla} SET status = 'succeeded', lease_token = NULL, lease_until = NULL WHERE ${VIGENTE}`, [r.id, r.token]);
  if (u.rowCount !== 1) throw new ErrorLeaseVencido(`lease vencido o ajeno para ${r.cola}#${r.id}`);
}

export function backoffSegundos(intento: number, azar: () => number = Math.random): number {
  const base = Math.min(5 * 2 ** intento, 900);
  if (base === 900) return 900;
  return Math.round(base * (0.8 + 0.4 * azar()));
}

async function empresaDe(tx: Consultable, cola: Cola, id: string): Promise<string> {
  const { tabla } = TABLA[cola];
  const e = await tx.query<{ company_id: string }>(`SELECT ca.company_id FROM ${tabla} m JOIN core.channel_accounts ca ON ca.id = m.channel_account_id WHERE m.id = $1`, [id]);
  const fila = e.rows[0];
  if (!fila) throw new Error(`mensaje ${cola}#${id} sin cuenta de canal`);
  return fila.company_id;
}

export async function fallar(pool: pg.Pool, r: Reclamo, error: unknown): Promise<'retryable' | 'uncertain' | 'dead_lettered'> {
  const { tabla } = TABLA[r.cola];
  const codigo = error instanceof Error ? error.name : 'desconocido';
  const detalle = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  const agotado = r.attempts >= r.maxAttempts;
  const destino = error instanceof ErrorIncierto ? 'uncertain' : error instanceof ErrorTransitorio && !agotado ? 'retryable' : 'dead_lettered';
  return enTransaccion(pool, async (tx) => {
    const columnaError = r.cola === 'inbox' ? ', last_error_code = $4' : '';
    const params: unknown[] = [r.id, r.token, destino];
    if (r.cola === 'inbox') params.push(codigo);
    const disponible = destino === 'retryable' ? `, available_at = now() + make_interval(secs => ${backoffSegundos(r.attempts)})` : '';
    const u = await tx.query(`UPDATE ${tabla} SET status = $3, lease_token = NULL, lease_until = NULL${columnaError}${disponible} WHERE ${VIGENTE}`, params);
    if (u.rowCount !== 1) throw new ErrorLeaseVencido(`lease vencido o ajeno para ${r.cola}#${r.id}`);
    if (destino === 'retryable') return destino;
    if (destino === 'dead_lettered') {
      const motivo = error instanceof ErrorTransitorio ? 'intentos_agotados' : 'error_terminal';
      await tx.query('INSERT INTO integrations.dead_letters (source_type, source_id, reason_code, detail) VALUES ($1, $2, $3, $4)', [r.cola, r.id, motivo, detalle]);
    }
    await registrarEvento(tx, {
      companyId: await empresaDe(tx, r.cola, r.id), actorType: 'system', actorId: 'plataforma.colas',
      action: `cola.${destino}`, aggregateType: r.cola, aggregateId: r.id, correlationId: r.correlationId,
      reason: detalle, payload: { codigo, intento: r.attempts },
    });
    return destino;
  });
}

export async function soltarPorApagado(pool: pg.Pool, r: Reclamo): Promise<void> {
  const { tabla } = TABLA[r.cola];
  await pool.query(`UPDATE ${tabla} SET status = 'pending', lease_token = NULL, lease_until = NULL, attempts = GREATEST(attempts - 1, 0) WHERE ${VIGENTE}`, [r.id, r.token]);
}

export async function liberarVencidos(pool: pg.Pool, cola: Cola): Promise<{ pendientes: number; muertos: number }> {
  const { tabla } = TABLA[cola];
  return enTransaccion(pool, async (tx) => {
    const u = await tx.query<{ id: string; status: string; correlation_id: string }>(
      `UPDATE ${tabla} SET status = CASE WHEN attempts >= max_attempts THEN 'dead_lettered' ELSE 'pending' END,
              lease_token = NULL, lease_until = NULL
        WHERE status = 'claimed' AND lease_until <= now()
        RETURNING id, status, correlation_id`,
    );
    let muertos = 0;
    for (const f of u.rows) {
      if (f.status !== 'dead_lettered') continue;
      muertos++;
      await tx.query("INSERT INTO integrations.dead_letters (source_type, source_id, reason_code, detail) VALUES ($1, $2, 'lease_vencido_agotado', 'el procesamiento se interrumpió en todos los intentos')", [cola, f.id]);
      await registrarEvento(tx, {
        companyId: await empresaDe(tx, cola, f.id), actorType: 'system', actorId: 'plataforma.scheduler',
        action: 'cola.dead_lettered', aggregateType: cola, aggregateId: f.id, correlationId: f.correlation_id,
        reason: 'lease vencido con intentos agotados',
      });
    }
    return { pendientes: u.rows.length - muertos, muertos };
  });
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd plataforma && npm run typecheck && npx vitest run test/colas.test.ts`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add plataforma/src/colas plataforma/test/colas.test.ts
git commit -m "feat(plataforma): colas con lease, reintentos, incierto y DLQ (E1-Q-01..06, E1-DUP-01)"
```

---

### Task 5: Configuración, logs, correlación, latidos y apagado

**Files:**
- Create: `plataforma/src/comun/config.ts`, `plataforma/src/comun/logger.ts`, `plataforma/src/comun/correlacion.ts`, `plataforma/src/comun/latido.ts`, `plataforma/src/comun/apagado.ts`
- Test: `plataforma/test/comun.test.ts`

**Interfaces:**
- Consumes: `crearPool` (Task 1); `crearBaseDePrueba` (Task 2).
- Produces:
  ```ts
  export type Servicio = 'api' | 'worker' | 'scheduler';
  export interface Config { servicio: Servicio; instancia: string; version: string; pgUrl: string; apiPuerto: number; estadoPgDir: string }
  export function cargarConfig(env: NodeJS.ProcessEnv, leerArchivo?: (ruta: string) => string): Config; // lanza ErrorConfig
  export class ErrorConfig extends Error {}
  export function crearLogger(servicio: string, destino?: pino.DestinationStream): pino.Logger;
  export function correlacionDe(valor: string | string[] | undefined): string;
  export function registrarLatido(db: Consultable, servicio: Servicio, instancia: string, version: string): Promise<void>;
  export function iniciarLatidos(db: Consultable, servicio: Servicio, instancia: string, version: string, logger: pino.Logger, cadaMs?: number): () => void;
  export function alApagar(logger: pino.Logger, fn: () => Promise<void>, limiteMs?: number): void;
  ```

- [ ] **Step 1: Escribir los tests**

`plataforma/test/comun.test.ts`:
```ts
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cargarConfig, ErrorConfig } from '../src/comun/config.ts';
import { correlacionDe } from '../src/comun/correlacion.ts';
import { registrarLatido } from '../src/comun/latido.ts';
import { crearLogger } from '../src/comun/logger.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('configuración', () => {
  const env = { SERVICIO: 'api', INSTANCIA: 'api-1', VERSION: '0.1.0', PG_HOST: 'pg', PG_PORT: '5432', PG_DATABASE: 'plataforma', PG_USER: 'plataforma_app', PG_PASSWORD_FILE: '/run/secretos/pg', API_PUERTO: '3201', ESTADO_PG_DIR: '/estado-pg' };

  it('arma la URL con la contraseña leída del archivo', () => {
    const c = cargarConfig(env, () => 'cla ve/1\n');
    expect(c).toMatchObject({ servicio: 'api', apiPuerto: 3201, estadoPgDir: '/estado-pg' });
    expect(c.pgUrl).toBe('postgres://plataforma_app:cla%20ve%2F1@pg:5432/plataforma');
  });

  it('falla claro si falta una variable', () => {
    const { PG_USER: _omitido, ...incompleto } = env;
    expect(() => cargarConfig(incompleto, () => 'x')).toThrow(ErrorConfig);
    expect(() => cargarConfig(incompleto, () => 'x')).toThrow(/PG_USER/);
  });

  it('rechaza un servicio desconocido', () => {
    expect(() => cargarConfig({ ...env, SERVICIO: 'otro' }, () => 'x')).toThrow(ErrorConfig);
  });
});

describe('logs y correlación', () => {
  it('oculta contraseñas, tokens, cookies y emails', () => {
    let salida = '';
    const destino = new Writable({ write(chunk, _enc, cb) { salida += String(chunk); cb(); } });
    crearLogger('api', destino).info({ password: 'secreto', token: 't', req: { headers: { cookie: 'c', authorization: 'a' } }, email: 'a@b.c' }, 'hola');
    expect(salida).not.toMatch(/secreto|"t"|a@b\.c/);
    expect(JSON.parse(salida)).toMatchObject({ servicio: 'api', msg: 'hola', password: '[oculto]' });
  });

  it('respeta un X-Correlation-Id UUID válido y genera otro si no', () => {
    const uuid = '0191f2c4-7b1e-7d3a-9c1f-2b6a1e4d5f60';
    expect(correlacionDe(uuid)).toBe(uuid);
    expect(correlacionDe('no-es-uuid')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlacionDe(undefined)).not.toBe(correlacionDe(undefined));
  });
});

describe('latidos', () => {
  let base: BaseDePrueba; let app: pg.Pool;
  beforeAll(async () => { base = await crearBaseDePrueba(); app = crearPool(base.urlApp); });
  afterAll(async () => { await app.end(); await base.borrar(); });

  it('registrarLatido inserta y actualiza una fila por servicio', async () => {
    await registrarLatido(app, 'worker', 'w1', '0.1.0');
    await registrarLatido(app, 'worker', 'w2', '0.1.0');
    const r = await app.query<{ instancia: string }>("select instancia from core.service_heartbeats where servicio='worker'");
    expect(r.rows).toEqual([{ instancia: 'w2' }]);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd plataforma && npx vitest run test/comun.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar**

`plataforma/src/comun/config.ts`:
```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type Servicio = 'api' | 'worker' | 'scheduler';
export interface Config { servicio: Servicio; instancia: string; version: string; pgUrl: string; apiPuerto: number; estadoPgDir: string }
export class ErrorConfig extends Error { override name = 'ErrorConfig'; }

const Esquema = z.object({
  SERVICIO: z.enum(['api', 'worker', 'scheduler', 'migrate']),
  INSTANCIA: z.string().min(1),
  VERSION: z.string().min(1),
  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().positive(),
  PG_DATABASE: z.string().min(1),
  PG_USER: z.string().min(1),
  PG_PASSWORD_FILE: z.string().min(1),
  API_PUERTO: z.coerce.number().int().positive().default(3201),
  ESTADO_PG_DIR: z.string().min(1).default('/estado-pg'),
});

export function cargarConfig(env: NodeJS.ProcessEnv, leerArchivo: (ruta: string) => string = (r) => readFileSync(r, 'utf8')): Config {
  const r = Esquema.safeParse(env);
  if (!r.success) {
    const campos = r.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ErrorConfig(`configuración inválida o incompleta: ${campos}`);
  }
  const e = r.data;
  if (e.SERVICIO === 'migrate') throw new ErrorConfig('SERVICIO=migrate usa src/db/cli-migrar.ts');
  const clave = leerArchivo(e.PG_PASSWORD_FILE).trim();
  if (!clave) throw new ErrorConfig('PG_PASSWORD_FILE está vacío');
  return {
    servicio: e.SERVICIO, instancia: e.INSTANCIA, version: e.VERSION,
    pgUrl: `postgres://${encodeURIComponent(e.PG_USER)}:${encodeURIComponent(clave)}@${e.PG_HOST}:${e.PG_PORT}/${e.PG_DATABASE}`,
    apiPuerto: e.API_PUERTO, estadoPgDir: e.ESTADO_PG_DIR,
  };
}
```

`plataforma/src/comun/logger.ts`:
```ts
import pino from 'pino';

export function crearLogger(servicio: string, destino?: pino.DestinationStream): pino.Logger {
  const opciones: pino.LoggerOptions = {
    base: { servicio },
    messageKey: 'msg',
    redact: {
      paths: ['password', 'clave', 'token', 'email', '*.password', '*.token', '*.email', 'req.headers.cookie', 'req.headers.authorization', 'headers.cookie', 'headers.authorization'],
      censor: '[oculto]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destino ? pino(opciones, destino) : pino(opciones);
}
```

`plataforma/src/comun/correlacion.ts`:
```ts
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function correlacionDe(valor: string | string[] | undefined): string {
  const v = Array.isArray(valor) ? valor[0] : valor;
  return v !== undefined && UUID.test(v) ? v.toLowerCase() : randomUUID();
}
```

`plataforma/src/comun/latido.ts`:
```ts
import type pino from 'pino';
import type { Consultable } from '../db/pool.ts';
import type { Servicio } from './config.ts';

export async function registrarLatido(db: Consultable, servicio: Servicio, instancia: string, version: string): Promise<void> {
  await db.query(
    `INSERT INTO core.service_heartbeats (servicio, instancia, version, visto_en) VALUES ($1, $2, $3, now())
     ON CONFLICT (servicio) DO UPDATE SET instancia = EXCLUDED.instancia, version = EXCLUDED.version, visto_en = now()`,
    [servicio, instancia, version],
  );
}

export function iniciarLatidos(db: Consultable, servicio: Servicio, instancia: string, version: string, logger: pino.Logger, cadaMs = 30_000): () => void {
  let fallando = false;
  const latir = async () => {
    try {
      await registrarLatido(db, servicio, instancia, version);
      if (fallando) { logger.info('base de datos recuperada'); fallando = false; }
    } catch (error) {
      if (!fallando) { logger.error({ err: (error as Error).message }, 'no se pudo registrar el latido: base de datos caída'); fallando = true; }
    }
  };
  void latir();
  const timer = setInterval(() => void latir(), cadaMs);
  return () => clearInterval(timer);
}
```

`plataforma/src/comun/apagado.ts`:
```ts
import type pino from 'pino';

export function alApagar(logger: pino.Logger, fn: () => Promise<void>, limiteMs = 10_000): void {
  let apagando = false;
  const manejar = (senal: string) => {
    if (apagando) return;
    apagando = true;
    logger.info({ senal }, 'apagando');
    const limite = setTimeout(() => { logger.error('apagado excedió el límite; se fuerza la salida'); process.exit(1); }, limiteMs);
    fn().then(() => { clearTimeout(limite); process.exit(0); }, (error: unknown) => {
      clearTimeout(limite); logger.error({ err: (error as Error).message }, 'error al apagar'); process.exit(1);
    });
  };
  process.once('SIGTERM', () => manejar('SIGTERM'));
  process.once('SIGINT', () => manejar('SIGINT'));
}
```

- [ ] **Step 4: Correr los tests**

Run: `cd plataforma && npm run typecheck && npx vitest run test/comun.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add plataforma/src/comun plataforma/test/comun.test.ts
git commit -m "feat(plataforma): configuración, logs con redacción, correlación, latidos y apagado"
```

---

### Task 6: API — salud, incidentes, sesión y contrato (E1-CAP-01, E1-API-01)

**Files:**
- Create: `plataforma/src/auth/sesion.ts`, `plataforma/src/api/estado-wal.ts`, `plataforma/src/api/salud.ts`, `plataforma/src/api/cursor.ts`, `plataforma/src/api/app.ts`, `plataforma/src/api/main.ts`
- Test: `plataforma/test/estado-wal.test.ts`, `plataforma/test/api.test.ts`

**Interfaces:**
- Consumes: `crearPool`, `Consultable` (Task 1); `crearBaseDePrueba` (Task 2); `encolarInbox`, `reclamar`, `fallar` (Task 4); `crearLogger`, `correlacionDe`, `registrarLatido`, `cargarConfig`, `iniciarLatidos`, `alApagar` (Task 5); `ErrorIncierto` (Task 4).
- Produces:
  ```ts
  // auth/sesion.ts
  export interface Sesion { usuario: string; capacidades: ReadonlySet<string> }
  export type ProveedorSesion = (req: FastifyRequest) => Promise<Sesion | null>;
  export const sinSesion: ProveedorSesion;
  // api/estado-wal.ts
  export type NivelComponente = 'ok' | 'degraded' | 'down';
  export interface EstadoComponente { status: NivelComponente; checked_at: string; detail?: string }
  export function evaluarWal(dir: string, ahora: Date): EstadoComponente;
  // api/salud.ts
  export interface Salud { status: NivelComponente; components: { database: EstadoComponente; worker: EstadoComponente; scheduler: EstadoComponente; wal_archive: EstadoComponente } }
  export function calcularSalud(db: Consultable, estadoPgDir: string, ahora?: Date): Promise<Salud>;
  // api/cursor.ts
  export interface PosicionCursor { opened_at: string; source_type: 'inbox' | 'outbox'; source_id: string }
  export function codificarCursor(p: PosicionCursor): string;
  export function decodificarCursor(c: string): PosicionCursor | null;
  // api/app.ts
  export interface OpcionesApp { db: pg.Pool; estadoPgDir: string; proveedorSesion: ProveedorSesion; logger: pino.Logger }
  export function construirApp(o: OpcionesApp): Promise<FastifyInstance>;
  ```

- [ ] **Step 1: Tests de `wal_archive` (umbrales del vigía)**

`plataforma/test/estado-wal.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluarWal } from '../src/api/estado-wal.ts';

const AHORA = new Date('2026-09-15T12:00:00Z');
let dir = '';
const escribir = (datos: object) => { dir = mkdtempSync(join(tmpdir(), 'wal-')); writeFileSync(join(dir, 'estado-pg-archivo.json'), JSON.stringify(datos)); };
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

describe('evaluarWal', () => {
  it('ok con medición reciente y sin atraso', () => {
    escribir({ medido: '2026-09-15T11:58:00Z', ok: true, pendientes: 0, mas_viejo_s: 0 });
    expect(evaluarWal(dir, AHORA).status).toBe('ok');
  });
  it('degraded si el segmento pendiente más viejo supera 180 s', () => {
    escribir({ medido: '2026-09-15T11:58:00Z', ok: true, pendientes: 2, mas_viejo_s: 200 });
    expect(evaluarWal(dir, AHORA).status).toBe('degraded');
  });
  it('down si supera 300 s', () => {
    escribir({ medido: '2026-09-15T11:58:00Z', ok: true, pendientes: 5, mas_viejo_s: 301 });
    expect(evaluarWal(dir, AHORA).status).toBe('down');
  });
  it('down si la medición tiene más de 15 minutos', () => {
    escribir({ medido: '2026-09-15T11:44:59Z', ok: true, pendientes: 0, mas_viejo_s: 0 });
    expect(evaluarWal(dir, AHORA).status).toBe('down');
  });
  it('down si ok es false o el archivo es ilegible', () => {
    escribir({ medido: '2026-09-15T11:58:00Z', ok: false });
    expect(evaluarWal(dir, AHORA).status).toBe('down');
    expect(evaluarWal('/no/existe', AHORA).status).toBe('down');
  });
});
```

- [ ] **Step 2: Tests de API**

`plataforma/test/api.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirApp } from '../src/api/app.ts';
import { sinSesion, type ProveedorSesion } from '../src/auth/sesion.ts';
import { encolarInbox, fallar, reclamar } from '../src/colas/colas.ts';
import { ErrorIncierto } from '../src/colas/errores.ts';
import { crearLogger } from '../src/comun/logger.ts';
import { registrarLatido } from '../src/comun/latido.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

// Proveedor de test: la cabecera x-test-sesion elige la sesión. No existe en producción.
const proveedorDeTest: ProveedorSesion = async (req) => {
  const v = req.headers['x-test-sesion'];
  if (v === 'lector') return { usuario: 'lector', capacidades: new Set(['operations.read']) };
  if (v === 'sin-permiso') return { usuario: 'otro', capacidades: new Set() };
  return null;
};

describe('API v2', () => {
  let base: BaseDePrueba; let db: pg.Pool; let app: FastifyInstance; let estadoDir: string;
  let validar: (ruta: string, metodo: string, status: number, cuerpo: unknown) => void;

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    db = crearPool(base.urlApp);
    estadoDir = mkdtempSync(join(tmpdir(), 'estado-pg-'));
    writeFileSync(join(estadoDir, 'estado-pg-archivo.json'), JSON.stringify({ medido: new Date().toISOString(), ok: true, pendientes: 0, mas_viejo_s: 0 }));
    app = await construirApp({ db, estadoPgDir: estadoDir, proveedorSesion: proveedorDeTest, logger: crearLogger('api-test') });
    const spec = await SwaggerParser.dereference(new URL('../../openapi/platform-v2.yaml', import.meta.url).pathname) as any;
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats.default(ajv);
    validar = (ruta, metodo, status, cuerpo) => {
      const esquema = spec.paths[ruta][metodo].responses[String(status)].content['application/json'].schema;
      const ok = ajv.validate(esquema, cuerpo);
      expect(ok, JSON.stringify(ajv.errors)).toBe(true);
    };
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    const cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
    for (let i = 0; i < 3; i++) {
      await encolarInbox(db, { channelAccountId: cuenta, topic: 'ml.orders', resourceId: `inc-${i}`, remoteVersion: 'v1', source: 'sweep', correlationId: randomUUID() });
    }
    for (const r of await reclamar(db, 'inbox', ['ml.orders'], 3)) await fallar(db, r, new ErrorIncierto('cortado'));
  });
  afterAll(async () => { await app.close(); await db.end(); await base.borrar(); rmSync(estadoDir, { recursive: true, force: true }); });

  it('E1-API-01 /health 503 sin latidos y 200 con todo sano, según contrato', async () => {
    let r = await app.inject({ method: 'GET', url: '/api/v2/health' });
    expect(r.statusCode).toBe(503);
    expect(r.json().components.worker.status).toBe('down');
    validar('/health', 'get', 503, r.json());
    await registrarLatido(db, 'worker', 'w1', '0.1.0');
    await registrarLatido(db, 'scheduler', 's1', '0.1.0');
    r = await app.inject({ method: 'GET', url: '/api/v2/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok' });
    validar('/health', 'get', 200, r.json());
    expect(r.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('E1-CAP-01 /incidents: 401 sin sesión, 403 sin capacidad, 200 con capacidad', async () => {
    const sin = await app.inject({ method: 'GET', url: '/api/v2/incidents' });
    expect(sin.statusCode).toBe(401); validar('/incidents', 'get', 401, sin.json());
    const prohibido = await app.inject({ method: 'GET', url: '/api/v2/incidents', headers: { 'x-test-sesion': 'sin-permiso' } });
    expect(prohibido.statusCode).toBe(403); validar('/incidents', 'get', 403, prohibido.json());
    const ok = await app.inject({ method: 'GET', url: '/api/v2/incidents', headers: { 'x-test-sesion': 'lector' } });
    expect(ok.statusCode).toBe(200); validar('/incidents', 'get', 200, ok.json());
    expect(ok.json().items).toHaveLength(3);
  });

  it('E1-API-01 paginación por cursor sin repetir ni saltear', async () => {
    const h = { 'x-test-sesion': 'lector' };
    const p1 = (await app.inject({ method: 'GET', url: '/api/v2/incidents?limit=2', headers: h })).json();
    expect(p1.items).toHaveLength(2); expect(p1.next_cursor).toBeTypeOf('string');
    const p2 = (await app.inject({ method: 'GET', url: `/api/v2/incidents?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`, headers: h })).json();
    expect(p2.items).toHaveLength(1); expect(p2.next_cursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((i: { source_id: string }) => i.source_id);
    expect(new Set(ids).size).toBe(3);
  });

  it('E1-API-01 cursor inválido y limit fuera de rango → 422 con error uniforme', async () => {
    const h = { 'x-test-sesion': 'lector', 'x-correlation-id': '0191f2c4-7b1e-7d3a-9c1f-2b6a1e4d5f60' };
    const malCursor = await app.inject({ method: 'GET', url: '/api/v2/incidents?cursor=%%%', headers: h });
    expect(malCursor.statusCode).toBe(422); validar('/incidents', 'get', 422, malCursor.json());
    expect(malCursor.json().correlation_id).toBe('0191f2c4-7b1e-7d3a-9c1f-2b6a1e4d5f60');
    const malLimit = await app.inject({ method: 'GET', url: '/api/v2/incidents?limit=500', headers: h });
    expect(malLimit.statusCode).toBe(422); validar('/incidents', 'get', 422, malLimit.json());
  });

  it('en producción (sinSesion) /incidents siempre responde 401', async () => {
    const prod = await construirApp({ db, estadoPgDir: estadoDir, proveedorSesion: sinSesion, logger: crearLogger('api-test') });
    const r = await prod.inject({ method: 'GET', url: '/api/v2/incidents', headers: { 'x-test-sesion': 'lector' } });
    expect(r.statusCode).toBe(401);
    await prod.close();
  });

  it('un error inesperado devuelve 500 internal_error sin mensaje interno', async () => {
    const roto = await construirApp({ db, estadoPgDir: estadoDir, proveedorSesion: async () => { throw new Error('detalle interno secreto'); }, logger: crearLogger('api-test') });
    const r = await roto.inject({ method: 'GET', url: '/api/v2/incidents' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toMatchObject({ code: 'internal_error' });
    expect(r.body).not.toContain('secreto');
    await roto.close();
  });
});
```

- [ ] **Step 3: Verificar que fallan**

Run: `cd plataforma && npx vitest run test/estado-wal.test.ts test/api.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 4: Implementar sesión, estado WAL, salud y cursor**

`plataforma/src/auth/sesion.ts`:
```ts
import type { FastifyRequest } from 'fastify';

export interface Sesion { usuario: string; capacidades: ReadonlySet<string> }
export type ProveedorSesion = (req: FastifyRequest) => Promise<Sesion | null>;

// Tramo 1: no hay login real. En producción nadie tiene sesión; los tests inyectan su proveedor.
export const sinSesion: ProveedorSesion = async () => null;
```

`plataforma/src/api/estado-wal.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type NivelComponente = 'ok' | 'degraded' | 'down';
export interface EstadoComponente { status: NivelComponente; checked_at: string; detail?: string }

// Mismos umbrales que lib/vigiaBackup.js del legado.
export function evaluarWal(dir: string, ahora: Date): EstadoComponente {
  const checked_at = ahora.toISOString();
  let datos: { medido?: string; ok?: boolean; mas_viejo_s?: number };
  try {
    datos = JSON.parse(readFileSync(join(dir, 'estado-pg-archivo.json'), 'utf8'));
  } catch {
    return { status: 'down', checked_at, detail: 'estado del archivado ilegible' };
  }
  const medido = datos.medido ? Date.parse(datos.medido) : Number.NaN;
  if (!Number.isFinite(medido) || (ahora.getTime() - medido) / 1000 > 900) return { status: 'down', checked_at, detail: 'medición del archivado vencida' };
  if (datos.ok !== true) return { status: 'down', checked_at, detail: 'el archivado informa error' };
  const atraso = datos.mas_viejo_s ?? 0;
  if (atraso > 300) return { status: 'down', checked_at, detail: `WAL pendiente hace ${atraso} s` };
  if (atraso > 180) return { status: 'degraded', checked_at, detail: `WAL pendiente hace ${atraso} s` };
  return { status: 'ok', checked_at };
}
```

`plataforma/src/api/salud.ts`:
```ts
import type { Consultable } from '../db/pool.ts';
import { evaluarWal, type EstadoComponente, type NivelComponente } from './estado-wal.ts';

export interface Salud {
  status: NivelComponente;
  components: { database: EstadoComponente; worker: EstadoComponente; scheduler: EstadoComponente; wal_archive: EstadoComponente };
}

const PEOR: Record<NivelComponente, number> = { ok: 0, degraded: 1, down: 2 };

export async function calcularSalud(db: Consultable, estadoPgDir: string, ahora = new Date()): Promise<Salud> {
  const checked_at = ahora.toISOString();
  let database: EstadoComponente = { status: 'ok', checked_at };
  let worker: EstadoComponente = { status: 'down', checked_at, detail: 'sin latido' };
  let scheduler: EstadoComponente = { status: 'down', checked_at, detail: 'sin latido' };
  try {
    const r = await db.query<{ servicio: string; edad: number }>(
      'SELECT servicio, EXTRACT(EPOCH FROM (now() - visto_en))::float8 AS edad FROM core.service_heartbeats',
    );
    for (const f of r.rows) {
      const estado: EstadoComponente = f.edad <= 120 ? { status: 'ok', checked_at } : { status: 'down', checked_at, detail: `último latido hace ${Math.round(f.edad)} s` };
      if (f.servicio === 'worker') worker = estado;
      if (f.servicio === 'scheduler') scheduler = estado;
    }
  } catch {
    database = { status: 'down', checked_at, detail: 'base de datos no responde' };
    worker = { status: 'down', checked_at, detail: 'sin base de datos' };
    scheduler = { status: 'down', checked_at, detail: 'sin base de datos' };
  }
  const wal_archive = evaluarWal(estadoPgDir, ahora);
  const componentes = { database, worker, scheduler, wal_archive };
  const status = Object.values(componentes).reduce<NivelComponente>((acc, c) => (PEOR[c.status] > PEOR[acc] ? c.status : acc), 'ok');
  return { status, components: componentes };
}
```

`plataforma/src/api/cursor.ts`:
```ts
export interface PosicionCursor { opened_at: string; source_type: 'inbox' | 'outbox'; source_id: string }

export function codificarCursor(p: PosicionCursor): string {
  return Buffer.from(JSON.stringify([p.opened_at, p.source_type, p.source_id])).toString('base64url');
}

export function decodificarCursor(c: string): PosicionCursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [opened_at, source_type, source_id] = v as unknown[];
    if (typeof opened_at !== 'string' || !Number.isFinite(Date.parse(opened_at))) return null;
    if (source_type !== 'inbox' && source_type !== 'outbox') return null;
    if (typeof source_id !== 'string' || !/^\d+$/.test(source_id)) return null;
    return { opened_at, source_type, source_id };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Implementar la app Fastify**

`plataforma/src/api/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type pino from 'pino';
import { z } from 'zod';
import type { ProveedorSesion } from '../auth/sesion.ts';
import { correlacionDe } from '../comun/correlacion.ts';
import { codificarCursor, decodificarCursor } from './cursor.ts';
import { calcularSalud } from './salud.ts';

export interface OpcionesApp { db: pg.Pool; estadoPgDir: string; proveedorSesion: ProveedorSesion; logger: pino.Logger }

declare module 'fastify' {
  interface FastifyRequest { correlationId: string }
}

class ErrorHttp extends Error {
  constructor(readonlyStatus: number, readonlyCode: string, mensaje: string, detalles?: Record<string, unknown>) {
    super(mensaje);
    this.status = readonlyStatus; this.code = readonlyCode;
    if (detalles) this.details = detalles;
  }
  status: number; code: string; details?: Record<string, unknown>;
}

const ConsultaIncidentes = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  topic: z.enum(['ml.orders', 'ml.shipments', 'ml.questions', 'ml.messages', 'ml.claims', 'ml.items', 'woo.orders', 'woo.products']).optional(),
  status: z.enum(['retryable', 'uncertain', 'dead_lettered', 'parked']).optional(),
});

export async function construirApp(o: OpcionesApp): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: o.logger, disableRequestLogging: true });

  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (req, reply) => {
    req.correlationId = correlacionDe(req.headers['x-correlation-id']);
    reply.header('X-Correlation-Id', req.correlationId);
  });

  app.setErrorHandler(async (error, req, reply) => {
    if (error instanceof ErrorHttp) {
      return reply.status(error.status).send({ code: error.code, message: error.message, correlation_id: req.correlationId, ...(error.details ? { details: error.details } : {}) });
    }
    req.log.error({ correlation_id: req.correlationId, err: (error as Error).message }, 'error inesperado');
    return reply.status(500).send({ code: 'internal_error', message: 'Error interno.', correlation_id: req.correlationId });
  });
  app.setNotFoundHandler(async (req, reply) => reply.status(404).send({ code: 'not_found', message: 'Ruta inexistente.', correlation_id: req.correlationId }));

  app.get('/api/v2/health', async (_req, reply) => {
    const salud = await calcularSalud(o.db, o.estadoPgDir);
    return reply.status(salud.status === 'ok' ? 200 : 503).send(salud);
  });

  app.get('/api/v2/incidents', async (req, reply) => {
    const sesion = await o.proveedorSesion(req);
    if (!sesion) throw new ErrorHttp(401, 'unauthenticated', 'Se requiere iniciar sesión.');
    if (!sesion.capacidades.has('operations.read')) throw new ErrorHttp(403, 'forbidden', 'No tenés permiso para ver incidentes.');
    const q = ConsultaIncidentes.safeParse(req.query);
    if (!q.success) throw new ErrorHttp(422, 'invalid_parameter', 'Parámetros inválidos.', { parameter: q.error.issues[0]?.path.join('.') ?? '' });
    const desde = q.data.cursor === undefined ? null : decodificarCursor(q.data.cursor);
    if (q.data.cursor !== undefined && desde === null) throw new ErrorHttp(422, 'invalid_parameter', 'El cursor no es válido.', { parameter: 'cursor' });
    const r = await o.db.query<{ source_type: 'inbox' | 'outbox'; source_id: string; topic: string; status: string; reason_code: string | null; opened_at: Date; attempts: number; correlation_id: string }>(
      `SELECT source_type, source_id::text AS source_id, topic, status, reason_code, opened_at, attempts, correlation_id
         FROM integrations.incidents
        WHERE ($1::text IS NULL OR topic = $1) AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamptz IS NULL OR (opened_at, source_type, source_id) > ($3::timestamptz, $4::text, $5::bigint))
        ORDER BY opened_at, source_type, source_id
        LIMIT $6`,
      [q.data.topic ?? null, q.data.status ?? null, desde?.opened_at ?? null, desde?.source_type ?? null, desde?.source_id ?? null, q.data.limit + 1],
    );
    const filas = r.rows.slice(0, q.data.limit);
    const items = filas.map((f) => ({ ...f, opened_at: f.opened_at.toISOString() }));
    const ultimo = items.at(-1);
    const next_cursor = r.rows.length > q.data.limit && ultimo ? codificarCursor({ opened_at: ultimo.opened_at, source_type: ultimo.source_type, source_id: ultimo.source_id }) : null;
    return reply.send({ items, next_cursor });
  });

  await app.ready();
  return app;
}
```

Nota para el implementador: `ErrorHttp` declara sus campos después del constructor porque `erasableSyntaxOnly` prohíbe parameter properties; mantener esa forma.

`plataforma/src/api/main.ts`:
```ts
import { hostname } from 'node:os';
import { sinSesion } from '../auth/sesion.ts';
import { alApagar } from '../comun/apagado.ts';
import { cargarConfig } from '../comun/config.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { crearLogger } from '../comun/logger.ts';
import { crearPool } from '../db/pool.ts';
import { construirApp } from './app.ts';

const logger = crearLogger('api');
const config = cargarConfig({ INSTANCIA: hostname(), ...process.env });
const db = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const app = await construirApp({ db, estadoPgDir: config.estadoPgDir, proveedorSesion: sinSesion, logger });
const detenerLatidos = iniciarLatidos(db, 'api', config.instancia, config.version, logger);
await app.listen({ host: '0.0.0.0', port: config.apiPuerto });
logger.info({ puerto: config.apiPuerto }, 'api escuchando');
alApagar(logger, async () => { detenerLatidos(); await app.close(); await db.end(); });
```

- [ ] **Step 6: Correr los tests**

Run: `cd plataforma && npm run typecheck && npx vitest run test/estado-wal.test.ts test/api.test.ts`
Expected: 11 passed.

- [ ] **Step 7: Commit**

```bash
git add plataforma/src/auth plataforma/src/api plataforma/test/estado-wal.test.ts plataforma/test/api.test.ts
git commit -m "feat(plataforma): API v2 de salud e incidentes con contrato y capacidades (E1-CAP-01, E1-API-01)"
```

---

### Task 7: Worker y scheduler

**Files:**
- Create: `plataforma/src/worker/worker.ts`, `plataforma/src/worker/main.ts`, `plataforma/src/scheduler/exclusion.ts`, `plataforma/src/scheduler/scheduler.ts`, `plataforma/src/scheduler/main.ts`
- Test: `plataforma/test/servicios.test.ts`

**Interfaces:**
- Consumes: `crearPool` (Task 1); `crearBaseDePrueba` (Task 2); `encolarInbox`, `reclamar`, `completar`, `fallar`, `soltarPorApagado`, `liberarVencidos`, `Reclamo`, `Cola` (Task 4); `crearLogger`, `cargarConfig`, `iniciarLatidos`, `alApagar` (Task 5).
- Produces:
  ```ts
  export type Procesador = (reclamo: Reclamo) => Promise<void>;
  export interface Worker { unaVuelta(): Promise<number>; detener(): Promise<void> }
  export function crearWorker(o: { db: pg.Pool; procesadores: ReadonlyMap<string, Procesador>; logger: pino.Logger; lote?: number }): Worker;
  export interface Exclusion { tieneLock(): boolean; soltar(): Promise<void> }
  export function tomarExclusion(url: string, logger: pino.Logger, alPerder: () => void): Promise<Exclusion | null>;
  export interface Scheduler { unaVuelta(): Promise<{ pendientes: number; muertos: number }> }
  export function crearScheduler(o: { db: pg.Pool }): Scheduler;
  ```

- [ ] **Step 1: Escribir los tests**

`plataforma/test/servicios.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encolarInbox, reclamar } from '../src/colas/colas.ts';
import { ErrorTransitorio } from '../src/colas/errores.ts';
import { crearLogger } from '../src/comun/logger.ts';
import { crearPool } from '../src/db/pool.ts';
import { tomarExclusion } from '../src/scheduler/exclusion.ts';
import { crearScheduler } from '../src/scheduler/scheduler.ts';
import { crearWorker, type Procesador } from '../src/worker/worker.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('worker y scheduler', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let cuenta: string;
  const logger = crearLogger('test');
  const encolar = (topic: string, id: string) => encolarInbox(app, { channelAccountId: cuenta, topic, resourceId: id, remoteVersion: 'v1', source: 'sweep', correlationId: randomUUID() });

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    const empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    cuenta = (await app.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { await admin.query('delete from integrations.dead_letters; delete from integrations.inbox_messages'); });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('sin procesadores registrados el worker no reclama nada', async () => {
    await encolar('ml.orders', 'w0');
    const w = crearWorker({ db: app, procesadores: new Map(), logger });
    expect(await w.unaVuelta()).toBe(0);
    const r = await app.query<{ status: string }>("select status from integrations.inbox_messages where resource_id='w0'");
    expect(r.rows[0]?.status).toBe('pending');
  });

  it('procesa sólo tópicos registrados y clasifica fallos', async () => {
    await encolar('ml.orders', 'w1'); await encolar('ml.orders', 'w2'); await encolar('woo.orders', 'w3');
    const proc: Procesador = async (r) => { if (r.id && (await app.query("select resource_id from integrations.inbox_messages where id=$1", [r.id])).rows[0].resource_id === 'w2') throw new ErrorTransitorio('503'); };
    const w = crearWorker({ db: app, procesadores: new Map([['ml.orders', proc]]), logger });
    expect(await w.unaVuelta()).toBe(2);
    const r = await app.query<{ resource_id: string; status: string }>('select resource_id, status from integrations.inbox_messages order by resource_id');
    expect(r.rows).toEqual([{ resource_id: 'w1', status: 'succeeded' }, { resource_id: 'w2', status: 'retryable' }, { resource_id: 'w3', status: 'pending' }]);
  });

  it('detener suelta lo reclamado sin consumir el intento', async () => {
    await encolar('ml.orders', 'w4');
    let liberarProcesador: () => void = () => undefined;
    const proc: Procesador = () => new Promise<void>((resolve) => { liberarProcesador = resolve; });
    const w = crearWorker({ db: app, procesadores: new Map([['ml.orders', proc]]), logger });
    const vuelta = w.unaVuelta();
    await new Promise((r) => setTimeout(r, 300));
    const detenido = w.detener();
    liberarProcesador();
    await vuelta; await detenido;
    const r = await app.query<{ status: string; attempts: number }>("select status, attempts from integrations.inbox_messages where resource_id='w4'");
    expect(['succeeded', 'pending']).toContain(r.rows[0]?.status);
  });

  it('el scheduler libera leases vencidos', async () => {
    await encolar('ml.orders', 's1');
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    await admin.query("update integrations.inbox_messages set lease_until = now() - interval '1 second' where id=$1", [r!.id]);
    expect(await crearScheduler({ db: app }).unaVuelta()).toEqual({ pendientes: 1, muertos: 0 });
  });

  it('sólo un scheduler obtiene la exclusión; al soltarla la toma otro', async () => {
    const a = await tomarExclusion(base.urlApp, logger, () => undefined);
    const b = await tomarExclusion(base.urlApp, logger, () => undefined);
    expect(a?.tieneLock()).toBe(true);
    expect(b).toBeNull();
    await a!.soltar();
    const c = await tomarExclusion(base.urlApp, logger, () => undefined);
    expect(c?.tieneLock()).toBe(true);
    await c!.soltar();
  });

  it('si la conexión de la exclusión se corta, avisa y deja de tener el lock', async () => {
    let perdida = false;
    const a = await tomarExclusion(base.urlApp, logger, () => { perdida = true; });
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'plataforma-scheduler-lock' and datname = current_database()");
    await new Promise((r) => setTimeout(r, 500));
    expect(perdida).toBe(true);
    expect(a?.tieneLock()).toBe(false);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd plataforma && npx vitest run test/servicios.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar el worker**

`plataforma/src/worker/worker.ts`:
```ts
import type pg from 'pg';
import type pino from 'pino';
import { completar, fallar, reclamar, soltarPorApagado, type Reclamo } from '../colas/colas.ts';
import { ErrorLeaseVencido } from '../colas/errores.ts';

export type Procesador = (reclamo: Reclamo) => Promise<void>;
export interface Worker { unaVuelta(): Promise<number>; detener(): Promise<void> }

export function crearWorker(o: { db: pg.Pool; procesadores: ReadonlyMap<string, Procesador>; logger: pino.Logger; lote?: number }): Worker {
  let deteniendo = false;
  const enCurso = new Set<Reclamo>();
  let vueltaActual: Promise<number> = Promise.resolve(0);

  const procesarUno = async (r: Reclamo) => {
    const procesador = o.procesadores.get(r.tipo);
    enCurso.add(r);
    try {
      if (!procesador) { await soltarPorApagado(o.db, r); return; }
      await procesador(r);
      if (deteniendo) { await soltarPorApagado(o.db, r); return; }
      await completar(o.db, r);
    } catch (error) {
      if (error instanceof ErrorLeaseVencido) { o.logger.warn({ id: r.id }, 'lease vencido: otro worker tomará el mensaje'); return; }
      if (deteniendo) { await soltarPorApagado(o.db, r); return; }
      try { await fallar(o.db, r, error); } catch (e) { if (!(e instanceof ErrorLeaseVencido)) throw e; }
    } finally {
      enCurso.delete(r);
    }
  };

  return {
    unaVuelta() {
      vueltaActual = (async () => {
        const tipos = [...o.procesadores.keys()];
        if (deteniendo || !tipos.length) return 0;
        const lote = await reclamar(o.db, 'inbox', tipos, o.lote ?? 10);
        await Promise.all(lote.map(procesarUno));
        return lote.length;
      })();
      return vueltaActual;
    },
    async detener() {
      deteniendo = true;
      await Promise.allSettled([...enCurso].map((r) => soltarPorApagado(o.db, r)));
      await vueltaActual.catch(() => 0);
    },
  };
}
```

`plataforma/src/worker/main.ts`:
```ts
import { hostname } from 'node:os';
import { alApagar } from '../comun/apagado.ts';
import { cargarConfig } from '../comun/config.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { crearLogger } from '../comun/logger.ts';
import { crearPool } from '../db/pool.ts';
import { crearWorker, type Procesador } from './worker.ts';

const logger = crearLogger('worker');
const config = cargarConfig({ INSTANCIA: hostname(), ...process.env });
const db = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
// Tramo 1: sin procesadores. Los tramos siguientes registran tópicos acá.
const procesadores = new Map<string, Procesador>();
const worker = crearWorker({ db, procesadores, logger });
const detenerLatidos = iniciarLatidos(db, 'worker', config.instancia, config.version, logger);
let activo = true;
let fallando = false;

alApagar(logger, async () => { activo = false; detenerLatidos(); await worker.detener(); await db.end(); });

while (activo) {
  try {
    await worker.unaVuelta();
    if (fallando) { logger.info('base de datos recuperada'); fallando = false; }
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 4000));
  } catch (error) {
    if (!fallando) { logger.error({ err: (error as Error).message }, 'worker sin base de datos; reintentando'); fallando = true; }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
```

- [ ] **Step 4: Implementar exclusión y scheduler**

`plataforma/src/scheduler/exclusion.ts`:
```ts
import pg from 'pg';
import type pino from 'pino';

export interface Exclusion { tieneLock(): boolean; soltar(): Promise<void> }

const LOCK = "hashtextextended('plataforma.scheduler', 0)";

// Conexión dedicada (no del pool): un advisory lock de sesión vive en esa conexión.
export async function tomarExclusion(url: string, logger: pino.Logger, alPerder: () => void): Promise<Exclusion | null> {
  const cliente = new pg.Client({ connectionString: url, application_name: 'plataforma-scheduler-lock' });
  await cliente.connect();
  const r = await cliente.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${LOCK}) AS ok`);
  if (!r.rows[0]?.ok) { await cliente.end(); return null; }
  let vigente = true;
  const perder = (motivo: string) => {
    if (!vigente) return;
    vigente = false;
    logger.error({ motivo }, 'se perdió la exclusión del scheduler');
    alPerder();
  };
  cliente.on('error', (e) => perder(e.message));
  cliente.on('end', () => perder('conexión cerrada'));
  return {
    tieneLock: () => vigente,
    async soltar() {
      if (!vigente) return;
      vigente = false;
      await cliente.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => undefined);
      await cliente.end().catch(() => undefined);
    },
  };
}
```

`plataforma/src/scheduler/scheduler.ts`:
```ts
import type pg from 'pg';
import { liberarVencidos } from '../colas/colas.ts';

export interface Scheduler { unaVuelta(): Promise<{ pendientes: number; muertos: number }> }

export function crearScheduler(o: { db: pg.Pool }): Scheduler {
  return {
    async unaVuelta() {
      const inbox = await liberarVencidos(o.db, 'inbox');
      const outbox = await liberarVencidos(o.db, 'outbox');
      return { pendientes: inbox.pendientes + outbox.pendientes, muertos: inbox.muertos + outbox.muertos };
    },
  };
}
```

`plataforma/src/scheduler/main.ts`:
```ts
import { hostname } from 'node:os';
import { alApagar } from '../comun/apagado.ts';
import { cargarConfig } from '../comun/config.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { crearLogger } from '../comun/logger.ts';
import { crearPool } from '../db/pool.ts';
import { tomarExclusion, type Exclusion } from './exclusion.ts';
import { crearScheduler } from './scheduler.ts';

const logger = crearLogger('scheduler');
const config = cargarConfig({ INSTANCIA: hostname(), ...process.env });
const db = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const scheduler = crearScheduler({ db });
const detenerLatidos = iniciarLatidos(db, 'scheduler', config.instancia, config.version, logger);
let activo = true;
let exclusion: Exclusion | null = null;

alApagar(logger, async () => { activo = false; detenerLatidos(); await exclusion?.soltar(); await db.end(); });

while (activo) {
  try {
    if (!exclusion?.tieneLock()) {
      exclusion = await tomarExclusion(config.pgUrl, logger, () => undefined);
      if (!exclusion) { logger.warn('otro scheduler tiene la exclusión; en espera'); await new Promise((r) => setTimeout(r, 30_000)); continue; }
      logger.info('exclusión del scheduler obtenida');
    }
    const r = await scheduler.unaVuelta();
    if (r.pendientes || r.muertos) logger.info(r, 'leases vencidos liberados');
  } catch (error) {
    logger.error({ err: (error as Error).message }, 'vuelta del scheduler falló; reintentando');
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
```

- [ ] **Step 5: Correr los tests**

Run: `cd plataforma && npm run typecheck && npx vitest run test/servicios.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add plataforma/src/worker plataforma/src/scheduler plataforma/test/servicios.test.ts
git commit -m "feat(plataforma): worker con procesadores por tópico y scheduler con exclusión dedicada"
```

---

### Task 8: Imagen, compose y `npm run test:e1` (E1-SVC-01 y evaluación del tramo)

**Files:**
- Create: `plataforma/deploy/Dockerfile`, `plataforma/deploy/compose.test.yml`, `plataforma/deploy/compose.prod.yml`
- Create: `scripts/plataforma/test-e1.sh`
- Modify: `package.json` (raíz): script `test:e1`
- Test: el propio `npm run test:e1`

**Interfaces:**
- Consumes: todos los tests de Tasks 1–7 (sus títulos contienen los IDs `E1-…`); `src/*/main.ts`; `src/db/cli-migrar.ts`; `deploy/alta-base.sql`.
- Produces: `npm run test:e1` que escribe `$E1_DIR/resultado.json` con `{ tramo: 1, escenarios: { "E1-…": "ok" | "falla" | "falta" } }` y sale ≠ 0 si algún exigido no es `ok`.

- [ ] **Step 1: Dockerfile**

`plataforma/deploy/Dockerfile`:
```dockerfile
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
USER node
CMD ["node", "src/api/main.ts"]
```

- [ ] **Step 2: Compose de test (aislado, sin tocar E0)**

`plataforma/deploy/compose.test.yml`:
```yaml
name: ${E1_PROJECT}
x-servicio: &servicio
  image: fusion-plataforma:test
  init: true
  stop_grace_period: 15s
  security_opt: ["no-new-privileges:true"]
  mem_limit: 128m
  cpus: 0.25
  depends_on:
    migrate: { condition: service_completed_successfully }
  environment: &entorno
    VERSION: test
    PG_HOST: pg
    PG_PORT: "5432"
    PG_DATABASE: plataforma
    PG_USER: plataforma_app
    PG_PASSWORD_FILE: /run/secretos/pg-app
    ESTADO_PG_DIR: /estado-pg
  volumes:
    - ${E1_DIR}/secretos:/run/secretos:ro

services:
  pg:
    image: postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af
    environment: { POSTGRES_PASSWORD: admin }
    healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres"], interval: 2s, timeout: 3s, retries: 60 }
  migrate:
    image: fusion-plataforma:test
    init: true
    command: ["node", "src/db/cli-migrar.ts"]
    environment:
      PG_HOST: pg
      PG_PORT: "5432"
      PG_DATABASE: plataforma
      PG_USER: plataforma_migrador
      PG_PASSWORD_FILE: /run/secretos/pg-migrador
    volumes:
      - ${E1_DIR}/secretos:/run/secretos:ro
    depends_on:
      pg: { condition: service_healthy }
  api:
    <<: *servicio
    command: ["node", "src/api/main.ts"]
    environment: { <<: *entorno, SERVICIO: api, API_PUERTO: "3201" }
    ports: ["127.0.0.1:${E1_PORT}:3201"]
    volumes:
      - ${E1_DIR}/secretos:/run/secretos:ro
      - ${E1_DIR}/estado-pg:/estado-pg:ro
  worker:
    <<: *servicio
    command: ["node", "src/worker/main.ts"]
    environment: { <<: *entorno, SERVICIO: worker }
  scheduler:
    <<: *servicio
    command: ["node", "src/scheduler/main.ts"]
    environment: { <<: *entorno, SERVICIO: scheduler }
```

- [ ] **Step 3: Compose de producción**

`plataforma/deploy/compose.prod.yml`:
```yaml
# E1 tramo 1 en sombra. Uso: docker compose -f plataforma/deploy/compose.prod.yml -p fusion-plataforma up -d --build
# Requiere: /root/.config/fusion-plataforma/{pg-migrador,pg-app} (600) y /opt/fusionbikes/estado-pg/.
name: fusion-plataforma
x-servicio: &servicio
  build: { context: .., dockerfile: deploy/Dockerfile }
  image: fusion-plataforma:local
  init: true
  restart: unless-stopped
  stop_grace_period: 15s
  security_opt: ["no-new-privileges:true"]
  mem_limit: 128m
  cpus: 0.25
  networks: [fusion-pg]
  depends_on:
    migrate: { condition: service_completed_successfully }
  environment: &entorno
    VERSION: tramo1
    PG_HOST: pg
    PG_PORT: "5432"
    PG_DATABASE: plataforma
    PG_USER: plataforma_app
    PG_PASSWORD_FILE: /run/secretos/pg-app
    ESTADO_PG_DIR: /estado-pg
  volumes:
    - /root/.config/fusion-plataforma:/run/secretos:ro

services:
  migrate:
    build: { context: .., dockerfile: deploy/Dockerfile }
    image: fusion-plataforma:local
    init: true
    restart: "no"
    networks: [fusion-pg]
    command: ["node", "src/db/cli-migrar.ts"]
    environment:
      PG_HOST: pg
      PG_PORT: "5432"
      PG_DATABASE: plataforma
      PG_USER: plataforma_migrador
      PG_PASSWORD_FILE: /run/secretos/pg-migrador
    volumes:
      - /root/.config/fusion-plataforma:/run/secretos:ro
  api:
    <<: *servicio
    command: ["node", "src/api/main.ts"]
    environment: { <<: *entorno, SERVICIO: api, API_PUERTO: "3201" }
    ports: ["127.0.0.1:3201:3201"]
    volumes:
      - /root/.config/fusion-plataforma:/run/secretos:ro
      - /opt/fusionbikes/estado-pg:/estado-pg:ro
  worker:
    <<: *servicio
    command: ["node", "src/worker/main.ts"]
    environment: { <<: *entorno, SERVICIO: worker }
  scheduler:
    <<: *servicio
    command: ["node", "src/scheduler/main.ts"]
    environment: { <<: *entorno, SERVICIO: scheduler }

networks:
  fusion-pg:
    name: fusion-pg_default
    external: true
```

Nota: los archivos de secretos deben ser legibles por el uid 1000 del contenedor: se crean con dueño `1000:1000` y modo `600` (Task 10).

- [ ] **Step 4: Script `test:e1`**

`scripts/plataforma/test-e1.sh`:
```bash
#!/bin/bash
# npm run test:e1 — E1 tramo 1. Corre typecheck y la suite de plataforma/ (PostgreSQL temporal propio),
# levanta los servicios contenerizados en un proyecto Docker aislado y evalúa los escenarios exigidos.
# E1_KEEP=1 conserva el entorno para depurar.
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
TRAMO=1
EXIGIDOS=(E1-SCH-01 E1-SCH-02 E1-AUD-01 E1-AUD-02 E1-AUD-03 E1-Q-01 E1-Q-02 E1-Q-03 E1-Q-04 E1-Q-05 E1-Q-06 E1-DUP-01 E1-CAP-01 E1-API-01 E1-SVC-01)
export E1_PROJECT="e1test$$"
export E1_DIR="$(mktemp -d /tmp/e1-XXXX)"
export E1_PORT="$(shuf -i 43000-43999 -n 1)"
C=(docker compose -f "$RAIZ/plataforma/deploy/compose.test.yml" -p "$E1_PROJECT")
declare -A RES
for e in "${EXIGIDOS[@]}"; do RES[$e]=falta; done
log() { echo "[e1] $*"; }
limpiar() { [ "${E1_KEEP:-0}" = "1" ] && { log "entorno conservado: $E1_PROJECT $E1_DIR"; return; }; "${C[@]}" down -v --remove-orphans >/dev/null 2>&1; rm -rf "$E1_DIR"; }
trap limpiar EXIT

log "1/4 typecheck y suite de plataforma"
cd "$RAIZ/plataforma"
npm run -s typecheck || { log "typecheck falló"; exit 1; }
npx vitest run --reporter=json --outputFile="$E1_DIR/vitest.json" >/dev/null 2>&1
node -e '
  const r = require(process.argv[1]); const res = {};
  for (const f of r.testResults) for (const t of f.assertionResults) {
    for (const id of (t.title.match(/E1-[A-Z]+-\d+/g) || [])) {
      if (t.status !== "passed") res[id] = "falla"; else if (res[id] !== "falla") res[id] = "ok";
    }
  }
  console.log(Object.entries(res).map(([k, v]) => k + "=" + v).join("\n"));
' "$E1_DIR/vitest.json" > "$E1_DIR/escenarios.txt"
while IFS='=' read -r id estado; do [ -n "$id" ] && RES[$id]=$estado; done < "$E1_DIR/escenarios.txt"
[ "$(node -e 'console.log(require(process.argv[1]).numFailedTests)' "$E1_DIR/vitest.json")" = "0" ] || log "hay tests fallidos en la suite"

log "2/4 imagen y entorno contenerizado"
mkdir -p "$E1_DIR/secretos" "$E1_DIR/estado-pg"
printf 'migrador' > "$E1_DIR/secretos/pg-migrador"; printf 'app' > "$E1_DIR/secretos/pg-app"
chown -R 1000:1000 "$E1_DIR/secretos"; chmod 600 "$E1_DIR/secretos/"*
printf '{"medido":"%s","ok":true,"pendientes":0,"mas_viejo_s":0}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$E1_DIR/estado-pg/estado-pg-archivo.json"
docker build -q -t fusion-plataforma:test -f "$RAIZ/plataforma/deploy/Dockerfile" "$RAIZ/plataforma" >/dev/null || { log "build falló"; exit 1; }
"${C[@]}" up -d pg >/dev/null 2>&1
for _ in $(seq 60); do "${C[@]}" exec -T pg pg_isready -U postgres -q >/dev/null 2>&1 && break; sleep 1; done
"${C[@]}" exec -T pg psql -U postgres -q -v pw_migrador=migrador -v pw_app=app < "$RAIZ/plataforma/deploy/alta-base.sql" >/dev/null || { log "alta de base falló"; exit 1; }
"${C[@]}" up -d api worker scheduler >/dev/null 2>&1 || { log "no levantaron los servicios"; "${C[@]}" logs --tail 30; exit 1; }

salud() { curl -s -o "$E1_DIR/salud.json" -w '%{http_code}' "http://127.0.0.1:$E1_PORT/api/v2/health"; }
esperar() { local codigo="$1" campo="$2" valor="$3"; for _ in $(seq 90); do
  [ "$(salud)" = "$codigo" ] && node -e 'const s=require(process.argv[1]); process.exit(s.components[process.argv[2]].status===process.argv[3]?0:1)' "$E1_DIR/salud.json" "$campo" "$valor" && return 0; sleep 2; done; return 1; }

log "3/4 E1-SVC-01 servicios separados"
if esperar 200 worker ok \
  && "${C[@]}" stop worker >/dev/null 2>&1 \
  && docker exec "$("${C[@]}" ps -q pg)" psql -U postgres -d plataforma -qc "update core.service_heartbeats set visto_en = now() - interval '5 minutes' where servicio='worker'" \
  && esperar 503 worker down \
  && [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$E1_PORT/api/v2/incidents")" = "401" ] \
  && "${C[@]}" start worker >/dev/null 2>&1 \
  && esperar 200 worker ok; then
  RES[E1-SVC-01]=ok
else
  RES[E1-SVC-01]=falla; "${C[@]}" logs --tail 40
fi

log "4/4 contenedor api no ve nada fuera de /estado-pg"
"${C[@]}" exec -T api sh -c 'ls /estado-pg && ! ls /opt/fusionbikes 2>/dev/null' >/dev/null 2>&1 || { log "el contenedor api ve rutas del host"; RES[E1-SVC-01]=falla; }

FALLOS=0
{
  printf '{"tramo":%s,"escenarios":{' "$TRAMO"
  primero=1
  for e in "${EXIGIDOS[@]}"; do [ $primero = 1 ] || printf ','; primero=0; printf '"%s":"%s"' "$e" "${RES[$e]}"; [ "${RES[$e]}" = ok ] || FALLOS=$((FALLOS+1)); done
  printf '}}\n'
} > "$E1_DIR/resultado.json"
for e in "${EXIGIDOS[@]}"; do printf '  %-11s %s\n' "$e" "${RES[$e]}"; done
cp "$E1_DIR/resultado.json" "$RAIZ/plataforma/resultado-test-e1.json" 2>/dev/null || true
[ "$FALLOS" = 0 ] && log "tramo $TRAMO: todos los escenarios exigidos OK" || log "tramo $TRAMO: $FALLOS escenarios exigidos no OK"
exit "$FALLOS"
```

En `package.json` (raíz), agregar junto a `test:e0`:
```json
    "test:e1": "bash scripts/plataforma/test-e1.sh",
```
Y agregar `plataforma/resultado-test-e1.json` a `.gitignore`.

- [ ] **Step 5: Correr `test:e1`**

Run (raíz, sin otra suite corriendo): `pgrep -af "vitest" ; npm run test:e1`
Expected: los 15 escenarios `ok`, salida `tramo 1: todos los escenarios exigidos OK`, código 0.

- [ ] **Step 6: Commit**

```bash
git add plataforma/deploy scripts/plataforma/test-e1.sh package.json .gitignore
git commit -m "feat(plataforma): imagen, compose y npm run test:e1 del tramo 1 (E1-SVC-01)"
```

---

### Task 9: Mudanza del estado de E0 a `/opt/fusionbikes/estado-pg/` (legado)

**Files:**
- Modify: `scripts/postgres/estado-archivo.sh:10`, `scripts/postgres/backup-diario.sh:4,10`
- Modify: `lib/vigiaBackup.js:10-11,36-37` (constantes `ESTADO_PG_DEFAULT` y `ESTADO_PG_ARCHIVO_DEFAULT`; ubicarlas por nombre si las líneas cambiaron)
- Modify: `test/vigiaBackup.test.js` (agregar test de rutas por defecto)

**Interfaces:**
- Produces: `ESTADO_PG_DEFAULT = '/opt/fusionbikes/estado-pg/estado-pg.json'`, `ESTADO_PG_ARCHIVO_DEFAULT = '/opt/fusionbikes/estado-pg/estado-pg-archivo.json'` (consumidos por Task 10 y por `compose.prod.yml`).

- [ ] **Step 1: Test que falla**

Agregar a `test/vigiaBackup.test.js` (dentro del archivo, al final):
```js
import { ESTADO_PG_DEFAULT, ESTADO_PG_ARCHIVO_DEFAULT } from '../lib/vigiaBackup.js';

describe('rutas de estado de PostgreSQL', () => {
  it('viven en una carpeta propia montable por la plataforma, fuera de backups', () => {
    expect(ESTADO_PG_DEFAULT).toBe('/opt/fusionbikes/estado-pg/estado-pg.json');
    expect(ESTADO_PG_ARCHIVO_DEFAULT).toBe('/opt/fusionbikes/estado-pg/estado-pg-archivo.json');
  });
});
```

Run: `npx vitest run test/vigiaBackup.test.js`
Expected: FAIL en el test nuevo (rutas viejas).

- [ ] **Step 2: Cambiar rutas**

`lib/vigiaBackup.js`, líneas 33–34:
```js
// Carpeta propia (no /opt/fusionbikes/backups): la API de la plataforma la monta en sólo lectura y
// no debe ver los backups con datos de negocio (diseño E1 tramo 1, 2026-09-15).
export const ESTADO_PG_DEFAULT = '/opt/fusionbikes/estado-pg/estado-pg.json';
export const ESTADO_PG_ARCHIVO_DEFAULT = '/opt/fusionbikes/estado-pg/estado-pg-archivo.json';
```
En el comentario de cabecera (líneas 10–11) reemplazar `estado-pg.json` / `estado-pg-archivo.json` por `/opt/fusionbikes/estado-pg/estado-pg.json` / `/opt/fusionbikes/estado-pg/estado-pg-archivo.json`.

`scripts/postgres/estado-archivo.sh`, línea 10:
```bash
ESTADO="/opt/fusionbikes/estado-pg/estado-pg-archivo.json"
mkdir -p /opt/fusionbikes/estado-pg
```

`scripts/postgres/backup-diario.sh`, línea 10 (y el comentario de la línea 4 con la ruta nueva):
```bash
ESTADO="/opt/fusionbikes/estado-pg/estado-pg.json"
mkdir -p /opt/fusionbikes/estado-pg
```

- [ ] **Step 3: Correr los tests del vigía**

Run: `npx vitest run test/vigiaBackup.test.js`
Expected: todos passed.

- [ ] **Step 4: Commit (sin desplegar todavía; el despliegue ordenado es Task 10)**

```bash
git add lib/vigiaBackup.js scripts/postgres/estado-archivo.sh scripts/postgres/backup-diario.sh test/vigiaBackup.test.js
git commit -m "refactor(e0): estado de PostgreSQL en carpeta propia montable, fuera de backups"
```

---

### Task 10: Revisión, suite completa y puesta en marcha en sombra

> **Bloqueado intencionalmente:** esta task describe un futuro corte en VPS y no forma parte de la implementación actual. Requiere autorización expresa de José, una línea base tomada en el momento del corte y revisión independiente del diff. No ejecutar los pasos 3–9 desde esta ficha como consecuencia de la verificación aislada indicada arriba.

**Files:**
- Modify: `docs/superpowers/delivery-program.json` (E1 `next`), `docs/memory/active.md`, `docs/memory/modules/operations-vps.md`
- Create (VPS, fuera del repo): `/root/.config/fusion-plataforma/pg-migrador`, `/root/.config/fusion-plataforma/pg-app`, `/opt/fusionbikes/estado-pg/`

- [ ] **Step 1: Revisión independiente del diff**

Invocar `revisor` sobre `git diff <commit previo a Task 1>..HEAD` con este contexto: spec del tramo, las Global Constraints de este plan y los hallazgos ya resueltos en la spec. Corregir hasta OK.

- [ ] **Step 2: Suite completa del legado y test:e1**

Run: `pgrep -af "vitest|node.*server" ; npm test`
Expected: 0 fallos (misma cuenta que antes + el test nuevo del vigía).
Run: `npm run test:e1`
Expected: 15 escenarios `ok`.

- [ ] **Step 3: Medición previa en producción (línea base)**

```bash
docker exec fusion-pg-pg-1 psql -U postgres -tAc "select archived_count, now() from pg_stat_archiver"
curl -s -o /dev/null -w 'legado healthz %{http_code} %{time_total}s\n' http://127.0.0.1:3001/healthz
pm2 describe herramientas | grep -E "restarts|uptime"
free -m | head -2
```
Anotar los valores (se comparan en Step 7).

- [ ] **Step 4: José genera las contraseñas en el VPS (no pasan por el chat)**

```bash
install -d -m 700 /root/.config/fusion-plataforma
openssl rand -base64 32 | tr -d '\n' > /root/.config/fusion-plataforma/pg-migrador
openssl rand -base64 32 | tr -d '\n' > /root/.config/fusion-plataforma/pg-app
chown 1000:1000 /root/.config/fusion-plataforma/pg-*; chmod 600 /root/.config/fusion-plataforma/pg-*
```

- [ ] **Step 5: Mudanza del estado de E0 (orden: primero copiar, después desplegar código)**

```bash
install -d -m 755 /opt/fusionbikes/estado-pg
cp -p /opt/fusionbikes/backups/estado-pg.json /opt/fusionbikes/backups/estado-pg-archivo.json /opt/fusionbikes/estado-pg/
cd /opt/fusionbikes/herramientas && pm2 restart herramientas --update-env
sleep 20 && curl -s -o /dev/null -w 'healthz %{http_code}\n' http://127.0.0.1:3001/healthz
bash scripts/postgres/estado-archivo.sh && cat /opt/fusionbikes/estado-pg/estado-pg-archivo.json
```
Esperar la corrida `*/5` del vigía y confirmar 0 incidentes de `postgres`. Luego borrar los archivos viejos:
`rm /opt/fusionbikes/backups/estado-pg.json /opt/fusionbikes/backups/estado-pg-archivo.json`.

- [ ] **Step 6: Alta, migraciones y servicios**

```bash
cd /opt/fusionbikes/herramientas
docker exec -i fusion-pg-pg-1 psql -U postgres -q \
  -v pw_migrador="$(cat /root/.config/fusion-plataforma/pg-migrador)" \
  -v pw_app="$(cat /root/.config/fusion-plataforma/pg-app)" < plataforma/deploy/alta-base.sql
docker compose -f plataforma/deploy/compose.prod.yml -p fusion-plataforma up -d --build
docker compose -f plataforma/deploy/compose.prod.yml -p fusion-plataforma ps
docker compose -f plataforma/deploy/compose.prod.yml -p fusion-plataforma logs migrate --tail 5
```
Expected: `migrate` terminado con `aplicadas: ["0001_esquema_base.sql","0002_permisos.sql"]`; `api`, `worker`, `scheduler` `running`.

- [ ] **Step 7: Verificación en vivo**

```bash
sleep 60
curl -s http://127.0.0.1:3201/api/v2/health
curl -s -o /dev/null -w 'incidents sin sesion %{http_code}\n' http://127.0.0.1:3201/api/v2/incidents
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep plataforma
curl -s -o /dev/null -w 'legado healthz %{http_code} %{time_total}s\n' http://127.0.0.1:3001/healthz
pm2 describe herramientas | grep -E "restarts|uptime"
```
Expected: `/health` 200 con los cuatro componentes `ok`; `incidents` 401; cada contenedor < 128 MB; legado 200 sin reinicios nuevos.
Una hora después: `docker exec fusion-pg-pg-1 psql -U postgres -tAc "select archived_count from pg_stat_archiver"` — la diferencia por hora no debe superar la de la línea base de Step 3 en más de 2 segmentos.

- [ ] **Step 8: Vuelta atrás (sólo si falla Step 6 o 7)**

```bash
docker compose -f plataforma/deploy/compose.prod.yml -p fusion-plataforma down
git revert --no-edit <commit de Task 9> && pm2 restart herramientas --update-env
cp -p /opt/fusionbikes/estado-pg/*.json /opt/fusionbikes/backups/
```
La base `plataforma` queda sin uso y no afecta al legado.

- [ ] **Step 9: Documentar y cerrar el tramo**

- `docs/superpowers/delivery-program.json`: E1 `next` → "Tramo 1 en sombra desde <fecha>; siguiente: tramo 2 (barridos contra simulador)". Regenerar (`node scripts/generate-deliveries.mjs`) y validar (`npm run docs:validate-deliveries`).
- `docs/memory/active.md` y `docs/memory/modules/operations-vps.md`: proyecto `fusion-plataforma`, puerto 3201, secretos en `/root/.config/fusion-plataforma/`, estado de E0 en `/opt/fusionbikes/estado-pg/`, comandos de operación y vuelta atrás, mediciones del Step 7.

```bash
git add docs
git commit -m "docs(e1): tramo 1 en sombra en el VPS con mediciones y operación"
```
