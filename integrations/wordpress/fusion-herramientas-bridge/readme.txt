Fusion Herramientas — Puente de lectura 0.3.1

Etapa inicial de integración. No sustituye POS, Chat, Taller ni Facturador.
No incluye tareas programadas, tablas nuevas, emisores, redirecciones de checkout,
envíos de mensajes, credenciales nuevas ni modificaciones del catálogo.

Rutas GET bajo la autenticación y los permisos de claves REST de WooCommerce:
/wp-json/wc/v3/fusion-herramientas/status
/wp-json/wc/v3/fusion-herramientas/commercial-products?ids=123,456
/wp-json/wc/v3/fusion-herramientas/migration-inventory
/wp-json/wc/v3/fusion-herramientas/migration-export?resource=taller_jobs&page=1
/wp-json/wc/v3/fusion-herramientas/metrics-options
/wp-json/wc/v3/fusion-herramientas/metrics-products?ids=123,456
/wp-json/wc/v3/fusion-herramientas/metrics-refunds?ids=123,456

Requiere HTTPS y manage_woocommerce. Máximo 25 IDs positivos, sin duplicados.
No colocar claves WooCommerce en el navegador; sólo usar desde el servidor VPS.
Las respuestas no se almacenan en caché pública.
Inventario/exportación exigen además manage_options. Las tablas y opciones están
limitadas a una lista de los tres módulos; 50 registros por página. Se excluyen
contraseñas y credenciales fiscales. La exportación incluye datos personales del
negocio: guardarlos sólo en el VPS autorizado, con acceso privado. No representa
por sí sola un snapshot consistente para el corte operativo.

Master Control cambia la representación de precios de la API estándar. Este
puente consulta sus servicios comerciales directamente, igual que el POS.
Las cotizaciones son para una unidad sin envío, cupón, cálculo de impuestos o
dólares; no autorizan un cobro. El checkout sigue revalidando la operación.
No multiplicar un precio de unidad ya redondeado para cotizar varias unidades.
El campo excludes declara los cálculos que todavía no cubre este contrato.

Retirada: desactivar este plugin. No elimina ni migra datos al desactivarlo.
Instalar el puente por sí solo todavía no reduce la carga de la tienda.

Métricas 0.3.0: GET con HTTPS, clave Woo vigente, manage_woocommerce y
manage_options. Opciones/taxonomías/estados/zona horaria; dimensiones sin precios
(máximo 100 IDs de productos); devoluciones por ítem (máximo 25 pedidos).
No incluye información identificatoria de compradores ni recalcula precios.
Los importes de pedidos se sincronizan por REST con dp=8 para evitar redondear
el historial según los decimales de visualización de la tienda.
0.3.1 agrega el indicador de producto virtual a dimensiones para conservar la
clasificación de bultos Andreani. No altera precios ni operaciones.
