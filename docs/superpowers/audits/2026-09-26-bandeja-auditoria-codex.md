# Auditoría senior UX/UI y de producto — Bandeja de identidad

**Fecha:** 2026-09-26  
**Pantallas evaluadas:** `public/bandeja-identidad/`  
**Resoluciones objetivo:** 1440×900 y 1280×800  
**Criterio:** escritorio primero, decisión humana segura aunque el motor falle.

## Dictamen ejecutivo

La pantalla actual tiene el concepto correcto —comparar ML contra Woo— y una base técnica valiosa: decisiones idempotentes, conflicto 409, deshacer, atajos y explicación de atributos. Pero el layout convierte cada caso en una página de lectura larga. La comparación aparece primero en una matriz de 5+ columnas; después se repiten los candidatos como tarjetas; recién abajo aparecen los botones. A 1440×900 el usuario llega a ver el encabezado, la matriz parcial y el comienzo de los candidatos, pero no el bloque completo de decisión. A 1280×800 la situación es peor: la grilla se vuelve más angosta, los títulos se parten y las acciones quedan fuera del pliegue. La foto ML, además, no se renderiza nunca en la matriz actual.

La propuesta es una estación de decisión fija: publicación ML y candidato seleccionado lado a lado arriba; sólo diferencias y evidencia en el centro; una barra de decisión sticky abajo. El caso frecuente debe resolverse con una tecla: `1/2/3` elige candidato y confirma en la misma acción, `x` rechaza, `?` aparta, `o` omite, `/` busca. Una sugerencia no debe parecer verdad: mostrar evidencia, contradicciones y estado “sugerencia”, sin convertir el score en confianza.

## 1. Reconstrucción del uso actual

### Qué se carga y qué queda arriba

La página tiene una topbar sticky de 54 px y debajo una segunda barra sticky de filtros que puede envolver hasta dos líneas (`index.html:30-117`, `index.html:457-486`). En 1440 px normalmente ocupa unos 110–135 px; en 1280 px el chip “Sin publicación única” puede generar otra línea. El caso empieza debajo con padding y gaps de `var(--sp-3)`/`var(--sp-2)` (`index.html:119-127`).

El caso se renderiza en este orden (`bandeja.js:646-745`):

1. ID, título, prioridad y link a MercadoLibre.
2. Buscador, sólo si se abrió manualmente.
3. Matriz: encabezado + foto + título + SKU + precio/stock + atributos + “Por qué”.
4. Lista de candidatos repetida como radios/tarjetas.
5. Acciones.
6. Historial, evidencia y notas.

En consecuencia, a 1440×900 el pliegue cubre aproximadamente la cabecera y 4–6 filas de la matriz, no la decisión completa. A 1280×800 suele cortar durante las filas de atributos o en el primer candidato. No hay un scroll horizontal de página previsto, pero sí mucho scroll vertical; `caso` tiene `overflow-y:auto` (`index.html:120-127`) y los diálogos también (`bandeja.css:377-405`). La matriz no tiene altura propia ni sticky de decisión.

### Fotos

La foto Woo ocupa una celda 4:3 y se puede abrir con click (`bandeja.css:58-75`). El problema crítico está en `celdaFija`: para ML se construye explícitamente `foto: null` (`bandeja.js:545-552`), por lo que la publicación de MercadoLibre siempre muestra “Sin foto ML”, aunque la API pudiera devolverla. Las fotos de candidatos sí aparecen, pero se repiten en la matriz y luego no vuelven a aportar información en la tarjeta. El visor amplía una sola imagen en un `dialog`, no compara ambas (`index.html:502-508`).

### Diferencias y evidencia

El motor devuelve `explicacion.atributos` y la UI marca `ok`, `difiere`, `falta` o `equivalente` (`bandeja.js:508-542`; `plataforma/src/identidad/candidatos.ts:51-77`). T4 colapsa los atributos iguales y agrega “Por qué” (`bandeja.js:579-623`), lo cual rescato. Sin embargo, la tabla conserva la publicación ML en una columna y cada candidato en otra; con títulos largos y `overflow-wrap:anywhere` (`index.html:173-197`) se parte demasiado texto. La diferencia se ve dentro de cada celda, no como una lista corta ordenada por impacto.

### Candidatos y acciones

El render muestra hasta los candidatos sugeridos y los candidatos de búsqueda como radios (`bandeja.js:670-694`). Para vincular, el flujo normal es: seleccionar radio + pulsar “Vincular seleccionado”, dos interacciones aunque exista un primer candidato. El botón de vincular y las acciones están en una grilla vertical (`index.html:278-303`), después de toda la comparación. Hay 7–9 opciones visibles: vincular, buscar, apartar, omitir, no existe, no vincular, sólo diferencias, más confirmar/rechazar según el caso (`bandeja.js:697-729`). Es una paleta demasiado plana para acciones con consecuencias distintas.

### Teclado: cuántas acciones lleva

Hay atajos reales (`bandeja.js:831-875`):

| Intención | Flujo actual | Costo frecuente |
|---|---|---:|
| Vincular candidato 1 | `1` selecciona, `Enter` vincula | 2 teclas |
| Vincular candidato 2/3 | `2`/`3`, `Enter` | 2 teclas |
| Confirmar SKU ya vinculado | `Enter` | 1 tecla |
| Rechazar confirmable | `x` | 1 tecla |
| Apartar | `?` | 1 tecla |
| Omitir | `o` | 1 tecla |
| Buscar | `/`, escribir, elegir resultado, confirmar | 4+ acciones |
| Siguiente/anterior | `j`/`k` o flechas | 1 tecla |

El costo de 2 teclas para la decisión dominante contradice el objetivo de velocidad. La pantalla sí evita atajos mientras un botón/input tiene foco, y dispone de ayuda, pero el usuario debe recordar qué tecla selecciona y cuál confirma. La práctica de herramientas de revisión es hacer que seleccionar y enviar sea un gesto corto y repetible; Label Studio documenta explícitamente teclado, skip y submit como flujo de anotación, y permite ocultar paneles que no aportan a la tarea ([Label Studio labeling guide](https://labelstud.io/guide/labeling)). Gmail también separa navegación, acciones y ayuda de atajos (`?`) ([Gmail keyboard shortcuts](https://support.google.com/mail/answer/90559?hl=en)).

### Truncamientos y cortes

- Títulos, SKU y valores usan `overflow-wrap:anywhere`, así que no se truncarán con elipsis, pero sí crearán filas de altura impredecible (`index.html:173-197`; `bandeja.css:102-107`, `295-296`).
- La matriz crece por cada atributo visible y sólo colapsa los iguales después de una mejora T4 (`bandeja.js:579-613`).
- El resumen de “Iguales” corta a tres nombres y usa `…` (`bandeja.js:589-591`): correcto como resumen, insuficiente si el usuario no abre “Ver más”.
- El candidato se repite en tabla y tarjeta; el usuario lee dos representaciones del mismo objeto.
- Historial y evidencia están después de las acciones, pero pueden desplazar el foco visual del caso actual (`bandeja.js:731-745`).
- El visor de foto puede ocupar hasta 90dvh y scrollea como diálogo (`bandeja.css:377-405`), pero no ofrece zoom, comparación simultánea ni navegación entre fotos.

## 2. Buenas prácticas aplicables

### Entity resolution y revisión con modelo

OpenRefine define reconciliation como record linkage/entity resolution y su API devuelve una lista ordenada de entidades potenciales, no una identidad automática ([OpenRefine reconciliation](https://openrefine.org/docs/manual/reconciling), [Reconciliation API](https://openrefine.org/docs/technical-reference/reconciliation-api)). Eso encaja con FusionBikes: mostrar candidatos rankeados y permitir buscar, pero exigir confirmación humana.

Label Studio permite filtrar/ordenar tareas, revisar predicciones, aceptar o rechazar sugerencias manualmente, saltar tareas y enviar con teclado ([Label Studio labeling guide](https://labelstud.io/guide/labeling), [Data Manager](https://labelstud.io/guide/manage_data)). Prodigy describe uncertainty sampling: concentrar revisión en ejemplos inciertos y mostrar progreso, en vez de tratar toda predicción como igualmente confiable ([Prodigy text classification](https://prodi.gy/docs/text-classification)). Para este caso: la cola debe priorizar conflictos y contradicciones, no el score desnudo.

### Evidencia, no score

La spec vigente ya reconoce que el score no debe mostrarse como confianza hasta calibrarlo (`docs/superpowers/specs/2026-09-24-e3-identidad-design.md:88-91`, `159-168`). La UI debe llevar esa regla al lenguaje visual: “3 atributos coinciden; color difiere; talle ausente”, fuente y fecha de cada dato, y una banda de contradicción. Nunca “92%” si el top-1 todavía puede ser incorrecto.

### Comparación visual

Una comparación útil mantiene el mismo orden de atributos, alinea valores y hace visibles sólo las diferencias. La referencia interna `public/sync-ml/index.html` confirma que “Comparar productos” es el concepto que funciona; la bandeja actual lo diluye al mostrar una tabla amplia y luego repetir tarjetas. La unidad debe ser “dato que cambia la decisión”, no “todos los campos disponibles”.

### Accesibilidad y fatiga

WCAG 2.2 AA exige contraste mínimo 4.5:1 para texto normal y 3:1 para texto grande ([WCAG 2.2, 1.4.3](https://www.w3.org/TR/wcag/#contrast-minimum)). Las diferencias no pueden depender sólo de color: deben incluir ícono (`✓`, `≠`, `?`) y texto. El indicador de foco debe ser visible, persistente mientras el componente tiene foco y no quedar oculto ([W3C Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance)); WCAG también exige contraste no textual 3:1 para límites y estados que comunican información ([Non-text Contrast](https://www.w3.org/WAI/WCAG21/understanding/non-text-contrast.html)).

La fatiga acá no se resuelve agregando más filtros. Se reduce con: un layout estable, decisión primaria siempre en el mismo lugar, evidencia resumida, acciones reversibles, feedback inmediato, lotes homogéneos y no obligar a recordar datos vistos en otra pantalla. La densidad debe ser alta en información y baja en decisiones simultáneas.

## 3. Auditoría priorizada

### CRÍTICO

| Hallazgo | Archivo:línea | Evidencia | Por qué frena |
|---|---|---|---|
| La foto ML nunca aparece | `public/bandeja-identidad/bandeja.js:545-552` | `src` de ML fija `foto: null`; renderiza “Sin foto ML” | La evidencia visual más valiosa está ausente; obliga a abrir ML o decidir por texto. |
| La decisión está debajo de la comparación y de una segunda lista | `bandeja.js:559-729`, `index.html:278-303` | Matriz completa, candidatos repetidos y acciones verticales | En 1440×900/1280×800 no se ve el conjunto necesario sin scroll; baja velocidad y aumenta abandono. |
| Vincular requiere seleccionar y confirmar | `bandeja.js:677-709`, `831-864` | `1/2/3` sólo selecciona; `Enter` ejecuta después | Dos acciones por caso dominante; la cola de 5.300 casos se vuelve mecánica y cansadora. |
| La UI puede presentar una mala sugerencia como candidata principal | `bandeja.js:681-690`; spec `2026-09-24...:88-91` | “Sugerencia del sistema” existe, pero no hay evidencia compacta por impacto junto a la acción | Con top-1 incorrecto frecuente, la posición del candidato induce sesgo de aceptación. |

### ALTO

| Hallazgo | Archivo:línea | Evidencia | Por qué frena |
|---|---|---|---|
| Comparación redundante | `bandeja.js:559-623` y `670-694` | Misma foto/título/SKU aparece en matriz y tarjetas | Consume altura y atención sin agregar evidencia. |
| Muchas acciones con jerarquía débil | `bandeja.js:697-729` | Botones similares para vincular, apartar, omitir, no existe y no vincular | Aumenta el tiempo de elección y el riesgo de una acción equivocada. |
| Búsqueda manual no es una ruta de primera clase | `bandeja.js:661-665`; `bandeja.css:220-257` | Se abre como modo alternativo y los resultados no tienen comparación rica | Cuando el motor falla, el usuario cae en una mini-lista sin foto/evidencia equivalente. |
| Fotos pequeñas y no comparables | `bandeja.css:58-75`; `index.html:502-508` | 4:3 dentro de cada celda; visor de una sola imagen | La identidad de producto se decide por forma, color y variante; el diseño los minimiza. |
| El scroll del caso no tiene zona de decisión sticky | `index.html:119-127`, `index.html:278-303` | Sólo `.caso` scrollea; acciones están en flujo | El usuario debe volver abajo para actuar después de releer. |

### MEDIO

| Hallazgo | Archivo:línea | Evidencia | Por qué frena |
|---|---|---|---|
| Títulos variables desestabilizan la altura | `index.html:173-197`; `bandeja.css:102-107` | `overflow-wrap:anywhere` parte palabras largas | El mismo gesto cae en lugares distintos; dificulta escaneo y memoria muscular. |
| “Iguales” se descubre después de renderizar la tabla | `bandeja.js:579-613` | Botón “Ver más” resume sólo tres atributos | Buena intención, pero la señal de “hay diferencias” debería estar antes del detalle. |
| El historial/evidencia compite con la tarea | `bandeja.js:731-745` | Se encuentra en la misma columna y después de acciones | Información útil para auditoría, pero no debe empujar el caso actual. |
| Falta agrupación accionable | `bandeja.js:457-486`; API proxy `routes/bandejaIdentidad.js:25-64` | Hay chips de grupo, no operación por grupo homogéneo | José repite decisiones equivalentes caso por caso. |
| La foto tiene `alt=''` | `bandeja.js:550-551` | El botón sí tiene `aria-label`, pero la imagen carece de descripción | El control es operable, pero la evidencia no queda descrita para tecnologías asistivas. |

### BAJO

| Hallazgo | Archivo:línea | Evidencia | Por qué importa |
|---|---|---|---|
| CSS específico embebido en `index.html` | `index.html:9-447` | La mayor parte de layout está fuera de `bandeja.css` | Hace más difícil iterar con consistencia y revisar tokens. |
| “Sin publicación única” se ve como chip pero no es botón | `index.html:483-485` | Es un `span` dentro de toolbar | Comunica un contador como si fuera filtrable; expectativa falsa. |
| Atajos pueden chocar con foco y navegación | `bandeja.js:831-837` | Se desactivan en controles, pero no hay modo explícito “focus en estación” | Requiere prueba E2E de teclado completa para no sorprender a usuarios. |

## 4. Rediseño concreto

### Principios

1. **Una pantalla, un caso, una decisión.** Nada importante queda después de un scroll de página a 1440×900.
2. **La foto es evidencia primaria.** ML y Woo deben verse grandes, alineados y ampliables juntos.
3. **La diferencia manda.** Mostrar primero contradicciones y datos faltantes; los iguales quedan resumidos.
4. **El modelo sugiere, José decide.** El rank es contexto, no autoridad.
5. **Una acción frecuente = una tecla.** Seleccionar y aplicar son la misma decisión.

### Wireframe objetivo — 1440×900, sin scroll de página

```text
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Bandeja   Identidad  ·  5.300 abiertos    Conflictos 17  SKU 2.098  [A ayuda]           │ 64
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Caso 18/5.300 · user_product_divergente     [ML #123]  Prioridad alta     Guardado ✓       │ 48
├──────────────────────────────────────────────────────┬─────────────────────────────────────┤
│ PUBLICACIÓN ML                                      │ CANDIDATO 1 · sugerido               │
│ ┌──────────────────────┐                            │ ┌─────────────────────┐             │
│ │                      │  Título completo           │ │                     │             │
│ │       FOTO ML        │  SKU: ML-ABC               │ │      FOTO WOO       │             │
│ │   click / zoom       │  $ precio · stock           │ │      click / zoom   │             │
│ └──────────────────────┘  [Abrir ML]                │ └─────────────────────┘             │
│                                                      │ SKU FB-ABC · stock 4                 │
│                                                      │ [1] Vincular este candidato          │
├──────────────────────────────────────────────────────┴─────────────────────────────────────┤
│ DIFERENCIAS QUE CAMBIAN LA DECISIÓN                                                         │
│ ≠ Color     ML: negro mate                 Woo: negro                 ⚠ difiere             │
│ ≠ Talle     ML: M                          Woo: —                       ! falta              │
│ ✓ Marca     Trek                           Trek                         coincide             │
│  2 coinciden · 2 difieren · Ver todos                       Evidencia: ML 09:42 / Woo 09:41 │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ OTROS CANDIDATOS   [2] ...   [3] ...   [/] Buscar SKU o título                             │ 72
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ [1 Vincular] [2] [3]   [x] No es este   [?] Apartar   [o] Omitir   [n] No existe   [j/k]   │ 64
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Altura aproximada: topbar 56 + contexto 48 + comparación 365 + diferencias 145 + otros 70 + barra 64 = 748 px, dejando margen dentro de 900 px. En 1280×800 reducir “Otros candidatos” a una tira horizontal de 56 px y usar foto de 260–300 px; la barra de decisión sigue visible. El scroll queda sólo dentro de “Evidencia” y del buscador, no para encontrar el botón principal.

### Fotos

- Enviar `foto_ml`/`imagenes_ml[]` en el detalle o resolverla en el proxy; no hardcodear ausencia.
- Dos imágenes principales de 280–360 px de alto, `object-fit: contain`, fondo neutro y mismo baseline.
- Click abre un visor comparativo con ML y Woo simultáneos, zoom con rueda/`+`/`-`, `Esc` cierra y flechas cambian la imagen si hay galería.
- Debajo de cada foto: título, SKU, origen y estado de imagen (“original ML”, “primera imagen Woo”).
- Si falta una foto, reservar el mismo espacio y mostrar “Sin foto disponible”; ofrecer “Abrir publicación ML”.

### Diferencias

Usar una lista de diferencias, no una grilla completa como primer plano:

- `≠` + fondo warning + borde lateral para diferencia.
- `!` + patrón/borde discontinuo para dato faltante.
- `✓` + texto “coincide” para evidencia positiva.
- `≈` + texto “equivalente normalizado” cuando corresponda.

Nunca usar sólo rojo/verde. Mostrar “ML dice” y “Woo tiene” en columnas alineadas. Ordenar: identidad estructural (modelo/tipo), variante (color/talle/rodado), pack, SKU, stock/precio. El botón “Ver todos” abre iguales, sin desplazar la barra de decisión.

### Teclado propuesto

| Tecla | Acción | Resultado |
|---|---|---|
| `1`, `2`, `3` | Vincular candidato correspondiente | Selecciona y envía una sola decisión; foco pasa al siguiente caso |
| `x` | No es este / rechazar | Envía rechazo; pide motivo sólo si es requerido |
| `?` | Apartar | Envía `apartar`; queda fuera del lote activo |
| `o` | Omitir por ahora | Marca sesión/estado sin bloquear el siguiente |
| `n` | No existe en catálogo | Decide `sin_candidato` |
| `/` | Buscar | Foco inmediato en SKU/título; `Enter` vincula el resultado enfocado |
| `j`/`k` | Siguiente/anterior | Navega sin perder selección ni estado de guardado |
| `z` | Deshacer | Sólo dentro de 10 s y después del 200 |
| `f` | Visor comparativo | Abre ambas fotos |
| `d` | Sólo diferencias | Mantiene el estado y no cambia la selección |

Las teclas 1–3 deben ser decisiones, no preselecciones. Para evitar errores, mostrar una confirmación visual no modal de 400–600 ms (“Vinculado a FB-ABC”) y ofrecer `z`; no agregar un segundo Enter. Mantener botones visibles con la misma tecla y `aria-keyshortcuts`.

### Motor malo o sin candidatos

- Mostrar una banda explícita: **“No hay candidato confiable; buscá por SKU o título”**.
- Abrir búsqueda con `/` y devolver resultados en tiempo real, con foto, SKU, nombre, atributos y diferencias contra ML.
- Buscar por SKU exacto primero, luego token de modelo/marca/color; devolver hasta 10, con paginación o “ver más”.
- No auto-seleccionar resultados de búsqueda ni sugerir que el primero es correcto.
- Permitir `No existe` y `Apartar` siempre visibles; nunca castigar al usuario por no encontrar.
- Registrar `fuente = manual`, consulta, resultados vistos y decisión final para medir recall del motor.

### Decisiones en bloque

Agregar selección de grupo sólo cuando haya evidencia homogénea: mismo `variant_id`, mismo SKU exacto o misma regla confirmable, misma versión de caso y mismo tipo de decisión. Antes de aplicar, mostrar una bandeja de revisión: “12 publicaciones → FB-ABC; 0 contradicciones; 2 sin foto”. Exigir una confirmación explícita para el lote y registrar cada caso con el mismo `Idempotency-Key` lógico por miembro. No permitir lote por título parecido o por score alto.

## 5. Qué rescatar y qué tirar

### Rescatar

- La comparación ML/Woo como idea central.
- `explicacion.atributos`, “Por qué” y colapso de iguales (`bandeja.js:579-623`).
- Fotos Woo con visor, `dialog`, `Esc` y precarga de vecinos (`bandeja.js:157-163`, `795-798`).
- Atajos `j/k`, `/`, `?`, `o`, `n`, `z`, indicador de guardado y feedback persistente.
- Idempotencia, expected version, conflicto 409 y deshacer; son la base de una estación segura.
- Proxy que descarta actor enviado por cliente y lo deriva de sesión (`routes/bandejaIdentidad.js:71-87`).
- Filtros por grupos y paginación por cursor; sirven para triage y lotes.

### Tirar o reemplazar

- La matriz ancha como vista primaria.
- Repetir cada candidato en tabla y tarjeta.
- El `foto: null` fijo para ML.
- Botonera vertical homogénea y decisión en dos teclas.
- El score/rank como señal visual dominante.
- El buscador como modo secundario escondido.
- `overflow-wrap:anywhere` como estrategia de layout para títulos; reservar líneas y permitir expansión.

## 6. Plan de implementación chico, TDD y escritorio primero

Cada tarea debe entregar una mejora visible y cubrir 1440×900, 1280×800, foco por teclado y axe. No modificar API sin contrato y fixture.

1. **Baseline de medición y fixtures.** Agregar fixture de caso con foto ML, 3 candidatos, contradicción, sin candidato y título largo. Capturar métricas y screenshots actuales. Tests de render y teclado.
2. **Shell de estación.** Reordenar `index.html`/`bandeja.css` a contexto + dos paneles + barra sticky. Test visual sin scroll de página en ambos tamaños.
3. **Contrato de fotos ML.** API/proxy: exponer `foto_ml`/galería desde `plataforma/src/api/identidad-interna.ts` y `routes/bandejaIdentidad.js`; fallback explícito. Tests de contrato y error de imagen.
4. **Comparador de dos paneles.** Reutilizar datos de `renderMatriz`, eliminar duplicación de foto/título/SKU y mover el detalle a componente de evidencia. Tests de igualdad, falta, diferencia y equivalente.
5. **Diferencias priorizadas.** Extraer `diferenciasVisibles()` a `logica.js`; ícono + texto + color + patrón. Tests de orden y de “sólo diferencias”.
6. **Decisión de una tecla.** Cambiar `accionDeTecla` y handlers para que 1/2/3 envíen directamente; preservar `expected_version`, idempotencia y `z`. Tests de doble pulsación, offline, 409 y foco.
7. **Búsqueda manual rápida.** Mejorar `GET /variantes?q=` para resultados con imagen/atributos/diferencias y cursor si hace falta; UI con `aria-activedescendant`, Enter y Esc. Test de “motor sin candidatos”.
8. **Triage y lotes seguros.** API de preview de lote, validación de homogeneidad, aplicación individual transaccional/idempotente y auditoría. No habilitar hasta medir tasa de error.
9. **Accesibilidad y rendimiento.** axe, contraste, foco, zoom 200%, navegación sólo teclado, imágenes lazy fuera de la primera vista; medir carga inicial y feedback de guardado.
10. **Piloto observado.** 50 casos reales con José: medir tiempo, errores, dudas y fatiga; ajustar copy y tamaños antes de habilitar los 5.300.

### Cambios de API necesarios

- **Sí:** `foto_ml`/galería y metadatos de fuente/fecha.
- **Sí, probablemente:** explicación normalizada por diferencia, no sólo por candidato; estado de calibración y `fuente` de candidato.
- **Sí para búsqueda rica:** endpoint de variantes debe devolver foto, atributos y campos comparables; cursor si el catálogo vuelve lento.
- **Sí para lotes:** preview, validación de grupo, idempotencia por miembro y auditoría.
- **No:** atajos, layout, orden de bloques, visor, chips, barra sticky; son frontend.
- **No romper:** `expected_version`, 409, `Idempotency-Key`, `/apartar`, deshacer y actor derivado de sesión.

## 7. Métricas de éxito

Medir baseline una semana y comparar por tipo de caso, no sólo promedio:

- **Casos/minuto** y mediana de segundos hasta decisión.
- **% de casos decididos sin scroll** y **% resueltos con una tecla**.
- **% que abre búsqueda manual**, recall del candidato correcto en top-3 y tasa de “sin candidato”.
- **% de decisiones deshechas** dentro de 10 s y **% corregidas después**; separar error de UI de error de motor.
- **% de conflictos 409**, reintentos y errores de guardado.
- **Top-1 aceptado vs corregido**, por versión de motor y tipo de diferencia.
- **Fotos vistas/abiertas**, casos sin foto y tiempo adicional cuando falta evidencia.
- **Throughput sostenible:** casos resueltos en bloques de 15 minutos y abandono antes/después.

Objetivo inicial razonable para validar, no prometer: decisión mediana ≤10 s en confirmables, ≤15 s en candidatos visibles, ≥70% de decisiones frecuentes con una tecla, sin aumento de correcciones posteriores y cero pérdida de decisiones por errores de red.

## Resumen para José

La idea de comparar ML contra Woo sirve; la pantalla actual la vuelve lenta y agotadora.  
El problema más grave: no muestra la foto de ML y pone el botón después de una tabla y tarjetas repetidas.  
Propongo una estación fija, sin scroll de página: dos fotos grandes, diferencias primero y barra de decisión abajo.  
`1/2/3` debe decidir y avanzar en una sola acción; `x`, `?`, `o`, `n` quedan siempre visibles.  
Si el motor falla, la búsqueda manual tiene que ser tan rápida como aceptar una sugerencia.  
El score no se muestra como confianza: se muestran coincidencias, diferencias, faltantes y fuentes.  
Los lotes sólo se habilitan para grupos realmente homogéneos y con previsualización.  
Primero medimos baseline, hacemos el escritorio, probamos con 50 casos tuyos y recién después escalamos.
