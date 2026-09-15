# Entregas vigentes E0–E26

Esta es la única lista operativa. Los números son identidades estables; la columna Dependencias
define el DAG. El archivo histórico sólo se consulta mediante el crosswalk.

| Entrega | Resultado | Dependencias | Estado | Ficha |
|---|---|---|---|---|
| E0 | Infraestructura, DR y PITR | — | desarrollo | [E0](E0-infraestructura-dr.md) |
| E1 | Fundación PostgreSQL en sombra | E0 | planificada | [E1](E1-fundacion-sombra.md) |
| E2 | Modelo e importación del catálogo canónico | E1 | borrador | [E2](E2-catalogo-modelo-importacion.md) |
| E3 | Identidad y matcher único en sombra | E2 | borrador | [E3](E3-identidad-matcher-sombra.md) |
| E4 | Campaña SKU y corte de catálogo/identidad | E3 | borrador | [E4](E4-catalogo-identidad-corte.md) |
| E5 | Libro de stock, apertura y reservas | E4 | borrador | [E5](E5-stock-libro-dominio.md) |
| E6 | Recepción y conteos sobre el libro | E5 | borrador | [E6](E6-recepcion-conteos-libro.md) |
| E7 | Sombra y corte de autoridad de stock | E6 | borrador | [E7](E7-stock-corte.md) |
| E8 | Orden canónica e importación | E1 | borrador | [E8](E8-pedidos-modelo-importacion.md) |
| E9 | Dominio de pedidos y efectos remotos | E5, E8 | borrador | [E9](E9-pedidos-dominio.md) |
| E10 | UI, preparación y simulación de pedidos | E9 | borrador | [E10](E10-pedidos-ui-preparacion-sombra.md) |
| E11 | Corte de pedidos, preparación y despacho | E7, E10 | borrador | [E11](E11-pedidos-corte.md) |
| E12 | Plantillas y propuestas de catálogo | E2 | borrador | [E12](E12-estandarizacion-modelo-propuestas.md) |
| E13 | Publicación verificada por categorías | E4, E12 | borrador | [E13](E13-estandarizacion-publicacion.md) |
| E14 | Inventario, archivo y apagado reversible del legado | E11, E13 | borrador | [E14](E14-legado-inventario-archivo.md) |
| E15 | Compatibilidad y retiro físico autorizado | E14, E23, E24 | borrador | [E15](E15-legado-compatibilidad-retiro.md) |
| E16 | Excepciones físicas y proveedor | E7 | borrador | [E16](E16-excepciones-fisicas.md) |
| E17 | Garantías y posventa | E8, E16 | borrador | [E17](E17-garantias-posventa.md) |
| E18 | Taller web y venta Woo | E17 | borrador | [E18](E18-taller-web-woo.md) |
| E19 | Base App, contrato y migración OTA | E1 | borrador | [E19](E19-app-base-ota-fachadas.md) |
| E20 | Bandeja, alertas, turnos y reemplazos en App | E9, E19 | borrador | [E20](E20-app-bandeja-turnos.md) |
| E21 | Infraestructura móvil offline común | E19 | borrador | [E21](E21-app-offline-comun.md) |
| E22 | Recepción y conteos en iPhone | E6, E21 | borrador | [E22](E22-app-recepcion-conteos.md) |
| E23 | Taller en iPhone | E18, E21 | borrador | [E23](E23-app-taller.md) |
| E24 | Impresión y agente Windows | E10 | borrador | [E24](E24-impresion-agente-windows.md) |
| E25 | Métricas, reposición, entrante y preventa | E7, E11 | borrador | [E25](E25-metricas-reposicion.md) |
| E26 | Consolidación y cierre del programa | E13, E15, E16, E17, E18, E20, E22, E23, E24, E25 | borrador | [E26](E26-consolidacion-cierre.md) |

Antes de cambiar una ficha se ejecuta `npm run docs:validate-deliveries`. El generador sólo se usa
cuando cambió deliberadamente `delivery-program.json` y el diff resultante siempre se revisa.
