# Fase D: pantalla única "Catálogo y vínculos"

Fecha: 2026-10-09. Programa: `docs/superpowers/specs/2026-10-03-consolidacion-herramientas.md`, Fase D.
Depende de la Fase C (protección única por Identidad, en `activo` desde el 2026-10-08).
Decisiones de José tomadas en la sesión del 2026-10-09 (citadas en cada regla).

## Objetivo

Una sola pantalla para resolver el vínculo entre publicaciones de ML y productos de Woo, reemplazando a
Matcher, Identidad de productos (incluida su pestaña "Códigos en conflicto"), Guardia ML y la Bandeja E3.
Que un operador resuelva lo simple sin poder romper nada, y José lo dudoso.

## Decisiones

| Tema | Decisión de José |
|---|---|
| Usuarios | Un operador y José ("Ambos"). |
| Permisos | El operador vincula, marca "no sincronizar" y saltea. Solo José (admin) destraba una publicación en intervención y confirma un vínculo con contradicción de atributos. |
| Orden de la cola | Por plata en juego: unidades vendidas en ML en los últimos **30 días** × stock en Woo. Con datos ya disponibles, sin recarga. |
| Pantallas viejas | Se retiran **el mismo día** que sale la nueva. |
| Primera entrega | Caso por caso completo. El lote por familia va en una segunda entrega. |
| Dispositivo | PC o notebook con teclado. En celular se consulta todo y las acciones se hacen con toques, sin atajos. |
| "No sincronizar" | Quien lo hace elige entre 3 variantes (ver R3). Sus ventas **siempre se retienen**; solo un "link de pago" ignora ventas, como hoy. |
| Ventas retenidas | Solo "Liberar". "Cancelar" se descarta. |

## Inventario de lo que se reemplaza (verificado en `origin/master`)

| Pantalla vieja | Qué se usa hoy | Dónde queda |
|---|---|---|
| Matcher (`public/matcher/`) | Solo lee `GET /api/matcher/candidatos` (publicaciones que necesitan atención, filtros de asignación, verificación y confianza) | Candidatos del detalle del caso, y los mismos filtros en el buscador de **Vínculos** |
| Identidad: Pendientes | Casos, tomar/relevar, decidir, notas, excepción "solo ML" con vencimiento | Pestaña **Casos** (detalle) |
| Identidad: paneles de salud | Salud de lectura, conciliación, conflictos de bolsa compartida, publicaciones vendiendo sin respaldo en Woo, protección pendiente (`public/identidad-productos/index.html:153-277`) | Franja **Estado** arriba de la pestaña Casos, con un enlace por indicador a la lista filtrada |
| Identidad: Productos Fusion | Buscar producto, identificadores, reordenar identificadores | Pestaña **Vínculos** |
| Identidad: Operaciones | Estado de operaciones; reintentar y confirmar impacto (admin) | Pestaña **Ejecución** |
| Identidad: Códigos en conflicto | Por **GTIN** (no es un caso de publicación): elegir qué producto conserva el código, o marcarlo incorrecto en uno o varios (`routes/identidadProductos.js:124-145`) | Sección **Códigos en conflicto** dentro de **Vínculos**, con el mismo flujo de hoy |
| Identidad: Historial | Consulta | Panel `h` del caso, y "ver historial" en **Vínculos** |
| Guardia ML | Casos (ya retirados en activo) y ventas retenidas | Pestaña **Retenidas** (solo Liberar) |
| Bandeja E3 | UX (teclado, deshacer, sin preselección); escribe solo en Postgres | Se hereda la UX; la escritura a Postgres se abandona |

Endpoints que siguen vivos por otros consumidores y **no** se retiran: `POST /api/matcher/decisiones` y
`push-skus-pendientes*` (los usan `public/sync-detalle` y el inicio), y `/api/v1/identidad-productos`
(fachada móvil). Los procesos de fondo de Guardia (`liberarRetenidasResueltas`) siguen por cron.

## Arquitectura de información

Una pantalla, 4 pestañas.

1. **Casos** (por defecto). La cola a la izquierda y el detalle a la derecha. Filtros: Abiertos, Salteados, En
   intervención, Pausadas.
2. **Vínculos.** Buscador por producto Woo o publicación ML, con los filtros del Matcher. Muestra el vínculo vigente,
   las hermanas por SKU y por GTIN, las notas y el orden de identificadores. Permite revincular con la misma matriz y
   revertir un "no sincronizar" (según R3). Incluye la sección **Códigos en conflicto** (por GTIN).
3. **Ejecución.** Operaciones en ML: encolada → aplicada, fallida o frenada. Un contador muestra las fallidas.
   Reintentar y confirmar impacto son solo de admin.
4. **Retenidas.** Ventas retenidas, con Liberar y motivo obligatorio. Aviso de que se liberan solas cada 5 minutos
   cuando la causa se resuelve.

## Reglas

### R1. Cola

- Cada fila muestra: título, motivo del caso, plata en juego, y chips PAUSADA, HERMANAS n e INTERVENCIÓN.
- Orden descendente por `unidades ML 30 días de esa publicación × stock Woo`. Con empate, primero el caso más
  antiguo. Sin producto Woo o sin stock conocido, la plata en juego es 0 y ordena por antigüedad.
- Fuente de ventas: `gestion_pedidos` + `gestion_pedido_items` con fuente `mercadolibre`. Hoy el ítem guarda solo el
  SKU, y agrupar por SKU atribuiría las mismas ventas a publicaciones distintas. Se agrega la clave ML (`ml_key`:
  item y variación, que la orden normalizada ya conoce en `lib/modelos/ordenVenta.js:53-65`) a
  `gestion_pedido_items` con una migración, y se completa una vez con la reconciliación de 30 días existente. El cron
  de 48 h la mantiene al día.
- Saltear (`s`) manda el caso al final y lo marca "salteado por X". No resuelve nada.

### R2. Detalle y matriz por atributo

- Arriba, dos datos separados: lo **observado en ML** (`ml_publicaciones_cache`: estado y cantidad) y lo que **manda
  la regla** (`frenaIdentidad`: "stock 0 por …" o "stock de Woo N"). Si no coinciden, se marca "ML todavía no
  refleja la regla".
- Matriz: columnas Atributo, Publicación ML, **Candidato elegido** y Estado. Filas: título, SKU, GTIN, color, talle,
  rodado, transmisión y velocidades.
- Hoy no hay función que la produzca: `obtenerCasoIdentidad` trae el producto actual del caso y no el candidato,
  `atributosLegibles` devuelve texto y `contradiccionDeClave` no compara GTIN ni da estados por fila. Se agrega
  `matrizAtributos(db, clave, sku)` en el backend, que arma las filas con estado por fila, reutiliza las reglas de
  extracción y normalización de `lib/contradiccionTitulo.js` y compara GTIN aparte. El veto rojo sale de
  `contradiccionDeClave`, para que coincida con lo que bloquea el backend.
- Semáforo:
  - **Rojo (veto):** el campo está en `motivos`, o sea los dos lados tienen valor y difieren.
  - **Ámbar:** falta el dato de un lado, o difiere solo en el formato.
  - **Verde:** coincide después de normalizar.
  - **Gris:** no aplica al producto.
- El estado nunca se indica solo con color: siempre va con ícono y texto ("Difiere", "Falta", "Coincide").
- SKU igual con GTIN o título contradictorio se rotula "leve: sigue vendiendo" (R2 de la Fase C).
- Candidatos sin preselección. Elegir uno (1/2/3) recalcula la matriz.
- **Decisión (2026-10-09, coordinador):** un GTIN distinto es ámbar "Difiere" con la marca `leve` en la respuesta; no es veto, porque el rojo sale solo de `contradiccionDeClave`, que no compara GTIN.

### R3. Acciones

| Acción | Quién | Qué hace |
|---|---|---|
| Vincular | Operador y José | `decidirCasoIdentidad`. Con rojo, deshabilitado y con la razón a la vista. |
| Confirmar igual | Solo José | Vincula pese al veto, con motivo. **Contrato nuevo:** hoy `decidirCasoIdentidad` rechaza toda contradicción y la saga la vuelve a vetar antes de restaurar stock (`lib/identidadProductos.js:1521-1529,1861-1864`). Se agrega una decisión de admin con `override` y motivo, guardada en `identidad_decisiones`, que la saga respeta para esa clave y ese SKU. La protección de la Fase C deja de frenar solo cuando el caso queda cerrado por esa decisión. |
| No sincronizar | Operador y José | Pide motivo y una de 3 variantes: **(a)** solo marcar: el sistema deja de tocarle el stock y cualquiera lo revierte; **(b)** marcar y pausar en ML; **(c)** solo marcar, y revertir queda solo para admin. En las tres, **las ventas de esa publicación se retienen** (decisión de José, para no perder ventas). |
| Link de pago | Solo José | Marca distinta de "no sincronizar": ignora stock y ventas, como hoy hace `omitir` (R1 de la Fase C). |
| Saltear | Operador y José | R1. |
| Destrabar | Solo José | **Contrato nuevo:** hoy no hay forma de sacar un caso de intervención sin reintentar una operación (`lib/identidadProductos.js:1688-1713`). Se agrega la transición `intervencion → pendiente`, con motivo y evento en el historial. Al pasar a pendiente, el caso se reevalúa con las reglas de la Fase C: si sigue habiendo contradicción, la protección sigue frenando. |
| Reintentar / confirmar impacto | Solo José | Pestaña Ejecución. |
| Liberar retenida | Operador con rol Ventas o Supervisor, y José | Igual que hoy (`routes/guardiaMl.js:161-167`). Motivo obligatorio. Si la causa sigue, avisa "Se va a volver a retener". |

**Decisión de contrato (2026-10-09, coordinador): modelo de "no sincronizar".** Marca separada de `omitir`, que no se toca; las ventas quedan siempre retenidas.
- Se guarda como decisión `no_sincronizar` en `identidad_decisiones`, con la variante (a/b/c) y el motivo en `detalle_json`.
- La operación durable `pausar` existe solo en la variante **(b)**: alcance de item completo, exige confirmar el impacto en las hermanas.
- Las variantes **(a)** y **(c)** son solo la marca. Su deshacer es una decisión compensatoria; en (c) es solo admin, validado en servidor (403).
- En **(b)**, el deshacer solo vale con la op pendiente o en shadow; si no, `INVALID_STATE`.
- **Implementación (revisada por el coordinador):** la marca es un `omitir` en `sku_matcher_decisiones` con `origen` `no_sincronizar_a|b|c` (link de pago: `link_de_pago`); el motivo y la variante van al historial. La variante (b) usa la tabla `identidad_pausas` (migración 124) en vez de ampliar `identidad_operaciones`.

**Variante (b), pausar en ML.** La pausa es del ítem entero, así que afecta a todas sus variaciones
(`lib/matcherPush.js:203-219`). Antes de pausar se muestra el alcance ("pausa también estas N variaciones") y se pide
confirmación. La pausa va como operación durable en la cola de Identidad (no una llamada directa) y su resultado se
ve en Ejecución; si falla, la marca queda puesta y la operación queda fallida y a la vista. Revertir (b) quita la
marca y deja la publicación pausada: el reactivador la levanta cuando corresponda por stock. El helper actual
bloquea si hay un caso legado de Guardia; la pausa nueva no depende de Guardia.

**Permisos (en el servidor, no solo en la pantalla).** Operador: `matcher:write`. Liberar retenidas: además, rol
Ventas, Supervisor o Admin, como hoy. Confirmar igual, destrabar, link de pago, revertir la variante (c), reintentar
y confirmar impacto: admin, verificado en el router.

**Idempotencia y deshacer.** Se usa el contrato de Identidad: `operation_id` en el cuerpo, generado por intento y
reutilizado en el reintento. "Guardado" aparece recién con la respuesta exitosa (201 al crear, 200 si es repetido).
Deshacer (`z`, 10 segundos, solo la última decisión propia y una vez) cancela la operación **solo si todavía no
empezó** (estado pendiente o en sombra). Si ya empezó, no se ofrece deshacer y se muestra "Ya se mandó a ML; mirá
Ejecución".

### R4. Casos especiales

- **Publicación pausada:** se vincula igual. Si ML ya tiene ese SKU, se actualiza el vínculo local y se cierra el
  caso ("Vínculo actualizado. ML ya tenía este SKU"). Requiere el cambio de `decidirCasoIdentidad` del PR en curso
  (SIN_CAMBIO_SKU con publicación pausada).
- **Hermanas** (`SIBLING_IMPACT_CONFIRMATION_REQUIRED`): confirmación en la misma tarjeta con la lista de
  hermanas, "Vincular las n" y "Volver".
- **Intervención:** el operador lo ve en solo lectura, con candado y "Lo destraba José".
- **Operación fallida o frenada:** tarjeta roja y fija con el motivo y la acción siguiente. Si hay ventas retenidas
  del mismo ítem, un enlace lleva a Retenidas.

### R5. Estados y errores

Estados: cargando, cola vacía ("No hay casos abiertos"), caso, rojo, intervención, guardando, guardado (solo
después del 200), conflicto 409 ("Alguien cambió este caso" con "Aplicar mi decisión sobre la versión nueva"),
rechazada, error de carga con Reintentar, sin conexión (banner fijo y acciones bloqueadas) y deshaciendo. Los
errores quedan fijos hasta resolverse; no son toasts.

| Código API | Mensaje |
|---|---|
| `NOT_FOUND` | Este caso ya no existe. Se resolvió o lo sacaron. |
| `INVALID_INPUT` | Falta completar un dato (por ejemplo, el motivo). Revisá lo marcado. |
| `omitir_requiere_override` | Esta publicación está en "no sincronizar". Quitalo antes de vincular. |
| `VERSION_CONFLICT` / `EVIDENCE_CONFLICT` | Alguien cambió este caso. Se vuelve a cargar con los datos nuevos antes de ofrecer "Aplicar mi decisión". |
| `INVALID_STATE` (409) | Este caso no admite esa acción en su estado actual. |
| `contradiccion_titulo` | No se puede vincular: difiere {campos}. Lo confirma José. |
| `SIBLING_IMPACT_CONFIRMATION_REQUIRED` | Esto cambia también {n} publicaciones hermanas. ¿Seguimos? |
| `SIN_CAMBIO_SKU` (409) | Activa: ML ya tiene este SKU, no hay nada que cambiar. Pausada: Vínculo actualizado, ML ya tenía este SKU. |
| `OPERACION_DUPLICADA` (409, con `operacion_id`) | Ya se mandó este cambio. Mirá su estado en Ejecución. |
| 403 | Esto lo hace José. |
| Red | Sin conexión. No se guardó nada. |
| Operación encolada / aplicada / fallida / frenada | En cola para ML / Aplicada en ML / ML la rechazó: {motivo}. Reintenta José. / Frenada: {regla}. Stock en 0 hasta resolver. |

### R6. Teclado (escritorio)

1/2/3 elegir candidato, Enter vincular, `s` saltear, `n` no sincronizar, `/` buscar otra variante, `z` deshacer,
`d` solo diferencias, `f` foto, `h` historial, `?` atajos (apagables, preferencia guardada en el navegador).
En celular no hay atajos: las mismas acciones son botones.

### R7. Retiro de las pantallas viejas

El mismo día del despliegue: Matcher, Identidad, Guardia y Bandeja redirigen a la pantalla nueva; se sacan sus
tarjetas del inicio y se agrega la de "Catálogo y vínculos". Antes del despliegue se recorre la tabla de
inventario como checklist: cada acción vieja tiene su equivalente o está descartada en esta spec.

## Criterios de aceptación

1. La cola sale ordenada por unidades 30 días × stock, descendente; con empate, el caso más antiguo primero.
2. Un operador no ve Destrabar, Confirmar igual ni Reintentar, y un POST directo a esas acciones devuelve 403.
3. Con un veto rojo, Vincular está deshabilitado y la razón aparece en texto.
4. "Guardado" no aparece antes de la respuesta exitosa; un reintento usa el mismo `operation_id`. Deshacer solo se
   ofrece si la operación no empezó.
5. Una publicación pausada cuyo SKU en ML ya es el objetivo se vincula y el caso se cierra.
6. Un caso con hermanas pide confirmación con la cantidad correcta.
7. El estado de ejecución pasa de encolada a aplicada sin recargar; una fallida queda roja y fija.
8. "No sincronizar" exige motivo y variante; la (b) muestra el alcance y pausa en ML como operación visible en
   Ejecución; la (c) no deja revertir a un operador. Una venta de una publicación en "no sincronizar" queda
   retenida; una de un "link de pago" se ignora.
8b. Confirmar igual y destrabar devuelven 403 a un operador. Destrabar un caso que sigue con contradicción no
    libera el stock.
8c. La cola ordena por ventas de la propia publicación (por `ml_key`), no por SKU compartido.
8d. Cada indicador de salud de Identidad y la sección de códigos en conflicto por GTIN tienen su lugar en la
    pantalla nueva.
9. Liberar una retenida exige motivo y queda registrado.
10. Ningún estado depende solo del color. A 360 px la cola y el detalle se apilan sin nada oculto.
11. Las pantallas viejas redirigen y ninguna acción del inventario queda sin equivalente.
12. Recorrido E2E de teclado (con operador y con admin): foco en el primer caso → `2` → `d` → `f` → `h`/Esc →
    Enter (encolada) → `z` → `s` → `n` sin motivo da error y con motivo guarda → caso rojo: Enter no hace nada y
    como admin "Confirmar igual" exige motivo → `/` y `?` → hermanas: confirmación en la tarjeta, Tab, Esc (vuelve) → Retenidas: liberar →
    sin red: banner y acciones bloqueadas → 360 px.

## Fuera de alcance

- Lote por familia (segunda entrega).
- Confirmar stock compartido (hoy no tiene pantalla).
- Cancelar venta retenida.
- Ventas de 90 días.
- Log de eventos de decisiones como fuente del set dorado.
