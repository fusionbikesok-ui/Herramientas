# Sombra: seguimiento de capacidad — 2026-10-16

Continúa la [medición del 15/10](2026-10-15-capacidad-bajas-woo.md). Consultas de sólo lectura efectuadas entre 14:22 y 14:27 UTC (11:22–11:27 ART). E1 sigue **sin aceptación**; este seguimiento no cambia consumidores, crons, cuotas ni datos comerciales.

## Capacidad observada

Ventana desde 2026-10-15 23:26 UTC, después del cambio de cupos. Las duraciones de la tabla corresponden únicamente a corridas exitosas; los dos fallos se informan por separado.

| Corriente | Corridas exitosas | Promedio | p95 | Máximo | Intervalo |
|---|---:|---:|---:|---:|---:|
| Mensajes ML | 43 | 15,22 min | 16,22 min | 18,34 min | 20 min |
| Envíos ML | 58 | 10,47 min | 10,78 min | 14,38 min | 15 min |
| Pedidos ML | 89 | 0,10 min | 0,13 min | 3,89 min | 10 min |
| Preguntas ML | 45 | 0,17 min | 0,18 min | 3,42 min | 20 min |
| Reclamos ML | 45 | 0,18 min | 0,17 min | 3,89 min | 20 min |
| Pedidos Woo incremental | 88 | 0,10 min | 0,21 min | 3,52 min | 10 min |
| Productos Woo incremental | 88 | 0,11 min | 0,22 min | 3,65 min | 10 min |

El barrido diario ML terminó a las 08:05 UTC: 4.260 recursos en 65,02 minutos con el cupo de 4 RPM. El de productos Woo terminó a las 07:15:44 UTC: 2.123 recursos en 0,68 minutos. El próximo barrido semanal de pedidos Woo está previsto para el 18/10 a las 07:30 UTC.

Los cupos efectivos del proceso vivo siguen siendo mensajes 30, envíos 20, items 4, pedidos 3, preguntas 2 y reclamos 1 RPM; total 60 y E2/E3 en cero.

## Fallos y recuperación

Las corridas 21460 (mensajes) y 21464 (envíos) terminaron con `Connection terminated due to connection timeout` a las 12:22 UTC. PostgreSQL, API y scheduler fueron recreados alrededor de las 12:17 UTC; el log de PostgreSQL registra timeouts de consultas a las 12:18. La coincidencia temporal está comprobada, pero no identifica por sí sola la causa raíz de esa intervención.

Después se completaron nuevamente ambas corrientes. No se reescribieron los fallos históricos. A las 14:22, PostgreSQL, worker, scheduler y archivo WAL estaban saludables, el legado respondió 302 y no había reinicios automáticos ni OOM en los contenedores actuales. Disco: 74 %, aproximadamente 26 GiB libres.

## Bajas Woo y captura

- Los siete inbox corregidos siguen `succeeded`.
- No hay entradas sin resolver en `integrations.dead_letters`; esto no elimina las señales históricas `dead_lettered`.
- Catálogo: 26.014 mensajes ML y 10.187 Woo, todos `succeeded` a las 14:22.
- Se conservan 7.766 mensajes de corrientes futuras, todos con cero intentos, a las 14:25.
- Las 20 relecturas compensatorias del 15/10 siguen `succeeded`.
- Las 210 señales recibidas desde las 03:00 UTC del 16/10 habían terminado correctamente a las 14:25.

## Cambios concurrentes ya desplegados

Otra sesión añadió dos cambios, publicados en [PR42](https://github.com/fusionbikesok-ui/Herramientas/pull/42) y [PR45](https://github.com/fusionbikesok-ui/Herramientas/pull/45). Ambos seguían abiertos, al igual que PR38. PR45 tiene como base la rama de PR38; PR42 también depende de la recuperación inicial. Este seguimiento no los modifica ni fusiona.

El worker vigente inició a las **14:05:14 UTC** con `fusion-plataforma:sombra-mensajes-20261016-r4`, imagen `sha256:549542828674ab2966951bd6bbb1de3e17cb2fc024fe8ef17426b15bccd2acb1`. El override persistido apunta a r4.

- Adaptador ML: hash `7ce5aa78dad288c75416873a8fb11025c11e6290fe501fbcc851bb4cb42d5005`, idéntico a PR42, commit `79f0bcd3`.
- Bajas Woo: hash `88f99cd1bd3e6220f26336d41debc565344efff202c6bfd40b23d129be255bd6`, idéntico a PR45, commit `d3b30707`.
- Proyector: hash `bf5cf3090d3e34c3b419d59d5e7369d8d1b8e1c07a05e22a90ac83a6364dbe3f`, igual a r3.
- `aplicar.ts` efectivo: hash `fda44e204233ae9789047771e112cb9bce067ca306e637c00936db0e181abbb5`. La comparación con PR45 conserva la exclusión de código E3 que no formaba parte del runtime anterior; las diferencias observadas corresponden a esas opciones de identidad, no al cambio de reapertura Woo.

La primera corrida de mensajes de r4, 21527, completó el control completo en 865,94 segundos, con 182 recursos y `avisos_perdidos=0`. Persistió `last_full_at` y los cursores livianos. No atribuir a r4 toda la estadística anterior ni dar por validado su modo liviano sólo con este control completo.

A las 14:27 UTC se verificó también la primera corrida liviana, 21538: terminó a las 14:26:58 UTC en **13,21 segundos**, sin recursos nuevos ni error. Avanzó `last_light_at` y conservó `last_full_at`; `avisos_recortados=false` y `avisos_perdidos=0`. Esto confirma la alternancia de modos y el cierre del cursor, pero una vuelta sin novedades no demuestra por sí sola capacidad ni cobertura bajo carga. Todos los componentes continuaban saludables, sin OOM ni reinicios automáticos del worker.

## Reportes y criterio de cierre

El reporte del **15/10 permanece rojo**, firmado, depositado y avisado a las 10:00 UTC del 16/10. En la consulta de señales de su ventana congelada aparecen dos faltantes de `ml.messages` con `ErrorDestinoProhibido`, anteriores a la reparación. Sus relecturas compensatorias están resueltas, pero los originales se preservan para no alterar la evidencia de un día cerrado. El resumen operativo de ese día conserva también la alerta histórica correspondiente. No se regeneró, modificó ni reenvió el reporte firmado.

Pendiente para E1:

1. Completar 24–48 horas con capacidad suficiente y sin retrasos sostenidos. El cambio de cuota cumple 24 horas el 16/10 a las 23:20 UTC; r4 recién cumple 24 horas el 17/10 a las 14:05 UTC y necesita observación propia.
2. Verificar las corridas livianas de r4, su control diario y los próximos reportes firmados, incluida cobertura y convergencia.
3. Obtener siete días consecutivos verdes. Un reporte rojo o amarillo no cuenta como día aceptado.
4. Integrar las ramas dependientes mediante la revisión correspondiente, preservando el runtime acotado y sin activar cambios E3 ajenos.

Las comprobaciones fueron de sólo lectura. Los cambios de este seguimiento son documentación y memoria operativa; no se ejecutaron pruebas de código ni se reiniciaron servicios.
