# Claves públicas de los informes firmados de E1

Una clave pública por archivo, nombrado por su `kid`: `<kid>.pub`, en PEM (SPKI). Es lo que usa
`npm run verificar-informe` para comprobar un manifiesto o un reporte sin depender del VPS.

- La privada **nunca** está acá: vive en el keyring del VPS, 0600, y se genera allá con
  `plataforma/scripts/generar-clave-firma.mjs`.
- Rotar la clave es agregar un archivo nuevo. Los viejos **no se borran**: sin ellos, los informes
  firmados antes de la rotación dejan de poder verificarse.
- La primera clave, `e1-2026-09`, se agregó en la puesta en producción (tarea 16 del plan del tramo 4) el 2026-09-18 y está **activa**: firma los manifiestos diarios que van a B2 en modo `compliance` (verificado el 2026-09-20 sobre los del 17, 18 y 19).
