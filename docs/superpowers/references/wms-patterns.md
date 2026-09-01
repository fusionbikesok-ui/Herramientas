# Patrones WMS evaluados para FusionBikes

Actualizado: 2026-09-01. Estas referencias son guías, no requisitos por prestigio. Un patrón se adopta solo si resuelve un escenario confirmado para 31–100 pedidos diarios y mejora una métrica observable.

| Patrón | Fuente oficial | Problema | Adaptación Fusion | Complejidad descartada | Entrega / métrica |
| --- | --- | --- | --- | --- | --- |
| Wave picking | [Odoo](https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/wave.html), [SAP EWM](https://help.sap.com/docs/SAP_SUPPLY_CHAIN_MANAGEMENT/57574d15fa1d414792d74047b66c3e41/6dc8cb53ad377114e10000000a174cb4.html) | Reducir recorridos sin perder urgencias | Ola inicial congelada, mini-olas continuas y prioridad ML | Automatización de oleadas para grandes centros | E1; tiempo de picking y pedidos tardíos |
| Putaway dirigido | [Odoo](https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/putaway.html) | Evitar stock recibido sin ubicación | Ubicación base/overflow sugerida y confirmada en dos pasos | Estrategias volumétricas y multi-almacén avanzadas | E9, E14; tiempo entrada→ubicación |
| Conteo por trabajo y revisión | [Dynamics 365](https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/cycle-counting) | Separar captura ciega de ajuste | Snapshot, captura móvil, reconciliación y control por riesgo | Work pools y políticas corporativas no necesarias | E16–E17; exactitud y reconteos |
| Puesto de empaque | [SAP EWM](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/9832125c23154a179bfa1784cdc9577a/ec54c1ceebe744d788aa4800750aa4e0.html) | Vincular contenido, paquete, evidencia y etiqueta | Preparación por paquete, evidencia aprobada y etiqueta interna | Automatización industrial, balanza y dimensiones | E2–E4; reaperturas y errores de paquete |
| Procesamiento móvil WMS | [Oracle NetSuite WMS](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_156382465711.html) | Ejecutar tareas en el punto físico | Inicio urgente, escaneo, claims, lease y cola offline provisional | Suite ERP, RF especializado y licenciamiento | E13–E21; latencia y conflictos |

## Criterio de incorporación

Toda propuesta debe registrar escenario real, volumen, alternativa más simple, dato de línea base, métrica esperada, costo operativo y mecanismo de reversión. La similitud visual con un WMS conocido no es evidencia de valor.
