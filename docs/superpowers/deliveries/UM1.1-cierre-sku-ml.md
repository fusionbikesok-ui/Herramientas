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
- Auditoría de despliegue sobre el diff final (`4adeee1..881cc1b`): 🟢, con la observación
  operativa de que pm2 sirve estáticos desde `/opt/fusionbikes/herramientas` al instante
  mientras el backend sigue en memoria hasta un `pm2 restart`, así que un merge abriría una
  ventana con el front nuevo pegando contra rutas viejas. **No se mergeó**: la decisión es
  del responsable operativo.

## Auditoría contra el universo ML real (2026-09-04)

Ejecutada sobre **copias** de `data/fusion.sqlite` en `/tmp`, sin llamadas a ML y sin escribir
en la base productiva, según pide la ficha matriz. Universo: 6893 publicaciones en cache, de
las cuales **1201 son claves activas con stock**; catálogo Woo: 5139 productos.

**El resultado del código no era utilizable, y ese es el hallazgo principal.** Devolvió
`total: 1201, verificadas: 0, urgentes: 1201, conciliado: true`, con las 1201 clasificadas
`sku_ausente`. Contando a mano contra el catálogo Woo sobre la misma copia, lo real es:

| Clasificación | Claves |
| --- | --- |
| `sku_exacto` (cubiertas) | 907 |
| `sku_vacío` o ausente | 217 |
| `sku_inexistente` en Woo | 77 |
| `sku_no_único` | 0 |

A corregir: **294 de 1201**, no 1201.

Causa (PM-044): la migración 082 agrega `seller_sku_presente` con `DEFAULT 0` y las filas del
cache son anteriores. Verificado sobre la copia migrada: `seller_sku_presente=1` en **0** filas
y `atributos_json` no nulo en **0**, pese a que 984 tienen `seller_sku` con valor.
`clasificarClaveMl` evalúa `if (!presente) → 'sku_ausente'` antes de mirar el SKU.

No se hizo backfill: sería incorrecto por PM-045.

Endurecimiento aplicado (PM-043, PM-044): una clave sin observación completa ya no se
clasifica, no genera caso, se cuenta como `observacion_incompleta`, impide la conciliación y
degrada la salud. Verificado sobre el universo real: `auditadas: 0`,
`observacion_incompleta: 1201`, `conciliado: false`, **0 casos creados** — en vez de 1201
urgencias falsas.

**Estas cifras son un diagnóstico sobre cache local, no evidencia del gate 2.** El gate exige
un refresco ML completo previo, que todavía no se ejecutó.

## Publicación en producción (2026-09-04)

Autorizada explícitamente por el responsable operativo.

- Merge fast-forward de `feature/um1-identidad-continuacion` a `conteo-confiable`, la rama
  productiva. Punto de retorno: tag `pre-merge-um1-identidad-20260904` en `6949f02`.
- Respaldo de la base antes de migrar:
  `/tmp/.../fusion-pre-082-1833.sqlite` (41 MB).
- `pm2 restart herramientas`. Verificado en el puerto real (3001, no 3000):
  `/login/` 200, `/identidad-productos/` 200, `/api/identidad-productos/resumen` 401 sin sesión.
- Base productiva tras el restart: migración 082 aplicada, `user_version` en **30** (la
  compuerta de Hito 7 intacta, PM-034), `device_tokens` presente.
- **0 casos creados y 0 productos_fusion**, con 1201 claves contadas como `observacion_incompleta`.
  El endurecimiento de PM-044 funcionó en producción: sin él se habrían creado 1201 urgencias
  falsas. El cron de refresco completo (cada 15 minutos) repuebla los atributos y recién
  entonces la auditoría clasifica.

El modo sigue siendo `shadow`: no hay escrituras a MercadoLibre.

## Corrección reportada por el usuario: la pantalla no permitía comparar

Reporte: «en la pantalla de identidad no tengo fotos, solo me aparecen códigos y no tengo
cómo saber con qué producto comparar en WC». Confirmado y corregido; eran tres fallas mías.

1. **El detalle se armaba solo con la instantánea de evidencia**, que guarda identificadores
   y no título ni foto. `obtenerCasoIdentidad` ahora entrega también la publicación ML
   (título, foto, permalink) y el producto Woo candidato (nombre, foto, SKU, stock); la cola
   lleva miniatura y variante (PM-054).
2. **Las 1113 miniaturas de ML son `http://`** y la herramienta se sirve por HTTPS: el
   navegador las bloqueaba por contenido mixto. Se normalizan a `https` al entregarlas
   (PM-053). El E2E falla si la foto no sale por https.
3. **El buscador de vínculo obligaba a adivinar la consulta.** Ahora arranca precargado con
   el título de la publicación y busca solo (PM-055).

Verificado contra una copia de la base productiva, no solo con datos sintéticos: el caso
«Casco Rembrandt Para Niños» muestra foto y título reales, y el buscador trae **5 candidatos
Woo con foto** sin que nadie escriba nada. Comprobado además que las imágenes **cargan**
(`naturalWidth > 0`), no solo que exista la etiqueta.

## Blindaje contra regresión silenciosa

`test/invariantes-esquema.test.js` no prueba una feature: impide que vuelvan clases de bug
que la suite **no detectaba**, porque fallaban en runtime solo al ejecutar esa rama o, peor,
devolvían un resultado falso con todo en verde. Alcance: todo el repo (`lib/`, `routes/`,
`db/`, `server.js`), no solo UM1.

| Guard | Qué impide |
| --- | --- |
| Columnas = valores en todo `INSERT` | 261 INSERT analizados. Es el bug que rompió 7 pruebas de UM1.1 |
| Ninguna migración escribe `user_version` > 30 | PM-034: saltearía Hito 7 y tiraría la auth móvil |
| Ninguna ruta/`lib`/`server` pasa `allowRemoteWrites: true` | `shadow` deja de depender solo de una fila de config |
| La 082 nace en `shadow`, escrituras en 0 y con fila 1 | Una base nueva no puede arrancar escribiendo en ML |

Cada guard fue validado **reintroduciendo su bug a propósito** y confirmando que falla con
archivo, línea y causa. Un guard que no se probó contra su propio bug no blinda nada (PM-047).

Hallazgo del blindaje: hoy **ningún** código de producción invoca
`procesarPasoOperacionIdentidad`. No hay worker que ejecute la saga remota, así que `shadow`
está garantizado por estructura y no solo por bandera (PM-048).

Verificado en producción tras el restart: `identidad_config` tiene la fila 1 con
`modo='shadow'` y `escrituras_remotas_habilitadas=0`.

## Gate 2 cumplido contra el universo ML real (2026-09-04 18:51)

El cron de refresco completo repobló los atributos y la auditoría corrió sobre datos frescos
de MercadoLibre. Resultado en la base productiva:

| Clasificación | Claves |
| --- | --- |
| `sku_exacto` → **verificadas** | 1090 |
| `sku_inexistente` | 80 |
| `gtin_contradictorio` | 17 |
| `sku_ausente` | 9 |
| `stock_no_verificado` | 7 |

`conciliacionIdentidad`: `total 1203 = verificadas 1090 + excepciones 0 + urgentes 113`,
`observacion_incompleta: 0`, **`conciliado: true`**, con `ultimo_scan_confiable_en` fresco.
Esta vez la igualdad significa algo, porque la clasificación es real.

**El backlog real a corregir es 113**, no 1201 (lo que decía el código sin endurecer) ni 294
(mi diagnóstico previo sobre cache viejo). La diferencia se explica sola: el refresco anterior
no pedía `include_attributes=all`, así que ML no devolvía `SELLER_SKU` para buena parte del
catálogo y el cache lo registraba como ausente.

## Incidente de producción y su corrección

Durante ese primer escaneo **la aplicación dejó de responder unos 3 minutos**: el proceso
quedó en estado `D` (bloqueado en I/O) y `/login/` no contestaba.

Causa: ni `auditarIdentidadProductos` ni `bootstrapProductosFusion` envolvían sus escrituras
en una transacción. Con `journal_mode=delete` cada statement hace su propio `fsync`, y como
`better-sqlite3` es síncrono, el cron bloqueaba el hilo que sirve HTTP. Medido sobre la base
real: **158 s y 200 s por auditoría**, con el cron corriendo cada 900 s.

Corregido envolviendo ambas en una sola `db.transaction()` (PM-049). Medido sobre copia de la
misma base: **1890 ms y 1931 ms**, con resultados idénticos (`urgentes=113`,
`verificadas=1090`, `conciliado=true`). Unas 100 veces más rápido.

`journal_mode=WAL` queda evaluado y no adoptado (PM-050): merece su propia ventana.

## Por qué sigue en `desarrollo` y no pasa a `candidata`

La auditoría dio verde sobre el diff, pero el diff no es la entrega. Contra los gates propios
de UM1.1 quedan sin cumplir:

- **Gate 2** — la auditoría contra el universo real se ejecutó (ver arriba) y demostró que el
  cache no es clasificable sin un refresco ML completo previo. Ese refresco es la acción
  pendiente; hasta entonces `conciliado` es `false` por diseño.
- **Gate 3** — «ningún caso se resuelve antes de releer ML» está cubierto por tests, no por una
  verificación contra ML real.
- **Gate 6** — canario designado y jornada observada son externos y no ocurrieron.

Un veredicto verde de auditoría de código no sustituye evidencia de gate. El estado no se
infiere por tener el diff limpio y la suite verde.
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
