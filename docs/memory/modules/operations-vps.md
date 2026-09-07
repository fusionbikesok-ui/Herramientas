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
