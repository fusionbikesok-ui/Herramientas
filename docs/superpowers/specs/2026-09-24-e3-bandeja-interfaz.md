# E3: interfaz de la bandeja de identidad

**Fecha:** 2026-09-24. **Complementa:** `2026-09-24-e3-identidad-design.md` §10 y la Tarea 6 del plan `plans/2026-09-24-e3-corte1-bandeja.md`.

**De dónde sale:**
- los pedidos de José: cualquier ancho, sin máximo ni mínimo; nombres nunca cortados; atributos visibles; operable con teclado;
- investigación propia;
- una segunda investigación con Codex (`/tmp/claude-0/codex-ui-bandeja.txt`).

**Estado:** es un borrador. Los puntos marcados **[José]** esperan su decisión.

## 1. Qué es la pantalla

Es una **cola de decisión, un caso por vez**:
- José ve una publicación de ML y sus candidatos del catálogo, decide, y pasa solo al siguiente caso.
- No es una tabla de 5.300 filas ni un panel de control.

Tomamos de otras herramientas lo siguiente:

| Referencia | Qué tomamos | Qué evitamos |
|---|---|---|
| OpenRefine, conciliación | Separa el texto observado de la entidad candidata. Muestra pocos candidatos (3), ordenados, con los datos que se usaron para proponerlos. | Tomar el primer candidato como verdad. |
| Dedupe y herramientas de record linkage | Comparación **campo por campo** con la evidencia de cada diferencia. | Un único puntaje sin contexto. |
| Gmail, Superhuman, Linear | Flujo lineal, avance automático, atajos memorizables, **deshacer en vez de confirmar**, el foco siempre en un lugar predecible. | Atajos que se disparan mientras se escribe. |
| Label Studio | Cola priorizada, estado visible y quién decidió y cuándo. | Cambiar decisiones anteriores sin avisar. |
| El matcher actual del legado (`public/matcher/KEYBOARD_SHORTCUTS.md`) | José ya usa `j`/`k`, `Enter` y `s`. Esas teclas se conservan. | — |

## 2. La comparación, que es lo central

Hoy el error más caro es un primer candidato equivocado con puntaje alto: pasa en el 30 % de los casos. Por eso la pantalla tiene que hacer que **la diferencia salte a la vista**. No alcanza con mostrar la coincidencia.

- **Matriz alineada por atributo, sin tarjetas sueltas:**
  - una fila por atributo;
  - una columna para la publicación de ML;
  - una columna por candidato.

  Así nadie tiene que memorizar la publicación mientras mira cada candidato.

  | | Publicación ML | Candidato 1 | Candidato 2 | Candidato 3 |
  |---|---|---|---|---|
  | Foto | … | … | … | … |
  | Título / nombre | completo | completo | completo | completo |
  | SKU | … | … | … | … |
  | Marca, modelo, rodado, talle, color, pack | … | ✓ / ≠ / — | … | … |
  | Precio y stock | … | … | … | … |

- **Qué filas aparecen:** todos los atributos que tenga **alguna** de las columnas, no sólo seis fijos.
  - El orden es siempre el mismo, para que el ojo aprenda dónde mirar.
  - Hay un conmutador «sólo diferencias» (tecla `d`).
- **Cómo se marca cada celda de un candidato:** con **símbolo y texto, no sólo con color**:
  - ✓ coincide;
  - ≠ difiere, con los dos valores resaltados;
  - — falta en uno de los dos;
  - ≈ equivalente normalizado (p. ej. «Negro mate» contra «Negro»), con la normalización aplicada visible.

  Esto lo exige WCAG 1.4.1.
- **Contradicciones fuertes:** pack distinto, rodado distinto o marca distinta van primero, con un aviso en la cabecera del candidato. Por ejemplo: «≠ pack: publicación ×1, candidato ×2».
- **Puntaje:** no se muestra como confianza hasta que esté calibrado (spec §9). El candidato muestra su orden («1.º sugerido») y las **señales** que coinciden.
- **Fotos:** son parte de la evidencia, porque el color y el modelo se reconocen mirando. Tienen tamaño fluido, y la tecla `f` o un clic las amplían en un visor accesible que se cierra con `Esc`.
- **«Buscar otra variante»** (`/`): los resultados entran como columnas nuevas de la **misma matriz**, no en otra vista.

## 3. Maquetación intrínseca: cualquier ancho, sin máximo ni mínimo

La regla es que **no hay breakpoints de viewport**:
- cada bloque se adapta al **espacio de su contenedor**;
- se usan Grid y Flex con `auto-fit`/`minmax(min(Xrem, 100%), 1fr)`;
- `clamp()` para la tipografía y los espacios;
- `container queries` cuando un bloque tiene que cambiar su forma interna.

No se usa `@media (min-width…)` para la maquetación.

- **Nombres que nunca se cortan:**
  - prohibido `text-overflow: ellipsis`, `line-clamp`, `white-space: nowrap` y las alturas fijas en títulos, SKU y atributos;
  - `overflow-wrap: anywhere` para los SKU e identificadores sin espacios;
  - `hyphens: auto` sólo en el texto natural (`lang="es"`);
  - `min-width: 0` en todos los hijos de grid y flex.

  La revisión con `grep` lo verifica sobre el CSS.
- **Ancho angosto** (320 px o zoom al 400 %):
  - la matriz se vuelve una lista de pares: publicación arriba y cada candidato abajo, con sus atributos en filas «etiqueta: ML / candidato»;
  - la página nunca tiene scroll horizontal (WCAG 1.4.10);
  - lo decide un `container query` sobre el contenedor del caso, no el ancho de la ventana.
- **Ancho grande** (3000 px o más):
  - «sin máximo» quiere decir que no hay un `max-width` que desperdicie espacio;
  - el espacio sobrante se usa para contenido: la cola a la izquierda, el caso en el centro y el historial y la evidencia a la derecha, con paneles que entran por `auto-fit` según quepan;
  - con más espacio también entran más candidatos de la búsqueda como columnas;
  - lo único que se limita es la medida de lectura de los **párrafos** de texto largo (~75ch), no los datos.
- **Espaciado de texto (WCAG 1.4.12):** con interlineado 1,5 y espaciado de letras y palabras aumentado, no se superpone nada ni se pierde nada.
- **Pruebas:** en vez de 3 anchos fijos, un barrido automático de anchos de 320 a 3840 px, de a 40 px, que falla si:
  - hay scroll horizontal;
  - algún texto queda recortado (`scrollWidth > clientWidth` en un elemento con `overflow: hidden`);
  - hay elementos superpuestos.

  Además: zoom al 400 % y el bookmarklet de espaciado de texto.

## 4. Teclado

Todo se puede hacer sin mouse, y con mouse todo sigue igual.

| Tecla | Acción |
|---|---|
| `j` / `↓` · `k` / `↑` | siguiente / anterior caso (como el matcher de hoy) |
| `1` `2` `3` (y `4`… si hay resultados de búsqueda) | seleccionar el candidato N |
| `Enter` | vincular al candidato seleccionado |
| `s` | omitir (como el matcher de hoy) |
| `n` | «no existe en el catálogo» |
| `/` | buscar otra variante |
| `d` | sólo diferencias |
| `f` | ampliar la foto |
| `z` | deshacer la última decisión |
| `?` | ayuda de atajos |
| `Esc` | cerrar la ayuda, la búsqueda o el visor |

- **WCAG 2.1.4:** los atajos de una sola tecla **se pueden apagar** desde la ayuda (`?`), y la preferencia se guarda en `localStorage`. Además:
  - nunca se disparan con el foco en un `input`, `textarea`, `select` o diálogo;
  - tampoco con modificadores (Ctrl, Alt, Meta), para no pisar los atajos del navegador ni los del lector de pantalla.
- **Candidatos:** son un **grupo de radios nativos** (`fieldset` + `legend`, con las flechas del navegador), no un widget ARIA inventado. Cada radio lleva `aria-keyshortcuts`.
- **El foco:**
  - después de decidir, va al encabezado del caso siguiente (`tabindex="-1"`) y nunca se pierde en `body`;
  - después de un 409, vuelve al caso en conflicto;
  - `scroll-padding` evita que una barra fija lo tape (WCAG 2.4.11).
- **Anuncios (WCAG 4.1.3):**
  - una región `role="status"` dice «Vinculado a FB-123. Caso 12 de 340. Deshacer: z»;
  - los errores y los conflictos van por `role="alert"`;
  - no se usa `role="application"`.
- **Tamaño de los objetivos:** al menos 44×44 px, como los tokens actuales, y siempre ≥24 px (WCAG 2.5.8).

## 5. Flujo, velocidad y seguridad

- **Precarga:** además del caso actual se cargan el siguiente y el anterior, incluidas las fotos. Se pagina por cursor; nunca se carga la bandeja entera.
- **Decidir no espera al servidor:**
  - la pantalla avanza en el acto al siguiente caso, que ya está precargado;
  - la decisión se guarda en segundo plano con su `Idempotency-Key`;
  - un indicador muestra «guardando / guardado»;
  - si falla o hay un 409, un aviso **persistente**, no un toast que se va, lleva de vuelta al caso con la elección conservada;
  - nunca se muestra «guardado» antes de la respuesta del servidor. **[José]** La alternativa es esperar la respuesta, unos 200 ms, antes de avanzar. Es más simple y sin sorpresas, pero más lenta en 5.300 casos.
- **Deshacer en vez de confirmar:**
  - elegir, omitir y «no existe» se aplican sin diálogo, y durante 10 s se pueden deshacer (`z` o el botón del aviso);
  - deshacer genera una **decisión compensatoria**, así que nada se borra (append-only);
  - revertir decisiones viejas o ajenas sigue siendo sólo del admin, con diálogo y motivo obligatorio.
  - **[José]** El plan hoy dice que sólo el admin revierte. Para que «deshacer» sirva, cualquier operador tendría que poder revertir **su propia** última decisión dentro de los 10 s y mientras nadie haya tocado el caso después. Es un cambio chico en `decidirCaso` (T3).
- **Conflicto 409:** se muestra «Este caso cambió mientras lo revisabas; tu elección se conserva». La matriz se muestra actualizada, con los cambios marcados, y hay un botón «aplicar mi decisión sobre la versión nueva». Nunca se sobrescribe automáticamente.
- **Estados de la pantalla:** cargando (esqueleto del mismo tamaño, sin saltos), vacío («no quedan casos en este filtro»), error con reintento y sin conexión.

## 6. Cola, filtros y contexto

- **Cabecera:** muestra el filtro activo con los contadores (conflictos, D5, SKU exacto, activas con stock, resto), en el orden de prioridad de la spec. Cada chip es un botón.
- **Historial del caso:** quién decidió, cuándo, qué, y la decisión anterior. Siempre visible si entra; si no, se despliega (`h`).
- **Motivo:** es opcional al decidir y obligatorio al revertir.

## 7. Qué cambia en el plan (Tarea 6)

- «390/768/1440» se reemplaza por el barrido de 320 a 3840 px, el zoom al 400 % y el espaciado de texto (§3).
- `disenador-ux` y `disenador-ui` reciben **este documento** como entrada, en lugar de diseñar desde cero.
- `probador-e2e` hace un recorrido **sólo con teclado**:
  - decidir 5 casos;
  - buscar otra variante;
  - omitir;
  - deshacer;
  - provocar un 409 con dos pestañas;
  - apagar los atajos.

  También verifica los anuncios con axe y con la estructura de la región `status`.
- **La API interna (T5) agrega:**
  - todos los atributos normalizados de cada lado, con la marca ✓/≠/—/≈ por atributo;
  - la URL de la foto;
  - el precio y el stock del candidato;
  - la paginación por cursor con el «siguiente» precargable.
