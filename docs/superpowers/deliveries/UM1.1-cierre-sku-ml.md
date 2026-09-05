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

## Corrección reportada por el usuario: «¿se guardan las decisiones? me recarga siempre el mismo listado»

**Se guardaban.** Verificado en la base productiva: una decisión `vincular` del operador
`Jose` (2026-09-04 21:05:06) sobre el caso 24, con su operación encolada en `shadow`
(`sku_objetivo FB-1732`), el caso en estado `pendiente` y el evento
`decision_persistida_antes_de_efecto` en el historial.

El fallo era de la pantalla, y tenía dos partes:

1. La cola titulada «Pendientes» pedía **todos** los casos: 1203, de los que 1092 ya estaban
   verificados. El trabajo real (110) quedaba enterrado.
2. El orden es por severidad, no por estado, así que un caso recién decidido **no se movía de
   lugar** y no había ninguna señal de que algo hubiera pasado. En modo `shadow` tampoco hay
   efecto remoto que se note.

Corregido: la cola lista sólo casos accionables (PM-056) y toda decisión confirma en pantalla
y avanza al siguiente caso (PM-057). La cabecera informa las tres cifras para que nada quede
oculto, y los casos con operación encolada siguen visibles en Operaciones.

El E2E lo cubre: verifica el aviso «Decisión guardada», que el caso sale de la cola de trabajo
(`accionables: 0`) y que **no desaparece del tablero** (`todos: 1`).

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
- **Gate 6** — el canario directo de dos publicaciones ya fue designado, ejecutado y
  observado; rollback y jornada operativa completa siguen siendo pendientes.

Un veredicto verde de auditoría de código no sustituye evidencia de gate. El estado no se
infiere por tener el diff limpio y la suite verde.
- Auditoría del universo ML real y jornada operativa completa: pendientes; el modo productivo
  está restringido al canario explícito.

## Checkpoint para el próximo agente

Base: producción en `/opt/fusionbikes/herramientas`, rama `conteo-confiable`, commit `f2ddb22`.
El worktree `/opt/fusionbikes/worktrees/um1-identidad` conserva la rama de desarrollo.

### Lo que quedó funcionando y verificado

- **Ejecutor de la saga remota completo**: `procesarOperacionesIdentidad` (worker, cron cada
  minuto) + `lib/identidadMl.js` (adaptador, único lugar que escribe en ML). Fail-closed:
  exige `modo='enforced'` y `escrituras_remotas_habilitadas=1`; respeta `canario_ml_key` y
  `lote_max`; saltea operaciones con `claim_hasta` vigente.
- **Dos canarios ejecutados en producción**, con escrituras reales verificadas leyendo la API
  de ML en cada paso:
  - `MLA1320264343` (SKU ya correcto): completó **sin ninguna escritura**.
  - `MLA1563030043`: corrigió `FB-FB-29140` → `FB-29140`, stock 1 → 0 → 1. Ventana en 0: ~6 min.
- **Pasos encadenados en una corrida**: la saga completa pasó de ~8 minutos a 13,7 s.
- **Camino directo sin cero**: si el destino es un SKU válido se sobrescribe de una, sin poner
  stock en 0 ni limpiar. Medido: 1 escritura en 6 s, stock intacto. Tests 36/36.

### Problemas de estado reportados por el usuario

Casos que ya tenían decisión volvieron a la cola. **No son el bug de la huella** (ese está
arreglado y verificado): son dos caminos distintos.

1. **Resuelto — caso 105 (`MLA1320264343|`)**: si la operación está `completada`, ML conserva
   exactamente el `fusion_sku` y el Producto Fusion no cambió, una reclasificación
   `gtin_contradictorio` mantiene el caso `verificado`. El conflicto queda en la clasificación
   y en el evento `gtin_contradictorio_post_verificacion`; no vuelve a la cola ni repite la
   escritura. Si el SKU desaparece o cambia, sí reabre urgente. Regresión dirigida: 34/34.
2. **Resuelto — caso 1018 (`MLA3588983126|`)**: si el cambio de identidad llega mientras la
   última operación sigue `shadow`, tiene cero intentos y no registra pasos remotos, esa
   operación queda inmovilizada como `obsoleta_por_cambio_identidad_antes_de_efecto_remoto`.
   No se puede reintentar, el responsable se libera y el caso vuelve a `urgente` para una
   decisión nueva. Una saga que ya empezó conserva `intervencion`, porque puede tener efectos
   parciales. Regresión dirigida incluida.

### Estado operativo observado — 2026-09-05 01:07 UTC

Configuración durante el canario: `modo=enforced`, `escrituras_remotas_habilitadas=1`,
`canario_ml_key='MLA798189569|,MLA1541702013|'`, `lote_max=2`. Backups históricos:
`fusion.sqlite.bak-antes-canario-20260904-232618`, `...-canario2-20260904-234431`,
`fusion.sqlite.bak-um11-directo-20260905-005000` y
`fusion.sqlite.bak-um11-canario2-20260905-010000`.

Tras la observación, el canario fue retirado y se habilitó el procesamiento general el
2026-09-05 01:07 UTC: configuración observada `modo=enforced`,
`escrituras_remotas_habilitadas=1`, `canario_ml_key=''`, `lote_max=2`. En el primer tick, dos
operaciones antiguas fueron llevadas a `intervencion` por el umbral de 15 minutos, sin fallo
remoto. Backups: `data/fusion.sqlite.bak-um11-retirar-canario-20260905T010521Z` y
`data/fusion.sqlite.bak-um11-habilitar-general-20260905T010721Z`.

### Despliegue técnico — 2026-09-05

- Merge local: `a0a6b6d`; sin push.
- PM2 reiniciado; proceso online y servidor escuchando en `:3001`.
- La migración `identidad_sin_cero_085` quedó aplicada sin tocar `user_version`.
- Backup consistente previo: `data/fusion.sqlite.bak-um11-directo-20260905-005000`.
- La configuración inicial quedó restringida a `MLA1563030043|` y lote 1 durante el arranque.

### Canario directo de dos publicaciones — 2026-09-05

- Backup consistente previo: `data/fusion.sqlite.bak-um11-canario2-20260905-010000`.
- Se reencolaron únicamente `MLA798189569|` (operación 22) y `MLA1541702013|` (operación 13),
  con `canario_ml_key` exacto de esas dos claves y `lote_max=2`.
- El worker completó ambas operaciones con `sin_cero=1`; no hubo una tercera operación canario.
- Relectura autenticada de ML a las 01:00 UTC: `MLA798189569|` quedó en `FB-10376`, stock 1;
  `MLA1541702013|` quedó en `FB-50396`, stock 6. El stock permaneció intacto en ambos casos.
- Este resultado cierra la observación del camino directo para el canario de dos publicaciones;
  cualquier ampliación requiere una nueva designación explícita.

## Cierre documental de reglas operativas — 2026-09-05

- PM-111 reemplaza definitivamente la saga con stock cero por sobrescritura directa, stock Woo fresco y verificación remota; un fallo pasa a intervención sin fallback destructivo.
- PM-104/PM-115 fijan protección ante pérdida de identidad Woo y retención del pedido completo.
- PM-107 separa trabajo humano de operaciones esperando worker; `bloqueada_impacto` permanece accionable en ambas vistas.
- Los conteos, canarios y diagnósticos anteriores de esta ficha son evidencia histórica fechada, no descripción automática del estado productivo actual.
- Gates aún no ejecutados por este cierre: suite global serial, jornada comercial completa y rollback en copia sanitaria más prueba productiva `shadow/read-only`.

### Checkpoint para integración paralela

Base de este cierre: rama `conteo-confiable`, commit inicial `43cae13`, checkout `/opt/fusionbikes/herramientas`. Claude trabaja separadamente en `/opt/fusionbikes/worktrees/um1-identidad`, rama `feature/um1-identidad-continuacion`, rango observado `43cae13..1d5b2c8`. Ese rango todavía no se incorporó: toca código, UI, pruebas y documentación y debe reconciliarse contra PM-104–PM-116 antes de atribuir resultados. Este avance documental no ejecutó código, despliegues, escrituras remotas ni gates operativos.

### Rediseño de la pantalla — 2026-09-05

Motivo: la crítica visual completa (`visual-critique:critique-screen`) sobre las capturas
`crit-desktop-detalle.png` y `crit-movil-detalle.png` marcó como P1 que en 390px la tarea no
era visible sin scrollear y que `--accent` decoraba etiquetas que no se pueden tocar.

Cambios:

- **Nuevo** `public/lib/components.css`: capa de componentes compartida sobre los tokens de
  `theme.css` (PM-104). Clases `ui-btn`, `ui-card`, `ui-panel`, `ui-chip`, `ui-id`, `ui-label`,
  `ui-resumen`, `ui-mas`, `ui-tabs`, `ui-table`, `ui-aviso`, `ui-input`, más una escala
  tipográfica real de cinco escalones (`--fs-titulo` 1.25rem … `--fs-label` 0.75rem); la escala
  anterior comprimía todo en 0.28rem de rango.
- `public/identidad-productos/index.html`: importa la capa; las cinco tarjetas de telemetría
  pasan a una línea `.ui-resumen` (PM-105); los atributos de ML usan divulgación progresiva
  (PM-106); las acciones se ordenan con la primaria primero; el comparador ML/Woo va a 55fr/45fr.
- `scripts/um11-browser-smoke.mjs`: la aserción de conciliación deja de buscar las etiquetas de
  las tarjetas viejas y verifica la línea `#recon .ui-resumen`.

Contraste: el primario usa fondo `--accent-dim` + borde + texto de acento, no fondo sólido —
texto claro sobre `#2DB8E8` sólido da ~1.9:1 y no pasa AA.

Evidencia medida:

- Blanco de toque: los 4 botones de acción a 44px (`min-height: var(--tap-min)` aplicado).
- En 390px el detalle del caso arranca a **330px** del borde superior; antes quedaba fuera de la vista.
- Atributos de ML: de 26 filas planas a **6 discriminantes + «Ver los otros 19»**.
- `npx vitest run test/identidad-productos.test.js test/invariantes-esquema.test.js
  --no-file-parallelism` → **2 archivos, 41 tests, todos verdes**.
- `npm run e2e:um11:responsive` → verde en 390/768/1440, `"axe_violaciones":[]` en los tres.

### Handoff

- Rama: `feature/um1-identidad-continuacion` en `/opt/fusionbikes/worktrees/um1-identidad`.
- `docs/superpowers/plans/plan-maestro-v2.md` §18.1: la máquina de estados de la operación ya
  describe el camino directo (`pendiente → write → verify_write → activate → reprocess →
  confirmado`) y deja el camino largo como excepción marcada con `sin_cero=0`.
- Pendiente de definición del usuario: si la capa de componentes se extiende a las 27 pantallas
  o queda por ahora en las de UM1.

### Suite completa: de 121 rojos a 11 — 2026-09-05

Resultado final: `Test Files 4 failed | 104 passed | 1 skipped (109)`,
`Tests 14 failed | 2116 passed | 51 skipped (2181)`.

De los 14, **3 son falsos** y **11 son una alarma correcta**:

- `sync.test.js`, `inventario.test.js` y `consultaPrecios.test.js` fallan 1 caso cada uno en la
  corrida completa y pasan **325/325 corridos juntos y aislados**. Es la interferencia entre
  archivos ya documentada en CLAUDE.md.
- `preparacion-contrato.test.js` (11) falla porque **falta el código**, no porque el test esté
  viejo: la migración `064_seguimiento_paso1_incierto.sql` está aplicada y los tests existen,
  pero `routes/preparacion.js` no tiene una sola aparición de `incierto`. El commit `1c5f560`
  sí la tiene (17 apariciones) y **no es ancestro de esta rama**. Se dejan en rojo a propósito:
  silenciarlos ocultaría una regresión real del flujo de tracking de Andreani.

Causa raíz de los 121, ya cerrada: el commit base `6949f02` superpuso los invariantes estrictos
de UM1 sobre el código y los tests legacy sin reconciliarlos.

Lección operativa nueva: **un test puede estar verde por una base rancia.**
`matcher-ml-robusto-hito4` escribe su propio `CREATE TABLE` a mano y había quedado seis columnas
atrás de lo que inserta `prepararUpsertCache`; venía pasando sólo porque reusaba un `.sqlite`
viejo de `test/` que sí las tenía. Al limpiar los temporales huérfanos apareció el fallo.
Conviene correr `git clean -f -x test/` antes de una corrida que se vaya a creer.

### Reconciliación con el cierre documental paralelo — 2026-09-05

El rango `43cae13..bb35def` de esta sesión se reconcilió contra PM-104–PM-116 mezclando
`9ca06bf` hacia la rama, no al revés. Criterio de cada conflicto:

- **§18.1 del plan maestro:** gana la reescritura de producción, posterior y más completa; ya
  incorpora el camino directo. El detalle de implementación (`sin_cero`, nombres reales de los
  pasos) queda en esta ficha, que es donde corresponde.
- **Decisiones:** la numeración PM-103–PM-116 de producción es la canónica. Las tres decisiones
  de esta sesión se renumeraron a PM-117 (capa de componentes), PM-118 (línea de telemetría) y
  PM-119 (divulgación progresiva). PM-103 de producción reemplaza a la equivalente de esta rama,
  mejor redactada. Se agregan PM-120 (cobertura por `seller_sku` único), PM-121 (retiro de
  Cobertura confirmado) y PM-122 (un test verde por base rancia).
- **Pendientes:** se conservan los dos hallazgos abiertos de esta sesión (2 publicaciones con SKU
  inexistente en Woo y 3 claves con stock que no coincide). Se descartan los dos ya cerrados.
- **Fichas:** ambas secciones son complementarias y se conservan las dos.

Gate de la regla de despliegue: la suite global quedó en 11 rojos, todos de
`preparacion-contrato.test.js` y todos por **código faltante**, no por tests viejos — ver la
sección anterior. No hay rojo atribuible a este rango.

### Despliegue del rediseño y la reconciliación de ventas — 2026-09-05

- Producción había divergido dos veces durante el trabajo (`9ca06bf` y `f8388bb`, ambos sólo
  documentación). Se mezclaron **hacia la rama** y recién después se hizo `--ff-only` sobre
  producción: nunca se forzó ni se pisó el trabajo de la sesión paralela.
- Backup consistente previo (`VACUUM INTO`):
  `data/fusion.sqlite.bak-um11-merge-rediseno-20260905T124447Z` (83 MB).
- `pm2 restart herramientas` → `online`. `GET /login/` responde **200** en 12 ms y
  `GET /lib/components.css` responde **200**: la capa de componentes se sirve.
- Verificación de que la reconciliación de ventas no retiene de más: reservas retenidas **2**
  (las mismas del 2026-08-30), `wc_order_id=0` **3**, sin altas nuevas. Identidad: 109
  operaciones completadas, 1133 casos verificados, 4 urgentes.
- Los errores en el log son ruido preexistente de rate-limit 429 de ML, ajenos a este cambio.

### Deuda dormida de publicaciones fuera del universo activo — 2026-09-05

Brecha 5 del documento de arquitectura, acotada a su parte de detección (la protección remota
con stock cero escribe en ML y va aparte).

Hallazgo: una publicación pausada o en cero se cerraba como `resuelto` («fuera de alcance») y
desaparecía. No es fuera de alcance: conserva la identidad que tenga y, si se reactiva, sale a
la venta con ella. El cron legacy que las corregía (`pushSkusPendientes`) ya no está agendado.

Peor: al reactivarse **se auto-verificaba contra el producto equivocado**, porque el SKU ajeno
que llevaba existe y es único en Woo, así que clasificaba `sku_exacto`.

Cambios (`lib/identidadProductos.js`):

- Pase nuevo de deuda dormida, con corte **estrecho**: sólo claves fuera del universo activo con
  una decisión que ML no refleja. Severidad `normal`, fuera de la conciliación.
- `decision_no_aplicada`: una decisión divergente invalida la identidad y el caso apunta al
  producto decidido, no al que ML lleva por error.
- Escalada a `critica` cuando una deuda vuelve a estar activa con stock e identidad inválida.
- `huellaIdentidad()` extraída: los dos pases deben producir la misma huella o el caso oscilaría
  entre ellos en cada scan.

Evidencia, comando y resultado literales:

```
npx vitest run test/identidad-productos.test.js test/invariantes-esquema.test.js \
  test/guardia-ml.test.js test/um1-coverage-matrix.test.js test/matcher-candidatos.test.js \
  test/cobertura.test.js test/syncFlow.test.js
  Test Files  7 passed (7)
  Tests  210 passed | 2 skipped (212)

npm run e2e:um11:responsive → ok:true en 390/768/1440, "axe_violaciones":[]
```

Contra una **copia** de la base de producción (sin escrituras remotas):

```
conciliacion: {"total":1088,"verificadas":1086,"excepciones":0,"urgentes":2,"conciliado":true}
decision_no_aplicada: MLA1401411650|180043410439, MLA1927478426|187049488547, MLA2000138388|192504429779
```

Un corte más ancho (toda pausada sin SKU) daba **4047 casos** y se descartó por eso.

### Handoff

- Sin desplegar. No se ejecutó ninguna escritura remota.
- Pendiente de UM1.6: migrar `POST /api/guardia-ml/vincular-clave` a UM1 y recién después
  desagendar el worker de Guardia (PM-125). Hoy hay dos escritores de `SELLER_SKU`.

### Despliegue de deuda dormida y permisos de despacho — 2026-09-05 18:41 UTC

Commits desplegados: `d7fc2a0` (paso 1 incierto de Andreani), `b89c63d` (deuda dormida y
`decision_no_aplicada`) y `e01fc1d` (permisos de despacho sobre el tracking).

Gate de la suite global, comando y resultado literales:

```
npm test
  Test Files  1 failed | 107 passed | 1 skipped (109)
  Tests  1 failed | 2137 passed | 51 skipped (2189)

npx vitest run test/inventario.test.js     # el único rojo, aislado
  Test Files  1 passed (1)
  Tests  167 passed (167)
```

El único fallo de la corrida completa es `inventario.test.js`, que pasa 167/167 aislado: es la
interferencia entre archivos ya documentada, no una regresión. `preparacion-contrato` quedó
verde en la corrida completa, cerrando los 11 rojos que venían del código faltante.

Despliegue:

- Producción tenía un cambio sin commitear de otra sesión (`docs/memory/modules/warehouse-operations.md`).
  Se verificó que el rango no toca ese archivo y se confirmó intacto después del merge.
- Backup consistente previo (`VACUUM INTO`): `data/fusion.sqlite.bak-um11-deuda-20260905T184122Z` (84,5 MB).
- `--ff-only` a `e01fc1d`; `pm2 restart` → `online`; `GET /login/` 200 en 5,8 ms.
- Estado posterior sin cambios: reservas retenidas 2, `wc_order_id=0` 3, 111 operaciones
  completadas, 1124 casos verificados.

**Verificado en producción, 2026-09-05 18:51:46 UTC.** Al desplegar, el último scan confiable
era de las 18:36:46 —código anterior—, así que la deuda no podía haber aparecido todavía. Se
esperó al primer scan posterior con el código nuevo y se observó el resultado:

```
scan nuevo: 2026-09-05T18:51:46.467Z
deuda dormida: MLA1401411650|180043410439, MLA1927478426|187049488547, MLA2000138388|192504429779
               (las tres severidad 'normal', estado 'urgente')
casos: verificado 1124, resuelto 79, urgente 5
```

Aparecieron exactamente las tres esperadas y ninguna más. Los 5 urgentes son los 2 previos más
estas 3, que por severidad `normal` no cuentan como trabajo humano ni entran en la conciliación
del universo activo.

## Bolsa de stock compartida: `user_product_id` y su invariante — 2026-09-05

Un `user_product` de MercadoLibre es UNA cantidad, compartida por todas las publicaciones que
lo referencian. Si dos apuntan a Productos Fusion distintos, cada corrida del sync empuja una
cantidad diferente a la misma bolsa: se pisan para siempre y la que pierde queda exponiendo el
stock de la otra.

Dos cambios:

1. **`lib/modelos/publicacionMl.js`** — `user_product_id` se toma de `body.user_product_id`
   (campo de primer nivel), no de los atributos. El código lo buscaba como atributo
   `USER_PRODUCT_ID` y devolvía `null` siempre; las 6894 filas del cache estaban en NULL desde
   la migración 082. La petición a ML ya lo pedía y el upsert ya tenía la columna.
2. **`lib/identidadProductos.js`** — nuevo `conflictosDeBolsaCompartida(db)`. Agrupa por el
   producto del **caso**, no por la identidad activa: una identidad sólo se activa al
   verificarse, y estos conflictos impiden que se verifique, así que la primera versión no
   habría detectado ninguno de los casos reales.

Evidencia:

```
npx vitest run test/identidad-productos.test.js test/modelos-publicacionMl.test.js \
  test/publicacion-ml.test.js test/matcher-candidatos.test.js \
  test/matcher-ml-robusto-hito4.test.js test/guardia-ml.test.js test/um1-coverage-matrix.test.js
  Test Files  7 passed (7)
  Tests  123 passed (123)
```

Medición contra una **copia** de la base de producción, poblando `user_product_id` con lecturas
autenticadas (sólo GET, ninguna escritura):

```
items activos a leer: 927
leidos: 927 | con user_product_id: 874        (94%)

=== CONFLICTOS DE BOLSA COMPARTIDA: 3
   MLAU3086754975 | FB-3789, FB-28334     maza 28H vs 32H
   MLAU3210195462 | FB-1805, FB-32234     cadena vs OEM
   MLAU402482129  | FB-21141, FB-21145    maza Boost 15×110 vs estándar 15×100
```

El tercero **no daba síntoma**: sus cantidades coinciden hoy, así que no producía el bucle de
reconciliación. Pero la bolsa tiene 1 unidad y las dos publicaciones muestran 1. Ése es el valor
del detector: encuentra el conflicto latente, no sólo el que ya está fallando.

### Handoff

- Sin desplegar. Ninguna escritura remota.
- Falta exponerlo en la pantalla y decidir el destino de cada par: cuál de los dos mapeos está
  mal, o si hay que desvincular las publicaciones del `user_product` compartido en ML. Eso es
  decisión de Ventas: son productos distintos que ML agrupó.
- El primer refresco tras desplegar poblará `user_product_id` de forma natural; no hace falta
  backfill.
