# Operación del VPS y despliegue

## Recuperación de Sombra — 2026-10-15

La firma Woo quedó reparada conservando el secreto efectivo del proceso: `.env` usa comillas para que shell y dotenv lo interpreten igual. Webhooks 17–20 alineados y activos; pings autenticados 200. El monitor fue refrescado desde Woo y comprobó los ocho webhooks propios sin caídos ni ausentes. El ping prueba autenticación; la recuperación de entregas de negocio se verifica con tráfico natural, sin generar pedidos de prueba.

Respaldo de la configuración de firma: `/opt/fusionbikes/backups/sombra-firma-2026-10-15T18-11-47-971Z`. Respaldo de PostgreSQL/configuraciones: `/opt/fusionbikes/backups/sombra-recuperacion-20261015`. Worker vigente verificado el 16/10 a las 14:22 UTC: `fusion-plataforma:sombra-mensajes-20261016-r4`, imagen `sha256:549542828674ab2966951bd6bbb1de3e17cb2fc024fe8ef17426b15bccd2acb1`, iniciado a las 14:05 UTC por otra sesión. Incorpora el adaptador liviano de PR42 y la corrección de restauración de hijas Woo de PR45, sobre la recuperación de PR38. Compose debe incluir `/opt/fusionbikes/plataforma-prod/sombra-worker.override.yml`. PostgreSQL/API/scheduler también fueron recreados el 16/10 alrededor de las 12:17 UTC; no afirmar que conservan los contenedores del 15/10. Cuotas efectivas verificadas sin cambios. El reporte firmado del 15/10 sigue rojo por faltantes históricos; las compensaciones terminaron y se conserva la evidencia. E1 continúa sin aceptación: se requiere observación sostenida de r4 y siete días verdes. Evidencia detallada en la rama de PR38: `docs/superpowers/evidence/e1/2026-10-16-seguimiento-capacidad.md`.

Decisión de José: conservar la captura para consumidores futuros. La medición `scripts/ops/medir-recuperacion-sombra.sql` distingue esos pendientes sin intentos de los errores de consumidores activos. El reparto vigente mantiene 60 RPM globales: mensajes 30, envíos 20, publicaciones 4, pedidos 3, preguntas 2, reclamos 1; E2/E3 sigue en cero. Antes de siete días verdes falta confirmar capacidad sostenida durante 24–48 horas. No reducir crons para ocultar el atraso.

La verificación de avance detectó que la imagen heredada no incluía el motor reanudable presente en Git. La reparación requiere publicar juntos `adaptadores/ml.ts`, `relectura.ts`, `motor.ts` y `corridas.ts`; comprobar sólo los adaptadores no basta. El artefacto debe probarse con su propio código extraído y el avance debe verificarse en `integrations.sweep_runs.cursor_after`.

## Operación vigente POS y ARCA — regreso a la web, 2026-10-06

POS y Facturador ARCA vuelven a operar exclusivamente en fusionbikes.com.ar, por decisión del usuario. Herramientas ofrece accesos directos; los informes, directorio y etiquetas Andreani/corrector PDF permanecen en el VPS. Los enlaces antiguos ?fm_module=pos/facturador redirigen a la web. El gateway con FUSION_SALES_LOCATION=web bloquea las API antiguas de POS, facturación y envíos manuales del VPS; los enlaces PDF ya compartidos conservan su vigencia original.

Antes de habilitar la web se deshabilitó fusion_arca_vps_enabled y production_enabled en la copia privada y FUSION_POS_VPS_ENABLED en gateway.env; se conciliaron 173 comprobantes, 14 series, 225 ventas ML y 6 registros WhatsApp sin diferencias fiscales. La factura nueva 173/pedido 70706 ya estaba archivada en Woo. Numeración confirmada con ARCA: punto 15 A1/B15/NC_A0/NC_B1; punto16 A7/B135/NC_A0/NC_B0. Ningún pendiente ni CAE solicitado durante las pruebas. El autor del recibo 173 es 0 en la tienda por el contrato del archivo original.

En la web fusion_arca_vps_cutover queda vacío, respaldado junto con settings/ML en opciones fusion_return_web_20261006_*. La emisión manual del punto15 está habilitada y el usuario autorizó recuperar el automatismo ML del punto16. La automatización web por cambio de estado conserva su pausa. Certificados originales y conexión Meta for WooCommerce permanecen en la web. No se cambió Master Control ni precios.

Servicios privados VPS fusion-arca-egress/source y timer outbox detenidos y deshabilitados. El backup fiscal diario conserva el archivo y los borradores/operaciones anteriores. Respaldo del regreso: /opt/fusion-management-migration/backups/return-web-20261006T184545Z. No volver a habilitar VPS ni restaurar una base antigua después de nuevas emisiones web sin otro corte y conciliación. Historial anterior de migración que contradiga esta sección queda superado.

Verificación del regreso: 33 pruebas focalizadas de gateway, desvíos, bloqueo de API, POS, catálogo, transporte fiscal y entrega aprobadas en copia aislada sin credenciales productivas. UI real: WordPress WSFE y Padrón conectados; POS encuentra FB-70394 con stock1/contado ARS4.450.000 y ofrece 3/6/9/12/18/24 cuotas antes del cobro. Se retiró el producto de prueba, borrador web guardado vacío; no se creó un pedido ni se solicitó CAE de prueba. SQL confirmó ML enabled/automatic true, punto16, producción web true; tareas ML recientes completas. Informes VPS cargan 10.140 líneas y Andreani consulta el historial sincronizado. No se probó un envío real de correo/WhatsApp ni un cobro. Las 33 pruebas no constituyen la suite completa del proyecto.

## Hechos durables

- Ajuste E1 contra 429 de ML desplegado el 2026-09-30: worker en imagen `fusion-plataforma:e1-ml429-20260930T031014Z` y gateway legado recargado en PM2; sin migraciones ni cambios de RPM. API y scheduler no se recrearon. Rollback e IDs de imagen constan en `docs/superpowers/evidence/e1/2026-09-30-E1-429-api-fix-deploy.md`. La medición Tarea 0 de 24–48 horas todavía decide la calibración y el inicio de PM-186; el despliegue no equivale a aceptación E1.
- Preparaciones desplegadas el 2026-09-29: commits 7678096a-57272c22 en conteo-confiable; migraciones 115-116 aplicadas tras el respaldo `/opt/fusionbikes/backups/db/predeploy-preparacion-20260929T200500Z.sqlite` (`quick_check` e `integrity_check`: ok). Vista previa en vivo de 11 preparaciones: diez Web enviadas y una ML cancelada, sin errores. Cron activo (`PREPARACION_RECONCILIACION_ACTIVA=true`); primer tick 23:58 UTC procesó las 11 con cero errores: diez `despachada_sin_verificar`, una `cancelada_sin_retiro_registrado`, cero abiertas, once intentos y un evento de transición por prep. PM2 online, `/healthz` 200; ítems, fotos y auditoría conservados. El usuario rotará preventivamente la credencial Woo otro día; esa rotación no bloquea la operación. Prep 446 / pedido 70312 sigue fuera del lote y sin reparación; revisar su evidencia por separado.

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

El informe de taxonomía (`catalogo-informe-taxonomia.mjs`) se corre DESPUÉS de importar las categorías del
canal, no antes: traduce los `category_id` de MercadoLibre a nombres leyendo `catalog.channel_categories`, y
con esa tabla vacía cada id de ML queda sin traducir, ningún modelo publicado en los dos canales puede
coincidir y el desglose del puente (`cobertura.puente`) sale inflado con todos ellos. No es un hallazgo del
catálogo: es el informe corriendo sin su diccionario.

El desglose del puente es INVÁLIDO mientras no se importen las categorías de MercadoLibre. Medido el 2026-09-20, ya con las 82 categorías de Woo importadas: 942 modelos publicados en
los dos canales, y los 942 con el `category_id` crudo de ML (126 ids distintos). El número es idéntico al de
modelos en ambos canales, así que no mide contradicción: mide doble publicación. Importar Woo no lo arregla,
porque los valores de Woo ya eran nombres; los que necesitan diccionario son los `MLA*`, y esa importación no
existe todavía. No leerlo como un hallazgo del catálogo.

**Al 2026-09-20 esto quedó superado y el campo `contradictoriosEntreCanales` ya no existe.** El informe mide
por NODO del árbol propio, que es exacto, y dejó el criterio de nombres agrupado en `cobertura.puente`, que
cubre exactamente `sinNodoEnAlgunCanal` — los modelos a los que todavía les falta nodo en algún canal — y se
retira cuando ML esté mapeado del todo. Se le sacó el nombre viejo a propósito: había cambiado de significado
dos veces y nada fuera del informe lo consumía, así que el único riesgo era que una persona leyera un número
creyendo que medía lo de antes. `cadenasIncompletas` vive ahora dentro de `puente`, porque sólo se calcula
subiendo cadenas de categorías del canal.

El comando de la plataforma se corre **desde `/opt/fusionbikes/herramientas`**, siempre. El `-f` es una ruta
relativa, así que desde otro directorio falla con
`compose file "/opt/plataforma/deploy/compose.yml" is invalid: no such file or directory`, que parece un
archivo faltante y es sólo el directorio de trabajo. Escribirlo con el `cd` adelante evita la confusión:

```
cd /opt/fusionbikes/herramientas && docker compose -f plataforma/deploy/compose.yml \
  -p fusion-plataforma --env-file /opt/fusionbikes/plataforma-prod/plataforma.env <subcomando>
```

**Un `migrate` sin `build` previo parece exitoso y no aplica nada.** El Dockerfile hace
`COPY migrations ./migrations`: las migraciones van HORNEADAS en la imagen, no montadas. Si la imagen no tiene
el archivo nuevo, el migrador no ve nada pendiente, informa éxito y sale 0. Pasó el 2026-09-20 con la 0016: se
corrió el `migrate`, dio bien, y `core.schema_migrations` seguía en 15 — y encima la carga posterior escribió
58 de 78 mapeos porque el índice viejo seguía puesto.

El `build` NO es opcional ni una optimización: es parte del despliegue, y va primero de los tres.
Verificar SIEMPRE contra la base y no contra la salida del comando:

```
docker exec fusion-pg-pg-1 psql -U postgres -d plataforma -c \
  'select count(*), max(nombre) from core.schema_migrations'
```


- El VPS no tiene el binario `sqlite3`: el backup previo a un deploy se hace con `better-sqlite3` (`db.backup()`) desde Node, y el deploy no sigue si el backup no existe.
- Las credenciales de testing `auditor`/`Auditor2026!` no autentican en la base de producción (verificado 2026-10-05); valen para QA.

## Preparación de integración WordPress (2026-10-04)

- Puente WordPress independiente `fusion-herramientas-bridge` instalado y activo (actualizado a 0.2.0 abajo)
  desde la sesión de administración autorizada. No se modificaron los cinco plugins
  originales ni el runtime de Herramientas, ni se reiniciaron sus servicios.
- Fuente y prueba conservadas en `integrations/wordpress/`; especificación y plan
  `docs/superpowers/{specs,plans}/2026-10-04-puente-wordpress-lectura.md`.
- Prueba PHP aislada sin red: 44 comprobaciones con servicios originales de Master
  Control. Lectura real desde VPS: anónimo 401, autenticado 200, cotización 200,
  IDs duplicados 400. Estado habilitado de pasarelas y versiones de plugins originales
  conservados. No se realizaron transacciones ni se enviaron mensajes.
- Retirada: desactivar solamente `Fusion Herramientas — Puente de lectura` en WP.
  No borra datos ni requiere restaurar la base. Los módulos principales siguen en WP.
- Master Control debe permanecer íntegro por instrucción explícita del usuario.

## Chat nativo: ensayo aislado del 2026-10-04

- Proyecto independiente `/opt/fusion-chat-migration-qa`, Compose `fusion-chat-migration-qa`: API/worker con bot simulado, PostgreSQL y Redis propios. Sólo datos ficticios; no es producción ni una migración terminada.
- Red Docker interna sin puertos publicados ni salida a Internet; vista `/qa/` por túnel SSH ligado a loopback local. `qa.env` privado, nunca copiarlo al repositorio. Límites de memoria/CPU definidos por servicio.
- Fuente mantenida en `integrations/chat-migration-qa/`; allí están contratos, límites, reproducción de pruebas y comandos de inicio/parada. Plan: `docs/superpowers/plans/2026-10-04-chat-migracion-qa.md`.
- Respaldo previo del bot (código/configuración y dump PostgreSQL): `/opt/fusionbikes/backups/chat-migration/20261004T220310Z`; archivo e índice verificados, restauración completa pendiente.
- Los procesos, código y tráfico del bot original/Herramientas no se trasladaron. Master Control, checkout y plugins originales permanecen en su ubicación. No atribuir ahorro de carga de WordPress a este ensayo.
- Pendiente antes del corte: integración con sesión/permisos Herramientas, widget completo, datos/historial, leads y carrito abandonado, configuración/aprendizaje, WhatsApp/IA reales, notificaciones/retención y reversión. Diferencia previa entre test y lógica de derivación a Taller documentada en el README; no habilitar tráfico real asumiendo suite original verde.

## POS, Facturador y Taller: consulta en VPS (2026-10-04)

- Runtime independiente `/opt/fusion-management-migration`, WordPress 7.1.2/WooCommerce 11.1.2/PHP 8.2 con SOAP y los tres ZIP actuales. Master Control no se instaló ni modificó. Fuente propia en `integrations/management-migration/`; plan `docs/superpowers/plans/2026-10-04-pos-arca-taller-vps.md`.
- Entrada `/herramientas/gestion-vps/`, sesión vigente de Herramientas y administrador en cada solicitud. Gateway systemd `fusion-management-validation.service`, 127.0.0.1:8212, firma HMAC interna. PHP/DB en red interna Docker, sin puertos publicados; escrituras HTTP, cron, correo y salida externa bloqueados. Requiere actualizar IP de PHP con `ops/start-gateway.py` si se recrea su red/contenedor.
- Historial copiado y conciliado por página/hash y por columna: 153 comprobantes, 14 series, 221 estados ML y 6 estados WhatsApp; 27 presupuestos; 1 trabajo y 1 modelo de Taller, 2 constancias, 0 recordatorios. Cinco borradores conservados para mapear operadores, todavía no asignados. No se copiaron contraseñas, sales ni certificados fiscales.
- Origen privado: `data/2026-10-04T23-06-05-446Z`; respaldo destino previo a importación `backups/20261005T004328Z/before-import.sql`; respaldo Nginx previo al nuevo location `backups/20261005T004439Z/herramientas.nginx.conf`, todos dentro del runtime. No se ensayó restauración completa ni se obtuvo snapshot de corte con origen bloqueado.
- Puente WordPress actualizado a 0.2.0. Los dos GET de exportación/inventario exigen `manage_options` además del permiso Woo y HTTPS; recursos fijados, 50 filas/página, sin credenciales. 61 comprobaciones PHP. Gateway: tres pruebas HTTP integradas y comprobación real de sesión, firma vencida, bloqueo de métodos y acceso anónimo. Tienda y Herramientas respondieron 200. No se reinició la app principal.
- Las pantallas originales permiten consultar Taller, comprobantes y presupuestos con la sesión de Herramientas. Se adaptaron navegación y tabla móvil de Taller sólo en el envoltorio del VPS. La copia permite buscar el catálogo sincronizado local con cantidad y fecha; faltan campos comerciales/clientes/pedidos para operar y sus controles de negocio están bloqueados. No atribuirle un corte productivo ni ahorro medido de carga.
- Pendientes: completar campos comerciales del catálogo, clientes/pedidos e identidades; precios de Master Control/dólares; checkout POS original e idempotencia; configuración/certificados ARCA y conexiones ML/WhatsApp; documentos y recordatorios; corte con un solo escritor/emisor y rollback ensayado. Se consultó por SSH/SFTP del hosting para transferir certificados por canal privado. Los módulos originales continúan como autoridad y Chat sigue en QA.

<!-- end management validation memory -->

- Acceso a Gestión VPS añadido a `public/home/index.html` el 2026-10-04 (Argentina), sólo como navegación de administradores. Publicación estática sin reinicio ni migraciones; conservar permisos pero actualizar mtime al publicar HTML para que If-Modified-Since reciba la versión nueva. Respaldo y candidato en `/opt/fusion-management-migration/home-navigation/{before,candidate}.html`; suite completa ejecutada en copia aislada sin red ni datos/credenciales de producción. Revertir sólo si el hash vigente sigue coincidiendo con `home-navigation/result.json`.

- Catálogo local y estética de Gestión VPS publicados el 2026-10-04 (Argentina). Respaldo final: `/opt/fusion-management-migration/backups/catalog-20261005T025118Z`. Sólo se reinició `fusion-management-validation.service`; app principal, sincronizadores, tienda y Master Control sin cambios. Fuente en `integrations/management-migration`; once pruebas HTTP/unitarias y lint PHP/JS. Cantidad local, contado de Consulta de Precios y miniaturas verificados en navegador. Archivo ML: 221 registros visibles, paginación/filtro y bloqueo de escrituras probados. Falta OAuth/sincronización ML activa, validación comercial y corte operativo.

- Directorio compartido publicado 2026-10-05. Respaldo `/opt/fusion-management-migration/backups/directory-20261005T143651Z`; sólo se reinició gateway de validación. `fusion-management-directory-sync.service` hace GET con credenciales Woo preexistentes; timer cada 15 min para pedidos modificados con solapamiento 10 min, clientes cada 24 h y conciliación completa semanal. Descarga histórica con checkpoints privados y reanudación; primero publica clientes y marca pedidos incompletos, luego publica historial completo atómicamente. Gateway DynamicUser lee mediante grupo limitado `fusion-management-read`; credenciales siguen fuera. Última copia válida ante fallo. Pruebas 17 Node y 5 Python (incluye interrupción/reanudación), sintaxis JS y control de lectura bajo cuenta del gateway. Ver `directory-cache/status.json` para cobertura actual; no inferir fin de carga de la publicación de UI.

- Directorio: carga histórica y actualización incremental verificadas el 2026-10-05. La carga inicial concilió 1.593 cuentas customer y 13.888 pedidos desde 2023-03-09; el primer delta incorporó dos pedidos (13.890), con dos GET. 434 pedidos tienen marca de copia ML. UI probada: clientes POS, búsquedas por SKU y pedido exacto (#6115), detalle histórico y compras por ID de cliente. No hay mapeo de escritura ni selector fiscal ARCA; directorio compartido de consulta. No interpretar las fichas por pedido sin cuenta sincronizada como clientes únicos. El importador legado que acumula contactos repetidos no se modificó ni alimenta este índice.

- Flujo git del equipo (2026-10-06): `docs/operations/flujo-git-equipo.md`. Checkout de prod no se edita; worktree+rama por persona; `master` principal por PR sin aprobación humana con gates; deploy con OK de José. Codex Astra (migración POS/Gestión VPS) entra por SSH como root desde fuera del VPS.
- 2026-10-05: Panel de ventas 1.1.0 trasladado a `/herramientas/gestion-vps/ventas/`, bajo sesión/admin vigente y acceso desde Gestión/Directorio. Consultas, filtros, gráficos y CSV calculados sólo en caché VPS `metrics.sqlite`; usa pedidos del directorio (dp=8 explícito y checkpoint versionado), catálogo analítico diario y devoluciones por ítem del puente 0.3.0. Dos timers de 15 min; desfase combinado hasta aproximadamente 30 min, fecha real y alertas visibles. Paridad exacta de 452 líneas de septiembre 2026 (295 pedidos, 497 unidades, ARS 346.975.881) y 23 líneas de marzo 2023 (22 pedidos, 33 unidades, ARS 1.441.599,80), incluidos productos eliminados/reembolsos sin asignar. CSV descargado idéntico byte a byte al origen. 22 pruebas Node, 10 Python, 87 aserciones PHP. Snapshot/generación evita páginas o CSV mezclados; no se exponen contactos en analítica. Respaldo inicial metrics-20261005T154728Z, final metrics-20261005T160049Z; importador precision-20261005T155348Z. Sólo se reinició gateway; Master Control, precios/checkout/emisores originales intactos. POS/ARCA/Taller siguen consulta y Chat productivo pendiente. Usuario agregó migrar generador Andreani funcional: auditoría del plugin 1.1.2 iniciada, aún no publicado en esta etapa.

- 2026-10-05: Generador Andreani 1.1.2 migrado funcional a `/herramientas/gestion-vps/andreani/` y enlazado en Gestión. Lee pedidos/dimensiones locales (directorio shipping_fields_version=1, puente 0.3.1 sólo agrega virtual), guarda revisión versionada y exportación en SQLite privada del gateway; worker PHP interno reutiliza reglas y XLSX originales. Filtro inicial Todos, DNI/teléfono/domicilio y bultos revisables, domicilios/sucursales/Llega hoy, perfiles bicicleta categoría 62 editables. Sesión/admin actual + Origin + CSRF ligado a connect.sid; otras mutaciones continúan 423. 31 pruebas Node con roundtrip real aislado y 22 aserciones PHP; partes no editadas de plantilla idénticas, prueba real de consulta sin guardar/exportar pedidos reales. Descarga privada por autor 24 h, marcas permanentes. Estado nuevo en /var/lib/fusion-management-validation/andreani.sqlite (0700/umask0077), incluir en backups; código reconstruible en integrations/management-migration/andreani. No devuelve nuevas marcas a Woo: usar Herramientas para nuevas preparaciones, no operar el mismo pedido desde ambos generadores. No contratación/pagos ni envío de datos a Andreani; subir Excel en su portal. Backups inicial andreani-publish-20261005T165614Z y corrección andreani-publish-20261005T170119Z; sólo gateway reiniciado, Master Control intacto. Panel de ventas funcional; POS/ARCA/Taller aún consulta y Chat pendiente.

- 2026-10-05: Andreani Observaciones ahora agrega automáticamente el título histórico del primer producto a enviar (primera línea con cantidad positiva y no virtual), conservando aclaraciones de entrega y sin duplicarlo al reabrir o guardar. Regla aplicada en lectura de borradores nuevos/existentes, normalización y nuevas exportaciones. No reescribe archivos ya generados ni modifica la tienda. 27 aserciones PHP y validación del XML de Observaciones en las hojas domicilio/Llega hoy; plantilla de sucursal conserva su esquema original sin columna de observaciones.

- 2026-10-05: Corregida selección de bultos Andreani: borradores importados/locales con un único perfil predefinido conservaban other aunque el producto padre pertenecía a bicicletas. Perfil automático ahora se recalcula al abrir, guardar y exportar; no invalida por sí solo una revisión de destinatario existente. UI agrega Automático según los productos y conserva elecciones explícitas con profile_mode=fixed; medidas personalizadas, cajas guardadas y elecciones heredadas de varios bultos se respetan. Nuevos bultos automáticos llevan profile_mode=auto. Reglas configuradas: bicicletas 30×20×40 cm/9000 g; resto 12×25×30 cm/1000 g. 39 aserciones PHP, incluido Excel de borrador legado mal clasificado y casos manual/caja/múltiples. Tanda de 16 del 2026-10-05 15:03 ART: 11 bicicletas tenían perfil chico; se creó copia privada corregida modificando únicamente B–E (peso/medidas), sin cambiar destinatarios, referencias, observaciones, estados ni marcas originales. No se contrató/envió nada a Andreani. Archivo privado descargable 24 h para su autor, reporte en runtime andreani-package-correction.json.

- 2026-10-05: Por cambio solicitado, Andreani Observaciones ahora usa Pedido #<número visible Woo> en lugar del título. Aplicado permanentemente en la aplicación VPS al abrir borradores nuevos/existentes, guardar y generar nuevos Excel. Retira el antiguo título automático sólo como segmento completo, preserva aclaraciones de entrega y no duplica el número; menciones de productos dentro de frases manuales se conservan. 42 aserciones PHP y verificación XML de Observaciones; clasificación automática de bultos y medidas manuales conservadas. Archivos ya generados permanecen históricos; plantilla de sucursal sigue sin columna de observaciones. Fuentes en integrations/management-migration/andreani/worker.php.

- 2026-10-05: Corrector de etiquetas PDF publicado en Home/Gestión: `/herramientas/gestion-vps/corregir-etiquetas/`, requiere sesión administrador y Origin/CSRF. Entrada y salida editables (peso Gr, ancho/alto/largo Cm), enteros positivos hasta 6 dígitos en peso y 4 en medidas; valores habituales 9000/20/30/40 → 15000/25/70/150 y botón restaurar. Coincidencia conjunta exacta por página; no modifica pedidos ni registros de Andreani. Conserva fuentes/imágenes; ajusta ancho de líneas largas. Vista paginada, impresión al100% y descarga. Regla JSON X-Fusion-Pdf-Rule validada por gateway/Python; sin cabecera aplica habituales para clientes anteriores. Campos bloqueados durante corrección/impresión; cambiar invalida resultado. PDF en memoria sin historial,10MiB/300páginas. Worker loopback8213 autenticado, unidad `fusion-pdf-corrector.service`, fuente `/opt/fusion-pdf-corrector`; gateway `/opt/fusion-management-migration`, guía y pruebas en `integrations/management-migration/README-PDF.md`, pypdf6.10.0/PDF.js5.6.205 locales. Impresora física no probada. Actualización manual con backup /opt/fusion-management-migration/backups/pdf-manual-20261005T193419Z. Home, nginx y aplicación principal sin cambios.

- 2026-10-05: Ranking del Panel de ventas publicado en /herramientas/gestion-vps/ventas/. Carga inicial de últimos 12 meses, períodos rápidos, rankings paginados de productos y marcas por unidades o importe, participación y selección de una marca a sus modelos; comparación de varias marcas y filtros conservados al cambiar de período, incluso sin movimientos. Sólo cambiaron metrics.html, assets/metrics.js y assets/metrics.css; backend, cálculo, caché, sesión y CSV existentes conservados. 13 pruebas Node aprobadas; revisión real de carga automática, septiembre 2026, marca a productos, comparación múltiple, SKU, orden, período vacío y recuperación de filtros; 390/768/1440 px sin desborde del documento y sin errores de consola. Exportador real con la consulta generada en navegador: FB-63080, Venzo, 3 líneas, ARS 2.400.510, igual al panel. Los 30 archivos de runtime fuera del alcance conservaron su hash, incluidos Andreani y el corrector PDF. Sin reiniciar servicios. Respaldo: /opt/fusion-management-migration/backups/ranking-20261005T193115Z-535c3e. Para revertir, restaurar únicamente los tres archivos originales de ese respaldo; fuentes en integrations/management-migration y prueba ranking.test.cjs.

## Corte ARCA al VPS — 2026-10-05

Emisión manual de producción habilitada en punto 15; origen detenido con bridge 0.4.0. Historial reconciliado: 172 comprobantes (+19), 14 series, 225 ventas ML y 6 WhatsApp; IDs/hashes y numeración ARCA iguales (A1/B14/NC_A0/NC_B1). Ninguna factura emitida en validación. Certificados de producción privados fuera del webroot; SOAP con TLS y egress restringido. Servicios fusion-arca-egress/source, outbox durable cada minuto y backup fiscal local diario (14 copias) activos. POS/Taller siguen consulta; ML/bulk y automáticos pendientes. Correo y WhatsApp manual disponibles desde la actualización del 2026-10-06. Manual de operación, contratos y rollback seguro: integrations/management-migration/arca/README-ARCA.md. Backup corte: /opt/fusion-management-migration/backups/arca-cutover-20261005T235059Z. No reactivar origen ni restaurar DB antigua después de emitir sin conciliar CAEs.

Verificación ampliada del 2026-10-05: suite aislada de Gestión 44 aprobadas, 8 fallos y 1 omitida; los 8 fallos pertenecen a ranking.test.cjs (funciones de agrupación/fechas no exportadas), reproducidos al correr ese archivo solo. No se modificaron ranking ni métricas durante el corte ARCA; no afirmar suite global verde. Las 15 pruebas de gateway/catálogo/transporte fiscal y las pruebas nativas ARCA sí pasan. UI WSFE/Padrón y apertura real de PDF histórico verificadas; recepción idempotente del comprobante manual 11 sin pedido ni nuevas facturas aceptada en origen. Captura de escritorio sin desborde; el override de viewport del navegador no cambió su ancho efectivo de 1265px, por lo que no se afirma nueva prueba móvil.

- 2026-10-06: POS VPS activado con puente seguro 0.2.0 en tienda. Catálogo/directorio locales y borrador SQLite por operador; checkout, precio final y pedido en origen, Master Control intacto. HMAC de cuerpo/tiempo, CSRF y operación idempotente; no liberar pedidos existentes. Recorrido FB-70394 ARS 4.450.000 comprobado hasta checkout, luego preparación liberada/tablero limpio; ningún pedido/pago/factura de prueba. 20 pruebas Node y controles PHP aprobados. ARCA continúa en producción punto15; restauradas sus rutas antes de activar POS. Presupuestos nuevos, conversión y cobros manuales siguen pendientes de traslado. Fuente y límites: integrations/management-migration/README-POS.md. Backup de activación pos-active-20261006T104541Z.

Cierre POS 2026-10-06: respaldo diario privado ampliado con snapshot consistente pos.sqlite/configuración gateway y primera ejecución verificada; borrador limpio y operación de prueba liberada. Contraste de tarjetas corregido con variables del tema; confirmaciones internas permiten limpiar/liberar la preparación.

- 2026-10-06: POS VPS 0.3.0 restaura comparación previa de cuotas, checkout completo con plan seleccionado y cobro manual/entrega delegados al POS original antes del facturador ARCA integrado. Master Control intacto; búsquedas locales, cotización HMAC por canasta con caché 60s y revalidación al preparar. Recuperación de pedidos vinculada a actor. Renovación CSRF autenticada y reintento solo si pos_csrf. Ver integrations/management-migration/README-POS.md para contratos, validación y límites.


- 2026-10-06: Entrega manual recuperada en facturador VPS: email con PDF adjunto mediante SMTP existente (TLS verificado, confirmación de destinatario) y WhatsApp wa.me con enlace PDF siete días. Módulo Node delivery.mjs; persistencia privada delivery.sqlite, UUID/exclusión por comprobante/destinatario entre operadores, resultado incierto sin reintento automático. Solo descarga por token aleatorio expirable es pública; email/share/estado requieren administrador y escrituras Origin/CSRF. PDF nativo vía GET firmado, WordPress conserva bloqueo de correo/red genéricos. Backup fiscal incluye snapshot entrega/configuración SMTP privada. Validación funcional sin comunicaciones a clientes; entrega real de correo no probada. Contratos y rollback: integrations/management-migration/README-DELIVERY.md. Master Control y emisión ARCA sin cambios.

## Mensajería unificada (2026-10-07)

Bandeja Web/WhatsApp con sesión de Herramientas y roles propios. Matías con control completo
y administración global conservada; José supervisa; Santi/Miguel/Fabri atienden. Búsquedas,
historial, asignaciones, notas, IA y outbox en PostgreSQL del VPS. Widget y copia de presentación
en WordPress. Callbacks firmados con revisión, IDs opacos y cola de estado; importación sin IA.
Los modos de corte y rollback se coordinan; no restaurar bases antiguas sobre mensajes nuevos.
Contrato y rutas de respaldos: `integrations/mensajeria/README.md`. WhatsApp real conectado en coexistencia; emisores POS/ARCA, precios y Master Control no cambian.

Corte completado 2026-10-07 13:33 UTC: 526 sesiones y 1.372 mensajes fuente;
1.203 mensajes existentes reconocidos y 169 importados, todos mapeados. Ambos flags
activados; callback de presencia firmado confirmado y cola Web vacía en la verificación.
Entradas Chat de WordPress y Gestión redirigen a la bandeja. Imagen activa
`fusion-chatbot-unified:20261007`; plugin 1.7.18. Respaldos privados incluyen WordPress
antes/después, PostgreSQL, SQLite e historial fuente. El coordinador usa stdin para
ejecutar el corte como usuario restringido; no depende de un archivo temporal root.
Suite Node completa, 73 pruebas backend, 60 PHP y 3 de recuperación aprobadas;
QA visual con datos ficticios. Entrega real a clientes no usada como prueba.

## Conexión de WhatsApp comercial (2026-10-07)

La API de Meta confirmó coexistencia existente (is_on_biz_app=true, platform_type=CLOUD_API)
en ambos números; no necesitan nuevo registro. La app propia es Fusion Bikes Chatbot
(1394204749301211). Identidades verificadas: 4819 → phone 2185814538178526 / WABA
332553100782067; 2035 → phone 106810789054504 / WABA 117361584655886.
Los IDs reales están configurados en el VPS y la app está suscrita a ambas WABA y a
messages/history/smb_message_echoes, conservando campos e integraciones previos.
Meta publicó la app con autorización del dueño. El envío manual está habilitado para
ambos IDs; la IA de ambos números permanece apagada. Se verificó recepción desde los
dos teléfonos, reflejo de envíos hechos desde WhatsApp Business y respuestas desde la
bandeja del VPS con estado entregado/leído en ambos recorridos. Las únicas respuestas
de prueba se enviaron entre los dos números del dueño, con su autorización.
No se pidió una importación de historial antiguo ni se enviaron pruebas a clientes. El uso/área de
cada número espera aclaración; los nombres temporales provienen de los activos de Meta.
Imagen: fusion-chatbot-whatsapp:20261007. Respaldos privados y estados Meta antes/después:
/opt/fusionbikes/backups/whatsapp-connect-20261007. Coordinador:
/opt/fusion-whatsapp-connect-20261007/coexistence_remote.py. No repetir subscribe sin
reconciliar su marcador de intento; enable exige publicación y suscripciones verificadas.


## Audio, plantillas e inicio por teléfono (2026-10-07)

Imagen fusion-chatbot-inbox-tools:20261007 incluye FFmpeg/ffprobe y conversión Ogg Opus mono
con límites; columna aditiva inbox_media.is_voice. Dos conversiones simultáneas por proceso.
Nuevo chat idempotente por número/línea, sin envío ni cambio del estado del hilo existente.
Plantillas de texto posicionales con preview, consentimiento y revalidación antes de enviar.
No se habilitan plantillas pendientes/pausadas ni se reintentan envíos ambiguos.
Saludo fusion_inicio_atencion/es_AR aprobado en ambas WABA; revalidar estado real antes de enviar.
IA de ambos números apagada; no se cambia el modo del widget ni emisores fiscales.
Backup /opt/fusionbikes/backups/mensajeria-usabilidad-20261007, coordinador
/opt/fusion-inbox-tools-release-20261007/remote_deploy.py. Rollback detiene API antes de cancelar
plantillas en cola incompatibles, restaura software y conserva historial/flags. Fuente y manual
reconstruibles en integrations/mensajeria. No confundir QA con entrega real de audio/plantilla.


Publicación de usabilidad verificada el 2026-10-07: imagen activa en API/worker/outbox,
health correcto, columna is_voice aplicada, dos líneas conectadas y ambas IA apagadas.
Saludo aprobado y compatible en las dos WABA. Interfaz productiva de consulta verificada;
audio/plantillas completos sólo con transporte de QA, sin probar entrega real a clientes.
Servicios aislados y túnel de QA detenidos; respaldo y rollback disponibles en las rutas anteriores.


## Compartir productos, facturas y seguimiento (2026-10-07)

Acciones visibles junto al editor: Archivo, Audio, Producto, Factura y Seguimiento.
Producto abre un buscador por nombre/SKU con miniatura, variante, stock, fecha y precio
contado/transferencia web (precioContado sobre precio vigente, incluidas ofertas; no lista ML).
Consulta el catálogo SQLite local, con máximo 30 resultados. Elegir prepara un borrador;
Enviar sigue siendo explícito. No cambia checkout, Master Control ni stock.

Pedidos: copia sincronizada local, coincidencia exacta de teléfono completo y país;
nunca por últimos dígitos ni fusión automática. Hasta 50 pedidos recientes para elegir.
Factura agrega directamente el PDF único y vuelve a validar el teléfono en la tienda antes de
consultar comprobantes ya autorizados de producción y obtener el PDF. Puente de lectura
0.5.0 conserva autenticación Woo y permiso administrativo. GET acotado por pedido, sin
emitir, enviar, modificar pedidos o crear enlaces públicos. Esta acción consulta al facturador web; el producto elegido verifica la cotización comercial con caché. El archivo privado usa el transporte existente y queda en borrador;
su referencia sobrevive a recarga para el mismo operador y conversación. El servidor
verifica pertenencia y vigencia al enviar. Audio pendiente sigue siendo sólo en memoria.

Seguimiento usa números Andreani confirmados en preparaciones web, con enlace oficial
www.andreani.com/envio/<numero>. Exportar etiquetas no prueba que haya seguimiento.
Si no existe número registrado, se informa y no se inventa. El widget Web admite producto
y seguimiento como texto/enlaces; el PDF requiere WhatsApp. Fuera de la ventana de 24 h
desde el último mensaje entrante del cliente se ofrece Plantilla; dentro permanece oculta.

Contrato BFF: GET /products, GET /commerce/orders y POST /commerce/prepare.
Conserva sesión, permisos, responsable, Origin/CSRF, revisión e idempotencia del envío.
Fuentes: lib/mensajeriaCommerce.js, lib/mensajeriaInvoiceSource.js y
integrations/mensajeria/wordpress/fusion-herramientas-bridge. No cambia esquema ni bot.
Rollback de esta ampliación restaura software sin restaurar bases ni cancelar mensajes:
python3 /opt/fusion-inbox-share-release-20261007/remote_deploy.py rollback
Respaldo: /opt/fusionbikes/backups/mensajeria-compartir-20261007.
El puente puede permanecer como lectura o volver al ZIP 0.4.0 respaldado desde WordPress.
IA WhatsApp y emisores POS/ARCA se conservan; la emisión sigue únicamente en la web.


Publicación comercial verificada 2026-10-07: puente WordPress 0.5.0 actualizado y
Herramientas recargado, ambos health correctos. Producto FB-70394 confirma contado
ARS 4.450.000, stock y miniatura; buscador por nombre/SKU y preview comprobados en
conversación propia. PDF autorizado existente leído y validado en memoria, rechazo de
teléfono ajeno confirmado. Sin emisiones ni mensajes de prueba a clientes. IA, bot y
configuración conservados. Envío completo probado sólo con transporte sintético en QA.
Servicios de QA detenidos; rollback y respaldo conservan historial productivo.


### Mensajería — ficha comercial y adjuntos directos (2026-10-07)

El selector de productos filtra Solo con stock Sí/No sobre catálogo local antes del límite. Acciones con prefijo +. Elegir producto consulta el contrato comercial vigente con caché 60 s; comparte contado, cuotas 6/9/12/18/24 con redondeo público y envío gratis sólo según Master Control, sin modificarlo. Foto propia convertida a JPEG reducido se prepara como adjunto privado de WhatsApp; web conserva texto/enlace. Factura única del pedido elegido se agrega directamente al borrador; varios comprobantes requieren elegir uno. Se reemplaza el checkbox manual por validación exacta de teléfono y permisos en servidor. Nada se envía hasta Enviar. Publicación verificada.


Ficha comercial publicada y verificada 2026-10-07: puente de lectura 0.5.1 y Herramientas
activos. Comprobados SKU FB-47935, contado3200000, cuotas6/9/12/18/24 y fotoJPEG privada.
Filtro de stock Sí/No y botones + operativos. Factura única directamente al borrador;
varias requieren selección. Sin emisión ni mensajes de prueba a clientes reales.
IA, bot y Master Control conservados. QA aislado cerrado. Si se revierte a la UI anterior,
una foto JPEG todavía en borrador podría requerir adjuntarse nuevamente después de F5;
texto e historial no se restauran ni se reenvían. Backup y rollback en README operativo.


### Mensajería: pendientes y paneles (publicado 2026-10-08)

Pendientes corresponde a chats abiertos con mensajes sin leer; Todas conserva los leídos. Confirmación explícita POST /read al mostrar historial visible al final, con límite de mensaje perteneciente al chat y contador conservador ante nuevas entradas. No cambia responsable, estado, revisión, orden ni IA. Perfil lector no consume pendientes. Separador de escritorio ajustable por arrastre/teclado con preferencia local por operador; móvil conserva panel completo. Publicado y verificado en producción. Importaciones históricas no generan ni retienen pendientes. Todas las reglas de ancho de escritorio incluyen las tres columnas.

Preflight: IA 4819 deshabilitada, IA 2035 habilitada y chat web activo. Publicación preserva interruptores vigentes.

Corrección publicada del bot: precio del catálogo sincronizado no equivale a contado.
Variantes/simples se verifican con commercial-products de Master Control antes de mostrar
importes o filtrar presupuesto; lotes25, límite75 y caché60s. Sin cotización no usar
precio base, XML o Store API como respaldo. Datos de transferencia exclusivamente del
gateway BACS activo de WooCommerce; nunca del texto del cliente o del modelo.
API/worker usan la imagen corregida y .commercial.env privado con credenciales existentes
de Woo, sólo para endpoints GET fijos. Master Control y outbox intactos. Respaldo/rollback
preservan bases vivas, colas e interruptores. Permisos de supervisión no dependen del bot.

Consultas de pago con productos homónimos sólo usan la URL de la última respuesta del bot;
una aclaración posterior invalida enlaces anteriores y conserva la selección pendiente.

Publicación 2026-10-08 verificada: API y worker usan fusion-chatbot-inbox-pending:20261007;
salud de bot/Herramientas correcta. Interruptores preservados: 2035 habilitada y 4819
deshabilitada. Matías administrador general y supervisor. IA y operación muestra causas
de inactividad; pausar/tomar un chat mantiene precedencia sobre la habilitación del número.
Credenciales comerciales en .commercial.env privado, fuera del código y de la imagen;
sólo GET a cotizaciones Master Control y gateway BACS. Catálogo y stock siguen locales,
cotizaciones con caché 60 s. Rollback respaldado en
/opt/fusionbikes/backups/mensajeria-pendientes-20261007; ejecutar
python3 /opt/fusion-inbox-pending-release-20261007/remote_deploy.py rollback.
La reversión restaura software, sin restaurar bases vivas ni reenviar mensajes.


## Recuperación de facturas por IA (publicado 2026-10-08)

El bot pide el número de pedido antes de derivar. Sólo el remitente autenticado de
WhatsApp permite recuperar automáticamente una factura única autorizada de producción
del puente GET messaging-orders, que valida el teléfono del pedido. PDF privado validado
y encolado en la transacción/revisión existente; sin emitir ni modificar comprobantes.
Chat web, varias facturas, ausencia o error pasan a posventa. Tres búsquedas por conversación
en una hora, reservadas en auditoría antes del GET aunque luego cambie la revisión; nunca
usar teléfono escrito por cliente como autorización. Toma humana, pausa,
ventana y nueva entrada mantienen precedencia. Publicado y verificado. API y worker usan fusion-chatbot-invoice-recovery:20261008; outbox conserva su contenedor. Configuración e interruptores conservados.

Respaldo: /opt/fusionbikes/backups/mensajeria-facturas-ia-20261008. Reversión de software:
python3 /opt/fusion-invoice-release-20261008/remote_release.py rollback.
Sin restaurar bases de datos ni reenviar historial. Conversaciones ya derivadas requieren
Reanudar IA por el operador; esta publicación no las reactiva automáticamente.


## Seguimiento por IA (publicado 2026-10-08)

WhatsApp pide pedido y verifica pertenencia por remitente autenticado mediante GET
messaging-orders. Devuelve exclusivamente el código Andreani registrado y enlace fijo
https://www.andreani.com/envio/<codigo>. Ausencia de código no prueba despacho ni fecha.
Web, identidad no verificable y errores pasan a posventa; reservas atómicas de hasta tres
consultas de seguimiento por hora/conversación, independientes de facturas. Conserva
revisión, toma humana y cola existente. No cambia pedidos ni realiza consultas periódicas.
Publicado y verificado. API y worker usan fusion-chatbot-tracking:20261008; outbox, configuración e interruptores conservados.

Pagos/CBU conservan prioridad aunque incluyan número de pedido. El contexto automático
se limita a la última respuesta de factura/seguimiento; una referencia nueva inválida
requiere corregir el pedido y nunca reutiliza uno anterior.

Respaldo de seguimiento: /opt/fusionbikes/backups/mensajeria-seguimiento-ia-20261008.
Rollback sólo de software: python3 /opt/fusion-tracking-release-20261008/remote_release.py rollback.
No restaurar bases vivas ni reenviar mensajes. Si el chat ya fue derivado, requiere
Reanudar IA por el operador; la actualización no reactiva conversaciones pausadas.


## Lectura de fotos y audios (activada 2026-10-08)

Integración OpenAI opt-in, inicialmente sin clave, lectores apagados y presupuesto cero.
Configuración desde Mensajería / IA y operación / Configurar fotos y audios; sólo
administrador general con supervisión. Clave en /opt/fusion-chatbot/private-ai, permisos
privados, montaje API escritura y worker lectura. Nunca en respuestas, auditoría o imagen.
Archivos nuevos WhatsApp, IA habilitada y conversación libre; conserva prioridad humana,
revisión, idempotencia y ventana existente. Audio máximo 5 minutos; imagen normalizada
a JPEG hasta 1280 px. Audio entra en reglas comerciales verificadas; documentos/comprobantes
visuales van a posventa sin confirmar pagos. Texto y adjunto original se conservan; lectura
automática separada y visible al operador. Web conserva texto. No se reprocesa historial.
Reserva mensual atómica de USD 0,05 por mensaje antes del proveedor y hasta 12 archivos/hora/chat. Audio conserva la reserva preventiva hasta calibrar facturación; fotos liquidan usage válido con tarifa fija verificada.
Intentos ambiguos no se repiten automáticamente y conservan reserva. Configuración externa
se aplica al siguiente archivo; cambios durante procesamiento cancelan la respuesta pendiente.
Publicada inicialmente apagada; configuración completada el 2026-10-08. Clave de proyecto creada mediante OpenAI Developers y guardada por canal privado. Ambos lectores activados, con presupuesto preventivo mensual de USD 50 elegido por el usuario. Acceso a ambos modelos y procesamiento real verificados con una imagen dibujada y una voz sintética en español (OGG/Opus); no se usaron archivos de clientes ni se enviaron mensajes de prueba. Dos solicitudes de inferencia diagnósticas, fuera del contador de mensajes; sin reproducción de historial. El tope de la aplicación no configura el límite de facturación de OpenAI; no se ha verificado un límite duro en el proveedor. API y worker usan fusion-chatbot-multimedia:20261008; outbox e interruptores existentes conservados. Pantalla responsive comprobada en 320/390/768/1440 y permisos administrativos verificados.

Respaldo multimedia: /opt/fusionbikes/backups/mensajeria-multimedia-20261008.
Rollback sólo de software: python3 /opt/fusion-multimedia-release-20261008/remote_release.py rollback.
La reversión conserva historial, colas, tabla aditiva y directorio privado; no reenvía archivos.
No se realizaron consultas pagas ni se enviaron adjuntos de clientes durante la publicación.


## Respuestas puntuales y reenvíos en Mensajería (2026-10-08)

Menú por mensaje con Responder y Reenviar. Responder conserva borrador/cita por chat;
WhatsApp usa context.message_id nativo. Web transmite una cita textual por su contrato
actual. Las citas entrantes de Meta se resuelven sólo dentro de la misma conversación.
Audio muestra reproductor sin enlace redundante con extensión. Notas privadas y mensajes
no confirmados o eliminados no se pueden citar ni reenviar.

Reenvío manual a una conversación existente, con destinatario y línea visibles. Si está
libre, Tomar y reenviar asigna al agente y pausa IA; nunca toma un chat de otro agente.
Ventanilla de 24 horas y permisos revalidados por servidor. Contenido original se obtiene
del historial del servidor; copia de archivo ligada a destino, MIME validado y cuota
128 MiB/hora por agente serializada con el mismo bloqueo que las subidas. Web sólo texto.
El reenvío se entrega como mensaje nuevo; Reenviado es una etiqueta interna de la bandeja.

Idempotencia compartida con los envíos normales y sin reintento ambiguo. Outbox bloquea
origen y destino en orden estable y revalida disponibilidad/versión del original antes
del transporte; revocación/edición anterior al envío cancela el reenvío. Las respuestas
puntuales también revalidan disponibilidad del original. No reproduce historial ni cambia
roles, interruptores IA, integración comercial o la configuración privada multimedia.

Paquete: /opt/fusion-message-actions-release-20261008. Respaldo de software:
/opt/fusionbikes/backups/mensajeria-message-actions-20261008.
Reversión: python3 /opt/fusion-message-actions-release-20261008/remote_release.py rollback.
API, worker y outbox deben usar la misma imagen fusion-chatbot-message-actions:20261008.
Conservar bases e historial; nunca restaurar datos ni reenviar mensajes. La barrera de
despliegue usa un contenedor temporal de la imagen base, independiente de API, y un bloqueo
de outbox para esperar cero envíos activos. Rollback detiene también API/worker antes de
liberar la barrera y cancela exclusivamente citas/reenvíos nuevos todavía queued, con
motivo software_rollback_reference, para que el sender anterior no los envíe sin contexto.
Sent/sending/unknown e historial se conservan; el operador puede revisar las cancelaciones.


## Vendedor y continuidad multimodal (paquete 2026-10-08)

Vendedor OpenAI activado por autorización del propietario el 2026-10-08, con tope de
conversación de US$50 mensuales independiente de los US$50 para fotos y audios.
La instalación sin configuración conserva el valor por defecto apagado/US$0. Configuración de
administrador general con supervisión en Mensajería / IA y operación / Configurar OpenAI.
Modelo GPT-6.1 Sol; Responses sin almacenamiento, herramientas acotadas de sólo lectura.
Catálogo local fresco para identidad/stock; precios y cuotas exclusivamente de cotización
web. Bloques comerciales construidos por servidor, datos anteriores no son cotizaciones.
Factura/seguimiento conservan validación de pedido y teléfono autenticado. No emite ni cobra.
Reserva mensual atómica en sales_ai_calls, limitada por mensaje/etapa, sin reintento ambiguo;
cada generación ligada al external_id/revisión original. Pausa, toma humana e interruptores
prevalecen. No se reactiva historial ni se cambian roles ni precios Master Control.

Lector visual GPT-6.1 Sol compara la foto con nombres del catálogo de bicicletas y propone
candidatos que el cliente debe confirmar; nunca prueba versión exacta por apariencia.
Reserva preventiva US$0,25/foto; US$0,05/audio. Presupuesto multimedia existente conservado.
Agrupa hasta cuatro textos consecutivos con el adjunto inmediatamente anterior, máximo
90 segundos, mismo chat y sin intervención humana o respuesta entregada en medio. No lee
adjuntos revocados/editados. Pedido explícito de asesor evita toda solicitud paga.
Confirmaciones de marca/modelo mantienen filtros y aceptan seguimientos cortos de talle.

Paquete: /opt/fusion-sales-ai-release-20261008. Imagen fusion-chatbot-sales-ai:20261008
para API/worker/outbox. Respaldo /opt/fusionbikes/backups/mensajeria-sales-ai-20261008.
Rollback de software con remote_release.py rollback; conserva bases, historial y colas.
Aprendizaje automático de agentes y voz de salida permanecen pendientes, no publicados
por este paquete. No confundir transcripción entrante con generación de voz.


Voz personalizada (2026-10-08): las grabaciones de muestra y consentimiento se validaron y quedaron en el directorio privado voice-onboarding-20261008, fuera del repositorio y de archivos públicos. OpenAI rechazó el alta de consentimiento porque la organización no tiene acceso al endpoint de voces personalizadas. No se creó una voz ni se activó salida de audio. El siguiente paso requiere habilitación del proveedor o una elección explícita de alternativa; no reutilizar otro proveedor sin autorización. La muestra de voz no es una fuente de precios ni de condiciones comerciales.


Mensajería compacta (2026-10-08): Responder aparece directamente en la cabecera de cada
mensaje elegible; el menú de opciones conserva Reenviar. Audios con reproductor sin
enlace redundante al nombre del archivo. Editor y acciones compactos con puntero fino;
controles táctiles mantienen al menos 44 px. Los botones se distribuyen según el ancho
del editor y no sólo el de la ventana; se preservan advertencias, permisos y borradores.
HTML referencia app.js y style.css con versión derivada de su contenido, y app.js hace
lo mismo con message-actions.js: regenerar estas versiones en cada publicación que
modifique esos archivos. El HTML se sirve no-cache; los assets podían quedar hasta
cuatro horas en caché. Una pestaña ya abierta requiere recarga para usar la nueva UI.
Respaldo estático: /opt/fusionbikes/backups/mensajeria-compacta-20261008. Reversión sólo de
archivos de esta interfaz, sin reiniciar ni restaurar bases, colas o configuración IA.
## Mensajería profesional (2026-10-07)

- Nueva bandeja `/herramientas/mensajeria/` en Node con sesión existente; conversaciones y adjuntos privados en PostgreSQL del bot. Proxy HMAC independiente y cola durable `outbox`; migraciones aditivas. Backup/rollback y contrato: `integrations/mensajeria/README.md`.
- José supervisión; Santi/Miguel/Fabri agentes; Matías consulta. Overrides propios `mensajeria_roles` prevalecen sobre admin global. Otros permisos conservados.
- Chat web y captura de WhatsApp conservados; contexto web relacionado por teléfono cuando llega un chat de WhatsApp. POS/ARCA y plugin oficial de Meta no se migran ni modifican.
- Coexistencia de ambos números y publicación Meta pendientes con teléfonos. `INBOX_CONNECTED_NUMBER_IDS` vacío: sin envíos desde la nueva bandeja. Controles de bot independientes conservados.

- Publicación verificada el 2026-10-07: Home abre la bandeja con sesión real; rol de Matías consulta; API/worker/outbox operativos; ambos números permanecen pendientes y sin emisión. Respaldo de software/configuración y bases en `/opt/fusionbikes/backups/mensajeria-20261007`.


## Copia manual de Herramientas retenida — 2026-10-15

Por instrucción del usuario, conservar una sola copia manual de la base de Herramientas:
la más reciente. En esta limpieza quedó
`/opt/fusionbikes/backups/fusion-20261015T133253Z-predeploy-fixes.sqlite`.
La copia conservada pasó `PRAGMA quick_check`; su SHA-256 y el registro de las siete
copias anteriores eliminadas figuran en
`/opt/fusionbikes/backups/manual-cleanup-20261015-sombra.json`.
La copia manual del 14/10 mencionada en la revisión anterior fue reemplazada por esta.

Se retiraron únicamente las siete SQLite manuales anteriores de esa misma base, con
6.583.726.080 bytes en total. Los archivos de código, configuración y dumps de otras
bases se conservaron. Los procedimientos históricos que nombran las SQLite retiradas
ya no pueden restaurarlas desde esas rutas.
Los respaldos automáticos de `db/*.sqlite.gz`, `uploads/*.tar.gz`, PostgreSQL y la nube
quedan fuera de esta decisión. Para nuevas copias manuales, comprobar la integridad de
la nueva antes de retirar la anterior; no se agregó una tarea automática de limpieza.

## Modelos de Ollama depurados — 2026-10-14

Por autorización del usuario se retiraron mediante `ollama rm` únicamente los modelos
no seleccionados `qwen3.5:4b` y `qwen3:4b-instruct-2507-q4_K_M`.
Se conserva `qwen2.5:1.5b-instruct-q4_K_M` (ID `65ec06548149`), todavía seleccionado
por el circuito local anterior. El vendedor principal continúa configurado con OpenAI.
Ollama, su imagen y su volumen se mantienen; no se modificaron los controles de IA,
los horarios, los servicios ni los datos de conversaciones. Los modelos retirados
se pueden volver a descargar si fueran necesarios. Registro de la operación:
`/opt/fusionbikes/backups/ollama-model-cleanup-20261014.json`.


## Servicio de informes: stock y reposición — 2026-10-14

Runtime `/opt/fusion-management-migration`, fuente `integrations/management-migration`, entrada en el Panel comercial existente. La nueva vista comparte el lector/caché comercial y lee catálogo por loopback autenticado; no agrega tareas de sincronización. Gateway `fusion-management-validation.service` conserva CPUQuota=25% y recibe drop-in `stock-report-memory.conf` con MemoryHigh=192M y MemoryMax=256M para el historial consolidado. Solamente ese servicio requiere reinicio; no cambia la app principal ni las bases. Respaldo previo por archivo y manifiesto en `/opt/fusion-management-migration/backups/stock-report-*`; para revertir, restaurar originales y retirar sólo los archivos nuevos enumerados en ese manifiesto (incluido drop-in), daemon-reload y reiniciar el gateway. No restaurar bases de datos.


## Limpieza de desarrollo y QA — 2026-10-15

Por autorización del usuario se retiraron 4 instalaciones anteriores de VS Code remoto, una caché de descargas y 8 copias antiguas de Herramientas usadas en QA.
Se conserva VS Code 1.142.0 en `/root/.vscode-server/cli/servers/Stable-6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`, además del lanzador, las extensiones instaladas y los datos de usuario.

Se retiró la caché `/root/.vscode-server/data/CachedExtensionVSIXs`, que puede regenerarse con nuevas descargas. La caché `/root/.npm/_cacache` se conservó porque cambió durante las comprobaciones.
Copias QA retiradas:

- `/opt/fusion-sales-ai-qa-20261008/herramientas`
- `/opt/fusion-message-actions-qa-20261008/herramientas`
- `/opt/fusion-inbox-share-qa-20261007/herramientas`
- `/opt/fusion-inbox-tools-qa-20261007/herramientas`
- `/opt/fusion-messaging-qa-20261007/herramientas`
- `/opt/fusion-multimedia-qa-20261008/herramientas`
- `/opt/fusion-messaging-compact-qa-20261008/herramientas`
- `/opt/fusion-unified-qa-20261007/herramientas`

Los directorios padres de estas QA y sus archivos auxiliares se conservaron, incluidos los referenciados por contenedores detenidos. Los marcadores Git copiados dentro de las QA apuntaban al worktree original de `pausadas-volver`; el original y su registro se conservaron.

Antes de cada borrado se verificaron procesos, archivos abiertos, montajes, contenedores, servicios, tareas programadas y registros de worktrees. La limpieza no incluye worktrees registrados, QA activa, `/root/.npm/_npx`, contenedores, imágenes, volúmenes ni bases y respaldos de producción. Manifiesto privado: `/opt/fusionbikes/backups/dev-cleanup-20261015.json`. No se agregó una tarea automática de limpieza.

## Capacidad y bajas Woo — desplegado, 2026-10-15

Las siete DLQ de `woo.products` provienen del sobre sintético del motor (`id`, `lifecycle=deleted`, versión `deleted:<corrida>`), no de productos sin tipo enviados por Woo. El contrato de la corrección es archivar sólo representaciones Woo cuya observación actual confirme la baja, conservando identidades, modelos compartidos y representaciones ML. Las versiones `deleted:` no se comparan como fechas ni se escriben en el campo temporal del catálogo. Una observación posterior permite reaparición; una baja vieja o una proyección anterior a una baja vigente no modifica el catálogo.

Una variación cuya observación propia no está eliminada y cuyo padre aún figura eliminado se conserva para reintentar: no se completa como obsoleta, porque puede ser una restauración que llegó antes que su padre. Se acepta `parent_id` numérico o textual con el mismo contrato del proyector Woo.

La espera transitoria por el padre tiene código propio y no alimenta ni diluye el umbral global mientras siga reintentable; al agotar intentos sí cuenta como fallo. Esto evita que varias hijas impidan que el mismo proyector procese la reaparición del padre.

Plan de ejecución y reversión: `docs/superpowers/plans/2026-10-15-capacidad-barridos-bajas-woo.md`. El techo global del gateway permanece en 60 RPM y E2/E3 en cero; el ajuste de reparto no cambia intervalos ni habilita consumidores futuros. El despliegue debe partir de la imagen worker r2 efectiva: el código de catálogo en Git incluye opciones E3 todavía ausentes de esa imagen, por lo que copiar toda la carpeta activaría cambios fuera del alcance.

Las siete entradas históricas de Woo se reprocesaron con el handler desplegado y `completarEnTx` en una única transacción; las siete quedaron `succeeded` y las siete DLQ se resolvieron con nota, conservando su historial. Catálogo sin mensajes pendientes/reintentables/DLQ en la comprobación posterior. No hubo escrituras a Woo/ML ni cambios de esquema. Se preservó la captura de las seis corrientes futuras sin intentos.

Rollback de esta entrega: imagen r2 `sha256:20ee28ac78969751eae524728b51e6b96468160c3b85d6eb97d416cd8c1fae28` y `worker-before-r3.override.yml` guardados. Para cupos, restaurar sólo los seis valores anteriores desde `legacy-before-cupos.env` y recargar Herramientas comprobando salud; no sobrescribir cambios de configuración posteriores. `woo-before-r3.json` conserva la fotografía privada de siete inbox, siete DLQ y 28 representaciones. No restaurar una base anterior sobre producción.
