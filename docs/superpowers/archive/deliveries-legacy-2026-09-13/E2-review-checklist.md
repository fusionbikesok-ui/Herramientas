# Revisión independiente — E2

**Entrega:** E2 — Evidencia, perfiles, paquetes y aprobación
**Estado:** pendiente de ejecutar
**Revisor:** ____________________
**Fecha:** ____________________

## Alcance

Revisar únicamente los cambios de evidencia, perfiles, requisitos por embalaje,
retención, reconciliación de subidas y su interfaz. No aprobar E1, stock ni despliegue.

## Base reproducible

- [ ] Checkout y diff identificados; no hay secretos ni datos de producción.
- [ ] Migraciones 045, 046 y 047 son aditivas y su runner puede repetirse.
- [ ] Se verificó que los cambios ajenos del checkout permanecen intactos.

## Casos obligatorios

- [ ] Perfil seguro cuando el SKU/categoría no tiene regla.
- [ ] Versión de perfil queda en el ítem al iniciar la preparación.
- [ ] Cambiar una regla después de iniciar no altera el snapshot.
- [ ] Cambiar a `re_embalada` activa los requisitos de embalaje congelados.
- [ ] Falta de ítem, foto o foto de paquete bloquea la aprobación.
- [ ] Doble `upload_id` no crea una segunda foto.
- [ ] Timeout conserva preview local y ofrece reintento.
- [ ] Respuesta tardía que sí persistió se reconcilia sin duplicar.
- [ ] Recarga conserva la evidencia confirmada por servidor.
- [ ] Purga ocurre después de 180 días.
- [ ] Hold por reclamo/incidente/garantía/auditoría impide purga.
- [ ] Solo un usuario autorizado puede crear o quitar holds.

## Comandos y evidencia

- [ ] `npx vitest run test/preparacion.test.js --no-file-parallelism --testTimeout=30000 --reporter=dot`
- [ ] `npx vitest run test/preparacion-render.test.js --no-file-parallelism --testTimeout=30000 --reporter=dot`
- [ ] `npm run e2e:e2`
- [ ] Smoke de navegador y axe ejecutados en 390×844, 768×900 y 1440×900.
- [ ] Resultado exacto adjunto o copiado en la ficha E2.

## Hallazgos

| Severidad | Archivo/línea | Hallazgo | Responsable | Estado |
|---|---|---|---|---|
| | | | | |

## Decisión

- [ ] Aprobado sin críticos/altos.
- [ ] Aprobado con medios aceptados, responsable y fecha.
- [ ] Rechazado: requiere corrección y nueva revisión.

Firma/nombre del revisor: ____________________

Esta checklist no habilita publicación, piloto real ni aceptación por sí sola.
