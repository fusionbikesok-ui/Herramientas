# Sombra: capacidad de barridos y bajas Woo — 2026-10-15

Seguimiento posterior: [medición del 16/10 y worker r4](2026-10-16-seguimiento-capacidad.md). Los datos de despliegue siguientes describen r3 y conservan su contexto histórico.

Continúa la [recuperación del 15/10](2026-10-15-recuperacion-sombra.md). Autorización: ajustar capacidad y corregir siete bajas Woo sin cambiar la operación comercial. E1 continúa **sin aceptación**: faltan medición sostenida de 24–48 horas y la campaña de siete días verdes.

## Cambio y validación

El motor emite `{id, lifecycle: 'deleted'}` con versión `deleted:<corrida>`. El consumidor rechazaba estos sobres por no contener tipo de producto Woo. `catalogo/bajas-woo.ts` comprueba la observación vigente y archiva sólo representaciones Woo de la cuenta/recurso. Mantiene variantes, modelos compartidos y representaciones ML. No escribe la versión sintética en el campo temporal del catálogo, para permitir restauraciones posteriores.

La baja de un padre alcanza sus representaciones; una variación alcanza sólo la propia. Una baja superada no modifica el catálogo. Una hija que reaparece antes de su padre permanece reintentable, sin detener el proyector por el umbral de errores; si agota intentos, el fallo sí cuenta. Archivo, auditoría y cierre del inbox comparten transacción.

- Reproducción inicial: seis regresiones fallaron antes de corregir.
- Suite completa de plataforma sobre la primera revisión: 1.049 pruebas correctas en 93 archivos.
- Revisión final: typecheck correcto y 43 pruebas del proyector correctas, incluidas 14 nuevas.
- Imagen final extraída: 177 pruebas correctas en 18 archivos, con PostgreSQL efímero. Se corrigió una ruta OpenAPI ausente en el harness antes de repetir la validación.
- Revisión independiente de código y despliegue: sin bloqueos tras resolver restauración de hijas, padre textual y umbral de espera. `git diff --check` correcto.
- Sin cambios de raíz/legado desde las 4.527 pruebas Vitest y 90 Node correctas de la recuperación previa; no se repitieron sus suites mientras otros trabajos ejecutaban QA. Sin cambios de UI, esquema o peso frontend.

## Despliegue y recuperación

Worker desde **23:19:55 UTC**: `fusion-plataforma:sombra-capacidad-20261015-r3`, ID `sha256:aa2f621cf5374d9b29a518952127b03878ce3628f52fd2caf2299c7d43f43bdf`.

Comparación completa del árbol `src` extraído contra r2: sólo difieren `catalogo/bajas-woo.ts` y `catalogo/proyector.ts`. Se preservaron las opciones E3 y el resto del código efectivo anterior. Hashes fuente/imagen/contenedor coincidentes:

- `bajas-woo.ts`: `48cc6c33520c28cfe2f63ab20f7f3a9655c4a8672d0a30110132304a234bf07d`.
- `proyector.ts` efectivo: `bf5cf3090d3e34c3b419d59d5e7369d8d1b8e1c07a05e22a90ac83a6364dbe3f`.

Se conservaron entorno, montajes, límites y comando del worker. API y scheduler conservaron sus IDs. PostgreSQL permanece con las mismas 27 migraciones.

Los inbox `4478, 34905, 34906, 34907, 103946, 604467, 832440` se procesaron usando el handler desplegado y `completarEnTx`, en una única transacción con guardas de cuenta, tópico, origen, identidad, versión, observación y causa. Confirmación posterior: **7 succeeded y 7 DLQ resueltas**, con historial conservado. Las 28 representaciones ya estaban archivadas por observaciones de papelera anteriores; se consolidó el estado de baja, sin borrar ni desvincular registros. No se enviaron escrituras a Woo ni ML.

## Reparto de capacidad

El límite global permanece en **60 consultas/minuto**, E2/E3 en cero y los intervalos no cambian.

| Corriente | RPM anterior | RPM vigente | Intervalo |
|---|---:|---:|---:|
| Mensajes | 10 | 30 | 20 minutos |
| Envíos | 15 | 20 | 15 minutos |
| Publicaciones | 15 | 4 | 24 horas |
| Pedidos | 10 | 3 | 10 minutos |
| Preguntas | 5 | 2 | 20 minutos |
| Reclamos | 5 | 1 | 20 minutos |

Línea base observada: mensajes 46,1–46,2 minutos por vuelta; envíos 13,6–14,5 minutos. Con 470 packs y 220 envíos, los mínimos teóricos del nuevo reparto son 15,7 y 11 minutos; señales, latencia y reintentos consumen parte del margen. Estos cálculos no sustituyen la medición real.

El proceso anterior de Herramientas tenía exactamente la misma configuración que cargaría `.env` (66 variables verificadas sin revelar valores sensibles), y no había fuentes operativas modificadas desde su arranque. Los cambios de management-migration pertenecen a un servicio independiente y no son importados por Herramientas. Se cambió únicamente el reparto y se reinició ese proceso; nuevo PID 829027, respuesta HTTP 302 correcta y cuotas leídas desde el proceso coincidentes. El script conserva las demás variables y revierte la configuración si falla la comprobación posterior.

Comprobación a las **23:21 UTC**: salud de PostgreSQL, worker, scheduler y archivo WAL correcta. El catálogo sólo tenía mensajes `succeeded` (25.733 ML y 10.176 Woo). Las seis corrientes futuras conservaban 7.630 mensajes con cero intentos. El barrido de envíos activo guardaba 134 páginas, pendiente de reintento tras el reinicio; se comprueba su avance antes de cerrar la intervención.

Comprobación posterior: envíos avanzó a 173 páginas a las 23:22 y 193 a las 23:23; la corrida `21068` terminó a las **23:25:09 UTC** con 220 recursos. Su duración total de 13,5 minutos mezcla ambos repartos y no se usa como medida de una vuelta íntegra con el cupo nuevo. A las 23:25:35, `/healthz` del legado respondió 200 y el worker no registraba advertencias/errores desde el despliegue, ni reinicios ni OOM. La próxima vuelta de mensajes conserva su calendario original.

A las **23:32:49 UTC**, las primeras vueltas iniciadas íntegramente con el nuevo reparto (23:26:44) avanzaban sin error: envíos `21075`, 140 páginas/recursos; mensajes `21076`, 194 páginas y 85 recursos capturados. Pedidos, reclamos y preguntas ya habían terminado correctamente; los siguientes barridos incrementales de pedidos y productos Woo también. Las siete bajas permanecían `succeeded`, la salud de todos los componentes era correcta y el worker seguía sin reinicios ni OOM. Esta medición acredita avance y continuidad de las otras corrientes, no sustituye la duración final de ambas vueltas ni las 24–48 horas de observación.

## Reversión

Respaldo privado: `/opt/fusionbikes/backups/sombra-recuperacion-20261015`. `woo-before-r3.json` contiene siete inbox, siete DLQ y 28 representaciones; `legacy-before-cupos.env` contiene la configuración anterior con permisos restringidos desde su creación; `worker-before-r3.override.yml` conserva el override.

Para revertir sólo este worker, restaurar el override de r2 y recrear únicamente `worker` con `--no-deps --no-build`. Imagen r2 retenida: `sha256:20ee28ac78969751eae524728b51e6b96468160c3b85d6eb97d416cd8c1fae28`; conserva los mismos checkpoints. Para revertir cupos, aplicar sólo los seis valores anteriores, preservando cualquier edición posterior de `.env`, y verificar salud tras recargar Herramientas. No restaurar una base antigua sobre operaciones nuevas. El historial de bajas procesadas permanece auditable.
