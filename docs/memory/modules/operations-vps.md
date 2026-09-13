# Operación del VPS y despliegue

## Hechos durables

- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve la rama
  `conteo-confiable`; cualquier referencia histórica que lo llame staging está obsoleta.
- Política objetivo: un pipeline verde podrá publicar backend/web con migración compatible,
  health/smoke y rollback automático. Hasta que E23 lo implemente y audite, la operación vigente
  sigue requiriendo confirmación manual. Windows, hardware y App Store siempre requieren autorización explícita.
- El repositorio local `/opt/fusionbikes/herramientas` usa como remoto `origin` el repositorio
  privado `fusionbikesok-ui/Herramientas` en GitHub, mediante SSH.
- `bubblewrap` está instalado en `/usr/bin/bwrap`, versión 0.9.0.
- El commit `80e14eb` desplegó la ingesta de chat y aplicó la migración
  `chat_events_inbox_093`; `/api/v1/meta` conserva contrato `1.0.0`. La ruta queda
  deliberadamente fail-closed (`503`) hasta coordinar en producción
  `FUSION_CHAT_EVENTS_API_KEY` y `FUSION_CHAT_EVENTS_SECRET` con WordPress.

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
