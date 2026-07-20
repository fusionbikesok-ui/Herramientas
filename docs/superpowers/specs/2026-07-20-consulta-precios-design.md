# Consulta de Precios — Diseño

**Fecha:** 2026-07-20
**Estado:** Aprobado para implementación

## Problema

Se necesita consultar el **precio de venta web** de un producto de forma rápida,
buscándolo por **SKU** o por **código EAN** (el de la caja del producto). Uso típico:
mostrador, con un lector físico USB o la cámara del celular.

**Restricción clave descubierta:** el EAN no vive en ningún lado del servidor.
WooCommerce no lo expone (`global_unique_id` vacío, sin meta EAN/GTIN/barcode en los
productos). Hoy el único vínculo EAN↔SKU es el mapa que arma a mano el Contador de
inventario en el `localStorage` del navegador. Por lo tanto, para resolver EAN→precio
hace falta construir una tabla EAN↔SKU del lado del servidor.

## Alcance

- Buscar por SKU o EAN y mostrar el **precio web** (de `catalogo_cache.precio`),
  nombre, SKU, stock e imagen. Lectura local, respuesta instantánea. **No** se consulta
  MercadoLibre ni se calcula neto (eso ya lo hace la herramienta separada "Precios ML").
- La tabla EAN↔SKU **aprende de a uno**: cuando aparece un EAN desconocido, la
  herramienta pide el SKU una vez y lo recuerda para siempre, para todos los dispositivos.
- **Sembrado inicial opcional:** botón que importa el mapa EAN↔SKU del `localStorage`
  del Contador de inventario (cuando se abre esta herramienta en el mismo navegador donde
  se armó ese mapa) y lo sube al servidor de una.
- Ingreso por **caja de texto** (tipeo o lector físico USB que "teclea + Enter") **y**
  **cámara** (módulo `Scanner` compartido, ya usado en inventario/preparación).

### Fuera de alcance (YAGNI)

- Precio/neto de MercadoLibre en esta herramienta (existe "Precios ML" para eso).
- Edición de precios (es solo consulta).
- Historial de consultas.

## Modelo de datos

Una tabla nueva. El precio, nombre, stock e imagen ya viven en `catalogo_cache`; no se
duplican. `ean_sku` solo guarda el puente que hoy no existe.

```sql
CREATE TABLE IF NOT EXISTS ean_sku (
  ean TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
```

Se agrega a `db/schema.sql` (que se aplica idempotente al abrir la DB).

Notas:
- `ean` es la clave: reescanear el mismo EAN con otro SKU sobreescribe (upsert). Es
  aceptable — corrige un mapeo mal enseñado.
- No se valida contra el catálogo al momento de importar en lote (el catálogo puede
  refrescarse); la validación fuerte ("el SKU existe") se aplica al **enseñar de a uno**.
  En la búsqueda, si el EAN resuelve a un SKU que ya no está en el catálogo, se trata como
  "producto no encontrado" (ver más abajo).

## Backend — `routes/consultaPrecios.js`, montado en `/api/consulta-precios`

Router que recibe `db`. Sin llamadas a red.

### `GET /buscar?q=CODIGO`

Lookup unificado y robusto (no depende sólo de adivinar el formato del código):

1. **¿Match exacto de SKU** en `catalogo_cache` (`sku = q AND sku <> ''`)? →
   `{ ok:true, found:true, tipo:'sku', producto }`.
2. **¿EAN conocido** en `ean_sku` (`ean = q`)? → resuelve al SKU, busca en
   `catalogo_cache`.
   - Si el SKU existe → `{ ok:true, found:true, tipo:'ean', producto }`.
   - Si el SKU ya no existe en el catálogo → `{ ok:true, found:false, tipo:'ean',
     ean:q, skuHuerfano:<sku> }` (mensaje: el EAN apunta a un SKU que ya no está).
3. **¿No está pero parece EAN** (todo dígitos, largo 8/12/13/14)? →
   `{ ok:true, found:false, needsSku:true, ean:q }` para disparar el flujo de "enseñar".
4. **Nada** → `{ ok:true, found:false }`.

`producto` = `{ sku, nombre, precio, stock, tipo, img }` de `catalogo_cache`.

La detección "parece EAN" del punto 3 usa: string de sólo dígitos con largo 8, 12, 13 o
14 (EAN-8, UPC-A, EAN-13, GTIN-14). No se exige dígito de control válido para no rechazar
códigos internos; la validación real es "¿lo conozco o me lo enseñás?".

### `POST /ean` — nivel **write**

Body `{ ean, sku }`. Enseña un EAN nuevo:
- Valida que `ean` y `sku` no vengan vacíos.
- Valida que el `sku` **exista** en `catalogo_cache`. Si no, `400`.
- Upsert en `ean_sku` (`actualizado_en = now`).
- Devuelve `{ ok:true, producto }` con el producto ya resuelto (para mostrar el precio
  inmediatamente).

### `POST /importar` — nivel **write**

Body `{ pares: [{ ean, sku }, ...] }` (del `localStorage` del inventario). Sembrado en
lote:
- Filtra pares con `ean` y `sku` no vacíos.
- Upsert de cada uno en una transacción.
- **No** valida contra el catálogo (los SKUs viejos que ya no existen simplemente darán
  "no encontrado" al buscarlos; no ensucian nada).
- Devuelve `{ ok:true, importados:<n>, recibidos:<total> }`.

### `GET /buscar-sku?q=...`

Autocomplete sobre `catalogo_cache` para elegir el SKU al enseñar un EAN nuevo. Mismo
patrón que `GET /api/sync/buscar-sku`:

```sql
SELECT sku, nombre, stock, tipo FROM catalogo_cache
WHERE (sku LIKE ? OR nombre LIKE ?) AND sku <> ''
ORDER BY nombre ASC LIMIT 20
```

## Frontend — `public/consulta-precios/index.html`

Página estática, misma estética oscura que el resto (paleta `--azul #2DB8E8`, etc.).

- **Caja de búsqueda** grande con auto-focus. Un lector USB físico tipea el código y da
  Enter → dispara `GET /buscar`. Botón **Escanear con cámara** que abre el módulo
  `Scanner` (modo `single`) y al leer un código lo mete en la caja y busca.
- **Resultado encontrado:** card grande con el **precio web** destacado (formateado en
  pesos), nombre, SKU, badge de stock y miniatura. Indica si se llegó por SKU o por EAN.
- **EAN desconocido (`needsSku`):** card "EAN nuevo — ¿a qué producto pertenece?" con el
  código mostrado y un input de autocomplete (`GET /buscar-sku`). Al elegir el SKU y
  confirmar → `POST /ean` → muestra el precio. La próxima vez ese EAN sale directo, en
  cualquier dispositivo.
- **EAN huérfano (`skuHuerfano`):** aviso de que el EAN apunta a un SKU que ya no está en
  el catálogo, con opción de re-enseñar (mismo flujo que EAN desconocido).
- **No encontrado:** mensaje claro; si parecía SKU, sugerir revisar el código.
- **Importar EANs del inventario:** botón (quizás en un panel plegable "Herramientas")
  que lee `localStorage` con la misma clave que usa el Contador de inventario, reconstruye
  los pares `{ean, sku}` (respetando el formato `{other, desc}` migrado de ese tool) y los
  manda a `POST /importar`. Muestra cuántos se importaron. Si no hay mapa en ese navegador,
  avisa que no encontró nada.

### Detalle de la clave de localStorage

El Contador de inventario guarda el mapa bajo la clave `localStorage`
`fb_inv_descmap_v1` con forma `{ [code]: { other, desc } }`, donde `code` puede ser el EAN
o el SKU y `other` es el complemento. Para reconstruir pares `{ean, sku}` se replica
`pairOf`: si `code` parece EAN, `{ean: code, sku: other}`; si no, `{ean: other, sku: code}`.
Sólo se suben los pares con ambos campos no vacíos (los que sólo tienen `desc` sin el
código complementario se descartan).

## Integración (plomería estándar)

1. **`lib/permisos.js`:** agregar `{ id: 'consulta-precios', label: 'Consulta de Precios',
   niveles: true }` a `HERRAMIENTAS`, y una regla
   `{ re: /^\/consulta-precios(\/|$)/, resolve: (m) => ({ anyOf: ['consulta-precios'],
   nivel: nivelDe(m) }) }`. `read` = consultar, `write` = enseñar/importar EANs.
2. **`server.js`:** importar `consultaPreciosRouter`, montar
   `app.use('/api/consulta-precios', consultaPreciosRouter(db))` y el estático
   `app.use('/consulta-precios', express.static(path.join(__dirname,
   'public/consulta-precios')))`.
3. **`db/schema.sql`:** agregar la tabla `ean_sku`.
4. **`public/home/index.html`:** card nueva con
   `href="/herramientas/consulta-precios/"`. La home la gatea sola por el permiso
   `consulta-precios` (derivado del href); la UI de usuarios/permisos también se arma sola
   desde `HERRAMIENTAS`. Sin `data-admin-only` para que un usuario de mostrador con el
   permiso la vea.

## Testing

Tests unitarios (vitest, sin red) para `routes/consultaPrecios.js` sobre una DB en memoria:

- `GET /buscar` con SKU existente → `found:true, tipo:'sku'`.
- `GET /buscar` con EAN conocido → `found:true, tipo:'ean'` y precio correcto.
- `GET /buscar` con EAN desconocido que parece EAN → `needsSku:true`.
- `GET /buscar` con EAN conocido cuyo SKU ya no está → `skuHuerfano`.
- `GET /buscar` con basura → `found:false`.
- `POST /ean` con SKU inexistente → `400`; con SKU válido → upsert + `producto`.
- `POST /importar` → cuenta importados vs recibidos, ignora pares incompletos.
- Detección "parece EAN": 8/12/13/14 dígitos sí; con letras/guiones no.

Si la lógica de detección de EAN o de reconstrucción de pares se extrae a funciones puras,
se testean directo (preferido).

## Riesgos / notas

- **EAN duplicado entre productos distintos:** un mismo EAN sólo puede apuntar a un SKU
  (PK). Si dos productos comparten EAN físico (raro), gana el último enseñado. Aceptable.
- **Catálogo desactualizado:** el precio mostrado es el de `catalogo_cache`, que el cron
  refresca cada 15 min. Es el mismo dato que usa el resto de las herramientas; suficiente
  para consulta de mostrador.
