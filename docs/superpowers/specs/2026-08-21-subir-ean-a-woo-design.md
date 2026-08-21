# Subir a Woo el código escaneado — Entrega C1 (Contador de inventario)

## Qué pide el usuario

> Cuando escanee un código UPC o EAN **que sea válido, no cualquier código**, y esté **sin
> vincular en WC**, que lo suba a WC.

Hoy, cuando en un conteo se escanea un código que el sistema no conoce, el operario lo asocia
a un SKU y eso se guarda **solo en la tabla local `ean_sku`**. Woo nunca se entera: el producto
sigue sin `global_unique_id`, y el trabajo de escanear ese código no le sirve a nadie más
—ni a la web, ni a ML, ni a otra herramienta—. La próxima vez que alguien lo escanee en otro
lado, vuelve a ser desconocido.

## Lo que ya existe (no se reescribe)

- **`looksLikeEan(code)`** — `routes/inventario.js:25`. Exige solo dígitos, longitud **8, 12,
  13 o 14**, y **dígito de control GS1** correcto (`gtinCheckOk`, :13). Esto es exactamente el
  "que sea válido, no cualquier código": un SKU como `FB-7555` no pasa, y un EAN con un dígito
  mal tipeado tampoco.
- **`POST /api/codigos/asignar`** — `routes/codigos.js:150`. Ya hace todo el trabajo sucio:
  PATCH a Woo del `global_unique_id`, endpoint correcto según sea producto simple
  (`/products/{id}`) o variación (`/products/{padre}/variations/{id}`), rechazo del padre
  variable, **fail-closed** (si Woo falla o rechaza, no se toca la DB), y al confirmar
  actualiza `catalogo_cache.gtin` + siembra `ean_sku` + borra el `ean_sku` huérfano del código
  viejo.
- **`POST /sesiones/:id/asociar`** — `routes/inventario.js`. Valida el SKU contra el catálogo,
  convierte el ítem de "código desconocido" a conteo real, y siembra `ean_sku`.

## El obstáculo que obliga a refactorizar

**`codigos` e `inventario` son permisos distintos** (`lib/permisos.js:8` y `:25`;
`codigos` además tiene niveles). Un operario con acceso al Contador pero sin el permiso de
Códigos Universales recibiría **403** si el frontend llamara a `/api/codigos/asignar`.

Por eso la subida **no se delega** a la otra herramienta: se extrae la lógica a
**`lib/gtinWoo.js`** y la usan los dos routers. Subir el código del producto que estoy
contando es parte del conteo, y tiene que funcionar con el permiso del conteo.

## Comportamiento

Al asociar un código a un SKU dentro de una sesión:

1. Si el código **no** es un GTIN válido (`looksLikeEan` false) → se asocia localmente como
   hoy y **no se sube nada**. Sin aviso: es el caso normal de asociar un SKU tipeado.
2. Si es válido y el producto **no tiene código en Woo** → se sube automáticamente. Es el caso
   que el usuario pidió y no requiere ninguna decisión.
3. Si es válido y el producto **ya tiene ese mismo código** → nada que hacer.
4. Si es válido y el producto **ya tiene otro código distinto** → **no se pisa**. Se devuelve
   el conflicto con los dos códigos y **la pantalla pregunta**. Decisión del usuario
   (2026-08-21): preguntar cada vez, ni pisar en silencio ni saltear en silencio.

**Si Woo rechaza o no responde** (el caso típico: ese GTIN ya está cargado en **otro**
producto), la asociación local **se hace igual y el conteo sigue**, con un aviso visible de
que el código no subió y por qué. Decisión del usuario: el trabajo físico del operario no se
descarta por un error de Woo. Esto es una excepción deliberada al fail-closed del resto del
sistema, y vale **solo** para la parte de subir el código — el ajuste de stock sigue siendo
fail-closed como siempre.

### Contrato

`POST /sesiones/:id/asociar` acepta un campo nuevo opcional `pisar_codigo: true` y suma a su
respuesta:

```json
{ "ok": true, "item": {...},
  "codigo": { "estado": "subido" | "sin_cambio" | "conflicto" | "no_valido" | "fallo",
              "gtin": "7791234567890", "gtin_actual": "7799999999999", "error": "..." } }
```

- `subido` — se escribió en Woo.
- `sin_cambio` — el producto ya tenía ese mismo código.
- `conflicto` — el producto tiene otro código; **no se tocó nada**. La pantalla pregunta y, si
  el operario decide pisarlo, repite el POST con `pisar_codigo: true`.
- `no_valido` — no es un GTIN; no se intentó subir.
- `fallo` — se intentó y Woo lo rechazó o no respondió. `error` trae el motivo. **La
  asociación local igual se hizo.**

## Criterio de aceptación

1. Un código no-GTIN (un SKU, un código con checksum malo, 11 dígitos) **nunca** dispara una
   llamada a Woo. Verificable con el mock de fetch.
2. Un GTIN válido sobre un producto sin código → un PATCH a Woo y `catalogo_cache.gtin`
   actualizado.
3. Producto con **otro** código → **cero** llamadas a Woo y `estado: "conflicto"`. Con
   `pisar_codigo:true` → sí se sube y el `ean_sku` viejo se borra.
4. Woo caído o rechazando → el ítem **igual** queda asociado y el conteo sigue;
   `estado: "fallo"`.
5. Una variación usa el endpoint de variación; un padre `variable` no se intenta.
6. El refactor no cambia el comportamiento de `/api/codigos/asignar`: sus tests siguen verdes
   sin tocarlos.

## Fuera de alcance

- Consulta de Precios (entrega C2) y Preparación de pedidos (C3).
- Cargar códigos de productos que no se están contando.
- Cualquier cambio en el ajuste de stock, que sigue fail-closed.
