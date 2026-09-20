# Operación del VPS y despliegue

## Hechos durables

- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve la rama
  `conteo-confiable`; cualquier referencia histórica que lo llame staging está obsoleta.
- Política objetivo: un pipeline verde podrá publicar backend/web con migración compatible,
  health/smoke y rollback automático. Hasta que E23 lo implemente y audite, la operación vigente
  sigue requiriendo confirmación manual. Windows, hardware y App Store siempre requieren autorización explícita.
- El repositorio local `/opt/fusionbikes/herramientas` usa como remoto `origin` el repositorio
  privado `fusionbikesok-ui/Herramientas` en GitHub, mediante SSH.
- El tramo 1 de E1 se verificó exclusivamente con PostgreSQL, secretos, estado y red Docker efímeros mediante `npm run test:e1`; no creó roles, bases, secretos ni contenedores persistentes en el VPS. Cualquier puesta en sombra requiere autorización explícita, línea base contemporánea y el SOP de E1.
- `bubblewrap` está instalado en `/usr/bin/bwrap`, versión 0.9.0.
- El commit `80e14eb` desplegó la ingesta de chat y aplicó la migración
  `chat_events_inbox_093`; `/api/v1/meta` conserva contrato `1.0.0`. La ruta queda
  deliberadamente fail-closed (`503`) hasta coordinar en producción
  `FUSION_CHAT_EVENTS_API_KEY` y `FUSION_CHAT_EVENTS_SECRET` con WordPress.
- **Auditoría automática de precios desplegada (2026-09-16):** commit `cd8f141`, migración
  `auditoria_precios_107`, PM2 reiniciado y guardado. Verificaciones posteriores: SQLite
  `quick_check=ok`, health interno y externo OK, `/herramientas/precios/` 200. Backup previo:
  `/opt/fusionbikes/backups/db/predeploy-auditoria-precios-20260916T163605Z.sqlite`; snapshot
  de código anterior en `/opt/fusionbikes/deploy-backups/auditoria-precios-20260916T163605Z`.
  Corrección posterior `07b9652`: retirado el corte de 1.000 filas de `GET /api/precios`, que
  hacía incompletos los filtros locales (Pirelli: 6 visibles de 21 auditadas). Suite completa
  2.679/2.679, PM2 reiniciado/guardado y health interno/externo OK.

## Backups y DR (desde 2026-09-13)

- `/opt/fusionbikes/backups/backup.sh`, cron `/etc/cron.d/fusion-backup` 06:00 UTC bajo flock.
  Local: base 14 días, tarball de uploads 2 días (14 si la nube falló).
- Nube: Backblaze B2, bucket `Herramientas-Fusion` (versionado, Object Lock, SSE-B2), prefijo
  `herramientas/crypt` vía remoto rclone crypt (nombres y contenido cifrados con
  `/root/.config/fusion-backup/passphrase`; copia de la passphrase guardada fuera del VPS por el usuario, confirmado 2026-09-13).
  `db/` y `env/` una copia diaria; `uploads/` espejo incremental con `copy` (nunca borra).
- La clave del VPS (`B2_*` en `.env`, nombre `fusion-backup-vps`) sólo tiene
  listBuckets/listFiles/readFiles/writeFiles: borrar versiones da 401. Se crea con
  `backups/crear-clave-b2.py` (API nativa, pide la clave maestra por consola).
- Estado de la última corrida: `backups/estado-nube.json`. Procedimiento: `backups/RESTAURAR.md`.
- Restauración probada 2026-09-13: base y .env byte a byte, `integrity_check` ok; uploads
  3.736/3.736 por `cryptcheck`. La descarga completa de uploads cortó por el **tope diario de
  descarga de la cuenta B2** (403 `download_cap_exceeded`): una restauración real exige subir ese
  tope en Caps & Alerts.
- El tope diario de descarga también cuenta los HEAD de rclone: `copyto` sin `--no-check-dest`
  falló con 403 el 2026-09-13 06:00 tras la prueba de restauración. El script usa
  `--no-check-dest` en base y .env; `copy` de uploads sólo lista (no descarga).
- Decisión 2026-09-13: la cuenta B2 sigue **sin tarjeta**. Consecuencias: topes gratis de
  1 GB de descarga y ~2.500 transacciones clase B por día (una restauración completa de uploads
  tarda ≥2 días, no cumple RTO 1 h) y las subidas se cortan a los 10 GB (al ritmo de
  ~2,3 GB/mes, hacia fines de 2026). Revisar entonces tarjeta, lifecycle de `db/` o proveedor.
  `backup.sh` registra `bucket_bytes` (con versiones) en `estado-nube.json`; el vigía abre
  advertencia `backup/backup_nube/capacidad_bucket` por encima de 8 GB.
- Vigía: `lib/vigiaBackup.js`, cron de la app minuto 17 de cada hora; si `ultimo_ok` > 26 h o
  falta el estado, abre incidente crítico `backup/backup_nube/backup_vencido` (email) y lo
  resuelve solo al volver un backup completo.
- Monitoreo externo (Better Stack, plan gratis, cuenta del usuario, desde 2026-09-13):
  monitor keyword `"ok":true` sobre `https://herramientas.fusionbikes.com.ar/herramientas/healthz`
  cada 3 min (NA + Europa, confirmación 1–2 min para no alertar en reinicios de pm2) y heartbeat
  diario con 3 h de gracia que `backup.sh` envía sólo si la nube quedó completa
  (`BACKUP_HEARTBEAT_URL` en `.env`, tratarla como secreto). Cubre la caída total del VPS, que
  el vigía interno no puede avisar. Alertas por email.
- `/healthz` es público (sin sesión) y sirve para monitoreo externo: `SELECT 1` en cada
  llamada e `integrity_check` cacheado 5 min (sin caché bloqueaba el event loop ~0,5 s por
  llamada; commit `0df724d`).
- Producción corre con **Node 24.21.0** (NodeSource `node_24.x`) desde 2026-09-13; pm2 levanta
  `start.sh` con intérprete bash y la lista está guardada en `/root/.pm2/dump.pm2`.
  Vuelta atrás: `/opt/fusionbikes/rollback-node20/` (paquete .deb de Node 20 + tarball de
  `node_modules` compilado para Node 20).
- **Lección del cambio de Node (caída de 13 min, 15:16–15:29 UTC):** `apt-get install nodejs`
  reinicia el daemon de pm2 (`pm2-root.service` corre `pm2 kill` / `resurrect`) **antes** de
  recompilar los módulos nativos; la app murió por `NODE_MODULE_VERSION` de `better-sqlite3` y
  pm2 la dejó fuera de la lista. En un próximo cambio de versión: `pm2 stop herramientas`,
  instalar, `npm rebuild better-sqlite3 sharp`, `pm2 start` + `pm2 save`, y verificar
  `/healthz` en el momento.
- **QA bajo demanda** (plan `2026-09-13-qa-bajo-demanda.md`): `scripts/qa/qa.sh up [rama] | down |
  status`. Sólo `127.0.0.1:3101` (túnel SSH para mirar), snapshot anonimizado de la base,
  MercadoLibre/Woo simulados (`scripts/qa/simulador-canales.mjs`, control en `/__qa/llamadas` y
  `/__qa/fallas`), usuarios con la clave de `/root/.config/fusion-qa/clave`, apagado solo a las
  8 h. Lo levanta el asistente cuando una prueba lo necesita; `down` al terminar.
  La cuenta `auditor` **no es admin** (`is_admin=0`, sólo lectura en algunas herramientas; medido
  2026-09-13 en producción y en QA): para probar rutas de escritura en QA usar un usuario admin con
  la clave de QA.
- **E0 nivel 1 ensayado en QA (2026-09-13, sin desplegar en producción):** `deploy/postgres/`
  (PostgreSQL 18.6 por digest `sha256:1c59e2c3…e1af` + pgBackRest 2.59.1 del repo PGDG de la
  imagen, `pgbackrest.conf` con archive-push asíncrono, spool 5 GiB, zstd, aes-256-cbc,
  retención 2 completos) y `npm run test:e0` (`scripts/postgres/test-e0.sh`, proyecto y
  directorio temporales, se borra solo; `E0_KEEP=1` conserva). Resultado limpio: 7/7 escenarios,
  demora de archivado 1 s, segmento cerrado durante la caída del push archivado en 57 s sin perder
  WAL, restauración PITR exacta (1.500/1.500 filas, 0 posteriores) con RTO 5 s, RPO estimado ≤ 61 s,
  legacy intacto; registro sha256 `e43f7869e9b9…5792`. Firma criptográfica del registro pendiente.
- **E0 nivel 1 en producción desde 2026-09-13 22:36 UTC:** `docker compose -f
  deploy/postgres/compose.prod.yml -p fusion-pg` (PostgreSQL 18.6 + pgBackRest 2.59.1, init,
  `127.0.0.1:5432`, 768 MB, datos en `/opt/fusionbikes/postgres/{pgdata,repo,spool,log}`). Secretos
  en `/root/.config/fusion-pg/` (`cipher-pass` creada por José y guardada fuera del VPS;
  `postgres-pass` uid 999; `firma-ed25519.pem`, pública en `deploy/postgres/firma-ed25519.pub`).
  Cron `/etc/cron.d/fusion-backup`: `backup-diario.sh` 05:30 UTC (full domingo / diff; verify,
  manifiesto `repo/MANIFEST-fusion.sha256`, registro firmado en `/opt/fusionbikes/backups/pg-registros/`)
  y `estado-archivo.sh` cada 5 min (archivos `.ready` pendientes). Vigía `revisarBackupPostgres`
  cada 5 min; se activa porque existe `/opt/fusionbikes/postgres`. Ninguna app conecta todavía.
  Comandos: `... exec -T pg pgbr info|check|backup`. Nivel 2 (Mac): `deploy/postgres/mac/INSTALAR-NIVEL-2.md`.
- **SSH sólo por clave desde 2026-09-13** (José entra por clave; 8/8 ingresos aceptados eran
  `publickey`): `/etc/ssh/sshd_config.d/00-fusion-hardening.conf` con `PasswordAuthentication no`,
  `KbdInteractiveAuthentication no` y `PermitRootLogin prohibit-password`. Prefijo `00-` porque sshd
  toma el primer valor y `50-cloud-init.conf` habilitaba la contraseña. Aplicado con reload tras
  `sshd -t`; revertir = borrar el archivo y `systemctl reload ssh`.
- El gid 999 del contenedor PostgreSQL es `systemd-journal` en el host: no usar pertenencia a grupo para
  dar lectura al repositorio (nivel 2 usa ACL).
- Vigía PostgreSQL activo tras reinicio de la app (2026-09-13 22:42 UTC): desplegado, sanos backup,
  archivado y spool; 0 incidentes. Primer tick del cron de medición a las 22:40 UTC con 0 pendientes.
- **Lección:** el contenedor de PostgreSQL necesita **init como PID 1** (`init: true`). Sin init,
  el push asíncrono de pgBackRest queda huérfano de postgres y su muerte (kill/OOM) provoca
  recuperación de arranque con corte de todas las conexiones (medido). Además `failed_count` de
  `pg_stat_archiver` es acumulado e incluye intentos previos a `stanza-create`: medir por ventana.

## Restricciones

- No iniciar `node server.js` contra `data/fusion.sqlite` real.
- No hacer push forzado a `master` ni usar una tarea documental como autorización de despliegue.
- No dejar servidores o procesos de pruebas vivos.
- Una actualización documental no autoriza migraciones, cambios de configuración, reinicios de
  PM2 ni pruebas que escriban datos operativos.
- El staging objetivo es una instancia separada con snapshot sanitizado bajo demanda y sin credenciales reales de escritura. No elegir por cuenta propia producción, otro puerto o una base real como sustituto.

## Cuándo actualizar

Ante cambios confirmados de infraestructura, dependencias del sistema, proceso de staging o
despliegue, incluso cuando no haya cambios de código. El estado transitorio va en
`../active.md` y debe verificarse en vivo antes de usarlo.

## Nivel 2 DR: usuario de lectura (2026-09-14)

- `fusion-offsite` existe con **uid 1999** (bloqueado, sin contraseña) y ACL `rX` sobre
  `/opt/fusionbikes/postgres/repo` (también por defecto para archivos nuevos). Verificado: lee todo el
  repositorio y no puede escribir. `authorized_keys` tiene sólo la clave `mac-local-fusion-offsite` (2026-09-14) con `restrict,command="/usr/bin/rrsync -ro /opt/fusionbikes/postgres/repo"`. Verificado por SSH real con clave temporal: descarga 1007/1007 y manifiesto OK; subida, shell y rutas fuera del repo rechazadas.
- uid **999** en el host = postgres del contenedor `fusion-pg-pg-1` (dueño de `repo` y `pgdata`). Nunca
  crear usuarios con `useradd --system` sin `--uid` explícito.
- IP pública del VPS para el destino de la Mac: 179.197.74.83. El contenedor se llama `fusion-pg-pg-1`.
- **SSH 2026-09-14:** apareció `/etc/ssh/sshd_config.d/00-00-local-password.conf` (13:57:50 UTC, con
  recarga de sshd) que antepone `PermitRootLogin yes` y `PasswordAuthentication yes` al endurecimiento.
  Los logins con contraseña de ese día vinieron de la IP del local. Por decisión de José se borró el
  mismo día (copia en `/root/00-00-local-password.conf.bak-20260914`); efectivo otra vez
  `passwordauthentication no`, `permitrootlogin without-password`. Si el panel de Hostinger lo vuelve a
  crear, revisar antes de borrarlo.
- **Primer pull de la Mac OK (2026-09-14 20:28 UTC):** `OK: 1002 archivos verificados; foto diaria
  2026-09-14`, en ~3 s. Usuario de la Mac: `santi`; script en `~/FusionBackups/offsite-pull-mac.sh`.
  launchd `ar.com.fusionbikes.offsite-pull` instalado y cargado (corrida automática 20:29 UTC OK).
  Pendiente: heartbeat opcional y la restauración de prueba desde la copia de la Mac (aceptación del nivel 2).
- **Restauración desde la copia de la Mac (aceptación nivel 2):** `scripts/postgres/restaurar-desde-mac.sh`
  restaura lo que la Mac sube a `/opt/fusionbikes/qa/restore-mac/entrada` (usuario `fusion-restore`, uid
  1998, pensado para `rrsync -wo`; solo puede leer el manifiesto del repo de producción) en un contenedor
  sin red, verifica hashes, `pgbackrest verify`, la marca de `public.e0_verificacion` indicada en
  `qa/restore-mac/marca-esperada` y firma el registro en `pg-registros/restore-mac-*.json`.
  Lecciones del ensayo 2026-09-14: `--target-action` exige `--type` de objetivo (error 031), y el
  `postgres` restaurado necesita la clave del repo en su entorno (archive-get), leída como root y
  bajando con gosu. Ensayo con copia armada en el VPS: OK, RTO 7 s (etiquetado ENSAYO, no es aceptación).
- **Heartbeat "Backup PostgreSQL (VPS)" activo (2026-09-14):** Better Stack, período 1 día; URL en `.env`
  como `PG_BACKUP_HEARTBEAT_URL` (no se copia en docs). Ping de prueba HTTP 200; lo envía
  `backup-diario.sh` a las 05:30 UTC.
- **Observación de 24 h de WAL (13/09 22:36 → 14/09 22:36 UTC):** 0 fallos de archivado dentro de la
  ventana (los 9 de `pg_stat_archiver` son del despliegue, antes del stanza), WAL 01→11 continuo y
  `pgbackrest verify` OK, sobrevivió al reinicio del VPS de 13:45 UTC, backups full y diff firmados OK,
  0 incidentes del vigía de PostgreSQL.
- **Permisos de backups (2026-09-15):** `/opt/fusionbikes/backups/db` y `/opt/fusionbikes/backups/uploads`
  en `700` root (antes 755 con archivos 644, legibles por cualquier usuario local). Sólo los usa
  `backup.sh` (cron root 06:00 UTC). Memoria disponible medida ese día: 2,9 GB (Ollama 1,5 GB, legado 504 MB).

- **pgBackRest sin límite de cola en producción (2026-09-15 10:38 UTC, PM-177):** imagen `fusion-pg:local`
  reconstruida y contenedor `fusion-pg-pg-1` recreado; `test:e0` 8/8 antes (RTO 12 s, RPO 61 s); después
  `pgbackrest check` OK, `init=true`, archivado sin fallos y la marca `e0_verificacion` intacta. El
  arranque de archive-push ya no lista `--archive-push-queue-max`. `estado-archivo.sh` publica
  `ready_bytes`, `pg_wal_bytes`, `disco_pct` (68 % ese día) y `disco_libre_bytes`.
- **Subida de la Mac para restaurar (2026-09-15):** `fusion-restore` (uid 1998) tiene sólo la clave
  `mac-local-fusion-restore` con `restrict,command="/usr/bin/rrsync -wo /opt/fusionbikes/qa/restore-mac/entrada"`
  (verificado: sube; lectura, shell y rutas fuera rechazadas). La entrada debe ser `fusion-restore` 700 sin
  ACL: `cp -a origen/. entrada/` o `rsync -a` sobre la raíz copian dueño/permisos de la carpeta y la
  rompen (pasó con el ensayo del 14/09). La Mac sube con `rsync -rt` (sin permisos). Borrar la clave al
  terminar la restauración.

## Correr un script de `scripts/` contra PostgreSQL de producción

Los scripts que escriben en PostgreSQL (`catalogo-atributos-backfill.mjs`,
`catalogo-categorias-importar.mjs`, `catalogo-informe-taxonomia.mjs`, `revivir-senales.mjs`) **no leen
`plataforma.env`** a propósito: esperar el entorno ya poblado es lo que evita que un script suelto
pueda abrir el archivo de configuración del servicio. Por eso hay que pasárselo en la invocación:

```
cd /opt/fusionbikes/herramientas && PG_HOST=127.0.0.1 PG_PORT=5432 PG_DATABASE=plataforma \
  PG_USER=plataforma_app PG_PASSWORD_FILE=/opt/fusionbikes/plataforma-prod/secretos/app-pass \
  node scripts/<script>.mjs <argumentos>
```

`PG_PASSWORD_FILE` es una **ruta**: el secreto no pasa por la línea de comandos ni queda en el historial
del shell. Los secretos viven en `/opt/fusionbikes/plataforma-prod/secretos/` (`app-pass` para el rol de
la aplicación, `migrador-pass` para el migrador, que un script no debería necesitar nunca).

El `cd` no es decorativo: los scripts que además hablan con un canal toman `WOO_URL`/`WOO_CK`/`WOO_CS`
y `DB_PATH` del `.env` del legado vía `dotenv/config`, que se resuelve desde el directorio de trabajo, y
desde `/tmp` fallan con `ERR_MODULE_NOT_FOUND` por la resolución de `node_modules`.

Ids de producción que estos scripts piden como argumento (lectura de `core.channel_accounts`, 2026-09-20):
empresa `01a0ad82-dcf5-7235-a8d6-13fe30b386a2`; cuenta de WooCommerce
`01a0ad82-de15-7a79-b935-dc665538cd05`; cuenta de MercadoLibre `01a0b28d-18e4-733b-b53f-64d1be288253`.
