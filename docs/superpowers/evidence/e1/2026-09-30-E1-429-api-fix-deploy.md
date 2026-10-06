# E1 — ajuste de llamadas ML tras HTTP 429 (2026-09-30)

## Release

- Despliegue: 2026-09-30, aproximadamente 03:21–03:25 UTC.
- Base del worker: commit desplegado `025c8219`, con el ajuste de 429 aplicado sólo a los archivos de reconciliación ML.
- Imagen del worker: `fusion-plataforma:e1-ml429-20260930T031014Z`, ID `sha256:e67761ded86816f73d67b06d915e87ca3bff89906bbf0ad59aa1323881462c13`.
- Gateway legado: `lib/gatewayCanal.js` actualizado y proceso PM2 `herramientas` reiniciado.
- Alcance: se recreó sólo `fusion-plataforma-worker-1`; API y scheduler no se recrearon. No hubo cambios de RPM, `.env` ni migraciones; la imagen conserva migraciones hasta `0024`.

## Cambio aplicado

- Las notificaciones `messages` hacen GET individual `/messages/{id}?tag=post_sale` y aceptan el formato actualizado de mensajes.
- `/messages/unread` queda como reconciliación redundante cada seis horas.
- Los GET individuales de shipments quedan secuenciales, separados por 300 ms, y conservan `x-format-new: true`.
- Los 404 de mensajes se reintentan porque ML documenta que pueden ser transitorios.

## Verificación

- Antes del despliegue: legado `/healthz` 200 con SQLite íntegro; plataforma `/api/v2/health` 200 con database, worker, scheduler y WAL archive en `ok`.
- Después del despliegue: los mismos dos health checks respondieron 200; el worker figura `running` con la imagen indicada y registró sus diez corrientes. Los logs mostraron el arranque de adaptadores y ciclos sin errores.
- Pruebas previas: gateway legado 24/24; pruebas de gateway y relectura de plataforma 19/19; `npm run typecheck` y `git diff --check` pasaron.

## Rollback

- Backup del gateway anterior: `/root/backups-worker/e1-ml429-20260930T031014Z/gatewayCanal.js`.
- Imagen del worker reconstruida desde el commit previo desplegado `025c8219`: `fusion-plataforma:rollback-e1-ml429-worker-20260930T031014Z`.
- Etiqueta `fusion-plataforma:local` anterior guardada como `fusion-plataforma:rollback-e1-ml429-local-20260930T031014Z`.
- Instrucciones exactas: `/root/backups-worker/e1-ml429-20260930T031014Z/rollback.md`.

## Seguimiento

La medición Tarea 0 de 24–48 horas sigue pendiente para calibrar cuotas y habilitar el inicio de PM-186. Este despliegue no cambia esas cuotas.
