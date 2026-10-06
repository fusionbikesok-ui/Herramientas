# UI, UX y pruebas de navegador

## Fuentes normativas

- Sistema visual existente: tokens en `public/lib/theme.css` y **capa de componentes compartida
  en `public/lib/components.css`** (clases `ui-*`). La capa es la idea de shadcn/ui sin React ni
  build; una pantalla la importa y la extiende, nunca redefine sus clases. Reglas: sólo tokens
  (ningún color literal), `--accent` es exclusivamente interactivo —si algo es cian, se toca— y
  el blanco de toque mínimo es 44px. Estrenada en Identidad de productos; las 27 pantallas
  migran progresivamente. Antes de esa capa, `.btn` estaba redefinido en 13 pantallas, `.card`
  en 11, `.modal` en 6 y `.tag` en 4.
- Roles especializados: `.claude/agents/disenador-ux.md`,
  `.claude/agents/disenador-ui.md` y `.claude/agents/probador-e2e.md`.
- El acceso de prueba se resuelve solo durante una ejecución E2E autorizada; no persistir ni
  copiar credenciales en la memoria.

## Decisiones vigentes

- Los cambios normales o grandes de UX/UI se diseñan antes de implementar.
- Todo cambio en `public/` requiere prueba E2E interactiva y evidencia responsive antes del
  gate final.
- Matcher mantiene visible pero deshabilitada la dirección ML→Woo mientras no esté disponible,
  con su conteo informativo; las colisiones de vínculos ofrecen inspección y solo permiten
  deshacer al autor o a un administrador.
- Preparación carga todas las páginas de seguimientos pendientes y distingue visualmente los
  resultados inciertos que requieren verificación.
- Conteo mantiene el foco del campo de cantidad durante refrescos asincrónicos; el render
  pendiente se consume al terminar blur/reversión. El cierre expone en texto visible por qué
  el botón masivo está deshabilitado y la hoja EAN usa `role=region` sin secuestrar el foco.
- Los resultados de asociación SKU/EAN/UPC muestran el identificador siempre visible y dejan
  que el nombre/variante haga wrap en móvil; los dropdowns usan columnas fluidas y metadata en
  segunda línea en anchos estrechos, sin elipsis que oculte la variante.
- La App es herramienta de piso y la web conserva control, lotes, configuración, informes y contingencia. El inicio iPhone se ordena como “Trabajo urgente de hoy”.
- Ambos verticales deben diseñar estados vacío, cargando, sin permiso, error, reintento y conflicto.
  Las validaciones web usan 390/768/1440 px; cada vertical móvil cierra además con E2E en iPhone
  contra una API real aislada.

- La vista rápida de stock es una búsqueda global por SKU, EAN o nombre y muestra disponible,
  físico por ubicación, comprometido, no disponible, entrante, canales, frescura e incidentes.
  Una ubicación sin línea base se muestra como tal, nunca como cero inventado.
- La App móvil se valida primero en iPhone; Android queda fuera hasta demanda concreta. Stock móvil usa tareas, movimientos y conteos, no edición absoluta directa.
- Objetivos medibles: listas/filtros ≤2 s, feedback de escaneo <500 ms, preview/progreso de foto inmediato y confirmación objetivo ≤10 s; controles principales de una mano y al menos 44 px.
- Guardia ML presenta intenciones separadas para resolver urgencias, investigar, corregir catálogo, auditar cobertura y revisar decisiones previas. La comparación muestra la ficha ML y candidatos Woo en paralelo, con estados de lectura y acciones diferenciados; no presupone que toda visita sea una vinculación.
- La bandeja de identidad consume `publicacion.foto` y `tipo` desde el detalle interno; la foto ML es la primera imagen vigente de su representación, ordenada por `orden` e `id`.
- Bandeja de identidad (`public/bandeja-identidad/`, E3): decidir avanza al instante y guarda en segundo plano (varias decisiones en vuelo, misma `Idempotency-Key` en cada reintento; sólo se reintenta red/5xx/429). «Guardado» sólo tras el 200. Deshacer (`z`, 10 s, una vez) espera al 200 porque el `revierte` necesita el `decision_id` y la versión devueltos. Los chips filtran por `grupo` (0–4) en la API. Sin preselección de candidato; el cliente nunca manda `actor` (lo pone el proxy desde la sesión). Errores = avisos persistentes `role=alert`, nunca `alert()`. Lógica pura en `logica.js` (testeada en `test/bandejaIdentidad-ui.test.js`).
- T5 (2026-09-26): fase 1 de teclado implementada: `1/2/3` cambia el candidato visible, Enter vincula sólo fuera de controles nativos y requiere candidato visible (salvo confirmable), `x` normal reutiliza `eleccion: 'omitir'` y en confirmables conserva el rechazo. La barra muestra el deshacer confirmado con cuenta regresiva visible de 10 s; el intervalo se limpia al deshacer o salir.
- La estación de decisión de identidad mantiene una sola ficha ML y un candidato visible, diferencias priorizadas y una barra `#barra-decision` fija en escritorio; `1/2/3` sólo cambia el candidato y `Enter` vincula. `medir.mjs --verificar` valida documento ≤ viewport y visibilidad del primario. La foto usa `object-fit: contain`, el historial/evidencia queda colapsado y los precios se formatean con miles.
- La estación de decisión compacta usa `body` en `100dvh` con flex column, filtros y estado de guardado en una sola banda, encabezado del caso de una línea, fotos de `clamp(200px, 30vh, 300px)` y scroll interno sólo en diferencias; el panel confirmable muestra el SKU de `caso.confirmar` cuando no hay candidato sugerido.
- En la estación, los chips de otros candidatos cuentan con `diferenciasVisibles(...).diferencias.length`; muestran el título corto (28 caracteres con elipsis y `title` completo) y un conteo `N dif.` no recortable. El encabezado agrupa metadatos izquierdos y prioridad/enlace a la derecha; los separadores CSS sólo se dibujan entre hermanos del grupo izquierdo.
- El visor comparativo de identidad (`#visor-foto-dialog`) abre desde `f` o cualquiera de las fotos, muestra ML y el candidato lado a lado (o un espacio «Sin foto»), mantiene el foco atrapado y lo devuelve al disparador al cerrar. `+`/`-`/`0` y clic sincronizan zoom 1x/2x/3x con scroll interno por foto; flechas y `1/2/3` cambian el candidato sin cerrar y anuncian el cambio por `aria-live`. Las fotos de candidatos se precargan al abrir cada caso y el visor conserva su altura dentro de `dvh`.
- **Búsqueda manual rica (2026-09-26):** la estación abre la búsqueda dentro del panel derecho; los resultados muestran miniatura, SKU, precio/stock y `N dif.`, con mínimo de dos caracteres, debounce de 250 ms, cancelación de respuestas obsoletas y estados `aria-live`. ↑/↓ navega circularmente, Enter selecciona el candidato para la ficha grande y el siguiente Enter vincula; Esc restaura el candidato anterior. Sin candidatos, el buscador se abre automáticamente y los resultados tienen scroll interno.
- **T7 (2026-09-26):** la Bandeja enfoca el título del caso al navegar y anuncia `Caso N de M: tipo` por `aria-live`; diferencias/candidatos/resultados tienen roles de lista, la búsqueda usa `aria-activedescendant`, y el toast de deshacer conserva `role=status`. El visor aplica 1x/2x/3x real con scroll interno, sin que los máximos inline del documento lo limiten; las imágenes usan `decoding=async`, las miniaturas lazy y se precargan la publicación actual y el primer candidato del caso siguiente con token de navegación para ignorar respuestas obsoletas. La barra de decisión limita su ancho al viewport y la pantalla mantiene foco visible y `prefers-reduced-motion`.
- **Bandeja — invariantes de concurrencia (2026-09-26):** al navegar se invalida el detalle anterior; toda decisión toma un snapshot inmutable `{caseId, version, variantId}`, exige que detalle y fila de cola sigan identificando el mismo caso y una guardia por `caseId` reutiliza la entrada y su `Idempotency-Key` aunque el operador navegue A→B→A. Una respuesta ambigua agotada mantiene la entrada en `fallido`; sólo una respuesta terminal conocida, un deshacer confirmado o una cancelación explícita libera el caso, y «Reintentar» reutiliza esa misma entrada. Los avisos y temporizadores de deshacer sólo pertenecen a su entrada vigente; Apartar actualiza su propio objeto `undo` y sólo avanza si la cola todavía muestra el caso capturado. Las cargas de cola y la paginación descartan respuestas cuyo token o grupo ya no coinciden. Las diferencias se renderizan completas en el scroll interno y los chips de filtro/candidato respetan `--tap-min`.
- **Bandeja — cancelación de decisión (2026-09-26):** una decisión fallida ofrece «Reintentar» con la misma entrada/clave y «Descartar»; una decisión todavía en vuelo sólo muestra «Esperando confirmación…». Descartar pasa la entrada por el estado atómico `reconciliando`, oculta ambas acciones y relee `GET /casos/:id`; sólo después de aplicar el detalle exitoso libera la guardia y elimina las entradas pendientes de ese caso. Si el caso está cerrado se retira de la cola y se avanza; si sigue abierto se actualizan detalle, versión y render. Un GET fallido vuelve a `fallido` y conserva el bloqueo. Reintentar sólo es válido desde `fallido`; una decisión posterior usa una clave nueva.
- **Bandeja — descarte mientras el operador navega (2026-09-27):** al reconciliar un caso cerrado, si es el índice visible se abre el caso que ocupa su posición; si estaba antes se decrementa `S.idx`, y si estaba después no se navega. Si la cola local queda vacía se carga `S.siguiente` con `idx=-1`. La guardia se verifica antes de mutar cola/detalle y una reconciliación invalidada limpia su aviso sin mutar estado; los errores de GET sólo vuelven a `fallido` desde `reconciliando`.

## Cuándo actualizar

Ante cambios durables de navegación, sistema visual, accesibilidad, breakpoints o estrategia
de pruebas UI.

**Bandeja de identidad (2026-09-26, tarea 3 de auditoría):** `logica.js` normaliza la lista real de
`explicacion.atributos` + `otros_atributos` en `diferenciasVisibles()`, deduplica por nombre, prioriza
`difiere → falta → equivalente` y conserva los valores `*Original` cuando existen. El seed de
`scripts/qa/bandeja-real/levantar.mjs` emite la forma real (`marca`, valores normalizados y originales) y
siembra atributos persistidos para `otros_atributos`. La estación usa scroll interno de diferencias y no
scroll de página; queda pendiente validación visual responsive autorizada.

## Sincronización ML rediseñada y Pausadas con stock (2026-10-05)

Prototipos aprobados por José (fuente de layout, responsive, estados y copy; al implementar se usan los tokens de `theme.css`/`components.css`, no los hex):
[`docs/superpowers/prototipos/2026-10-05-sincronizacion-ml.html`](../../superpowers/prototipos/2026-10-05-sincronizacion-ml.html) y [`2026-10-05-pausadas-con-stock.html`](../../superpowers/prototipos/2026-10-05-pausadas-con-stock.html).

- `/herramientas/sync-ml/`: estado arriba en una línea (reemplaza las píldoras) + «Para resolver», una sola lista por gravedad (crítico > atención > info) con barra de color, número, frase y acción; las filas de frenadas y de cambios de producto se expanden in situ. Lo que está en 0 no ocupa fila: queda una línea «✓ …» al pie. Las 4 acciones manuales viven en el menú «Correr ahora» (sólo ícono en móvil); todo resultado va a una franja inferior persistente con ✕. Ventas ML: 2 KPIs y los últimos 5 pedidos plegados.
- `/herramientas/sync-ml/pausadas/`: lista por causa con foto de 56 px, lote con segundo clic, resultado por fila y hoja inferior en móvil; atajos j/k/x/Enter/r/Shift+R/?.
- Regla: **cero `confirm`/`alert`/`prompt` y ningún handler inline** en estas dos pantallas; la confirmación es un segundo clic o el propio plan previo.
- Enlaces antiguos vivos: `/sync-ml/#reactivar` redirige a Pausadas; `#frenadas` y `#cambios-formato` abren y centran la fila.
- Criterio de aceptación: sin scroll horizontal ni texto cortado en 320, 390, 600, 768, 900, 1024, 1280 y 1600 px; controles ≥24 px en PC y ≥44 px en móvil.

## Deuda: handlers `onclick` inline previos (2026-10-06)
Ticket pendiente, anterior a Fase B (no lo introdujo): quedan `onclick` inline en `public/matcher/index.html` (≈ líneas 540, 558, 608) y `public/home/index.html` (≈ 528, 756). Migrarlos a `addEventListener`/delegación, como pide la regla de «ningún handler inline» de arriba.

## Deuda: targets táctiles < 44 px en móvil (2026-10-06)
Detectada en el E2E de Fase B; no es de esa rama. Controles por debajo de 44 px en móvil: «Salir» y «Abrir bandeja en Mercado…» (home), «← Home», y el link MLA de la tabla del matcher. Llevarlos a ≥ 44 px (criterio de aceptación de arriba).
