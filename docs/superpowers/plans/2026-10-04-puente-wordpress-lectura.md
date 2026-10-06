# Puente WordPress de lectura — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verificar desde el VPS las versiones y los precios reales de Master Control sin crear otra credencial ni modificar ventas.

**Architecture:** Plugin aislado que registra dos rutas GET bajo `wc/v3` y reutiliza la autenticación WooCommerce existente. Instanciación de DataService/PricingEngine para lecturas comerciales; ninguna tarea programada. Este paso prepara la migración, no es una entrega funcional de los módulos migrados.

**Tech Stack:** PHP >=7.4, WordPress >=6.4, WooCommerce REST v3, contrato comercial 1 de Master Control; Node del VPS para sonda de sólo lectura.

**Spec:** `../specs/2026-10-04-puente-wordpress-lectura.md`. Alcance concreto de este paso: status y cotización de una unidad por producto; no hay nuevas pantallas ni escritura comercial.

## Global Constraints

- La tienda y el checkout permanecen en su alojamiento actual.
- Reutilizar claves Woo del VPS sin copiarlas al navegador, a archivos de prueba o a logs.
- Nunca usar el `price` de REST estándar como base del POS: `IntegrationsController::forceApiPrices` transforma esa representación.
- No cambiar las rutas existentes de WooCommerce ni hooks de precio.
- Master Control queda íntegro y excluido de la migración por instrucción explícita del usuario. No cambiar su código, configuración ni administración.
- No cobrar, emitir comprobantes, enviar mensajes, modificar clientes ni stock.
- Preservar cambios previos del repositorio; la implementación se prepara en una copia local identificada por commit.
- El usuario autorizó la integración, eligió acceso WordPress administrador y dejó sesión iniciada. No volver a pedir el acceso al VPS ni proponer otra clave sin necesidad.

## Task 1: Lectura comercial protegida y prueba de sus límites

**Files:**
- Create: `integrations/wordpress/fusion-herramientas-bridge/fusion-herramientas-bridge.php`
- Create: `integrations/wordpress/fusion-herramientas-bridge/readme.txt`
- Test: `integrations/wordpress/tests/bridge-test.php`
- Update: `docs/memory/modules/integrations-ml-woo.md`

**Interfaces:**
- Consumes: `DataService::getAllAllowedTypes()`, `getCoefficient(id,plan)`, `appliesNave(id)`; `PricingEngine::getBasePrice(product)`, `getUnitPrice(id,product,plan)`.
- Produces: GET `/wc/v3/fusion-herramientas/status` y `/wc/v3/fusion-herramientas/commercial-products?ids=...`, sin caché pública. Máximo 25 IDs únicos; respuestas de producto disponible, no disponible, sin precio o tipo no vendible.
- Unidad monetaria: cadena decimal y código de moneda Woo. `quantity=1`; el checkout debe revalidar. No multiplicar importes unitarios redondeados para otras cantidades.

- [x] Registrar plugin independiente sin hooks de activación, tablas, opciones ni cron.
- [x] Probar acceso sin sesión (401), rol insuficiente (403), HTTP (403) y gestión Woo por HTTPS.
- [x] Probar IDs ausentes, negativos, duplicados, arrays, SQL, rango y lotes >25.
- [x] Probar con los servicios comerciales originales: oferta, precio regular, excepción de variante y padre, redondeo y coeficiente inválido.
- [x] Probar producto privado, padre privado, variable y producto sin precio.
- [x] Probar respuestas sin caché pública y sin detalles de excepción; todos los métodos registrados son GET.
- [x] Ejecutar los tests PHP en un contenedor efímero sin red, con límites de CPU/memoria y archivos montados sólo lectura.

Ejemplos de aceptación que debe ejecutar el harness:
```php
assert(Bridge::parse_ids('12,34') === [12,34]);
assert(Bridge::allowed()->get_error_data()['status'] === 401); // usuario anónimo
// Precio base 100,01 y coeficiente 1,1: PricingEngine devuelve 111,00 para una unidad.
assert($response->get_data()['items'][0]['plans'][0]['unit_amount'] === '111.00');
```

## Task 2: Validación de instalación y conexión

**Files:**
- Package: `outputs/fusion-herramientas-bridge-v0.1.0.zip` (archivo en el workspace de esta tarea).
- Evidence: `outputs/conexion-migracion-verificada.json` (sin secretos ni registros personales).
- Update: memoria relacionada con contratos y estado de despliegue, sólo después de cambios efectivos.

**Interfaces:**
- Consumes: endpoints del Task 1; `WOO_URL`, `WOO_CK`, `WOO_CS` existentes en el VPS.
- Produces: evidencia de instalación, acceso autenticado y denegación anónima, o limitación concreta si la comprobación falla.

- [x] Empaquetar sólo el plugin revisado y sus instrucciones.
- [x] Instalar/activar el plugin independiente desde la sesión WordPress autorizada, una vez comprobado el código.
- [x] Comprobar GET anónimo denegado y GET autenticado con las claves existentes exitoso.
- [x] Consultar un producto público y comparar la representación comercial obtenida; no recorrer todo el catálogo como prueba.
- [x] Verificar que los cinco plugins originales continúan activos y las pasarelas mantienen el estado registrado.
- [x] Activación sin errores observados; no fue necesario retirar el puente. Si un fallo posterior requiere retirada, desactivar exclusivamente el puente.
- [x] Registrar que el puente no migra módulos ni reduce carga por sí solo. El siguiente paso funcional debe trasladar datos/consultas a Herramientas, con su plan y ensayos propios.

No aplicar aquí migraciones nativas de Herramientas ni ejecutar su suite completa: no se modifica su runtime. La conexión se prueba con lecturas acotadas; el despliegue posterior de los módulos tendrá sus propios gates.
