# UM1.1 — Cierre inmediato de publicaciones ML activas con stock y sin SKU válido

**Estado:** desarrollo. **Prioridad:** bloqueante. **Superficie:** VPS/web responsive.
**Base:** `origin/conteo-confiable` observada en `6949f02`; rama `feature/um1-identidad-continuacion`; worktree `/opt/fusionbikes/worktrees/um1-identidad`.
**Origen:** continúa el trabajo de Codex en `feature/um1-identidad-productos` / `/opt/fusionbikes/worktrees/identidad-productos`, que quedó sin commitear al agotarse sus tokens y se copió exacto en el commit `4adeee1`.
**Seguridad:** modo `shadow`; no autoriza despliegue, migración productiva ni escrituras reales en ML.

## Resultado y alcance

Crear el núcleo mínimo nuevo y conciliar todas las claves ML activas con stock cuyo `SELLER_SKU` esté ausente, vacío, no exista de forma única en Woo o contradiga un GTIN válido. Cada clave debe quedar verificada, exceptuada explícitamente como `solo_ml`, o visible como urgencia abierta.

## Gates

1. Migración aditiva/idempotente y rollback documentado.
2. Auditoría fresca con `total = verificadas + excepciones + urgentes abiertas`.
3. Ningún caso se resuelve antes de releer ML y verificar SKU y stock.
4. Saga stock cero → limpiar SKU → escribir SKU → restaurar stock cubierta por fallos parciales.
5. Ventas inseguras retenidas y reprocesadas únicamente tras verificación.
6. Revisión, tests, E2E 390/768/1440, canario designado y jornada observada.

## Evidencia

Actualizado: 2026-09-04, worktree `/opt/fusionbikes/worktrees/um1-identidad`, rama
`feature/um1-identidad-continuacion`.

- Núcleo implementado por Codex y preservado sin cambios en `4adeee1`:
  `lib/identidadProductos.js` (543 líneas), `migrations/082_identidad_productos.sql` (294),
  `routes/identidadProductos.js` (89), `test/identidad-productos.test.js` (204), más los
  enganches en `db/index.js`, `lib/permisos.js`, `lib/modelos/publicacionMl.js`,
  `routes/matcher.js` y `server.js`.
- Estado recibido: `npx vitest run test/identidad-productos.test.js` — **7 fallidas / 8
  aprobadas de 15**. Dos INSERT de `lib/identidadProductos.js` declaraban más valores que
  columnas: `identidad_evidencias` (9 columnas, 10 valores) e `identidades_canal`
  (16 columnas, 17 valores). El tercer fallo aparente —la operación que debía ir a
  intervención al tercer intento— era consecuencia del mismo error, no un bug propio.
- Corregidos ambos INSERT. Auditoría de los 18 INSERT de `lib/identidadProductos.js` y
  `routes/identidadProductos.js`: ningún otro desajuste columnas/valores.
- Regresión sobre lo que el cambio toca alrededor: **8 fallos introducidos**, detectados al
  comparar contra un checkout limpio de `6949f02`
  (`/tmp/.../base-6949f02`: 1 fallo preexistente; con el cambio: 9).
  Causa raíz única: `db/index.js` fijaba `db.pragma('user_version = 82')` al aplicar la 082.
  En esta base `user_version` no numera migraciones: es la compuerta de la migración Hito 7
  (`user_version < 30`, al final de `openDb`). Subirla a 82 saltea esa migración, la base
  queda sin `device_tokens` y cae toda la auth móvil. Corregido eliminando ambas escrituras
  del pragma; la idempotencia de 082 la da su marcador en `_schema_migrations`.
- `test/db.test.js` compara la lista exacta de tablas y no incluía las nuevas. Regenerada
  desde el esquema real; se verificó que **ninguna tabla desapareció**. Además cubre dos
  faltantes previos a este trabajo (`guardia_ml_aprendizajes`, `matcher_candidatos_cache`),
  que eran el único fallo de la base.
- `test/identidad-productos.test.js` afirmaba `user_version === 82`, es decir codificaba el
  bug anterior. Reemplazado por el marcador de `_schema_migrations`, `user_version === 30` y
  la presencia de `device_tokens`, para que la compuerta Hito 7 no se vuelva a romper en silencio.
- Tests dirigidos: `npx vitest run test/identidad-productos.test.js` — **15/15 aprobadas**.
- Regresión final: `npx vitest run test/identidad-productos.test.js test/db.test.js test/guardia-ml.test.js test/server.test.js test/modelos-publicacionMl.test.js --no-file-parallelism` — **5 archivos, 69/69 aprobadas**.
- `skuDesdeAtributosMl` dejó de caer a `seller_custom_field`, como exige el plan. Se verificó
  contra `test/guardia-ml.test.js` (21 pruebas) que el cambio no rompe Guardia: los dos fallos
  que aparecieron en una corrida intermedia eran `attempt to write a readonly database`,
  contaminación entre corridas, y no se reproducen.
- Revisión independiente: no ejecutada.
- E2E 390/768/1440: no ejecutado; todavía no hay pantalla de la herramienta.
- Auditoría del universo ML real: no ejecutada; requiere lectura contra ML y el modo sigue
  siendo `shadow`.
- Canario, rollback real y jornada observada: pendientes externos.

## Checkpoint para el próximo agente

Base: worktree `/opt/fusionbikes/worktrees/um1-identidad`, rama
`feature/um1-identidad-continuacion`, sobre `6949f02`. `node_modules` es un symlink al del
checkout principal. No desplegar, no migrar contra `data/fusion.sqlite`, no escribir en ML.

Verificado y funcionando: el núcleo de UM1.1 (productos, identidades, casos, evidencia,
excepciones, operaciones) con `npx vitest run test/identidad-productos.test.js` en 15/15,
incluida la saga zero → clear → write → restore y el pase a intervención al tercer fallo.

Queda a medias:

- No hay superficie web: `routes/identidadProductos.js` expone la API pero falta
  `/herramientas/identidad-productos/` en `public/`. Sin eso no se puede correr el E2E
  390/768/1440 que pide el gate 6.
- La conciliación del universo (gate 2: `total = verificadas + excepciones + urgentes
  abiertas`) solo está probada con datos sintéticos; falta la auditoría contra el universo ML
  real, que exige lectura remota.
- Los gates 3, 4 y 5 tienen cobertura sintética en `test/identidad-productos.test.js` pero no
  revisión independiente.

Próxima acción reproducible: correr `npx vitest run test/identidad-productos.test.js`, después
la regresión de lo tocado alrededor
(`npx vitest run test/modelos-publicacionMl.test.js test/db.test.js test/guardia-ml.test.js test/server.test.js --no-file-parallelism`),
y recién entonces construir la pantalla para habilitar el E2E.
