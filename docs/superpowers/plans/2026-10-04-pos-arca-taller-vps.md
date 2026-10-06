# POS, Facturador y Taller en Herramientas — 2026-10-04

Solicitud: trasladar los tres módulos al VPS, conservar tienda/checkout y Master Control, reducir trabajo real en el hosting. El usuario autoriza el método de integración y la migración; no corresponde pedir nuevamente autorización genérica. No se ejecutarán pagos, emisiones fiscales ni mensajes a clientes como prueba.

## Implementación

1. Servicio PHP/WordPress privado, separado del WordPress de prueba antiguo y del Chat. Usar los tres paquetes completos recibidos, WooCommerce 11.1.2 y WordPress 7.1.2. Añadir SOAP a una imagen propia para mantener el cliente ARCA original. No instalar Master Control en el destino.
2. Entrada a través de Herramientas, autenticando cada solicitud contra su sesión existente; firma interna hacia PHP. Sin contraseñas WordPress nuevas para el operador, sin claves de tienda en el navegador. Preparar primero en red aislada, sin pagos, emisiones, correos ni WhatsApp.
3. Extender el puente de lectura con inventario y exportación acotada de datos de estos módulos y del catálogo necesario. Sólo objetos y campos permitidos; paginación, HTTPS, permiso administrador, respuestas no cacheables. No exportar contraseñas, sales ni claves generales. Los secretos fiscales se migrarán por un canal específico únicamente cuando estén identificados y necesarios para el corte.
4. Preservar IDs y relaciones en el destino; reservar identidades locales para evitar colisiones. Mantener una copia recuperable de los datos de origen y conciliar conteos/hash antes del corte. Cargar datos reales como copia de lectura, sin ejecutar hooks de venta, stock, emisión ni envío.
5. Adaptador de precios: consumir la lectura del motor Master Control existente. Nunca usar el precio REST estándar como base ni recalcular sus reglas con coeficientes inventados. Cada checkout valida nuevamente precios/stock en la tienda.
6. POS: conservar borradores/presupuestos localmente y preparar la transferencia al checkout original usando sesión/permisos WordPress vigentes, operación idempotente y estado confirmado por servidor. No acreditar pagos por mensajes del navegador. Adaptar cuotas, cobros manuales, series, entrega y vínculo fiscal.
7. Taller: órdenes/revisiones/presupuestos/documentos y recordatorios se trasladan juntos. Conservar documentos anteriores en su origen hasta vencimiento. No alterar stock ni habilitar recordatorios apagados.
8. Facturador: conservar tablas/revisiones/numeración/CAE/pendientes/series y cliente fiscal/PDF originales. Ensayar borrador/PDF y recuperación sin emisión real. Sólo un emisor fiscal activo por alcance; el corte requiere detener el anterior, conciliar y activar el destino sin duplicar automatizaciones.
9. Verificar código, seguridad, permisos, recorridos reales de UI, formatos, dependencias, persistencia y reversión. Actualizar memoria y reportar qué está operativo y qué sigue pendiente. Instalar paquetes o habilitar vistas no equivale por sí solo a haber migrado el tráfico.

## Cambios permitidos

### Decisión posterior del usuario — catálogo local existente

El 2026-10-04 el usuario indicó que los productos deben venir de la base ya sincronizada del VPS. Esto sustituye la parte de búsqueda de catálogo del paso 3: se reutiliza `catalogo_cache` por el lector interno existente, sin consultas de producto a la tienda ni otro sincronizador. El puente conserva su alcance previo para inventario/historial y futura lectura comercial. Ver `CATALOG-PLAN.md`. Master Control continúa intacto; cantidades y precios web actuales se muestran únicamente como consulta hasta completar la validación comercial y el checkout.

Nuevo servicio y adaptadores propios; nuevas versiones del puente creado en esta tarea. Master Control, tienda y checkout permanecen en su alojamiento y conservan código/configuración. Datos originales y archivos ajenos se preservan. El runtime comienza cerrado a escrituras externas y automatizaciones hasta verificar el corte de cada módulo.
