# Preparación: que no se pueda despachar de menos

Fecha: 2026-08-12
Rama: `worktree-escaneo-obligatorio` (base `0c66e54`, master local — NO `origin/master`)

## Por qué

Textual del usuario: *"necesito que se escaneen los códigos de cada artículo que se prepara y si
es necesario foto de cada artículo, acaba de salir otro problema, se envió una unidad en vez
de 5"*. Antes había dicho: *"el sector de preparación no la usa por lentitud... y ya han habido
problemas de envíos sin forma de verificar que el envío haya salido bien de acá"*.

### Lo que muestran los datos

**El pedido de 1-en-vez-de-5 no pasó por la herramienta.** En toda la base hay 6 ítems con
cantidad esperada > 1, y ninguno de 5 unidades. No falló el sistema: faltó el sistema.

**Pero el agujero existe igual.** El cierre (`POST /:id/completar`, `routes/preparacion.js:1095`)
sí exige que todos los ítems estén `verificado` y con sus fotos. El problema es cómo se llega a
`verificado`:

| Camino | Qué hace |
|---|---|
| Escanear (`:877-882`) | suma de a 1 hasta `cantidad_esperada` |
| **Confirmar manual (`:905`)** | pone `cantidad_escaneada = cantidad_esperada` de un saque, **sin escanear nada** |

**El 48% de los ítems se confirma a mano** (38 de 80). El atajo es la norma, no la excepción. Un
ítem de 5 unidades confirmado a mano queda "verificado" con una sola unidad en la caja.

### La tensión que gobierna este trabajo

Obligar a escanear solo funciona **si escanear es más rápido que el atajo**. Si escanear cuesta
tres toques y confirmar cuesta uno, van a seguir confirmando — o van a dejar de usar la
herramienta, que es exactamente cómo llegamos acá. **El escaneo obligatorio y la velocidad son
el mismo trabajo, no dos.**

Esto vale doble porque el usuario eligió más fotos de las recomendadas (ver abajo): más fotos
por pedido es más tiempo, y el tiempo es lo que los expulsó.

## Decisiones del usuario (segunda ronda, tras plantear los límites del enfoque)

Se le planteó que **escanear 5 veces el mismo código de barras no prueba que haya 5 unidades en
la caja** (se puede escanear la misma unidad cinco veces). Es un control que fuerza un acto
deliberado por unidad, no una prueba física. Con eso a la vista, decidió:

- **Escaneo N veces + foto del artículo mostrando las N unidades a la vista.** Ahí sí hay prueba
  de cantidad. **El sistema NO puede verificar que la foto muestre realmente N unidades** — puede
  exigir la foto y pedirlo en pantalla, pero quien lo controla es el humano que la mira después.
  Eso queda escrito para que nadie lo confunda con una validación automática.
- **Dos fotos de paquete:** una del contenido a la vista y otra del paquete cerrado con la
  etiqueta puesta.
- **Las 24 preparaciones viejas se cierran todas**, incluidas las 8 con trabajo real. Cambió de
  idea respecto de la ronda anterior: un escaneo suelto no alcanza como evidencia.
- **Motivos para saltear el escaneo:** código ilegible / producto sin etiqueta / otro (con texto
  libre).
- **Las cerradas sin evidencia SE PUEDEN REABRIR** si entra un reclamo, y queda registrado que se
  reabrieron. No es un cierre definitivo.
- **Viven en una sección aparte**, no mezcladas con las verificadas de verdad — que es el punto
  de todo el estado nuevo.
- **La foto por artículo es el PISO para todos los artículos.** Las reglas por perfil de producto
  que ya existen (`requisitosParaItem`) no se reemplazan: pueden seguir exigiendo **más** fotos
  encima de ese piso.

## Decisiones del usuario (primera ronda)

- **Escaneo obligatorio por unidad.** Un ítem de 5 exige 5 escaneos.
- **La confirmación manual queda, pero pide motivo.** Cualquiera puede usarla; el motivo, el
  usuario y la hora quedan registrados. Lista corta de motivos (código ilegible, producto sin
  etiqueta, otro).
- **Foto del paquete armado Y foto de cada artículo**, las dos obligatorias.

Sobre las fotos se le recomendó otra cosa y eligió esto, con el trade-off explicitado: *el
escaneo previene el error, la foto resuelve el reclamo*. Una foto por artículo no evita mandar
de menos (podés fotografiar 5 y empacar 1); la que gana un reclamo es la de la caja abierta con
todo adentro antes de sellar. El usuario prefirió cubrirse de las dos formas. **Queda escrito
que el costo es tiempo por pedido, y que ese costo es el que ya expulsó al sector una vez.**

## Alcance

### 1. Escaneo por unidad, rápido

- `confirmarManual` deja de ser gratis: exige `motivo` y lo registra (quién, cuándo, por qué).
  Sin motivo, 400.
- El ítem solo llega a `verificado` por escaneos completos, o por confirmación manual **con
  motivo**.
- **La velocidad es requisito, no un extra:** la cámara tiene que quedar lista para el siguiente
  escaneo sin toques intermedios. Escanear 5 unidades = apuntar 5 veces, nada más. Medir cuántos
  toques cuesta hoy y cuántos después.

### 2. Fotos obligatorias

- **Del paquete armado**, con el contenido a la vista antes de cerrar.
- **De cada artículo.** Ojo: `requisitosParaItem`/`fotosFaltantes` ya existen y el cierre ya las
  valida — extender esas reglas, no inventar un mecanismo paralelo.
- El flujo de foto tiene que ser rápido: la cola asíncrona de `0c66e54` ya sacó la espera del
  procesamiento; falta que sacar la foto cueste el mínimo de toques.

### 3. Las 24 preparaciones viejas colgadas

24 sin completar, del 20/07 al 10/08. 23 sin ninguna foto, 7 con algún escaneo, 1 con foto.
`preparado_por` vacío en todas.

- Estado propio **"cerrada sin evidencia"** — salen de la lista de trabajo pero quedan
  distinguibles de las 42 verificadas de verdad. **No se marcan como completadas**: si entra un
  reclamo por una de esas, el sistema tiene que decir la verdad (se cerró sin poder verificar),
  no afirmar una verificación que nunca ocurrió.
- Corte: todo lo anterior a hoy.
- **Las 8 que tienen trabajo real (7 con escaneo + 1 con foto) quedan vivas** para que el usuario
  las revise.

## Fuera de alcance (siguiente)

**Seguimientos.** Medido hoy: `GET /api/preparacion/seguimientos` tarda **6,3 s** y hay **70
pedidos esperando tracking**. Es otra de las razones por las que no la usan y por las que salen
envíos sin seguimiento cargado. No entra acá para no mezclar, pero es el próximo.

## Regla de despliegue

`npm test` verde + revisor OK + `probador-e2e` + auditor 🟢. Toca `public/`. Merge y
`pm2 restart` los autoriza el usuario; el push al repo lo hace él.
