# Mensajería: compartir información comercial

Los agentes abren las acciones de cada conversación, eligen un resultado, revisan el contenido y lo agregan al borrador. El envío sigue siendo explícito. Las consultas de catálogo y pedidos usan SQLite sincronizado del VPS; la factura se consulta en el emisor vigente de la web únicamente al seleccionar un pedido. No se emiten comprobantes ni se modifican pedidos.

1. Incorporar buscador local de productos por nombre/SKU, variantes, miniatura, precio web, stock y fecha de sincronización. Reutilizar reglas comerciales existentes; nunca lista ML. Backend acotado en `lib/mensajeriaCommerce.js` y rutas protegidas.
2. Vincular pedidos por teléfono completo normalizado (sin coincidencias parciales). Mostrar varias coincidencias y selección manual. Exponer seguimiento solo si hay número real registrado; no convertir una exportación Andreani en un envío despachado. Facturas ya emitidas de producción por pedido y PDF, con identidad confirmada y permisos del responsable.
3. Mostrar acciones Archivo, Audio, Producto, Factura y Seguimiento junto al editor. Plantilla aparece cuando vence la ventana de 24 horas desde el último mensaje del cliente o todavía no existe esa ventana. Conservar texto y adjuntos al cancelar, cambiar de chat o fallar una petición.
4. Pruebas de permisos, CSRF, identidad, límites, precio, enlaces, PDFs, ausencia de envíos implícitos y carreras de UI. Revisión independiente, suite completa serial en copia aislada y QA de interfaz responsive con datos ficticios.
5. Publicar con copia de seguridad y restauración documentada. Verificar producción mediante lecturas; no mandar pruebas a clientes ni cambiar IA, Master Control, POS o emisión fiscal. Actualizar memoria relacionada y limpiar procesos QA.

Aceptación: búsqueda usable como el POS; producto seleccionado abre enlace público de la tienda; datos privados de otro teléfono no se obtienen por ID; varios pedidos/comprobantes permiten elección; sin factura o tracking el estado se explica; no hay envíos al abrir/buscar/preparar; teclado y audio existentes siguen funcionando.
