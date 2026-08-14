# Seguimientos: que muestre trabajo real y que cargar el tracking sea más cómodo que Woo

Fecha: 2026-08-13
Rama: `worktree-seguimientos` (base `2164283`, master local — NO `origin/master`)

## El problema, medido

La pantalla de Seguimientos muestra **70 pedidos**, y el usuario **no la usa**. Los números
explican por qué:

| | |
|---|---|
| Pedidos que muestra | **70** |
| De esos, esperando que se cargue el tracking | **0** |
| "Colgados" (según la pantalla) | **70** |
| Sin ninguna preparación local | **69 de 70** |
| Preparaciones con `woo_paso2_pendiente=1` (la marca propia de "quedé a medias") | **0** |
| Eventos `tracking_colgado` registrados | **0** |

**La pantalla muestra 70 problemas que no existen.**

### Por qué

`GET /seguimientos` (`routes/preparacion.js:629`) arma la lista con dos consultas:
1. Pedidos de Woo en `lpaandreani` **con preparación y etiqueta lista** → hoy da **0**.
2. Pedidos en `completed` que tengan la meta `_andreani_tracking` y no hayan llegado a
   `enviadoandreani` → hoy da **70**, y los marca `colgado: true`.

El paso 2 **infiere** el fallo mirando datos de Woo, en vez de usar la marca propia de la
herramienta. Y la inferencia es falsa: **el usuario carga el tracking a mano en WooCommerce**
(confirmado por él), así que esa meta aparece en pedidos que nunca pasaron por la herramienta.

Verificado en Woo: los 70 tienen `_andreani_tracking` con números reales de Andreani
(`360003042094910`, `360002981787550`), y van del **30 de enero al 20 de julio**. Los pedidos
actuales sí llegan a `enviadoandreani` — comprobado por dos caminos: filtrando por ese estado
devuelve 100 pedidos (67842, 67824, 67817…) y ninguno de los 70 está entre ellos.

**La herramienta ya tiene la marca correcta y no la usa:** `preparaciones.woo_paso2_pendiente`,
que ella misma pone en 1 al empezar y en 0 al terminar. Está en **0 para las 70 preparaciones**.

## Decisiones del usuario

- **Los 70 viejos: dejarlos como están.** No se escribe nada en WooCommerce. Lo que importa es
  que la pantalla deje de mostrarlos.
- **El estado `enviadoandreani` sí importa** en su operación.
- **La pantalla debería usarse y no se usa.** Tiene que mostrar tres cosas: los que esperan
  tracking, los que quedaron a medias de verdad, y los despachados sin verificar.
- **La herramienta pasa a ser el único lugar donde se carga el tracking**; cargarlo a mano en
  Woo se deja de usar. Hoy se hace a mano **por costumbre**, no porque Woo sea mejor.
- **Los números salen del portal de Andreani, uno por uno.**
- **Dos formas de cargar, según se prefiera:** elegir el pedido de la lista y pegar el número, o
  **escanear el código de barras de la etiqueta** con la cámara.
- **Esperan tracking: los que ya se prepararon y verificaron.** Cierra el circuito
  preparar → verificar → despachar.
- **Los despachados sin preparar en la herramienta van en una sección aparte**, para poder
  cargarles el tracking igual sin volver a Woo.

## Alcance

### 1. Que la pantalla deje de mentir

Reemplazar la inferencia del paso 2 por la marca propia (`woo_paso2_pendiente`). Un pedido está
"a medias" **solo si la herramienta lo dejó así**, no si tiene una meta que escribió otro.

Con eso los 70 desaparecen sin tocar WooCommerce. **Verificar que efectivamente desaparezcan** —
es el criterio de aceptación más importante de este trabajo.

### 2. Las tres secciones

- **Esperando tracking:** preparaciones **verificadas** (`completada`) sin tracking cargado.
- **A medias de verdad:** `woo_paso2_pendiente=1`. Hoy son 0, y está bien que sea así.
- **Despachados sin verificar:** el estado `despachada_sin_verificar` que ya existe.
- **Sin preparación en la herramienta:** sección aparte, para cargar el tracking igual.

### 3. Cargar el tracking, de dos formas

- Elegir el pedido y pegar el número.
- **Escanear el código de barras de la etiqueta de Andreani** con la cámara. Ya existe
  `public/lib/scanner.js` y se acaba de usar en modo continuo en Preparación — reusarlo, no
  inventar otro.

**El listón:** tiene que ser **más cómodo que cargarlo a mano en Woo**. Si no, van a seguir
haciéndolo donde siempre — el hábito es la única razón por la que hoy lo hacen ahí. Medir los
toques de las dos formas y compararlos contra el flujo actual de Woo.

## Flujo cerrado (diseño)

### La partición: nada del universo se oculta

`GET /seguimientos` parte de los pedidos de Woo en `lpaandreani` y los reparte en **dos
secciones que cubren todo el universo**, sin dejar ninguno afuera:

- **Esperando tracking:** `preparaciones.estado = 'completada'` (preparado y verificado).
- **Sin preparación verificada:** **todo el resto** — sin fila en `preparaciones`, en
  `en_preparacion`, `despachada_sin_verificar` o `cerrada_sin_evidencia`. Con un badge que
  diga cuál de esos casos es.

El diseño de flujo proponía excluir de la segunda a los que están `en_preparacion` ("ya los
está trabajando alguien"). **No se hace**, por un motivo concreto: marcar la casilla
"etiqueta lista" ya crea una preparación en `en_preparacion` sin ningún trabajo real
(`routes/preparacion.js:615`). Excluirlos escondería justo los pedidos que están por
despacharse, y un pedido que no aparece manda al operario de vuelta a Woo — el hábito que
todo este trabajo intenta cambiar. Ocultar es el peor fallo posible acá; un badge de más no
le hace daño a nadie.

### Las dos formas de cargar: el pedido primero, siempre

El número se carga **siempre sobre una tarjeta ya elegida**. El botón de cámara vive dentro
de cada tarjeta, nunca suelto arriba de la grilla: así elegir el pedido antes de escanear
queda forzado por la interfaz, no por una instrucción que se puede saltear.

El ancla para elegir la tarjeta es el **nombre del destinatario y la localidad**, visibles
en la tarjeta sin scroll. Es el dato que toda etiqueta de envío imprime, independientemente
de si Andreani respeta la columna de referencia del Excel.

### Defensas contra el error caro (tracking al pedido equivocado)

El paso 1 pasa el pedido a `completed` y eso dispara el mail al cliente, que no se puede
recallar. Por eso las defensas están **antes** de escribir:

1. Nombre y localidad siempre visibles en la tarjeta.
2. El botón dice **"Guardar para Juan Pérez"**, no "Guardar": el último gesto repite el dato
   a verificar, en el lugar exacto donde se hace clic.
3. **Número repetido en la sesión** → aviso con confirmación extra ("ya se cargó en el
   pedido #67824"). Cubre el error más probable: pegar el mismo número en la tarjeta de al
   lado por error de foco. Se resuelve entero en el frontend.
4. Validación de formato liviana (numérico, largo esperado) antes de habilitar Guardar.

Después de guardar: toast con **"Guardado para Juan Pérez, Córdoba"** y **Deshacer**, que
llama a `POST /seguimientos/:wcOrderId/corregir-tracking` (ya existe). El texto del Deshacer
tiene que decir el límite real: **corrige el número en el pedido, pero el cliente ya recibió
el mail con el anterior.** Ocultarlo sería peor que no tener Deshacer.

### Los tres errores, con mensajes distintos

- **Falló antes de Woo:** "No se guardó. Volvé a intentar." Reintentar es gratis.
- **Paso 1 sí, paso 2 no** (502 + `colgado:true`): "El tracking se guardó y el cliente ya
  recibió el mail. Falta un paso interno, se reintenta solo." Botón pasa a **Reintentar**,
  sin pedir retipear el número.
- **409:** "Este pedido ya no está disponible (otro lo cargó, o cambió de estado)." La
  tarjeta se saca de la lista, no se deja invitando a reintentar contra un estado muerto.

### Estado vacío = estado normal

Si el circuito funciona, la mayoría de los días no hay nada esperando. Una pantalla que
parece rota cuando está vacía deja de abrirse. Va un mensaje afirmativo con un dato de
refuerzo: `✓ Al día. Ya cargaste 3 hoy.` Las secciones en 0 **no se dibujan**.

### Contrato de `GET /seguimientos`

```json
{ "ok": true, "data": {
  "esperando":       [{ "wc_order_id", "envio", "preparacion_id", "estado_preparacion" }],
  "sin_preparacion": [{ "wc_order_id", "envio", "preparacion_id", "estado_preparacion" }],
  "a_medias":        [{ "wc_order_id", "envio", "preparacion_id", "tracking" }],
  "despachados_sin_verificar": 3,
  "cargados_hoy": 5
}}
```

`a_medias` sale de `woo_paso2_pendiente=1` — dato local, no depende de consultar Woo.
`cargados_hoy` exige registrar un evento `tracking_cargado` en el POST exitoso, que hoy no
se registra. Documentar el contrato nuevo en `docs/api-contrato.md`.

## La tensión que hay que declarar

**Esta pantalla depende de que la de Preparación se use primero.** Si solo aparecen los pedidos
verificados y el sector no prepara en la herramienta, la pantalla queda vacía — y si está vacía,
vuelven a Woo, que es el hábito que se quiere cambiar. Están encadenadas.

La sección aparte para los no verificados mitiga eso: siempre hay dónde cargar el tracking sin
salir de la herramienta. Pero conviene tenerlo presente al medir si el cambio funcionó.

## Fuera de alcance

**No se escribe nada en WooCommerce sobre los 70 viejos.** Decisión explícita del usuario.

## Regla de despliegue

`npm test` verde + revisor OK + `probador-e2e` + auditor 🟢. Toca `public/`. Merge y
`pm2 restart` los autoriza el usuario; el push al repo lo hace él.
