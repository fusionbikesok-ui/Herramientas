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
- La estación de decisión de identidad mantiene una sola ficha ML y un candidato visible, diferencias priorizadas y una barra `#barra-decision` fija en escritorio; `1/2/3` sólo cambia el candidato y `Enter` vincula. `medir.mjs --verificar` valida documento ≤ viewport y visibilidad del primario. La foto usa `object-fit: contain`, el historial/evidencia queda colapsado y los precios se formatean con miles.
- La estación de decisión compacta usa `body` en `100dvh` con flex column, filtros y estado de guardado en una sola banda, encabezado del caso de una línea, fotos de `clamp(200px, 30vh, 300px)` y scroll interno sólo en diferencias; el panel confirmable muestra el SKU de `caso.confirmar` cuando no hay candidato sugerido.

## Cuándo actualizar

Ante cambios durables de navegación, sistema visual, accesibilidad, breakpoints o estrategia
de pruebas UI.
