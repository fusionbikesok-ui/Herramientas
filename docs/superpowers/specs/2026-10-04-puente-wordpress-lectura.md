# Preparación de la migración de plugins WordPress

El usuario pidió integrar POS, Facturación, Chat y Taller en Herramientas para
reducir carga de la tienda, manteniendo el alojamiento y el checkout actuales.
Proporcionó también Master Control y acceso de administrador de WordPress.

**Restricción explícita del usuario:** Master Control queda fuera de la migración.
Conservar íntegros su código, configuración y lógica comercial en WordPress.
Los módulos migrados consumen su lógica; no trasladar tampoco su administración
ni publicar reglas hacia Master Control como parte de este trabajo.

Esta especificación cubre sólo el puente inicial de lectura. No declara migrados
los módulos ni modifica las entregas E0–E26.

## Contrato inicial

- Plugin independiente `fusion-herramientas-bridge`, versión 0.1.0, PHP >=7.4 y
  WordPress >=6.4; WooCommerce y contrato comercial 1 de Master Control.
- GET `/wc/v3/fusion-herramientas/status`: disponibilidad, versiones y límite 25.
- GET `/wc/v3/fusion-herramientas/commercial-products?ids=...`: hasta 25 IDs
  positivos, únicos; nombre, SKU, precio base y financiación de una unidad.
- Autenticación WooCommerce existente, HTTPS y `manage_woocommerce`; respuestas
  privadas sin caché pública. No crear credenciales ni leerlas desde el navegador.
- Los datos provienen de DataService y PricingEngine originales. La proyección
  REST estándar es distinta: `forceApiPrices` transforma price/regular_price/sale_price.
- Campos monetarios como cadenas decimales; moneda explícita y alcance acotado.
- Revalidar en checkout: no cubre carritos, cupones, envíos, impuestos, USD,
  varias unidades ni reserva de stock. Los precios unitarios redondeados no se
  multiplican para obtener la cotización de varias unidades.
- No tablas, cron, opciones, mensajes, comprobantes, cobros ni escrituras de negocio.
- La desactivación retira exclusivamente las rutas nuevas, sin borrar datos.

## Verificación

Permisos y entradas inválidas, lotes acotados, estados de publicación, ofertas,
excepciones heredadas por variante, redondeos del motor original y fallos sin
detalles internos. Prueba con datos sintéticos y motor original en PHP sin red;
después, lecturas de un único producto público desde el VPS autorizado.

## Continuación

El puente es infraestructura preparatoria. La reducción de carga requiere
trasladar operaciones y consultas a almacenamiento del VPS y medir el antes y
después. No autoriza copiar coeficientes aproximados ni reemplazar la fuente de
precios de las integraciones existentes sin su propia validación.
