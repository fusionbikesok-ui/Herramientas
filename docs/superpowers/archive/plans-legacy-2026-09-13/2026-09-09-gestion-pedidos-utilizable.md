# Plan específico: dejar utilizable Gestión de pedidos

**Fecha:** 2026-09-09
**Estado:** GP11 y GP12 entregados y desplegados (2026-09-09/10). GP13–GP15 pendientes.
Verificado sobre producción el 2026-09-11.
**Alcance:** convertir Gestión de pedidos de maqueta navegable en herramienta operativa real, sobre el backend `gestion_*` ya construido en GP2–GP8.

## Diagnóstico que origina el plan

Las fichas GP4–GP8 figuran `publicada` y su backend existe y está probado, pero
`public/gestion-pedidos/index.html` sigue siendo el prototipo de GP1: pedidos hardcodeados
(`#1001`, `#1005`…), `alert('Demo: …')` en casi toda acción, checklist en `localStorage`,
enlace a `demo.fusionbikes.com` y unos veinte scripts parche encimados. Lo único que consulta
la API real es Recuperar ventas. La herramienta no es utilizable hoy, y la numeración de las
fichas no lo revela: se cumplió la regla de no inferir una entrega terminada por commits.

Tres bloqueos adicionales, verificados:

1. `server.js:422-431` exige `PEDIDOS_PREVIEW_USER` (default `Matias`). Joaco (id 4) y Santi
   (id 15) ya tienen `pedidos:write` en `data/fusion.sqlite` y hoy reciben 403. La matriz de
   `lib/permisos.js` ya resuelve `/gestion-pedidos` contra la herramienta `pedidos` con
   `read`/`write` por método: el gate de preview es redundante y excluyente.
2. No hay cron de importación. La última corrida completada es del 2026-09-09 03:45
   (`gestion_pedido_importaciones` id 3, 706 pedidos). Sin cron, la herramienta muestra
   pedidos viejos al día siguiente.
3. GP10 sigue en `desarrollo`: falta la jornada observada y la suite completa.

## Decisiones tomadas con el usuario (2026-09-09)

- **Alcance de la UI:** completo, incluida edición de datos y de productos.
- **Importación:** cron cada 10 minutos, incremental, más botón manual de reconciliación de
  la ventana de 30 días.
- **Escritura en WooCommerce:** al confirmar cambios se escribe también en WooCommerce.
- **Cuotas:** se construye el contrato autenticado con Master Control (WordPress).
- **Stock:** al confirmar cambios se mueve stock real.

### Qué se edita y qué no (resuelto con el usuario, 2026-09-09)

**Sólo se modifican los pedidos nativos de WooCommerce.** Los pedidos de MercadoLibre no se
modifican, y tampoco los **pedidos espejo**: los que viven en Woo pero nacieron de una venta
de ML (`espejo_ml`, detectado por la meta `_ml_order_id`). Es exactamente el caso que cubre
la regla de `CLAUDE.md` — *«Un pedido WC creado desde ML no se modifica después»*, con las
únicas excepciones de la cancelación y la nota privada — así que la edición los excluye y la
pantalla explica por qué el botón está deshabilitado, en vez de esconderlo.

Consecuencia técnica pendiente: `gestion_pedidos` todavía no persiste `espejo_ml`, aunque el
normalizador ya lo calcula. Hay que agregar la columna antes de habilitar la edición, o el
backend no puede distinguir un pedido web genuino de uno espejo.

### Hallazgos de la revisión del 2026-09-09

Corregidos en el momento:

- **Los importes de ML estaban invertidos.** En ML `total_amount` es la suma de los ítems y
  `paid_amount` es lo pagado con envío incluido; mapearlos por su nombre dejaba subtotal
  mayor que total.
- **La entrega de ML se inventaba.** Se escribía `tipo: 'domicilio'` para toda venta de ML
  sin haber leído su shipment, lo que clasificaba mal un Flex o un retiro en sucursal. Ahora
  no se escribe la fila hasta que exista `envios_despacho`.
- **El contador de Recuperar ventas no usaba el filtro de su lista** (le faltaba
  `estado='vigente'`), así que la pill podía mostrar un número que la lista no explicaba.
- **La selección múltiple no se limpiaba** al cambiar de vista, buscar o filtrar: se podían
  mandar a preparación pedidos que ya no estaban en pantalla. Paginar sí la conserva.

Pendientes, anotados para no tropezar en GP13/GP14:

- **`gestion_pedido_items.id` no es un identificador estable.** `upsertItems` borra e
  inserta todas las líneas en cada corrida, y con el cron eso pasa cada 10 minutos: hay 887
  filas y el autoincremental ya va en 1858. GP14 tiene que referenciar las líneas por SKU, o
  el importador tiene que pasar a upsert por (pedido, sku).
- **`gestion_pedido_importaciones` crece sin poda:** 144 filas por día. Conviene registrar
  sólo las corridas con cambios o las fallidas, o podar por antigüedad; si no, el historial
  entierra los fallos, que es justo lo que hay que poder encontrar.
- **La preview de diseño quedó vacía para esta pantalla.** `scripts/design-preview.mjs`
  siembra `pedidos_cache`, no las tablas `gestion_*`; antes se veía porque la pantalla traía
  los datos escritos a mano.
- **`upsertItems` no guarda `moneda` en la línea.** Menor: la moneda del pedido sí se
  persiste y es la que usa la pantalla.

### Estados, duplicados y envíos (2026-09-09, sobre GP11)

- **`estado_canal`** (migración 099) guarda el estado crudo del canal. Las clasificaciones
  propias eran tan gruesas que 625 de 723 pedidos compartían combinación.
- **Cierran el pedido:** `enviadoandreani`, `retiradoenfusion`, `completed` y
  `serviceterminado` (configurable con `GESTION_PEDIDOS_ESTADOS_CERRADOS`), más un envío de
  ML en `shipped` o `delivered`. `paid` de ML y `ready_to_ship` NO cierran.
- **El estado operativo local ya no se pisa** en cada importación; el canal sólo gana cuando
  informa un cierre.
- **Venta de ML espejada en Woo:** se muestra la fila de ML, vinculada por la meta
  `_ml_order_id` (migración 099, columnas `espejo_ml` y `ml_order_id`). El espejo se oculta
  sólo si su orden de ML está importada.
- **Envío de ML:** `ml_shipment_id` (migración 100) enlaza con `ml_shipment_estado`.
- **Pendiente:** los pedidos del borde de la ventana de 30 días quedan con `estado_canal`
  nulo para siempre, porque la reconciliación ya no los alcanza. Hoy se muestran como "Sin
  estado conocido" en vez de afirmar un estado no verificado; falta decidir si se cierran por
  antigüedad.

### Conflictos que siguen abiertos

- **Mover stock real necesita un dueño único de la reserva.** Existe el ledger
  `stock_movements`, así que es técnicamente viable, pero Preparación también descuenta. Antes
  de GP14 hay que fijar quién reserva y quién descuenta, o habrá doble descuento.

## Entregas

Cortadas por valor: cada una, sola, mejora algo para quien la usa.

### GP11 — Gestión de pedidos consultable de verdad

Es la entrega que convierte la maqueta en herramienta. Sola ya sirve: el equipo puede buscar
y consultar cualquier pedido de Woo y ML con datos frescos.

1. Reescribir `public/gestion-pedidos/index.html` contra la API real: se descartan los
   scripts parche y los datos hardcodeados. Tokens de `public/lib/theme.css` y componentes de
   `public/lib/components.css`; `public/lib/api.js` para el transporte.
2. Tres pills en orden — **Requieren atención**, **Recuperar ventas**, **Todos los pedidos** —
   con Requieren atención como vista inicial, contra `GET /api/gestion-pedidos` con sus
   filtros `estado`, `comercial` y `fuente`.
3. Buscador global contra el parámetro `q`, que ya cubre número visible, id externo, cliente,
   email, teléfono, SKU, EAN y nombre de producto. No cambia de pill solo; ofrece abrir el
   resultado en Todos.
4. Vista rápida lateral de sólo lectura contra `GET /api/gestion-pedidos/:id`: cliente,
   entrega, items, importes, estados, eventos y `enlace_woocommerce`.
5. Detalle en `/gestion-pedidos/pedidos/{id}` como URL real: recarga, historial del navegador
   y permisos. Sin `history.pushState` sobre contenido de demo.
6. Reemplazar el gate `PEDIDOS_PREVIEW_USER` de `server.js:422-431` por el guard de permiso
   `pedidos` que ya existe en `lib/permisos.js`. La tarjeta del Home ya está gateada por
   `data-tool="pedidos"` en `public/home/index.html:641`.
7. Cron de importación incremental cada 10 minutos en `server.js`, con el patrón de los demás
   crons (respetando `DISABLE_CRONS`), más botón de reconciliación de 30 días y frescura
   visible del último dato.
8. Estados explícitos de carga, vacío y error en cada vista. Responsive verificado en 375 y
   1280.

**Aceptación:** un usuario con `pedidos:read` entra desde el Home, encuentra por SKU un pedido
real de los 706, abre su detalle en URL propia, lo recarga y ve datos que coinciden con Woo/ML.
Ningún `alert('Demo:` sobrevive en el archivo. Un usuario sin el permiso recibe 403.

**ENTREGADO (verificado el 2026-09-11).** Los ocho puntos están: la pantalla se reescribió
(49 KB de maqueta → ~29 KB reales), las tres pills, el buscador `q`, la vista rápida, el
detalle con URL propia. `PEDIDOS_PREVIEW_USER` **ya no existe** en el código. El cron corre
**cada 10 minutos** (231 corridas registradas, la última completada) y hay botón de
reconciliación de 30 días. **0** `alert('Demo:` en el archivo. La base pasó de 706 a **2.120
pedidos**.

Dos observaciones nuevas de esta verificación:

- **`woo_recibidos` y `ml_recibidos` no se escriben nunca.** `ejecutarImportacion`
  (`lib/gestionPedidosSync.js:74-79`) sólo graba `importados`, `creados` y `actualizados`; las
  otras dos columnas quedan en 0 en las 231 corridas. O se llenan o se sacan: hoy son un dato
  que parece decir "no llegó nada de Woo ni de ML" y no es eso.
- La poda de `gestion_pedido_importaciones` que el plan anticipaba **no es urgente**: 231
  filas en total, no las 144 por día estimadas.

### GP12 — Enviar a preparación desde la lista

1. Selección múltiple real en la lista.
2. `POST /api/gestion-pedidos/preparacion/validar-lote` antes de confirmar, mostrando cuántos
   entran y cuáles se excluyen con su motivo.
3. Confirmación contra el lote real de preparación, idempotente y auditada.

**Aceptación:** un lote de pedidos elegibles llega a Preparación y aparece en su cola; los no
elegibles se informan con motivo y no se envían. Repetir la confirmación no duplica el lote.

**ENTREGADO (2026-09-09).** Verificado creando las preparaciones 300 y 301 desde la lista.

### GP13 — Editar datos de cliente y entrega

Requiere resolver antes el conflicto de escritura en Woo.

1. Formulario único de cliente + entrega en el detalle.
2. Cambios acumulados como pendientes, con una sola revisión general: **Confirmar cambios**
   aplica todo, **Descartar** cancela. Hoy la API aplica en el POST; hay que agregar la
   semántica de pendiente/confirmar/descartar.
3. Escritura en WooCommerce al confirmar, idempotente y con rollback, sólo sobre pedidos
   nativos de Woo mientras la regla de ML siga vigente.

### GP14 — Editar productos

Requiere resolver antes el dueño de la reserva de stock.

1. Buscador de productos por nombre, SKU o EAN con foto grande, miniatura, stock, precio y
   cantidad. Sólo **Agregar producto**: no hay reemplazo implícito.
2. **Remover** por línea, con motivo obligatorio: No lo quiso, No apto para la venta, Falla de
   stock, Cambio.
3. Revisión única con diferencia económica e impacto de stock antes de guardar.
4. Movimientos en `stock_movements` al confirmar, idempotentes y auditados, sin doble
   descuento contra Preparación.

### GP15 — Cuotas y reintegros

El contrato ya está escrito de los dos lados; falta que alguien con acceso al hosting suba
el plugin y defina el token.

1. **Hecho, sin desplegar.** `GET /wp-json/fusion-pricing/v1/cotizacion` en
   `includes/Controllers/ApiController.php` de Master Control, registrado en `Plugin.php`.
   Es de sólo lectura y expone lo que ya calculan `PricingEngine` y `DataService`:
   precio de contado, coeficiente y precio financiado por cada plan permitido
   (3, 6, 9, 12, 18 y 24), buscando por `product_id` o por `sku`. Autenticación por secreto
   compartido en el header `X-Fusion-Token`, contra la constante `FUSION_API_TOKEN` de
   `wp-config.php` (se prefiere la constante sobre una opción de la base, que viajaría en
   cualquier backup). Comparación con `hash_equals`.
2. **Hecho.** Cliente del VPS en `lib/masterControlPricing.js`, fail-closed: si WordPress no
   responde, la pantalla dice que no puede calcular la financiación en vez de mostrar la
   diferencia de contado como si lo fuera. Variable `MASTER_CONTROL_TOKEN`.
3. Pendiente: mostrar la diferencia en la revisión de cambios, según el plan del pedido.
4. Pendiente: **Marcar como reintegrado** como acción separada, que registra usuario, fecha,
   hora, importe y referencia. Falta además el alta del reintegro: hoy sólo existe `marcar`.

**Despliegue del lado WordPress** (manual, requiere acceso al hosting):

1. Confirmar que `/opt/Master control` corresponde a la versión viva (declara 10.0.6). La
   copia del VPS no está versionada: subirla sin verificar pisaría cambios hechos después.
2. Subir la carpeta del plugin por wp-admin → Plugins, o por el administrador de archivos de
   Hostinger.
3. Agregar en `wp-config.php`: `define('FUSION_API_TOKEN', '<secreto largo y aleatorio>');`
4. Poner el mismo valor en `MASTER_CONTROL_TOKEN` del `.env` del VPS.
5. Verificar: `GET /wp-json/fusion-pricing/v1/cotizacion?sku=<SKU>&plan=6` con el header
   debe responder 200, y sin header 401.

## Fuera de alcance

- Reescribir Gestión de envíos.
- Cambiar el modelo relacional de GP2, que ya está desplegado.
- Reconstruir evidencia fotográfica inexistente.

## Gate de cierre

Vale la regla obligatoria de `CLAUDE.md`: auditoría de código y seguridad, `npm test` completo
en verde con nada más corriendo, UI responsive sin nada oculto, conformidad con el sistema
visual, migraciones aplicadas y presupuesto de peso frontend. GP10 recién se acepta con la
jornada observada firmada.
