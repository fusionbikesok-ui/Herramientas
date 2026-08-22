# Operación del VPS y despliegue

## Hechos durables

- El VPS ejecuta el entorno de staging; el despliegue a producción es manual.
- El repositorio local `/opt/fusionbikes/herramientas` usa como remoto `origin` el repositorio
  privado `fusionbikesok-ui/Herramientas` en GitHub, mediante SSH.
- `bubblewrap` está instalado en `/usr/bin/bwrap`, versión 0.9.0.

## Restricciones

- No iniciar `node server.js` contra `data/fusion.sqlite` real.
- No desplegar automáticamente ni hacer push directo o forzado a `master`.
- No dejar servidores o procesos de pruebas vivos.

## Cuándo actualizar

Ante cambios confirmados de infraestructura, dependencias del sistema, proceso de staging o
despliegue, incluso cuando no haya cambios de código. El estado transitorio va en
`../active.md` y debe verificarse en vivo antes de usarlo.
