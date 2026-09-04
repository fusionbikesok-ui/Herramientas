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
- Superficie web construida: `public/identidad-productos/index.html`, servida en
  `server.js` y enlazada desde `public/home/index.html`. Alcance UM1.1 (ver PM-036): salud,
  conciliación, cola ML→Fusion, detalle del caso con evidencia, tomar/relevar, nota,
  vincular, excepción `solo_ml`, operaciones e historial. `Productos Fusion` es lista de
  solo lectura hasta UM1.3 y la cola Woo→ML queda para UM1.4.
- E2E 390/768/1440: `npm run e2e:um11:responsive` — **`ok:true` en los tres anchos**
  (`scripts/um11-browser-smoke.mjs`, entorno aislado con sqlite temporal y `DISABLE_CRONS`).
  Verifica salud y modo visibles, conciliación exacta, caso en cola, detalle con
  `SELLER_SKU` ausente marcado, `seller_custom_field` declarado como no-cobertura, aviso de
  modo `shadow`, layout de una o dos columnas según ancho, una mutación real (nota, 201) con
  el sobre `operation_id` + `expected_version` + `evidence_fingerprint`, y el evento
  `nota_agregada` apareciendo en Historial. Falla si hay `pageerror` o respuesta ≥400.
- El E2E detectó que el plan no definía el comportamiento en tablet: resuelto en PM-037.
- Vínculo manual usable (PM-040): buscador por nombre, SKU Woo o GTIN
  (`buscarProductosFusion` + `GET /productos/buscar`), con foto, SKU, stock y cantidad de
  claves ML ya vinculadas, y **vista previa obligatoria** antes de confirmar. Reemplaza el
  `prompt()` que pedía el ID a mano.
- Revisión independiente ejecutada sobre `4adeee1..HEAD` + working tree: 🟡 aprobado con dos
  hallazgos accionables, ambos corregidos:
  (a) `public/home/index.html` y `package.json` se habían reescrito enteros por normalización
  de CRLF/BOM — 2547 líneas de ruido para un cambio de 16. Restaurados desde `4adeee1` y
  reeditados en binario preservando terminadores (PM-041).
  (b) `buscarProductosFusion` no tenía test unitario. Cubierto.
- El tester encontró un bug real al cubrirlo: `Number(limite) || 20` mandaba `limite: 0` al
  default en vez de clamparlo a 1, porque `0` es falsy. Corregido con `Number.isFinite`.
- Accesibilidad: axe-core corre dentro del E2E sobre la pantalla real en cada ancho, con
  reglas wcag2a/2aa/21a/21aa/22aa. **Cero violaciones** en 390, 768 y 1440; el script falla
  ante cualquier violación `critical` o `serious` (PM-042).
- Tests: `npx vitest run test/identidad-productos.test.js test/db.test.js test/guardia-ml.test.js test/server.test.js test/modelos-publicacionMl.test.js --no-file-parallelism` — **5 archivos, 76/76**.
- E2E final: `npm run e2e:um11:responsive` — `ok:true` en 390, 768 y 1440, con el vínculo
  hecho por el buscador real de la pantalla y la operación quedando en estado `shadow`.
- Auditoría del universo ML real: no ejecutada; requiere lectura contra ML y el modo sigue
  siendo `shadow`.
- Canario, rollback real y jornada observada: pendientes externos.

## Checkpoint para el próximo agente

Base: worktree `/opt/fusionbikes/worktrees/um1-identidad`, rama
`feature/um1-identidad-continuacion`. `node_modules` es un symlink al del checkout
principal. No desplegar, no migrar contra `data/fusion.sqlite`, no escribir en ML.

Verificado y funcionando:

- Núcleo UM1.1 y pantalla web. `npx vitest run test/identidad-productos.test.js test/db.test.js test/guardia-ml.test.js test/server.test.js test/modelos-publicacionMl.test.js --no-file-parallelism` — 69/69.
- `npm run e2e:um11:responsive` — `ok:true` en 390, 768 y 1440.

Queda a medias, en orden de valor:

1. **Auditoría contra el universo ML real** (gate 2). Hoy la conciliación solo se probó con
   datos sintéticos. Exige lectura remota; el modo sigue en `shadow`.
2. **Auditoría de despliegue**: pendiente sobre el diff final.
3. Gates externos: canario, rollback real y jornada observada.

Próxima acción reproducible: correr los dos comandos de arriba para confirmar la base, y
después atacar (1) o (2) según prioridad operativa.
