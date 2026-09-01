# UI, UX y pruebas de navegador

## Fuentes normativas

- Sistema visual existente: `public/lib/theme.css`.
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
- La primera UX móvil operativa se ordena como Base común → Preparación → Inventario. Preparación
  cubre cola, toma, escaneo, evidencia, cierre/etiqueta y despacho/incidencia; Inventario cubre
  Hoy/ubicación, conteo, diferencias, aprobación e historial/etiquetas.
- Ambos verticales deben diseñar estados vacío, cargando, sin permiso, error, reintento y conflicto.
  Las validaciones web de U0 incluyen 390 px; cada vertical móvil cierra además con E2E en iPhone
  contra una API real aislada.

- La vista rápida de stock es una búsqueda global por SKU, EAN o nombre y muestra disponible,
  físico por ubicación, comprometido, no disponible, entrante, canales, frescura e incidentes.
  Una ubicación sin línea base se muestra como tal, nunca como cero inventado.
- La App móvil debe validarse en iPhone y Android desde el comienzo; el stock móvil usa tareas,
  movimientos y conteos, no edición absoluta directa.

## Cuándo actualizar

Ante cambios durables de navegación, sistema visual, accesibilidad, breakpoints o estrategia
de pruebas UI.
