# Fotos de Preparación: que no fallen y que no bloqueen el servidor

Fecha: 2026-08-12
Rama: `worktree-fotos-preparacion` (base `3ba2140`, master local — NO `origin/master`)

## El pedido

Textual del usuario: *"Está dando errores al cargar las fotos, necesito que sea funcional al
100% y sea rápida de usar, que las consultas sean inmediatas, si tarda algo dejarlo en cola para
que el servidor lo haga cuando se libere."* Lo marcó como **urgente**. Falla desde antes de los
cambios de estos días.

## Diagnóstico

**1. Estamos ciegos, y a propósito.** `routes/preparacion.js:970`:

```js
} catch {
  return res.status(400).json({ ok: false, error: 'no se pudo procesar la imagen' });
}
```

El `catch` **descarta el error entero**. El usuario confirmó que ese es exactamente el mensaje
que ve. No hay un solo registro de qué falla: ni el tipo de error, ni el formato, ni el tamaño.
Es el mismo patrón que nos tuvo horas adivinando con ML esta mañana, y arreglarlo fue lo que
destrabó el diagnóstico.

**2. El HEIC de iPhone se convierte en JavaScript puro, y eso congela el servidor entero.**
Verificado en el VPS: `sharp` reporta `heif:in`, pero su `fileSuffix` es solo `.avif` — esta
compilación de libvips 8.18.3 trae AVIF, **no HEIC** (HEVC tiene patentes). Así que las fotos de
iPhone caen en `heic-convert` (línea 967), que es libheif compilado a JS.

Node tiene **un solo hilo**. Una conversión en JS puro de una foto de 12 MP lo bloquea por
segundos: mientras dura, la app no responde a nadie más. En un VPS de **2 CPUs**, con varias
fotos seguidas, es un cuadro de app trabada y subidas que fallan.

Contraste medido en este mismo VPS: `sharp` procesa una imagen de 4032×3024 en **146 ms**, y con
resize a 1600px en **86 ms**. `sharp` es nativo y no bloquea el hilo. El problema no es
procesar imágenes: es *cómo* se procesa el HEIC.

**3. No se achican.** El pipeline hace `sharp(entrada).rotate().jpeg()` sin `resize`. Hay fotos
guardadas de **3,4 MB**. Sobre el 4G del depósito eso es lento para subir y lento para mostrar.
Estado actual: 401 fotos, 72,9 MB, promedio 0,18 MB (la mayoría vienen de la cámara de la
herramienta, que ya sale chica; las pesadas son las que llegan del carrete del teléfono).

**4. Todo ocurre dentro del request.** Multer a memoria (hasta 15 MB) → conversión → sharp →
disco → base. El usuario espera todo eso parado frente al teléfono.

## Decisiones del usuario

- **Saca fotos con iPhone, con Android y con la cámara de la herramienta.** Los tres caminos
  tienen que andar; el de iPhone es el que falla.
- **El error que ve es "No se pudo procesar la imagen"** — o sea, el `catch` que se traga la
  causa.
- **Usa las fotos para las dos cosas**: constancia de lo empacado, y a veces detalle fino.
  Consecuencia: **no se puede tirar el original**. Se guardan las dos versiones.
- **La foto tiene que aparecer al toque y acomodarse sola**, sin cartel de "procesando" y sin
  bloquear el paso al siguiente producto.

## Alcance

### 1. Dejar de estar ciegos (primero, y desplegable solo)

Registrar el error real con contexto: tipo de error, mimetype, nombre de archivo, tamaño, y si se
detectó como HEIC. **Sin el nombre del archivo completo si puede traer datos del cliente** —
criterio del repo: se loguea qué pasó, no el contenido.

Esto solo ya convierte "no se pudo procesar la imagen" en un diagnóstico. Es un cambio chico y
va primero.

### 2. Que la subida devuelva al instante

El request guarda el archivo tal como llegó y responde. Nada de conversión sincrónica.

### 3. Cola de procesamiento en el servidor

Una cola que toma las fotos pendientes y hace la conversión, la rotación y el achicado **cuando
el servidor está libre**. Requisitos, todos con el criterio que ya usa el repo:
- **Candado anti-reentrada**, como `_wcToMlEnCurso` y `_refrescarCatalogoEnCurso`.
- **Reintentos acotados** y un estado de fallo visible: una foto que no se puede convertir no
  puede quedar reintentándose para siempre ni desaparecer en silencio.
- **No bloquear el hilo**: si el HEIC sigue necesitando JS puro, la conversión tiene que correr
  fuera del hilo principal (worker) o de a una con pausas. **Medir el bloqueo, no suponerlo.**

### 4. Dos versiones de cada foto

Original (para el detalle fino) y una versión liviana para mostrar. La pantalla usa la liviana;
el original queda disponible.

### 5. Que la foto aparezca al toque

El navegador ya tiene el archivo: puede mostrarlo local mientras el servidor la acomoda. Ojo con
el HEIC: **Safari en iOS lo muestra, el resto de los navegadores no.** Resolver ese caso sin
cartel de "procesando", que es lo que el usuario descartó explícitamente.

## Preguntas abiertas — resolver antes de escribir

1. **¿Por qué falla `heic-convert`?** Todavía no lo sabemos: puede ser una variante de HEIC que
   la librería no soporta, memoria, o 10-bit. El paso 1 lo contesta. **No diseñar el arreglo
   asumiendo la causa.**
2. **¿Conviene evitar el HEIC de raíz?** La cámara de la herramienta ya produce JPEG. Si el
   problema es solo el carrete del iPhone, quizá alcance con orientar al usuario a usar la cámara
   de la herramienta — pero eso es cambiar el hábito de la persona, no arreglar la herramienta.
   Decidir con el dato del paso 1.

## Regla de despliegue

`npm test` verde + revisor OK + `probador-e2e` + auditor 🟢. Toca `public/`. Merge y
`pm2 restart` los autoriza el usuario; el push al repo lo hace él.
