# Entregas vigentes E0–E26

Esta es la única lista operativa. Las fichas anteriores están en `../archive/` y sólo se consultan
mediante `../crosswalk-entregas.md`.

| Entrega | Nombre | Estado | Ficha |
|---|---|---|---|
| E0 | Infraestructura, DR y PITR | desarrollo | [E0](E0-infraestructura-dr.md) |
| E1 | Fundación PostgreSQL en sombra | planificada | [E1](E1-fundacion-sombra.md) |
| E2 | Modelo e importación del catálogo | planificada | [E2](E2-catalogo-modelo-importacion.md) |
| E3 | Identidad y matcher en sombra | planificada | [E3](E3-identidad-matcher-sombra.md) |
| E4 | Campaña SKU y corte de identidad | planificada | [E4](E4-catalogo-identidad-corte.md) |
| E5 | Libro de stock y reservas | planificada | [E5](E5-stock-libro-dominio.md) |
| E6 | Recepción y conteos sobre el libro | planificada | [E6](E6-recepcion-conteos-libro.md) |
| E7 | Corte de autoridad de stock | planificada | [E7](E7-stock-corte.md) |
| E8 | Orden canónica e importación | planificada | [E8](E8-pedidos-modelo-importacion.md) |
| E9 | Dominio de pedidos | planificada | [E9](E9-pedidos-dominio.md) |
| E10 | UI y preparación en sombra | planificada | [E10](E10-pedidos-ui-preparacion-sombra.md) |
| E11 | Corte de pedidos y despacho | planificada | [E11](E11-pedidos-corte.md) |
| E12 | Plantillas y propuestas | planificada | [E12](E12-estandarizacion-modelo-propuestas.md) |
| E13 | Publicación por categorías | planificada | [E13](E13-estandarizacion-publicacion.md) |
| E14 | Inventario y apagado legacy | planificada | [E14](E14-legado-inventario-archivo.md) |
| E15 | Compatibilidad y retiro | planificada | [E15](E15-legado-compatibilidad-retiro.md) |
| E16 | Excepciones físicas | planificada | [E16](E16-excepciones-fisicas.md) |
| E17 | Garantías y posventa | planificada | [E17](E17-garantias-posventa.md) |
| E18 | Taller web y Woo | planificada | [E18](E18-taller-web-woo.md) |
| E19 | Base App y OTA | planificada | [E19](E19-app-base-ota-fachadas.md) |
| E20 | Bandeja y turnos App | planificada | [E20](E20-app-bandeja-turnos.md) |
| E21 | Infraestructura offline | planificada | [E21](E21-app-offline-comun.md) |
| E22 | Recepción y conteos iPhone | planificada | [E22](E22-app-recepcion-conteos.md) |
| E23 | Taller iPhone | planificada | [E23](E23-app-taller.md) |
| E24 | Impresión y agente Windows | planificada | [E24](E24-impresion-agente-windows.md) |
| E25 | Métricas y reposición | planificada | [E25](E25-metricas-reposicion.md) |
| E26 | Consolidación y cierre | planificada | [E26](E26-consolidacion-cierre.md) |

Antes de cambiar una ficha se ejecuta `npm run docs:validate-deliveries`. El generador sólo se usa
cuando cambió deliberadamente `delivery-program.json`; nunca reemplaza evidencia agregada durante una
entrega sin revisar el diff.
