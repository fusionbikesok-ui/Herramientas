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
  `/root/.config/fusion-backup/passphrase`; copia de la passphrase fuera del VPS a cargo del usuario).
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
- Vigía: `lib/vigiaBackup.js`, cron de la app minuto 17 de cada hora; si `ultimo_ok` > 26 h o
  falta el estado, abre incidente crítico `backup/backup_nube/backup_vencido` (email) y lo
  resuelve solo al volver un backup completo.
- `/healthz` es público (sin sesión) y sirve para monitoreo externo: `SELECT 1` en cada
  llamada e `integrity_check` cacheado 5 min (sin caché bloqueaba el event loop ~0,5 s por
  llamada; commit `0df724d`).

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
