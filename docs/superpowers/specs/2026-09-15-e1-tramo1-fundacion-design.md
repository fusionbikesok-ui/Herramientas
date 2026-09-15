# E1 · Tramo 1 — Fundación de la plataforma (diseño aprobado)

**Estado:** diseño aprobado por José el 2026-09-15, sección por sección. Pendiente: revisión del
documento escrito y plan de implementación.
**Ficha:** [E1 — Fundación PostgreSQL en sombra](../deliveries/E1-fundacion-sombra.md).
**Especificaciones que implementa:** [schema.sql](e1/schema.sql),
[platform-v2.yaml](../../../openapi/platform-v2.yaml), [test-e1.md](e1/test-e1.md).
**Decisiones:** PM-173 a PM-176.

## 1. Alcance

E1 se divide en cuatro tramos, cada uno entregable y verificable por sí mismo (PM-174):

| Tramo | Construye | Escenarios de `test:e1` | Toca producción |
|---|---|---|---|
| **1. Fundación** | `plataforma/`, migraciones, auditoría, colas, API/worker/scheduler en Docker, `/api/v2/health` e `/incidents`, capacidades | SCH-01/02, AUD-01..03, Q-01..06, DUP-01, CAP-01, API-01, SVC-01 | Sólo corre en sombra, sin datos de negocio |
| 2. Barridos | barridos por tópico contra el simulador, cursores, convergencia, bajas Woo | SWP, CONV, DEL | No |
| 3. Sombra en vivo | copia de señales del legado, presupuesto de latencia, PostgreSQL caído, barridos de sólo lectura reales | LAT, PGDOWN | **Sí** (aprobación propia) |
| 4. Seguridad y reporte | passkeys virtuales, manifiesto y reporte firmados en B2, email | WA, REC, AUD-04 | No |

**No hace el tramo 1:** login real de personas, llamadas a MercadoLibre o Woo, procesadores de
tópicos, subida a B2, email, cambios en el ACK del legado.

## 2. Estructura y servicios (sección 1)

- `plataforma/` dentro del repo, con `package.json` y lockfile **propios**: no comparte
  `node_modules` con el legado (la caída del 13/09 fue un binario nativo de `better-sqlite3`).
- La raíz excluye `plataforma/**` en `vitest.config.js` y `eslint.config.js` (sin eso `npm test`
  del legado tomaría los tests nuevos).
- Pila (PM-175): Node 24.21 ejecutando TypeScript nativo (sin build), `tsc` 7.0.2 sólo para
  verificar tipos con `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `allowImportingTsExtensions`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  (verificado: rechaza `enum` y errores de tipos); Fastify 5.12; `pg` 8.23 con SQL explícito;
  Zod 4.6; Pino 10.3; Vitest 5.0. Dependencias de desarrollo para contrato:
  `@apidevtools/swagger-parser` 13 y `ajv` 8.
- Servicios en Docker (PM-173): una imagen `node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`
  (usuario `node`, uid 1000) con tres puntos de entrada — `api`, `worker`, `scheduler` — más un
  contenedor de un solo uso `migrate`. Cada servicio: `init: true`, ~128 MB y límite de CPU,
  `stop_grace_period: 15s`, `no-new-privileges`. Sólo la API publica, en `127.0.0.1:3201`
  (verificado libre).
- Base `plataforma` en el PostgreSQL de E0 (queda en su backup y PITR). Los servicios se conectan
  por la red Docker `fusion-pg_default` (host `pg`), con contraseña: el `pg_hba` de E0 exige
  `scram-sha-256` para conexiones de red.
- Roles sin superusuario: `plataforma_migrador` (dueño del esquema) y `plataforma_app` (datos).
  Contraseñas en archivos 600 bajo `/root/.config/fusion-plataforma/`, generadas por José en el VPS.
- `src/`: `db/` (pool, transacciones, migraciones), `audit/`, `colas/`, `auth/`, `api/`, `worker/`,
  `scheduler/`, `comun/` (config, logs, errores, correlación).

## 3. Base de datos, auditoría y colas (sección 2)

### Alta y migraciones

- `deploy/alta-base.sql`, una sola vez con el superusuario de E0: crea base, roles y `CONNECT`;
  `REVOKE ALL ON DATABASE ... FROM PUBLIC`. Idempotente. `REVOKE CREATE ON SCHEMA public FROM PUBLIC`
  va en `0002_permisos.sql`: `public` es un esquema de cada base y el alta corre conectada a `postgres`,
  así que sólo la migración, que corre dentro de `plataforma`, lo aplica a la base correcta.
- Runner propio `src/db/migrar.ts`: archivos `migrations/NNNN_nombre.sql` en orden, cada uno en su
  transacción bajo advisory lock; `core.schema_migrations` guarda nombre y SHA-256. **No arranca**
  si una migración aplicada cambió o hay huecos. Migraciones sólo hacia adelante (PM-176): la
  vuelta atrás es PITR de E0 o migración correctiva.
- `0001_esquema_base.sql` = `schema.sql` (un test compara que el esquema migrado coincida con la
  referencia). `0002_permisos.sql` otorga a `plataforma_app`:
  `USAGE` en los esquemas; `SELECT, INSERT, UPDATE` en `core`, `security`, `integrations`;
  sólo `SELECT, INSERT` en `audit`; `USAGE` en secuencias; `EXECUTE` en funciones de `audit`; y
  los mismos permisos por `ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador` para tablas
  futuras.
- Pool por servicio: máximo 5 conexiones, `statement_timeout` 5 s, `connectionTimeoutMillis` 2 s.
  El migrador no tiene `statement_timeout`.

### Hallazgos verificados en PostgreSQL 18.6 descartable (2026-09-14/15)

| Hallazgo | Evidencia | Resolución |
|---|---|---|
| **Carrera en la cadena de auditoría**: el `id` sale de la secuencia antes del lock; dos escrituras concurrentes se encadenaban en orden inverso y `verify_chain()` marcaba rota una cadena intacta | Reproducido con un trigger que demora 1,5 s: `verify_chain=2` sin manipulación | `chain_seq` asignado dentro del lock e incluido en el hash; encadenado y verificación por `chain_seq` (ya aplicado en `schema.sql`) |
| Corrección de la carrera | Misma carrera → íntegra (`id3:seq2`, `id2:seq3`); 4 conexiones × 300 → 1 203 eventos íntegros, hashes únicos; modificación detectada en seq 500; borrado del medio detectado en seq 700; la app no puede fijar `chain_seq` | — |
| Límite: borrar el **último** evento con superusuario no lo detecta la cadena | Verificado | Lo detecta el manifiesto diario firmado (último `chain_seq`), tramo 4 |
| Tablas futuras sin permisos para la app | `INSERT` en tabla nueva → `permission denied` | `ALTER DEFAULT PRIVILEGES` en `0002`; verificado |
| Permisos de `plataforma_app` | `UPDATE`/`DELETE`/`TRUNCATE` auditoría, desactivar triggers, `session_replication_role`, crear tablas o esquemas, `public`, `pg_authid`: todos denegados; hash falso reemplazado por el trigger | — |
| Esquema sin superusuario | `schema.sql` aplicado completo como `plataforma_migrador` | — |
| Colas | 1 000 reclamos con 4 conexiones → 1 000 únicos; duplicado no crea mensaje; `CHECK` de `claimed` y `parked`; completar con lease vencido → 0 filas; liberar vencidos y agotamiento → `dead_lettered` | — |

### Auditoría

- `registrarEvento(tx, evento)` escribe en la **misma transacción** que el cambio. Hash y
  `chain_seq` los pone el trigger. `verificarCadena()` usa `audit.verify_chain()`.
- El lock de la cadena es global: se auditan sólo transiciones con significado (`uncertain`,
  `dead_lettered`, `parked` y sus resoluciones), no cada reclamo o lease.
- El manifiesto diario se genera y prueba en forma canónica; su subida a B2 es del tramo 4.

### Colas (inbox y outbox, misma interfaz)

- `encolar`: `ON CONFLICT DO NOTHING` sobre la clave única.
- `reclamar(topicos, worker, n)`: `FOR UPDATE SKIP LOCKED`, `status='claimed'`, `lease_token`,
  `lease_until = now() + 60 s` (reloj de la base), `attempts + 1` (los intentos se cuentan al
  reclamar, así un mensaje que tumba al worker termina en DLQ).
- `completar` / `fallar`: sólo si `lease_token` coincide y `lease_until > now()`; si no, conflicto
  sin escribir. `ErrorTransitorio` → `retryable` con backoff exponencial con jitter;
  `ErrorIncierto` → `uncertain`; otro error o intentos agotados → `dead_lettered` + fila en
  `dead_letters`.
- `soltarPorApagado`: vuelve a `pending` y **devuelve el intento**.
- `liberarVencidos()`: el scheduler cada 30 s; vencidos → `pending`, o `dead_lettered` si agotados.
- Latidos en `core.service_heartbeats` (**`UNLOGGED`**: un latido no necesita sobrevivir a una caída).

## 4. API, worker, scheduler y errores (sección 3)

- **`GET /api/v2/health`**: sin autenticación; aislado porque el puerto sólo se publica en
  `127.0.0.1` (no hay chequeo de IP: detrás de Docker el origen es la IP de la red interna).
  Componentes: `database` (`SELECT 1`, 2 s), `worker` y `scheduler` (latido ≤ 120 s),
  `wal_archive` desde `estado-pg-archivo.json`: `ok` si ok y medido ≤ 15 min; `degraded` si el WAL
  pendiente más viejo > 180 s; `down` si > 300 s, medición > 15 min o ilegible (umbrales del vigía).
  200 si todo `ok`; 503 si no.
- **`GET /api/v2/incidents`**: capacidad `operations.read`; vista `integrations.incidents`; cursor
  base64 de `(opened_at, source_type, source_id)` sin firma (alterarlo sólo cambia la página que ve
  alguien autorizado); cursor inválido → 422.
- Contrato validado contra `openapi/platform-v2.yaml` en tests. `X-Correlation-Id` en toda
  respuesta (se respeta el recibido si es UUID). Errores `{code, message, correlation_id}`; manejador
  propio de Fastify: 500 → `internal_error` sin mensaje interno.
- Auth del tramo: un único hook `obtenerSesion()`; en producción siempre "sin sesión" (401). Los
  tests inyectan el proveedor por código; **no existe variable de entorno que lo habilite**.
- **Worker**: latido cada 30 s; reclama sólo tópicos con procesador registrado (ninguno en este
  tramo); espera 1–5 s con jitter.
- **Scheduler**: latido cada 30 s y `liberarVencidos()`; exclusión con advisory lock de sesión en
  una **conexión dedicada** (no del pool); si esa conexión cae, frena, reconecta y re-toma el lock.
- Apagado ante SIGTERM: termina lo actual, suelta lo reclamado sin consumir intento, cierra el pool
  (máx. 10 s, con `stop_grace_period` 15 s).
- Sin base: reintento con backoff hasta 30 s y un único log por cambio de estado; la API sigue viva
  con `/health` 503.
- Configuración validada con Zod al arrancar (falta algo → no arranca). Logs JSON con Pino,
  `correlation_id` y servicio; se ocultan contraseña, token, cookie y email.

### Hallazgos de la revisión

| Hallazgo | Evidencia | Resolución |
|---|---|---|
| Montar `estado-pg-archivo.json` como archivo suelto lo congela | `estado-archivo.sh` escribe `.tmp` + `mv`; contenedor de prueba: archivo suelto seguía en `{"v":1}`, carpeta en `{"v":2}` | Montar una **carpeta** |
| Montar `/opt/fusionbikes/backups` exponía datos del negocio | El uid 1000 del contenedor leyó un backup SQLite de `backups/db` (39 archivos) | Carpeta propia `/opt/fusionbikes/estado-pg/` con sólo `estado-pg.json` y `estado-pg-archivo.json`; se monta sólo esa |
| Latidos frecuentes forzarían un segmento de WAL por minuto (`archive_timeout=60`) | Simulación de 4 min con latidos cada 30 s: 1 segmento, igual con tabla normal y `UNLOGGED`; segmentos vacíos del repo real ≈ 1 KB | `UNLOGGED` igual; se mide en vivo antes/después |

## 5. Pruebas y puesta en marcha (sección 4)

### Pruebas

- Vitest 5 en `plataforma/test/`, contra PostgreSQL 18.6 temporal (misma imagen y digest de E0);
  una base por archivo de test creada desde las migraciones.
- Cubren: runner de migraciones (checksum, huecos, lock), cadena de auditoría incluida la **carrera
  forzada**, colas (concurrencia, lease vencido, soltar por apagado sin consumir intento, DLQ),
  permisos con roles reales, API contra OpenAPI, apagado limpio, latido `UNLOGGED`, y que el
  contenedor de la API **no lea nada fuera de `estado-pg/`**.
- `npm run test:e1` (raíz): proyecto Docker temporal con PostgreSQL + alta + `migrate` + los tres
  servicios; ejecuta los escenarios del tramo contra la aplicación contenerizada; deja un resultado
  JSON y falla si falta o falla un escenario **exigido para el tramo vigente** (lista en
  `test-e1.md`). E1-SVC-01: detener el worker → API viva y `/health` 503 con `worker: down`;
  reiniciarlo → 200.

### Puesta en marcha en el VPS (opción A)

1. José genera las dos contraseñas en el VPS.
2. Cambio chico en el legado, con tests: `estado-archivo.sh`, `backup-diario.sh` y
   `lib/vigiaBackup.js` pasan a `/opt/fusionbikes/estado-pg/`. Verificar el vigía en verde.
3. Alta de base (superusuario de E0), `migrate`, y los tres servicios.
4. Verificación en vivo: latidos, `/health` 200 con `wal_archive: ok`, memoria real de los
   contenedores, segmentos archivados por hora antes/después, y sin cambio en el legado
   (`/healthz`, códigos HTTP, latencia, reinicios de PM2).
5. Vuelta atrás: `docker compose down`; el vigía vuelve a la ruta anterior; la base queda sin efecto.

Memoria disponible medida el 2026-09-15: 2,9 GB (Ollama del chatbot 1,5 GB, legado 504 MB).

## 6. Endurecimiento aplicado junto con este diseño

`/opt/fusionbikes/backups/db` y `/opt/fusionbikes/backups/uploads` pasan a `700` root (antes 755
con archivos 644, legibles por `e2e`, `www-data`, `fusion-offsite` y `fusion-restore`). Sólo los usa
`backup.sh`, que corre como root.
