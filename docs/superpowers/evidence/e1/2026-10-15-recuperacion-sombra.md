# Recuperación de E1 — 2026-10-15

Ampliación posterior: [capacidad y bajas Woo, 23:21 UTC](2026-10-15-capacidad-bajas-woo.md). Allí consta el nuevo reparto de cupos y la resolución de las siete bajas; los pendientes descritos abajo corresponden a la fotografía inicial.

## Alcance y autorización

José autorizó corregir los bloqueos de la migración y decidió conservar la captura de corrientes sin consumidor para las entregas posteriores. La autoridad operativa sigue en el legado. No se acepta E1 ni se reduce ningún cron con esta reparación.

Base Git: `d4a84d20538506fc1bbd965b70dba5a8e02f174d`. Trabajo aislado en `/opt/fusionbikes/worktrees/codex-sombra-recuperacion-20261015`, rama `codex/sombra-recuperacion-20261015`. El checkout productivo tiene cambios ajenos que se preservan.

## Causas verificadas

- Envíos y conocidos pedían 20 recursos por página; packs, 10. Al agotarse el cupo antes de terminar la página no se guardaba el avance. Items repetía scan y bulk ya realizados. La reparación confirma una llamada por página, con IDs y bulk de items en checkpoints separados.
- La relectura individual de mensajes omitía `x-format-new: true`, requerido por el gateway. Una lectura real con el encabezado respondió 200 y un mensaje, sin mostrar su contenido.
- `WOO_WEBHOOK_SECRET` sin comillas tenía interpretaciones diferentes al cargar `.env` desde shell y dotenv. La firma con la interpretación de dotenv era rechazada; la firma con el secreto efectivo del proceso pasaba autenticación. Se conserva el secreto efectivo y se alinean los webhooks 17–20.
- Las siete DLQ de `woo.products` son tombstones emitidos por el barrido (`remote_version` con prefijo `deleted:`, observación `deleted`). El consumidor de catálogo los rechaza por falta de tipo. Quedan conservados y pendientes de tratamiento en E2; no se marcan procesados.
- La primera verificación posterior al despliegue reveló que la imagen heredada no incluía `motor.ts` y `corridas.ts` reanudables que sí estaban en Git. El checkpoint seguía siendo NULL: se amplió la imagen a esas dos fuentes ya probadas, además de adaptador y relector. Las diferencias restantes pertenecen a API/catálogo/identidad y no se incorporan en esta reparación.

## Verificación previa

- Cuatro regresiones fallaron antes del cambio y pasaron después.
- Typecheck correcto. Pruebas adicionales con PostgreSQL: checkpoint persistido entre procesos, último bulk sin scroll, expiración sin bajas ni avance de cursor. Expiración de scan y bulk comprobada antes de tocar la red.
- Suite plataforma final: 93 archivos, 1.039 pruebas correctas; typecheck correcto. Se repitió plataforma tras conservar la pausa entre envíos. Legado: 253 archivos correctos y uno omitido, 4.527 pruebas correctas y 51 omitidas; Node adicional: 90 correctas, una omitida. Omitidos preexistentes; ningún fallo. Ejecución serial en aislamiento.
- `npm run docs:validate-deliveries` y `git diff --check`: correctos.
- Revisión independiente de código y seguridad sin bloqueos tras corregir revalidación de URL/ID Woo, concurrencia de `.env` y rollback de checkpoints.
- Artefacto final: 134 pruebas de reconciliación correctas (17 archivos) sobre el código extraído de la imagen r2, con PostgreSQL efímero. El primer entorno carecía del fixture OpenAPI: se incorporó y la repetición completa terminó sin fallos. Segunda revisión del despliegue aprobada, con gate final y hashes de las cuatro fuentes.
- Imagen derivada de la imagen exacta del worker anterior. La revisión final requiere COPY de cuatro fuentes, incluidos motor y corridas. Humo de imports sin red correcto. Hashes de adaptador y relector:
  - `adaptadores/ml.ts`: `d59808dd4407472bd1add3217304a93768c39dc1c8b46daf5de060ab3ba89f8c`.
  - `relectura.ts`: `15568a72807c4bb05a87d22ced53e3663650f351eac46189779c806929ca9b69`.
  - `motor.ts`: `d6cf50a1f14fd94213bb38a21650aaa9ce633cef4ec30ec0a296e34d0fc9dbf0`.
  - `corridas.ts`: `42f03ecd5915627b03abadb532189f80e11da030d9ac7bcb6e1ccc5aa42da258`.
- Preflight de Compose: entorno, montajes, comando y límites coinciden con el worker vivo. Sin migraciones; PostgreSQL permanece en 27.
- Respaldo privado: `/opt/fusionbikes/backups/sombra-recuperacion-20261015`. Dump de PostgreSQL de 632.154.441 bytes, listado de restauración válido y SHA256 guardado; configuraciones y metadatos con permisos restringidos. No contiene restauración ensayada sobre otra base en esta sesión.

## Despliegue y observación

Firma Woo reparada a las 18:11 UTC: configuración consistente, webhooks 17–20 activos y cuatro pings autenticados 200. Respaldo de firma: `/opt/fusionbikes/backups/sombra-firma-2026-10-15T18-11-47-971Z`. Monitor refrescado con ocho webhooks propios, sin caídos ni ausentes. Se observaron 13 entregas naturales de `product.updated`, completadas en el legado y copiadas a sombra. Todavía falta una entrega natural de los tópicos específicos de 17–20; no se generaron pedidos.

Worker definitivo publicado a las **18:26:26 UTC**, imagen `fusion-plataforma:sombra-recuperacion-20261015-r2`, ID `sha256:20ee28ac78969751eae524728b51e6b96468160c3b85d6eb97d416cd8c1fae28`. Sustituye la primera imagen de las 18:16, cuyo motor heredado aún no persistía checkpoints. Configuración durable en `/opt/fusionbikes/plataforma-prod/sombra-worker.override.yml`; incluir ese override en las operaciones de Compose. API y scheduler conservaron sus IDs de contenedor; legado sin reinicio. Los cuatro hashes del contenedor coinciden con fuente e imagen verificadas.

Imagen anterior retenida: `fusion-plataforma:sombra-prev-20261015`, ID `sha256:e67761ded86816f73d67b06d915e87ca3bff89906bbf0ad59aa1323881462c13`. No se aplicaron migraciones.

Se crearon 20 relecturas compensatorias de mensajes (una por recurso, máximo 25, escalonadas cada 10 segundos) y la corrida adicional de items `20914`. Los estados históricos y el horario diario de items se conservan. Incidentes Woo 64 y 65 verificados resueltos por los monitores tras el refresco.

Comprobación a las 18:27 UTC: salud de plataforma y legado correcta, worker sin reinicios ni OOM. A las **18:28 UTC**, envíos `20903` pasó de 13 a 30 páginas confirmadas; mensajes `20827` guardó ocho páginas; items `20914` guardó diez páginas y 160 recursos, en fase `contenido`. Las **20 relecturas terminaron correctamente**: 16 duplicados y cuatro nuevas capturas. Esta fotografía acredita progreso durable y recuperación del lote, no convergencia completa ni aceptación.

Segunda medición a las 18:30 UTC con el SQL versionado: items 600 recursos/37 páginas, mensajes 27 páginas y envíos 41 páginas. Se mantiene el avance entre diferimientos; ninguna de esas tres vueltas había terminado todavía.

La recuperación de mensajes crea relecturas compensatorias escalonadas, con el origen y correlación del aviso conservados. No reescribe estados ni fechas de cierre de señales históricas, para preservar los reportes de días cerrados.

## Capacidad y aceptación pendientes

Línea base del 15/10: 470 packs conocidos requieren al menos 47 minutos a 10 RPM frente a un intervalo de 20 minutos. 222 envíos requieren al menos 14,8 minutos a 15 RPM frente a 15 minutos, sin margen para señales. Corregir los checkpoints permite avanzar, pero no demuestra que el reparto actual cumpla la capacidad contractual. Registrar 24–48 horas de mediciones y calibrar el reparto antes de comenzar la campaña de siete días verdes. Mantener el techo global y controlar impacto sobre el legado.

Consulta reproducible de sólo lectura: `scripts/ops/medir-recuperacion-sombra.sql`. Separa captura futura de los consumidores de catálogo, informa corridas, señales y recuperación. La captura futura permanece con sus estados y datos reales; a las 18:01 UTC había 7.431 pendientes sin intento.

## Rollback compatible

1. Detener exclusivamente el worker de plataforma.
2. Ejecutar `rollback-items.sql`, conservado en el respaldo privado: falla sin bajas las corridas activas de items con `cursor_after.posicion.fase=contenido`, limpia sólo ese checkpoint en curso y adelanta una vuelta completa. Conserva el cursor final previo, observaciones e inbox.
3. Cambiar la imagen del override del worker a `fusion-plataforma:sombra-prev-20261015` y recrear sólo ese servicio con `--no-deps --no-build`.
4. Verificar salud, latidos y que API/scheduler conservan sus contenedores. No restaurar una base antigua sobre producción ni arrancar el código anterior con checkpoints nuevos de contenido.

La corrección de firma Woo se conserva durante un rollback del worker: es independiente y restaurar la configuración defectuosa reintroduciría los rechazos.
