# Diseño v2: etiquetas en Preparación (web Andreani + ML) y menos scroll

Repo: FusionBikes Herramientas (Node/Express ESM, better-sqlite3, vitest). Prod real. Pedido de José, 15/10/2026.
v2 incorpora la revisión de Codex (ronda 1: 2 bloqueantes, 3 altas, 3 medias).

## Contexto verificado (master)

- `lib/preparacion.js:218-223` `requisitosPaquete()`: fotos obligatorias `paquete_abierto` y `paquete_cerrado`
  ("Paquete ya cerrado, con la etiqueta puesta").
- Web/Andreani: la etiqueta se genera a mano en Andreani desde un Excel que exporta la herramienta; al embalar a menudo
  no existe todavía.
- `POST /:id/foto` rechaza preparaciones `completada`; la cola "Pedidos a preparar" excluye completadas
  (`routes/preparacion.js:91, 3077-3081`; `lib/preparacion.js:372-380`).
- `POST /seguimientos/:wcOrderId` (`routes/preparacion.js:1992-2160`): guardas de estado Woo (`lpaandreani` o
  `completed` con mismo tracking), claim (admin exento), `seguimientosEnCurso`, intención durable
  (`woo_paso1_incierto`, `woo_paso2_pendiente`), PUT1 `completed`+meta (mail nativo), PUT2 `enviadoandreani`,
  reconciliación `reintentarColgadosTracking`. Sin preparación crea fila mínima. `GET /seguimientos` expone la sección
  `sin_preparacion` (`routes/preparacion.js:1971-1984`).
- `POST /etiquetas/:id/lista` crea fila mínima con `etiqueta_lista` (marca manual Andreani "etiqueta generada", NO es
  evidencia fotográfica; se mantiene tal cual).
- Al completar una preparación web la UI abre el flujo de tracking (`public/preparacion/index.html:2568-2573`).
- `mlFetch` (Axios) no pide respuesta binaria (`lib/mlClient.js:750-759`); con `manual:true` hace 1 reintento ante 429
  (`lib/mlClient.js:697-730`).
- `renderPendientes()` incrusta `renderListaRecoleccion()` (`public/preparacion/index.html:970`).
- Todas las etiquetas de envío se imprimen en la misma Zebra; el corrector PDF es solo Andreani (fuera de alcance).

## Reglas que no se rompen
- Pedido WC creado desde ML: nunca se modifica (salvo cancelación/nota privada). Todo el código ML nuevo decide por
  `canal='ml'` y clave `ml:*`, jamás llama `/seguimientos` web ni hace PUT a Woo, aunque la preparación tenga
  `wc_order_id`. Test explícito.
- Cargar tracking web conserva íntegro el flujo actual (PUT1/PUT2, intención, reconciliación, mensajes ante
  resultado incierto). Solo se AGREGA una guarda previa (A.3).

## A. Cerrar sin etiqueta y completar después (web y ML)

1. Fotos de paquete: `paquete_abierto` (igual) y `paquete_cerrado` pasa a "Paquete ya cerrado" (sin etiqueta). Nuevo tipo
   `paquete_etiquetado` ("Paquete con la etiqueta puesta"), opcional para cerrar.
2. "Falta etiqueta" NO es columna: se DERIVA = preparación `estado='completada'` sin foto `paquete_etiquetado` vigente
   (no borrada). Sin migración para esto.
3. Guarda nueva en `POST /seguimientos/:wcOrderId`, ubicada después de validar tracking/auth/claim y ANTES de
   `seguimientosEnCurso.add`, de persistir la intención y de cualquier PUT: si existe preparación `web:<id>` con
   `estado='completada'` y sin `paquete_etiquetado` vigente (releído en servidor en ese momento) → 409
   `FOTO_ETIQUETA_REQUERIDA`, sin efectos. Filas mínimas (creadas por `etiquetas/:id/lista` o por el propio tracking,
   estado `en_preparacion` sin cierre) y pedidos sin fila: sin exigencia, igual que hoy (despachado sin preparar).
   Reintentos sobre pedido ya `completed` con mismo tracking: si la foto ya existe pasa; la guarda no se aplica cuando
   ya hay intención registrada (`woo_paso1_incierto` o `woo_paso2_pendiente` = 1/2) para no trabar una recuperación.
4. Endpoint nuevo `POST /preparaciones/:id/foto-etiqueta` (multipart, mismo pipeline/validaciones de imagen que
   `POST /:id/foto`): acepta SOLO tipo `paquete_etiquetado`, SOLO sobre preparaciones `completada` (o en curso), web o
   ML. Permiso: mismo permiso de escritura de Preparación; sin exigir claim (la preparación ya cerró). Auditoría:
   `registrarEvento` tipo `foto_etiqueta_agregada` con usuario. Idempotente: subir otra reemplaza la vigente (la
   anterior queda marcada no vigente, no se borra).
5. Lista accesible "Falta etiqueta": nueva sección arriba en la pestaña "Listos para despachar" (web y ML), cada fila
   con "Subir foto con etiqueta". En web además aparece en "Seguimientos" la acción "Completar envío".
6. "Completar envío" (web) = dos operaciones de servidor, presentadas en una pantalla:
   (a) foto → `foto-etiqueta` (persistida, idempotente); (b) tracking → `POST /seguimientos/:wcOrderId` sin cambios.
   Si (b) falla o queda incierto, la foto ya quedó guardada: la pantalla muestra el mismo mensaje que hoy (incl.
   "resultado incierto, se reintentará") y permite reintentar SOLO el tracking, sin volver a subir la foto ni reenviar
   mail (el flujo actual ya saltea PUT1 si Woo está `completed` con el mismo tracking).
7. Al completar una preparación web sin `paquete_etiquetado`: en vez de abrir el tracking, la UI muestra
   "Preparación cerrada — falta la foto con etiqueta. Completala en Listos para despachar / Seguimientos". Con la foto,
   comportamiento actual.
8. ML: sin tracking manual. La foto se sube desde la lista "Falta etiqueta". No toca Woo ni ML.
9. Chip "etiqueta ✓" = SOLO foto `paquete_etiquetado` vigente (evidencia). `etiqueta_lista` web sigue siendo "etiqueta
   generada" (marca manual existente, texto distinto). Chips: "Falta etiqueta" (b-warn) cuando corresponde.

## B. Bajar etiquetas ML para imprimir

1. `POST /api/preparacion/etiquetas-ml` `{ claves: [...] }` (1..50). Validación en servidor por clave, con datos locales
   (`gestion_pedidos`/`pedidos_cache`/preparación): canal ML; orden `paid`; `shipment_id` vigente de esa orden
   (`order.shipping.id` proyectado); `mode=me2`; logística local (`cross_docking`, `self_service`, `drop_off`,
   `xd_drop_off`), nunca `fulfillment`; status `ready_to_ship` con substatus `ready_to_print` o `printed`; fotos de
   ítems + `paquete_abierto` + `paquete_cerrado` completas. Dedupe por `shipment_id` (packs comparten envío).
2. Una llamada `GET /shipment_labels?shipment_ids=<únicos>&response_type=pdf` con helper nuevo `mlFetchBinario`
   (`responseType:'arraybuffer'`, timeout 20 s, tope 15 MB, exige `Content-Type: application/pdf`), mismo token,
   limitador y cooldown que `mlFetch`; hereda su único reintento ante 429 (documentado), sin bucles.
3. Si ML rechaza el lote (p.ej. `not_printable_status` por un envío que cambió), reintento individual por envío (máx
   el mismo lote, secuencial) para aislar los rechazados; los aceptados se unen en un PDF (pdf-lib si ya está, si no se
   devuelven por separado). ML es la revalidación final: no se hace GET previo por envío (volumen).
4. Respuesta JSON `{ ok, pdf_base64, aceptados:[clave], rechazados:[{clave, motivo}] }`; el front abre el PDF y el
   diálogo de impresión (se elige la Zebra). Sin agentes locales.
5. Registro `etiquetas_ml_descargas(clave, shipment_id, usuario, descargado_en)` — migración numerada 133. Significa
   "PDF bajado", NO "impresa". UI: "PDF bajado el {fecha} por {usuario}" / "Ya impresa en ML" (substatus `printed`).
   Reimpresión permitida con ese aviso.
6. UI: botón "🖨 Etiqueta" por tarjeta elegible en "Pedidos a preparar" y en "Falta etiqueta"; motivo corto si no es
   elegible ("faltan fotos", "Full", "envío no listo"). Casillas + "Bajar etiquetas (N)" para lote.

## C. Menos scroll en "Pedidos a preparar"
- Quitar `renderListaRecoleccion(visibles)` de `renderPendientes()`; en su lugar "🔎 N productos para buscar → Ver
  lista" que abre la pestaña "Productos a buscar" (sin cambios).

## Gates
TDD por borde (guardas A.3 con cada tipo de fila, reintento incierto, foto sobre completada, ML nunca toca Woo, PDF
binario, lote con rechazo parcial, dedupe), revisor, Codex, probador-e2e (1280/375, cámara/archivo, lote, chips,
lista Falta etiqueta), suite completa, auditor, deploy autónomo con backup y tag.

## v3 — cambios por la ronda 2 de Codex (prevalecen sobre lo anterior)

1. **Salida ML sin foto (decisión de José): avisar y dejar salir.** La confirmación de salida del lote
   (`routes/preparacion.js:1602/1618`) NO se bloquea. La respuesta incluye `advertencias:[{clave, motivo:'falta_etiqueta'}]`
   y la UI muestra "N pedidos salieron sin foto de etiqueta — quedan en Falta etiqueta". El pedido sigue derivando
   "Falta etiqueta" hasta subir la foto. Para web, la guarda sigue siendo la de A.3 (tracking).
2. **Validez de la foto.** "Foto con etiqueta vigente" = fila `preparacion_fotos` tipo `paquete_etiquetado`, sin
   `borrado_en` y con `estado_proceso='listo'`. `pendiente`/`procesando` → la guarda de A.3 responde 409
   `FOTO_ETIQUETA_PROCESANDO` ("la foto se está procesando, reintentá en unos segundos"); `error` no cuenta. Al subir
   una sustituta, la anterior vigente NO se invalida hasta que la nueva llega a `listo` (lo hace el procesador de la
   cola, en la misma transacción que marca `listo`). Si la nueva termina en `error`, la anterior sigue vigente.
3. **Lote ML sin pdf-lib.** Respuesta única `{ ok, pdf_base64|null, aceptados, rechazados }`, siempre un solo PDF:
   (a) llamada con todos los ids únicos; si ML acepta → ese PDF. (b) si ML rechaza el lote, se prueba cada id por
   separado (secuencial, solo para clasificar; esos PDF se descartan) y luego (c) UNA llamada final con los aceptados →
   un PDF. Si no queda ninguno aceptado, `pdf_base64:null` y solo `rechazados`. Peor caso de volumen: 1 + N + 1
   llamadas, N ≤ 50, solo ante rechazo. No se agrega dependencia.
4. **Fuente de "Falta etiqueta".** Endpoint nuevo `GET /api/preparacion/falta-etiqueta?cursor=&limit=50`:
   preparaciones `estado='completada'` (web y ML) sin foto vigente según el punto 2, orden por `completado_en`
   ascendente, paginado por cursor (`completado_en`,`id`), sin el tope de `/historial` ni filtro por día. Devuelve
   `{ items, next_cursor, total }`. La sección de "Listos para despachar" muestra el total y pagina con "Ver más";
   ninguna queda oculta. Índice si hace falta, en la migración 133.

## v4 — cambios por la ronda 3 de Codex (prevalecen)

1. **Foto en proceso dentro de "Completar envío".** Tras subir la foto, la UI consulta su estado
   (`GET /api/preparacion/fotos/:fotoId/estado`, existente o nuevo mínimo) cada 2 s hasta 60 s. Al llegar a `listo`
   envía el tracking automáticamente. Si termina en `error`: mensaje "No se pudo procesar la foto" + botón
   "Reintentar" (usa el reintento manual existente, `routes/preparacion.js:3185`) o "Subir otra". Si vence la espera
   de 60 s: "La foto sigue procesándose" y el botón "Cargar seguimiento" queda disponible para reintentar después
   (la guarda decide en servidor). El número de seguimiento escrito no se pierde (queda en el formulario).
2. **Claim tras el cierre.** La exigencia de claim de `POST /seguimientos/:wcOrderId` y de `foto-etiqueta` aplica solo a
   preparaciones en curso (`estado='en_preparacion'`), como protección contra usurpar una tarea abierta. Sobre una
   preparación `completada` no se exige claim: basta el permiso de escritura de Preparación (el mismo que hoy permite
   operar la herramienta). Administración sigue exenta como hoy. Se audita el usuario en `registrarEvento`
   (`tracking_cargado` ya existe; `foto_etiqueta_agregada` nuevo). Tests: operario no admin completa envío horas
   después del cierre; operario no puede cargar tracking sobre una preparación en curso tomada por otro.
3. **Una sola vía para `paquete_etiquetado`.** `POST /:id/foto` (existente) rechaza `tipo='paquete_etiquetado'` con
   400 `USAR_FOTO_ETIQUETA`. Toda foto con etiqueta (antes o después del cierre) entra por `foto-etiqueta`, que aplica
   la regla de reemplazo diferido. Test.
4. **Elegibilidad por envío, no por clave (packs).** Antes de llamar a ML se agrupa por `shipment_id`
   (`gestion_pedidos.ml_shipment_id`). Un envío es elegible solo si TODAS las órdenes/preparaciones asociadas a ese
   `shipment_id` cumplen los requisitos (fotos completas, pagas, no canceladas). Si una no cumple, el envío entero va a
   `rechazados` con motivo "pack con fotos pendientes en #<orden>" para cada clave seleccionada de ese envío. Test con
   pack de 2 órdenes (una incompleta).

## v5 — cambios por la ronda 4 de Codex (prevalecen)

1. **Retención y alcance de "Falta etiqueta".** La lista incluye solo preparaciones completadas en los últimos 30 días
   (`completado_en >= now-30d`). La purga de fotos (`routes/preparacion.js:789-795`) pasa a usar la antigüedad de
   cada FOTO (`creado_en` de la foto) además de la de la preparación: una foto con menos de 30 días no se borra.
   Test: preparación de 40 días con foto de etiqueta subida hoy → la foto sobrevive.
2. **Reintento de foto tras el cierre.** El reintento manual (`routes/preparacion.js:3185`) se adapta con la misma
   regla de v4.2: sobre preparación `completada` no exige claim y acepta solo fotos `paquete_etiquetado`; sobre
   preparación abierta sigue igual. Test.
3. **Acción de tracking accesible.** Cada fila web de "Falta etiqueta" ofrece "Completar envío" (foto + tracking) en
   la misma fila; además, tras subir la foto, si el tracking no se cargó, la fila pasa a una sublista "Falta
   seguimiento" (web, preparación completada con foto vigente y sin `tracking`, mismos 30 días, paginada) con la acción
   de tracking. No depende del listado de 100 de `/seguimientos`.
4. **Pack con membresía desconocida.** Antes de bajar la etiqueta de un `shipment_id` se consulta
   `GET /shipments/{id}/items` (1 GET por envío único del lote, ≤ 50) para obtener TODAS las órdenes del envío. Si
   alguna orden no tiene preparación local completa con fotos → rechazado "pack con orden sin preparar #<id>". Si la
   consulta falla → rechazado "no se pudo verificar el pack" (fail-closed). Volumen acotado al lote pedido a mano.
5. **Claim en `pendiente_deposito`.** La regla queda: se exige claim en todo estado abierto (`en_preparacion` y
   `pendiente_deposito`); solo `completada` queda exenta. Test con `pendiente_deposito` tomada por otro.

## v6 (prevalece sobre v1–v5; responde a Codex ronda 5)

1. **El PDF de ML exige fotos `listo`.** Para cada orden del envío/pack, las fotos de ítems y las del paquete cuentan
   solo con `estado_proceso='listo'`. `pendiente` o `error` → no elegible, motivo "foto en proceso o fallida". Se
   agrega `fotosListasFaltantes()` sin cambiar la semántica de `fotosFaltantes()` (la usan otros flujos). Test: pack de
   2 órdenes con una foto `error` en la segunda → no elegible; al pasar a `listo` → elegible.
2. **La purga respeta la ventana posterior al cierre.** Una foto se borra solo si `subida_en < now-30d` **y** su
   preparación está cerrada **y** `cerrada_en < now-30d`. Preparaciones abiertas nunca se purgan. Tests: (a) prep
   abierta 40 días, cerrada hoy → la purga de mañana no borra sus fotos viejas; (b) a los 31 días del cierre → se
   borran; (c) foto subida hoy en prep cerrada hace 40 días → vive 30 días desde su subida.
3. **"Falta seguimiento" incluye envíos inciertos.** La sublista toma preparaciones cerradas sin envío confirmado:
   sin `tracking`, **o** con `tracking` local cuya intención quedó pendiente/incierta (la misma condición que hoy marca
   «a medias» en Seguimientos). Cada fila muestra el estado ("sin seguimiento" / "envío incierto") y la acción de
   recuperación existente (reintento idempotente, el mismo de Seguimientos). Al confirmarse sale de la lista. Test:
   POST cuyo PUT da timeout → fila "envío incierto"; reintento OK → desaparece.

## v7 (prevalece; responde a Codex ronda 6)

1. **Los pendientes no vencen.** «Falta etiqueta» y «Falta seguimiento» listan **todas** las preparaciones cerradas
   sin resolver, sin ventana de 30 días (paginadas, más viejas primero). La ventana de 30 días queda solo para el
   historial de resueltas. Una fila sale de la lista únicamente al resolverse (etiqueta cargada / envío confirmado,
   `tracking` presente y `woo_paso2_pendiente=0`).
2. **La purga excluye pendientes.** Una foto se borra solo si `fotos.creado_en < now-30d` **y** la preparación está
   `completada` con `completado_en < now-30d` **y** no está en «Falta etiqueta» ni en «Falta seguimiento». Test: prep
   cerrada hace 40 días sin tracking → la purga no borra sus fotos y sigue listada; al confirmar el envío, la purga
   aplica desde 30 días después de esa confirmación (se toma la fecha de la confirmación si es posterior a
   `completado_en`).
3. Nombres reales a usar: `creado_en` (foto), `completado_en` (preparación), `woo_paso2_pendiente` (incierto).

## v8 (prevalece; responde a Codex ronda 7)

1. **Confirmado ≠ asociado.** Columna nueva `preparaciones.envio_confirmado_en` (migración 133, junto con
   `etiquetas_ml_descargas`). Se escribe **solo** cuando el segundo PUT a Woo (paso 2, pedido → completado con
   tracking) responde OK: tanto en el POST normal (`routes/preparacion.js:633`) como en la recuperación automática
   de «a medias». `tracking_cargado` y `POST /:id/tracking` (solo local) **no** la escriben.
2. **Estados de «Falta seguimiento»** (preparación `completada` con `envio_confirmado_en IS NULL`):
   - `sin seguimiento`: sin `tracking`;
   - `asociado sin confirmar`: `tracking` local sin pasos Woo iniciados → acción «Confirmar envío» (dispara los dos
     pasos idempotentes);
   - `envío incierto`: `woo_paso2_pendiente=1` → acción «Reintentar»;
   - `abandonado`: hubo `tracking_abandonado` (Woo 404/410) → se muestra con el motivo; acciones «Reintentar» o
     «Descartar con motivo» (escribe `envio_descartado_en` + motivo + actor; no afirma confirmación).
   Sale de la lista solo con `envio_confirmado_en` o `envio_descartado_en`.
3. **Purga**: fotos con `creado_en < now-30d` **y** preparación `completada` **y**
   `COALESCE(envio_confirmado_en, envio_descartado_en) < now-30d` **y** sin «Falta etiqueta». Sin esa fecha, nunca se
   purga.
4. **Backfill de la migración** (para no inundar la lista con lo histórico): preparaciones `completada`, con
   `tracking`, `woo_paso2_pendiente=0` y **sin** evento `tracking_abandonado` → `envio_confirmado_en = completado_en`
   (marcado en el evento de migración como «histórico, inferido»). Las demás quedan NULL y aparecen en la lista.
   Las de solo-local históricas sin pasos Woo no son distinguibles; se acepta el inferido y se documenta.
5. Tests: tracking local + completar → sigue listada como «asociado sin confirmar»; 404 → «abandonado», sin purga;
   descartar → sale y purga a los 30 días del descarte; PUT paso 2 OK (normal y recuperación) → fecha escrita;
   backfill sobre fixture con los cuatro casos.

## v9 (prevalece; responde a Codex ronda 8)

1. **La etiqueta cargada es un dato durable, no la foto.** Columna `preparaciones.etiqueta_cargada_en` (migración
   133), escrita cuando la foto `paquete_etiquetado` llega a `estado_proceso='listo'`. «Falta etiqueta» se deriva de
   `etiqueta_cargada_en IS NULL` (ya no de la existencia de la foto), así la purga de la foto no la vuelve a listar.
   Backfill: `etiqueta_cargada_en = creado_en` de la foto `listo` existente.
2. **Abandonado en un pedido anulado en Woo.** «Falta seguimiento» incluye `completada` **y** `anulado_en_woo` cuando
   hay `tracking_abandonado` sin `envio_descartado_en`. En `anulado_en_woo` la única acción es «Descartar con motivo»
   (no hay «Reintentar» porque el pedido ya no existe/está anulado). El endpoint de descarte es la única excepción a
   la guarda de `anulado_en_woo` (`routes/preparacion.js:1205`): escribe solo `envio_descartado_en`, motivo y actor,
   sin otra mutación. Test: 404 → abandonado → sync pasa a `anulado_en_woo` → sigue listado → descartar OK; cualquier
   otra mutación sigue respondiendo 409.
3. **Nombres y recuperación.** Paso 1 = `completed`, paso 2 = `enviadoandreani` (`routes/preparacion.js:2038`,
   `:2141`). `envio_confirmado_en` se escribe: (a) cuando el PUT del paso 2 responde OK; (b) en la recuperación,
   cuando verifica en Woo que el pedido ya está en `enviadoandreani` con el tracking coincidente y saltea el PUT
   (`routes/preparacion.js:862-878`). Test: PUT paso 2 OK + caída antes de guardar → la recuperación encuentra
   `enviadoandreani` + tracking igual → escribe la fecha; con tracking distinto → no confirma y queda «envío incierto».
4. **ML.** Las preparaciones ML nunca entran en «Falta seguimiento» (ML no carga tracking aquí). Su
   `envio_confirmado_en` se escribe en el camino que hoy confirma la salida del lote ML (`routes/preparacion.js:4102`),
   y ahí arranca su retención de fotos. Backfill ML: las ya salidas toman la fecha registrada de esa salida.
5. La purga queda: foto con `creado_en < now-30d`, preparación cerrada (`completada` o `anulado_en_woo`) y
   `COALESCE(envio_confirmado_en, envio_descartado_en) < now-30d`. Borrar la foto no cambia ningún estado derivado.

## v10 (prevalece; responde a Codex ronda 9)

1. **Anulado con paso 2 pendiente.** «Falta seguimiento» incluye `anulado_en_woo` cuando hay `tracking_abandonado`
   **o** `woo_paso2_pendiente=1`, siempre sin `envio_confirmado_en` ni `envio_descartado_en`. Estado mostrado:
   «anulado en Woo con envío pendiente». Única acción: «Descartar con motivo» (misma excepción acotada a la guarda).
   Al descartar también se limpia `woo_paso2_pendiente` (para que nada lo reintente). Test: anulación de sync con
   `woo_paso2_pendiente=1` → listado → descartar → sale y queda en 0.
2. **Fecha ML desde la salida del lote.** `envio_confirmado_en` de cada preparación miembro se escribe en
   `POST /despacho/lotes/:id/salida` (`routes/preparacion.js:1618`), con la misma fecha que
   `despacho_lotes.salida_confirmada_en`, en la misma transacción. Backfill: miembros de lotes con
   `salida_confirmada_en` no nulo toman esa fecha. Se descarta la referencia a `:4102`.
3. **Etiqueta histórica.** Antes de esta entrega la foto del paquete con etiqueta se registraba como `paquete_cerrado`
   (`lib/preparacion.js:218`). Backfill de `etiqueta_cargada_en`: preparaciones `completada` (o `anulado_en_woo`)
   con foto `paquete_cerrado` o `paquete_etiquetado` → `creado_en` de esa foto; completadas sin ninguna de las dos →
   `completado_en` (histórico inferido, anotado en el evento de migración). Así lo histórico no inunda «Falta etiqueta»;
   solo entran las preparaciones cerradas con «sin etiqueta» desde esta entrega.
4. **Chip de etiqueta.** «Etiqueta ✓» se deriva de `etiqueta_cargada_en`. Si además la foto sigue vigente, el chip
   enlaza a verla; si fue purgada, muestra «Etiqueta ✓ (foto archivada)» sin enlace. Reemplaza la regla de v-anterior
   (diseño:64).

## v11 (prevalece; responde a Codex ronda 10)

1. **Solo los miembros que salieron.** En `POST /despacho/lotes/:id/salida` se escribe `envio_confirmado_en` solo en
   las preparaciones de `despacho_lote_items` con `estado='confirmado'` (los `escaneado` ya pasaron a `confirmado` al
   cerrar, `routes/preparacion.js:1612`). Los miembros no confirmados de un cierre excepcional quedan sin fecha → no se
   purgan y, si son ML, aparecen en una sublista «No salieron con el lote» con acción «Descartar con motivo» (mismo
   endpoint de descarte). Backfill idéntico: solo miembros `confirmado` de lotes con `salida_confirmada_en`.
2. **Etiqueta pendiente en pedido anulado.** «Falta etiqueta» incluye también `anulado_en_woo` sin
   `etiqueta_cargada_en` ni `envio_descartado_en`, con estado «anulado en Woo»; única acción «Descartar con motivo»
   (no se sube foto: la guarda sigue). Un descarte resuelve ambas sublistas.
3. **Origen de `etiqueta_cargada_en`.** Columna `etiqueta_origen` (`foto` | `historico_inferido`). Chip: `foto` y
   foto vigente → «Etiqueta ✓» con enlace; `foto` purgada → «Etiqueta ✓ (foto archivada)»; `historico_inferido` →
   «Etiqueta ✓ (histórico)» sin enlace ni afirmación de foto.

## v12 (prevalece; responde a Codex ronda 11)

1. **La salida de un lote ML nunca toca Woo (bug latente existente; en prod 0 jobs `dispatch.woo` a hoy).**
   `encolarSalidaWoo` (`routes/preparacion.js:62`) no encola nada si `lote.canal !== 'web'`, y su SELECT filtra
   `li.estado='confirmado'` y `p.canal='web'`. Defensa en profundidad en el worker
   (`lib/workerIntegrationJobs.js:288`): si `meta.canal !== 'web'` el job termina sin PUT y registra
   `dispatch_ml_ignorado`; omite órdenes con `canal!=='web'`. Regla: un pedido WC creado desde ML no se modifica.
   Tests: salida de lote ML → 0 jobs/0 PUT; lote web con un miembro `esperado` → ese pedido no recibe PUT; job viejo
   con canal ml → 0 PUT.
2. **Liberar un paquete que no salió.** En «No salieron con el lote» la acción principal es «Liberar para otro lote»:
   pasa el `despacho_lote_items` a `estado='anulado'` con motivo y actor (libera el índice único de
   `055_despacho_lote_control_unico.sql`); el paquete vuelve a la cola de despacho y se puede escanear en un lote
   nuevo. «Descartar con motivo» también anula el miembro. Test: cierre excepcional → liberar → escanear en lote
   nuevo OK → salida de ese lote fecha `envio_confirmado_en`.
3. **Borrar la foto antes del cierre invalida la marca.** Al borrar una foto `paquete_etiquetado` (ruta existente,
   `routes/preparacion.js:3205`, solo con prep abierta) se recalcula `etiqueta_cargada_en`: si no queda otra foto de
   ese tipo en `listo`, vuelve a NULL (y `etiqueta_origen` a NULL). Después del cierre las fotos no se borran por esa
   ruta; la purga no toca la marca. Test: subir → listo → borrar → cerrar sin etiqueta → aparece en «Falta etiqueta».

## v13 (prevalece; responde a Codex ronda 12)

1. **La salida de lote no escribe en Woo, ningún canal.** El único escritor del estado Woo de un pedido web es el
   flujo de dos pasos de Seguimientos (`completed` → `enviadoandreani`). `encolarSalidaWoo` deja de encolar
   `dispatch.woo` (prod: 0 jobs de ese tipo a hoy, nadie depende de él); la salida solo registra la fecha y escribe
   `envio_confirmado_en` en miembros ML confirmados. Los miembros web confirmados toman su fecha del paso 2, no de la
   salida. El worker conserva `dispatch.woo` como no-op que registra `dispatch_woo_obsoleto` (jobs viejos), sin PUT.
   Reemplaza v12.1. Tests: salida web y ML → 0 PUT; pedido en `enviadoandreani` no cambia.
2. **Liberar antes del cierre.** «Liberar del lote» (pasa el miembro a `anulado`, con motivo y actor) está disponible
   en lotes `abierto`/`en_preparacion` además de en «No salieron con el lote». La guarda de `anulado_en_woo`
   (`routes/preparacion.js:1185`) ignora miembros `anulado`. Test: lote con un miembro de pedido anulado → cerrar
   409 → liberar → cerrar OK → salida OK.
3. **Carrera borrado/procesado.** La transición de la foto a `listo` en la cola (`lib/fotosPreparacionCola.js:109`)
   se condiciona a `borrado_en IS NULL`, y el alta de `etiqueta_cargada_en` ocurre en esa misma transacción solo si el
   UPDATE afectó una fila. Test: tomar foto en cola → borrar → worker termina → foto sigue borrada y la marca NULL.

## v14 (prevalece; responde a Codex ronda 13)

1. **Los holds siguen mandando.** La purga final es la de v9.5/v10 **más** todas las exclusiones que ya aplica
   `purgarFotosBorradas` (`routes/preparacion.js:795`): reclamo, incidente, garantía o auditoría activos impiden
   borrar, aunque el envío esté confirmado o descartado. La regla nueva solo agrega condiciones; nunca quita una
   existente. Test: envío confirmado hace 40 días + hold de reclamo activo → no se purga; al cerrar el hold → se purga.
2. **El cierre ignora miembros liberados.** En `POST /despacho/lotes/:id/cerrar` (`routes/preparacion.js:1606`) el
   conteo de pendientes excluye `estado='anulado'` (además de `confirmado` y `escaneado`). Liberar no exige motivo de
   cierre excepcional: el motivo ya quedó registrado al liberar. Test: lote con un miembro liberado y el resto
   escaneado → cerrar sin motivo OK.
3. **Sin archivos huérfanos.** Si el UPDATE a `listo` afecta 0 filas (foto borrada en el medio), el worker elimina la
   versión liviana que acaba de generar (y el original, como hoy) antes de terminar, y registra
   `foto_procesada_tras_borrado`. Test: carrera → ningún archivo en disco sin fila que lo referencie.

## v15 (prevalece; responde a Codex ronda 14)

1. **Resolver «Falta etiqueta» sin foto.** Acción «Salió sin foto de etiqueta» disponible para todo pendiente de
   «Falta etiqueta» (ML o web) que ya tenga `envio_confirmado_en`. Exige motivo; escribe
   `etiqueta_cargada_en=now`, `etiqueta_origen='sin_foto'`, motivo y actor en el evento. Chip: «Sin foto de etiqueta
   (resuelto)» sin enlace ni afirmación de foto. Si después se sube la foto (prep cerrada, endpoint `foto-etiqueta`),
   `etiqueta_origen` pasa a `foto`. Test: ML confirmado sin foto → resolver → sale de la lista; chip correcto.
2. **Purga — fórmula final completa** (reemplaza toda versión anterior): foto con `creado_en < now-30d` **y**
   preparación cerrada (`completada` o `anulado_en_woo`) **y** `COALESCE(envio_confirmado_en, envio_descartado_en)
   < now-30d` **y** no está en «Falta etiqueta» (`etiqueta_cargada_en IS NULL` y sin `envio_descartado_en`) **y** no
   está en «Falta seguimiento» **y** sin hold activo (todas las exclusiones de `purgarFotosBorradas`). Test: ML
   confirmado hace 40 días en «Falta etiqueta» → no se purga nada; tras resolver → purga 30 días después.
3. **Huérfanos: alcance acotado.** La v14.3 cubre la carrera normal (borrado durante el procesamiento). Una caída del
   proceso entre escribir el archivo y actualizar la fila puede dejar un huérfano; queda cubierto por el script manual
   existente `scripts/reducir-fotos-preparacion.mjs` y fuera del alcance de esta entrega (no se promete «cero
   huérfanos»). Se anota como pendiente menor.

## v16 (prevalece; responde a Codex ronda 15)

1. **La purga cuenta desde la última resolución.** Fecha de referencia
   `ref = MAX(COALESCE(envio_confirmado_en, envio_descartado_en), COALESCE(etiqueta_cargada_en, ''))` (strings ISO;
   `etiqueta_cargada_en` se escribe al resolver «Falta etiqueta» por foto o por «Salió sin foto», y nunca se mueve
   hacia atrás). Condición: `ref < now-30d`, más el resto de la fórmula v15.2 sin cambios. Para los históricos
   (`historico_inferido`) la marca ya es vieja y no altera nada. Tests: ML confirmado hace 40 días, resuelto hoy sin
   foto → no purgable hasta dentro de 30 días; foto de etiqueta subida hoy a prep confirmada hace 40 días → ídem.

## v17 (prevalece; responde a Codex ronda 16)

1. **Liberar en lote cerrado sin salida.** «Liberar del lote» vale en todo lote sin `salida_confirmada_en`
   (`abierto`, `en_preparacion` y `cerrado`), solo para miembros no `confirmado`; en `cerrado` no cambia el estado del
   lote ni escribe ninguna fecha de salida. Un miembro `confirmado` de un lote cerrado no se libera (ya está listo para
   salir). Test: cierre excepcional → liberar el `esperado` antes de la salida → salida OK → solo los confirmados
   reciben fecha; el liberado se escanea en otro lote.
2. **Resoluciones con motivo, atómicas y fail-closed.** «Salió sin foto de etiqueta», «Descartar con motivo» y
   «Liberar del lote» hacen el cambio de estado y `registrarEvento(..., { failClosed: true })`
   (`routes/preparacion.js:769`) dentro de la misma `db.transaction`; si el evento falla, no hay cambio y responde 500.
   Test: forzar fallo del evento → estado intacto.

## v18 (prevalece; responde a Codex ronda 17)

1. **Liberar vale en cualquier momento para un miembro no confirmado.** «Liberar del lote» se permite para todo
   miembro con `estado` distinto de `confirmado` y de `anulado`, haya o no `salida_confirmada_en` (reemplaza la
   restricción de v17.1). Nunca escribe fecha de salida ni cambia el estado del lote. Un miembro `confirmado` nunca se
   libera. Test: salida confirmada con un `esperado` → liberar → escanear en lote nuevo OK.
2. **Doble auditoría.** Liberar escribe, en la misma transacción fail-closed, `registrarEvento` (preparación) **y**
   `eventoLote(loteId, 'miembro_liberado', actor, { control_id, motivo })` en `despacho_lote_eventos`
   (`routes/preparacion.js:1217`), así figura en el historial del lote. Si cualquiera falla, no hay cambio.

## v19 (prevalece; responde a Codex ronda 18 — recorte de alcance)

1. **Se retira «Liberar del lote» de esta entrega** (v12.2, v13.2, v14.2, v17.1 y v18 quedan sin efecto). No toca la
   lógica de armado, cierre ni confirmación de lotes, que sigue como hoy. La coordinación entre despacho individual y
   por lote (`routes/preparacion.js:1689`, `:1722`, `:1492`) y la elegibilidad de packs al crear un lote (`:1489`) son
   comportamiento previo, fuera de alcance; quedan anotadas como pendiente aparte.
2. **«No salieron con el lote»**: miembros no `confirmado` de un lote con salida confirmada. Única acción: «Descartar
   con motivo» (atómica, fail-closed, con `registrarEvento` + `eventoLote(..., 'miembro_descartado', ...)`), que solo
   escribe `envio_descartado_en` en sus preparaciones; no cambia el miembro ni el lote. Si el paquete se despacha
   después por la vía existente, la fecha `envio_confirmado_en` la pone esa vía (siguiente punto).
3. **Fecha de envío por grupo.** Al confirmar la salida, `envio_confirmado_en` se escribe en **todas** las
   preparaciones del `grupo_clave` de cada miembro `confirmado` (un pack sale físicamente junto). Las rutas de
   despacho individual existentes (`:1689`, `:1722`) escriben la misma fecha al confirmar un control, para el mismo
   grupo. Esto no cambia qué se puede despachar; solo fecha lo que salió.
4. Sin cambios a la cola de `encolarSalidaWoo` respecto de v13.1 (la salida no escribe en Woo).

## v20 (prevalece; responde a Codex ronda 19)

1. **«No salieron con el lote» se vacía al resolverse.** La fila aparece solo si **ninguna** preparación del
   `grupo_clave` del miembro tiene `envio_confirmado_en` ni `envio_descartado_en`. Descartar (escribe
   `envio_descartado_en` en todo el grupo) o un despacho individual posterior (escribe `envio_confirmado_en`, v19.3)
   la sacan. Test: ambos caminos → la fila desaparece.
2. **Backfill del despacho individual.** Además del backfill por lote (v10.2/v19.3), las preparaciones de todo
   `grupo_clave` cuyo control individual tenga `despacho_controles.confirmado_en` no nulo toman
   `envio_confirmado_en = confirmado_en` (la más temprana si hay varias fuentes). Test de migración con un control
   individual confirmado y un pack de dos preparaciones.

## v21 (prevalece; responde a Codex ronda 20)

1. **Solo ML se fecha por despacho.** Toda escritura de `envio_confirmado_en` originada en el despacho (salida de lote
   v19.3, despacho individual v19.3, backfill por lote v10.2 y backfill individual v20.2) aplica únicamente a
   preparaciones con `canal='ml'`. Para web, la única fuente es el paso 2 de Seguimientos (v9.3) y su backfill v8.4.
   «No salieron con el lote» (v20.1) evalúa web con su propia fecha de paso 2. Tests: confirmación individual y
   salida de lote web → `envio_confirmado_en` sigue NULL y el pedido sigue en «Falta seguimiento».

## v22 (prevalece; responde a Codex ronda 21)

1. **Paso 2 web, una sola sentencia.** `marcarPreparacionEnviada` (`routes/preparacion.js:633`) pone
   `woo_paso2_pendiente=0` y `envio_confirmado_en=COALESCE(envio_confirmado_en, now)` en el **mismo UPDATE**. Es el
   único lugar que limpia el indicador tras un paso 2 OK, y lo usan tanto el POST como la recuperación. Test: el UPDATE
   deja ambas columnas o ninguna.
2. **Fecha ML por trigger, cualquier vía de despacho.** En lugar de tocar cada ruta (lote, individual,
   regularización `:1731/:1744`, y las que vengan), la migración 133 crea un trigger SQLite
   `AFTER UPDATE OF confirmado_en ON despacho_controles WHEN NEW.confirmado_en IS NOT NULL` que hace
   `UPDATE preparaciones SET envio_confirmado_en=COALESCE(envio_confirmado_en, NEW.confirmado_en)
   WHERE canal='ml' AND (clave=NEW.grupo_clave OR pack_id=NEW.grupo_clave)`. Corre en la misma transacción que la
   confirmación. Para la salida de lote se usa la misma condición sobre los miembros `confirmado` (o, si la salida no
   toca `despacho_controles`, un UPDATE equivalente dentro de su transacción). Reemplaza las escrituras explícitas de
   v19.3 en las rutas individuales. Tests: confirmación individual, regularización y salida de lote → grupo ML fechado;
   grupo web intacto.

## v23 (prevalece; responde a Codex ronda 22)

1. **Trigger también en INSERT.** Se crean dos triggers con el mismo cuerpo: `AFTER INSERT ON despacho_controles
   WHEN NEW.confirmado_en IS NOT NULL` y `AFTER UPDATE OF confirmado_en ON despacho_controles WHEN NEW.confirmado_en
   IS NOT NULL`. Así un `INSERT ... ON CONFLICT DO UPDATE` queda cubierto por cualquiera de las dos ramas. Test:
   regularización de un control inexistente (rama INSERT) y existente (rama UPDATE) → grupo ML fechado.
2. **La fecha del paso 2 es solo web.** En `marcarPreparacionEnviada` la columna se escribe como
   `envio_confirmado_en = CASE WHEN canal='web' THEN COALESCE(envio_confirmado_en, now) ELSE envio_confirmado_en END`
   en el mismo UPDATE. Las llamadas desde el barrido ML (`:3641`) y la proyección ML (`:4105`) no fechan nada. Test:
   proyección ML que marca enviada → `envio_confirmado_en` sigue NULL hasta el despacho.
