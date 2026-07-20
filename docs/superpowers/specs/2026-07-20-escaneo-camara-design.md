# Escaneo de códigos por cámara — Preparación de pedidos y Conteo de stock

## Contexto

Dos herramientas identifican productos por código (EAN o SKU interno):

- **Preparación de pedidos** (`public/preparacion/index.html`) ya tiene un botón "📷 Cámara" que usa la API nativa `BarcodeDetector` (`abrirCamara()`/`cerrarCamara()`, líneas ~435-457). Funciona en Android/Chrome pero **no en iPhone/Safari** (`BarcodeDetector` no existe ahí; hoy muestra un alert de "no soportado").
- **Conteo de stock** (`public/inventario/index.html`) no tiene cámara: el input `#scan` (`inputmode="none"`) está pensado para un lector físico tipo pistola que actúa como teclado.

El sitio ya sirve por HTTPS (`https://herramientas.fusionbikes.com.ar/herramientas/...`), así que el permiso de cámara del navegador no es un bloqueante.

El equipo usa tanto Android como iPhone en depósito, así que la solución debe funcionar en ambos.

## Objetivo

Agregar lectura de códigos (EAN/SKU, QR) por cámara del celular en ambas herramientas, funcionando en Android y iPhone, manteniendo la UX que ya tiene cada pantalla (no romper el flujo existente de lector físico / tipeo manual).

## Fuera de alcance

- Cualquier otra herramienta que no sea preparación de pedidos y conteo de stock.
- Cambios al backend (`routes/preparacion.js`, endpoints de `/api/woo/catalogo`, etc.) — el escaneo por cámara solo alimenta las mismas funciones de JS que ya procesan un código escaneado o tipeado.
- Soporte de navegadores sin `getUserMedia` (versiones muy viejas): se degradan al mensaje de error existente, igual que hoy.

## Arquitectura

Módulo compartido nuevo, sin build step (se sirve tal cual, como el resto de `public/`):

- `public/lib/scanner.js` — wrapper único de escaneo.
- `public/vendor/zxing.min.js` — build UMD de `@zxing/library`, vendorizada en el repo (no CDN), para navegadores sin `BarcodeDetector`.

### API de `Scanner`

```js
Scanner.open({
  video,                       // elemento <video> ya en el DOM
  mode: 'single' | 'continuous',
  onCode: function(codigo) {}, // se llama con el string decodificado
  onError: function(msg) {}    // permiso denegado, sin cámara, etc.
})
Scanner.close()                // corta el stream de cámara y el loop de detección
```

Internamente:

1. Si `'BarcodeDetector' in window`, usa la API nativa (Android/Chrome) — más rápida y liviana en batería.
2. Si no, usa `zxing.min.js` vendorizada, decodificando frames del mismo `<video>` vía `getUserMedia`.

Ambos caminos alimentan el mismo `onCode`. Ni preparación ni inventario necesitan saber cuál se usó.

### Modo `single`

Detecta un código, llama `onCode` una vez, y el caller es responsable de llamar `Scanner.close()` (igual que hoy hace `cerrarCamara()` en preparación después de `escanear(v)`).

### Modo `continuous`

No se cierra solo. Reglas de "re-armado" para evitar contar de más:

- Cada código detectado tiene un estado `visto` / `no visto`.
- `onCode` se dispara en la transición de "no visto" → "visto" para ese código específico.
- Mientras la cámara sigue viendo el mismo código en frames consecutivos, no se vuelve a disparar.
- Cuando la detección deja de ver ese código (se retiró el producto de cuadro, o cambió a otro código), el código vuelve a `no visto` y puede volver a dispararse la próxima vez que aparezca.

Esto permite sostener un código quieto sin duplicar, y contar dos unidades distintas de la misma SKU escaneadas una tras otra.

## Integración

### Preparación de pedidos (`public/preparacion/index.html`)

- `abrirCamara()` pasa a llamar `Scanner.open({ video: cam-video, mode: 'single', onCode: function(v){ cerrarCamara(); escanear(v); }, onError: ... })` en vez de manejar `BarcodeDetector` directo.
- `cerrarCamara()` pasa a llamar `Scanner.close()` además de ocultar el modal.
- Modal (`#cam-modal`), botón y mensajes existentes se mantienen sin cambios visuales.
- Resultado: mismo comportamiento de hoy en Android, y ahora también funciona en iPhone.

### Conteo de stock (`public/inventario/index.html`)

- Nuevo botón "📷 Cámara" en `.toolbar`, junto a los botones existentes (mismo estilo `toolbar button`).
- Nuevo modal, mismo patrón visual que el de preparación (`.modal`/`.modal-box`, `<video>`, botón "Cerrar").
- Al abrir: `Scanner.open({ video, mode: 'continuous', onCode: function(codigo){ processScan(codigo); mostrarToast(codigo); }, onError: ... })`.
- `processScan` es la función ya existente que usa el input físico — no se duplica lógica de conteo.
- Toast: mensaje breve superpuesto (2-3 segundos, no bloqueante) del tipo "✓ 7791234567890 leído", reutilizando la paleta de colores existente (`--ok`/`--azul`) para que se sienta parte de la misma herramienta. No reemplaza el `banner` de arriba: ambos pueden convivir (el banner ya muestra el último código + cantidad).
- El modal se cierra solo con el botón "Cerrar" — la cámara puede quedar escaneando todo el tiempo que el usuario esté contando.

### UX/UI

- Reusar los estilos (`.modal`, `.modal-box`, `.btn`) ya definidos en cada página en vez de crear una hoja de estilos nueva, para que el modal de cámara se vea consistente con el resto de cada herramienta.
- El toast de conteo debe ser legible con el celular en mano (fuente grande, alto contraste) pero no debe tapar el video ni el botón de cerrar.
- Los mensajes de error (permiso denegado, sin cámara) van en el mismo lugar donde preparación ya los muestra hoy (`#cam-msg` o equivalente), sin alerts bloqueantes salvo el caso ya existente de navegador totalmente sin soporte.

## Manejo de errores

Mismo patrón en ambas pantallas:

- Permiso de cámara denegado → mensaje de texto en el modal, sin cerrar la app ni el flujo de tipeo/lector físico.
- Sin cámara disponible → idem.
- Navegador sin `getUserMedia` en absoluto → mensaje claro, sugiere usar el lector físico o tipear el código (mismo mensaje que ya existe en preparación hoy).

## Testing

El proyecto no tiene infraestructura de tests de frontend (vitest solo cubre `lib/`/`routes/` del backend; estas páginas son HTML+JS servido tal cual, sin build). Verificación manual antes de deploy:

1. Preparación, Android/Chrome: escanear un EAN real de producto → coincide con lo que ya hace hoy.
2. Preparación, iPhone/Safari: mismo caso — hoy falla, después del cambio debe funcionar.
3. Conteo de stock, Android e iPhone: abrir cámara, escanear una SKU, ver el toast, confirmar que sumó en la tabla.
4. Conteo de stock: sostener el mismo código quieto 3-4 segundos frente a la cámara → debe sumar 1 sola vez, no varias.
5. Conteo de stock: escanear el mismo código dos veces con una pausa/retiro del producto en el medio → debe sumar 2.
6. Caso de error: denegar permiso de cámara en ambas pantallas → debe mostrar mensaje y no romper el resto de la herramienta.

Deploy solo después de pasar esta verificación manual en Android e iPhone reales (no solo emulador), dado que la cámara y el rendimiento de decodificación varían por dispositivo.
