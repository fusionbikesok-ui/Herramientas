# Bandeja de identidad — auditoría unificada y propuesta de rediseño

**Fecha:** 2026-09-26. Une dos auditorías independientes:
- `2026-09-26-bandeja-auditoria-codex.md`: Codex leyó el código e investigó buenas prácticas, con fuentes.
- `2026-09-26-bandeja-auditoria-sesion.md`: la otra sesión abrió la pantalla real con Playwright y dejó 20 capturas en `capturas-2026-09-26/`. Límite: se probó con un harness que usa el `public/` real, una API simulada y 5 casos sintéticos. No se usó la base anonimizada, porque QA no levanta la plataforma.

**Criterio de José (textual):** "debería ser usable las veces que sean necesarias y no canse avanzar en ella; actualmente no da ni ganas de entrar, es fea, inservible, no es rápida de tomar la decisión; lo único rescatable es el concepto de la comparación de productos, pero no como está implementado". También pidió: nada cortado, fotos fáciles de ver, diferencias bien a la vista, poco scroll. El motor todavía no está calibrado.

## 1. Diagnóstico (confirmado por las dos auditorías)

| # | Problema | Evidencia medida | Gravedad |
|---|---|---|---|
| 1 | **Nunca se ve la foto de ML.** La API no la envía (`identidad-interna.ts:225,321`) y la UI la fija en `null` (`bandeja.js:551`). Aparece un recuadro vacío de ~505×380. | 0 de 5 casos | CRÍTICO |
| 2 | **La decisión queda fuera de la pantalla.** La página mide entre 1,9 y 2,6 veces la altura visible, y el botón Vincular está entre y=1273 y y=1610 con una ventana de 800–900. | 5 de 5 casos, en las dos resoluciones | CRÍTICO |
| 3 | **Cada candidato aparece dos veces**: en la tabla y otra vez en los radios. El título de ML también se repite, en el encabezado y en la tabla. | ~300 px desperdiciados por caso | ALTO |
| 4 | **6 a 8 botones iguales apilados a todo el ancho**, sin jerarquía: "Vincular" pesa lo mismo que "No vincular". | ~330–390 px | ALTO |
| 5 | **Vincular lleva dos teclas, y además hay que bajar para ver el botón.** Con mouse: 2 clics y entre 500 y 750 px de scroll. | medido | ALTO |
| 6 | **La sugerencia del motor se ve como si fuera la buena.** La evidencia ("Por qué") está en la última fila, fuera de la pantalla. Con un motor sin calibrar, esto empuja a aceptar sugerencias malas. | parcial: el sesgo no se puede medir con datos sintéticos | ALTO |
| 7 | **No se muestra el tipo de caso.** El front lee `tipo_caso` pero la API manda `tipo` (`bandeja.js:852` / `identidad-interna.ts:319`), así que el dato llega vacío. | bug | ALTO |
| 8 | **La búsqueda manual es un modo escondido.** Sus resultados se agregan como columnas de la misma tabla. | parcial | MEDIO |
| 9 | Con 3 candidatos, las fotos de Woo bajan a 270×202 (238×178 a 1280). | medido | MEDIO |
| 10 | `x` no hace nada fuera del grupo Confirmar. El aviso de deshacer no dice que dura 10 s. El precio no tiene separador de miles. | medido | BAJO |

Lo que **no** es un problema: no hay texto cortado con elipsis ni scroll horizontal. Lo que se ve "cortado" es lo que queda debajo del borde inferior de la pantalla.

## 2. Qué se rescata

- **La idea central:** comparar ML contra Woo, y el "Por qué" de cada atributo (`explicacion.atributos`).
- **La base segura:** idempotencia, `expected_version`, manejo de conflictos 409, deshacer con `z`, apartar y el actor derivado de la sesión en el proxy.
- **El visor de fotos** de Woo (`dialog`, `Esc`, precarga), los atajos `j/k`, `/`, `?`, `o`, `n` y los filtros por grupo con cursor.

Se tira: la tabla ancha como vista principal, la lista de radios duplicada, la botonera vertical y el puntaje como señal dominante.

## 3. Rediseño propuesto: una "estación de decisión"

**Principios:** una pantalla muestra un caso y lleva a una decisión, sin scroll de página a 1440×900 ni a 1280×800. La foto es la evidencia principal. Primero se muestran las diferencias. El motor sugiere y José decide.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Identidad · 5.300 abiertos   Conflictos 17 · SKU 2.098 · Apartados 3   [a]   │ 56
│ Caso 18 · USER PRODUCT DIVERGENTE — "ML y Woo no coinciden en variante"       │ 44
├───────────────────────────────────────┬──────────────────────────────────────┤
│ PUBLICACIÓN ML                        │ CANDIDATO 1 de 3 · sugerido           │
│ ┌──────────────┐ Título completo      │ ┌──────────────┐ Título completo      │
│ │  FOTO ML     │ SKU ML-ABC           │ │  FOTO WOO    │ SKU FB-ABC · stock 4  │ ~330
│ │  (clic=zoom) │ $189.900 · stock 2   │ │  (clic=zoom) │ [f] ver las 2 juntas  │
│ └──────────────┘ [Abrir en ML]        │ └──────────────┘                      │
├───────────────────────────────────────┴──────────────────────────────────────┤
│ DIFERENCIAS                          ML dice          Woo tiene               │
│ ≠ Color                              negro mate       negro         difiere   │ ~180
│ ! Talle                              M                —             falta     │
│ ✓ 6 atributos coinciden  [d] ver todos                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Otros: [2] Trek Marlin 5 M rojo · 1 dif   [3] … · 3 dif    [/] Buscar          │ 56
├──────────────────────────────────────────────────────────────────────────────┤
│ Enter = VINCULAR a FB-ABC (2 diferencias)  [x] No es ninguno [?] No estoy seg. │ 64
│ [o] Omitir por ahora  [n] No existe   · Deshacer: z (10 s)                     │  ← fija
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Fotos:** las dos imágenes principales tienen el mismo alto (entre 260 y 340 px) y `object-fit: contain`. Con `f` se abre un visor que muestra ML y Woo juntas con zoom. Si falta una foto, el espacio se mantiene y aparece "Sin foto" con el link a ML.
- **Diferencias:** es una lista, no una tabla. Primero lo que difiere, después lo que falta y al final lo equivalente. Los atributos iguales se resumen en una línea. Cada estado usa ícono, texto y color, nunca solo color.
- **Un solo candidato a la vez**, en grande. Los demás se muestran en una tira compacta con cuántas diferencias tiene cada uno, y se cambia con `2` o `3`.
- **Barra de decisión fija abajo**, con los botones jerarquizados. Dice explícitamente qué va a hacer `Enter` y contra cuántas diferencias.
- **Motor sin candidatos buenos:** una banda dice "No hay candidato confiable; buscá por SKU o título". `/` abre la búsqueda en el mismo panel del candidato, con foto y diferencias contra ML. No se autoselecciona nada.
- **Tipo de caso visible** en el encabezado, con una frase de qué mirar.

### Teclado: cómo se concilia con tu decisión S3 del 25/09 (dos teclas)

Las auditorías no coinciden. Codex propone una tecla (`1` vincula directo). La sesión muestra que el costo real no es la segunda tecla, sino tener que bajar a buscar el botón y no ver la evidencia. Propuesta unificada en fases:

1. **Fase 1 (cumple S3):** `1/2/3` cambia el candidato que se ve en grande y `Enter` vincula. Como la barra dice "Enter = Vincular a FB-ABC (2 diferencias)" y todo está en pantalla, el segundo paso se resuelve en un segundo de lectura.
2. **Fase 2 (solo si vos reabrís S3 para este caso):** si el candidato no tiene ninguna diferencia ni dato faltante, `1` vincula directo, con un deshacer visible y cuenta regresiva de 10 s.
3. La fase 2 se habilita **solo si** la tasa de deshacer medida en la fase 1 es baja. Nunca se usa el puntaje del motor como criterio.

## 4. Cambios necesarios en la API (plataforma)

- **Sí:** agregar `foto_ml` (y la galería) al detalle del caso, tomándola del `thumbnail` de `ml_publicaciones_cache` en el legado o del bootstrap de ML.
- **Sí:** unificar `tipo` / `tipo_caso`.
- **Sí, para la búsqueda:** que `GET /variantes?q=` devuelva foto, atributos y diferencias contra ML.
- **Más adelante:** lotes (vista previa, validación de homogeneidad e idempotencia por caso).
- **Recordatorio:** la API de producción sigue en la imagen vieja, sin "apartar" (ver plan maestro). El rediseño y la actualización de la API deberían salir juntos.

## 5. Plan de implementación (Codex implementa; revisor, probador y auditor antes de desplegar)

| # | Tarea | Capa |
|---|---|---|
| 0 | **Harness de QA con la plataforma real** y medición base: segundos por caso, scroll y teclas. Sin esto no se puede comprobar la mejora. | QA |
| 1 | Foto de ML en la API y en el proxy, y arreglo de `tipo` / `tipo_caso`. | API + proxy |
| 2 | Estructura de la estación: encabezado, dos paneles, diferencias, tira de otros candidatos y barra fija. Test "sin scroll de página" a 1440×900 y 1280×800. | UI |
| 3 | Lista de diferencias priorizadas (`diferenciasVisibles()` en `logica.js`), con ícono, texto y color. | UI |
| 4 | Visor comparativo `f`, con ML y Woo juntas y zoom. | UI |
| 5 | Teclado de la fase 1, con barra explícita y cuenta regresiva del deshacer. `x` hace algo en todos los grupos. | UI |
| 6 | Búsqueda manual en el panel del candidato, con foto y diferencias. | API + UI |
| 7 | Accesibilidad (axe, foco, zoom al 200 %) y rendimiento (lazy fuera de pantalla, precarga del siguiente caso). | UI |
| 8 | **Piloto con José: 50 casos reales**, midiendo el tiempo y la tasa de deshacer. Recién después se decide la fase 2 del teclado y los lotes. | — |

**Métricas objetivo (a validar, no prometidas):** decisión mediana de 10 s o menos en casos confirmables y 15 s o menos con candidatos visibles; el 100 % de los casos sin scroll de página; ninguna decisión perdida por errores de red; y que no aumenten las correcciones posteriores.

## 6. Decisiones para José

1. ¿Aprobás la estación de decisión (el wireframe) como dirección?
2. Teclado: ¿fase 1 (se mantiene S3) y medir, o reabrís S3 ya para los candidatos sin diferencias?
3. ¿El rediseño sale junto con la actualización de la API, en lugar de desplegar ahora la bandeja actual?
4. ¿Se hace primero la tarea 0 (harness con la plataforma real y medición base)? Es la única forma de demostrar que mejoró.
