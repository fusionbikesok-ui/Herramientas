# Carga de Códigos Universales — Diseño

**Fecha:** 2026-07-21
**Estado:** aprobado para implementación

## Problema

Muchos productos de WooCommerce no tienen cargado su **código universal** (GTIN/EAN,
el código de barras del fabricante). El campo nativo de Woo es `global_unique_id`
(GTIN/UPC/EAN/ISBN), disponible por la REST API tanto en productos simples como en
variaciones. Hoy no hay forma cómoda de irlos cargando; hay que hacerlo a mano en el
admin de Woo, uno por uno.

Se quiere una herramienta **mobile-first** (mismo espíritu que Consulta de Precios) para
recorrer el depósito con el teléfono, escanear el código de barras de cada producto con
la cámara, y que quede guardado en Woo.

## Verificación técnica (hecha)

Contra el Woo real (solo lecturas GET):

- `GET /wp-json/wc/v3/products` devuelve `global_unique_id` (algunos ya cargados, ej.
  `753068721935`; los `variable`/padres vienen vacíos, como corresponde).
- `GET /products/{id}/variations` devuelve `global_unique_id` por variación, y
  `attributes[].option` da las características ("Rojo", "Blanco", …).
- Escritura: `PATCH /products/{id}` con `{ global_unique_id }` para simples;
  `PATCH /products/{id_padre}/variations/{id}` para variaciones. El cache ya guarda
  `tipo` e `id_padre`, así que se resuelve el endpoint correcto sin lookups extra.

## Alcance de la "cola de faltantes"

Un producto entra en la cola si cumple **todo**:

- `stock > 0` (solo lo que tenés físicamente para escanear).
- `gtin` vacío (todavía sin código).
- `tipo != 'variable'` (los padres variables no llevan código; sí sus variaciones).
- `sku` no vacío.
- **No** es no-vendible: excluye categorías `SERVICES` y `QR PAGOS`
  (`lib/cobertura.js` → `esNoVendible`).
- **No** está en `cobertura_exclusiones` ("solo local").

Reutiliza el mismo criterio de exclusión que Cobertura para mantener coherencia.

## Flujo de uso

1. La pantalla muestra la **cola de faltantes** con tarjetas: foto + título +
   características de variación (ej. "Rojo / Talle L") + SKU + stock + marca.
2. **Filtros** (ver abajo) para acotar la cola.
3. En el producto que tenés en mano, tocás 📷 → se abre la cámara (reusa
   `public/lib/scanner.js`, modo `single`) → escaneás el código de barras.
4. Al escanear, la tarjeta muestra el código leído y pide **confirmar** (ver abajo).
5. Al confirmar se guarda: **PATCH a Woo** (`global_unique_id`) **+** se actualiza
   `catalogo_cache.gtin` **+** se siembra `ean_sku` (para que Consulta de Precios lo
   reconozca al toque).
6. El producto **sale de la cola** (o muestra ✓ y avanza) y seguís con el siguiente.
7. **Fail-closed:** si Woo rechaza (GTIN duplicado en otro producto, error de API), NO se
   marca como cargado, NO se toca el cache ni `ean_sku`, y se muestra el error claro.

### Confirmación antes de guardar

Al escanear, la tarjeta muestra el código leído junto al producto y un botón
**"Confirmar"** (y "Cancelar" / re-escanear). El PATCH a Woo recién ocurre al confirmar.
Esto evita cargar un código mal leído o en el producto equivocado. La confirmación es por
producto y rápida (un toque), para no frenar demasiado la carga en lote.

## Filtros y orden

Todos combinables (AND). Los desplegables se arman **dinámicamente** con lo que hay entre
los faltantes actuales (no se muestran marcas/categorías sin nada pendiente).

- **Marca** — desplegable (taxonomía `brands` de Woo → `catalogo_cache.marca`).
- **Categoría** — desplegable (nombres de `categorias_json`).
- **Texto libre** — filtra por SKU o nombre a medida que se tipea. Este buscador también
  encuentra productos **que ya tienen código**, para el flujo de sobrescritura.
- **Toggle "solo con stock"** — ON por defecto. Si se apaga, incluye faltantes con
  `stock <= 0` (advertencia: sin stock no tenés el producto físico para escanear).

**Orden por defecto:** por marca y luego por nombre (agrupa la carga por marca).

## Sobrescritura de códigos ya cargados

Además de la cola de faltantes, el buscador de texto libre encuentra cualquier producto,
tenga o no código. Si tiene código, la tarjeta lo muestra y permite re-escanear para
corregirlo (mismo `POST /asignar`, que sobrescribe). Fail-closed igual: si Woo rechaza,
no se pisa nada.

## Piezas técnicas

### DB

- Nueva columna `catalogo_cache.gtin TEXT` (nullable). Migración idempotente en
  `db/index.js` siguiendo el patrón existente:
  `try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN gtin TEXT'); } catch (_) {}`.

### Modelo / sync

- `lib/modelos/producto.js`:
  - `normalizarProductoWc`: capturar `raw.global_unique_id` → `gtin`.
  - `normalizarVariacionWc`: hereda de la variación (no del padre) su propio
    `global_unique_id`.
  - `filaCatalogo`: persistir `gtin`.
  - `productoDesdeFilaCatalogo`: leer `gtin`.
- `routes/woo.js` → `refrescarCatalogo`: agregar `gtin` al `INSERT ... ON CONFLICT`
  upsert de `catalogo_cache`.

### Backend — `routes/codigos.js` (montado en `/api/codigos`)

- `GET /faltantes` → cola filtrada según reglas de alcance. Devuelve productos
  (foto, título, atributos, sku, stock, marca, categorías) + las listas de **marcas** y
  **categorías** presentes (para poblar los desplegables). Acepta query params opcionales
  `marca`, `categoria`, `q`, `conStock` (default true) para filtrar del lado server, o se
  filtra client-side sobre la lista completa (decisión de implementación según tamaño;
  ver Rendimiento).
- `GET /buscar?q=` → búsqueda por SKU/nombre incluyendo productos ya con código (para
  sobrescritura). Reutiliza el patrón de `buscar-sku` de consultaPrecios.
- `POST /asignar` → body `{ id_woo, gtin }` (o `{ sku }` para resolver). Pasos:
  1. Resolver el producto en `catalogo_cache` (obtener `tipo`, `id_padre`, `sku`).
  2. PATCH a Woo en el endpoint correcto (simple vs variación).
  3. Si OK → `UPDATE catalogo_cache SET gtin=?` + upsert en `ean_sku (ean=gtin, sku)`.
  4. Si Woo falla → 4xx/5xx con mensaje, sin tocar DB (fail-closed).
- Montaje en `server.js`: `app.use('/api/codigos', codigosRouter(db, wooCfg))` +
  `app.use('/codigos', express.static('public/codigos'))`.
- Nota de permisos: `resolvePermiso` deriva el scope del path; la nueva herramienta
  necesita su entrada de permiso como las demás (revisar `lib/permisos.js`).

### Frontend — `public/codigos/index.html`

- Mismo lenguaje visual que `public/consulta-precios/index.html` (paleta, cards, gate de
  auth, modal de cámara). Reusa `../lib/scanner.js`.
- Barra de filtros arriba: desplegable marca, desplegable categoría, caja de texto,
  toggle "solo con stock".
- Lista de tarjetas de la cola. Cada tarjeta con botón 📷 para escanear su código.
- Al asignar OK: la tarjeta muestra ✓ + el código, y sale de la cola (o se atenúa).
- Manejo de error visible por tarjeta (GTIN duplicado, etc.).

### Home

- Nuevo tile en `public/home` que enlaza a `/codigos`.

## Rendimiento

La cola puede tener cientos/miles de faltantes. Opciones (a decidir en implementación):

- Traer la lista completa de faltantes una vez y filtrar client-side (simple, funciona si
  son ≤ algunos miles de filas livianas). **Preferido** salvo que se mida lento.
- Si es muy grande, filtrar server-side con los query params y paginar.

## Testing (vitest)

- Lógica de alcance de la cola: stock>0, sin gtin, excluye variable/sin-sku/no-vendible/
  solo-local. Casos límite de cada exclusión.
- `asignar`: resuelve endpoint correcto simple vs variación (mock de `wooFetch`); en OK
  actualiza cache + siembra ean_sku; en fallo de Woo no toca DB (fail-closed).
- Normalización: `gtin` se captura de simples y variaciones y round-trip por
  `filaCatalogo`/`productoDesdeFilaCatalogo`.

## Fuera de alcance (YAGNI)

- Carga sin cámara / lector físico ya funciona igual (input de teclado), pero no se
  agrega UI dedicada más allá de tipear el código.
- Importación masiva desde archivo/Excel de GTINs.
- Edición de otros campos del producto.
