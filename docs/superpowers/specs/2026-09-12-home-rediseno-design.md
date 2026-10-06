# Spec: rediseño del home de herramientas

**Fecha:** 2026-09-12
**Estado:** diseño, en implementación
**Alcance:** la pantalla que ve todo el equipo al entrar.

## Qué dice la investigación

No se copió un sistema: se juntaron cinco fuentes y se contrastaron contra la medición de esta
casa. NN/g es explícito en que *"no hay una solución única que puedas copiar directamente"*.

1. **Tareas, no sistemas.** NN/g, sobre 77 intranets: *"las estructuras basadas en tareas
   resistieron mejor que las organizadas por departamento"* y facilitan el aprendizaje. La
   mediana de categorías de primer nivel es **7**, sin ninguna relación con el tamaño de la
   organización.
2. **Qué tipo de tablero es éste.** Pencil & Paper distingue cuatro tipos; el que corresponde acá
   es el *"funcional e integrado: orientado a guiar, mostrando lo que necesita atención"*,
   combinado con el *"home de producto, que funciona como un índice contextual"*. No es un tablero
   de métricas.
3. **Dónde mira el ojo.** Patrón F/Z: lo más importante arriba a la izquierda. Y un dato que
   importa para el ancho completo: *"cuanto más abajo llega el usuario, menos escanea el ancho
   total"*.
4. **Ancho.** El texto corrido necesita 45–75 caracteres por línea (~660–720px); las grillas
   densas sí aprovechan el ancho completo. La recomendación general es full-width para lo visual
   con un contenedor interno acotado para lo que se lee.
5. **Rol y divulgación progresiva.** Mostrar lo relevante al rol; esconder no es el objetivo, sino
   presentar lo correcto en el momento correcto.

## Qué dice la medición de esta casa

| Persona | Rol real, medido | Herramientas con permiso |
|---|---|---|
| Joaco | **187 preparaciones** y 18 sesiones de conteo | 7 |
| Jose | 18 sesiones de conteo; admin | todas |
| Miguel | — | **1** (consulta de precios) |
| Santi | — | 11 |
| Fabri, Matías | admin | todas |

Miguel entra y hoy ve un panel pensado para un administrador. Joaco, que es quien más trabajo
físico hace, tiene que buscar sus dos herramientas entre las demás.

Los grupos actuales —**Ingreso, Control, Sincronización**— describen *partes del sistema*, no
tareas. "Control" no es nada que alguien vaya a hacer.

## Decisiones

### Ancho completo, con el texto acotado

Pedido explícito del usuario. Se resuelve como indica la investigación: la página es full-bleed y
la grilla usa todo el ancho —más tarjetas por fila, menos scroll—, pero **la descripción de cada
tarjeta y los textos corridos quedan acotados** a un ancho legible. En pantallas anchas eso
significa más columnas, no tarjetas más largas.

Como *"cuanto más abajo, menos se escanea el ancho total"*, lo que requiere atención va **arriba
y a la izquierda**, y los grupos de herramientas debajo.

### Seis grupos, por tarea

Bajo la mediana de 7 de NN/g. Cada nombre es algo que alguien hace:

1. **Vender y despachar** — Gestión de pedidos · Preparación · Etiquetas
2. **Stock y depósito** — Contador de inventario · Recepción · Ingreso de stock · Pedidos de compra
3. **Precios y catálogo** — Consulta de precios · Precios ML · Códigos universales · Identidad de productos
4. **MercadoLibre** — Sincronización · SKU Matcher · Cobertura · Config ML · **Auditoría de publicaciones**
5. **Posventa** — Taller · Garantías · Excepciones físicas
6. **Administración** — Usuarios y permisos

### Las tarjetas se declaran como datos, no como HTML

Hoy cada tarjeta son ~10 líneas de HTML escritas a mano, y el archivo tiene 1.323. Agregar una
herramienta significa copiar y pegar un bloque, que es exactamente por qué **auditoría de
publicaciones quedó sin enlace durante meses**: nadie se acordó de pegar la tarjeta.

Pasan a ser una lista declarativa y la grilla se arma sola. Agregar una herramienta es una línea.

### Honestidad sobre lo que no está terminado

Taller, garantías y excepciones **funcionan a medias**: se puede avanzar un caso existente, pero
**ninguna tiene forma de crear el primero**. Por eso tienen 0 filas — el enlace faltante no era
la única causa.

Se muestran, porque esconderlas es como llegamos acá, pero **marcadas y sólo para admin**. Un
operario no puede caer en una pantalla vacía sin salida. Cuando tengan alta, se les saca la marca.

**Auditoría de publicaciones** sí entra completa: tiene 2.730 filas de datos reales y 3 rutas
montadas. Es la puerta que más rinde abrir.

### Orden por uso real

Dentro de cada grupo, primero lo que más se usa, medido contra la base: conteo (38 sesiones),
preparación (294), gestión de pedidos (2.124). No por orden alfabético ni por antigüedad.

## Fuera de alcance

- Darle alta a taller, garantías y excepciones. Es una entrega propia por herramienta.
- Tocar el panel "Requiere tu atención", que ya funciona y se conserva tal cual.
- Personalización por usuario (fijar favoritos). No hay evidencia de que haga falta con 6 personas.

## Criterio de aceptación

1. La página usa el ancho completo; ningún texto corrido supera ~72 caracteres por línea.
2. Miguel (1 permiso) ve una sola herramienta y ningún grupo vacío.
3. Joaco ve sus 7, con preparación y conteo primero.
4. Auditoría de publicaciones es alcanzable desde el home.
5. Taller, garantías y excepciones aparecen sólo para admin y con su estado real a la vista.
6. Agregar una herramienta nueva es una línea en la lista declarativa.
7. Sin desborde horizontal ni controles bajo 44px, de 390px a 2560px.
