# Operación del VPS y despliegue

## Hechos durables

- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve la rama
  `conteo-confiable`; cualquier referencia histórica que lo llame staging está obsoleta.
- El despliegue a producción es manual y requiere confirmación explícita después de todos los
  gates.
- El repositorio local `/opt/fusionbikes/herramientas` usa como remoto `origin` el repositorio
  privado `fusionbikesok-ui/Herramientas` en GitHub, mediante SSH.
- `bubblewrap` está instalado en `/usr/bin/bwrap`, versión 0.9.0.

## Restricciones

- No iniciar `node server.js` contra `data/fusion.sqlite` real.
- No desplegar automáticamente ni hacer push directo o forzado a `master`.
- No dejar servidores o procesos de pruebas vivos.
- Una actualización documental no autoriza migraciones, cambios de configuración, reinicios de
  PM2 ni pruebas que escriban datos operativos.

## Cuándo actualizar

Ante cambios confirmados de infraestructura, dependencias del sistema, proceso de staging o
despliegue, incluso cuando no haya cambios de código. El estado transitorio va en
`../active.md` y debe verificarse en vivo antes de usarlo.
