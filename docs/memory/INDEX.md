# Índice de memoria

Este archivo es un router, no una enciclopedia. Leelo junto con `/opt/fusionbikes/herramientas/docs/memory/active.md` y abrí solo los
módulos cuyo disparador coincida con la tarea.

| Tema o disparador | Módulo a leer |
| --- | --- |
| Arquitectura, estructura, contratos internos, decisiones transversales | `/opt/fusionbikes/herramientas/docs/memory/modules/architecture.md` |
| MercadoLibre, WooCommerce, ventas, publicaciones, sincronización, precios | `/opt/fusionbikes/herramientas/docs/memory/modules/integrations-ml-woo.md` |
| VPS, staging aislado, dependencias, pipeline, backup y despliegue | `/opt/fusionbikes/herramientas/docs/memory/modules/operations-vps.md` |
| Pantallas, navegación, responsive, accesibilidad, pruebas en navegador | `/opt/fusionbikes/herramientas/docs/memory/modules/ui-ux.md` |
| Preparación, depósito, stock, recepción, conteos y despacho | `/opt/fusionbikes/herramientas/docs/memory/modules/warehouse-operations.md` |
| App móvil, ramas, contrato móvil y sincronización entre repositorios | `/opt/fusionbikes/herramientas/docs/memory/modules/mobile-app.md` |
| Coordinación entre agentes, worktrees, handoffs, fichas y gates | `/opt/fusionbikes/herramientas/docs/agent-coordination.md` |
| Especificación canónica, decisiones, archivo, fichas y SOP | `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md` |

La vigencia de planes y specs se consulta en `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md`; no trates un documento fechado como instrucción actual sin esa clasificación.

## Reglas de mantenimiento

- Actualizá únicamente los módulos afectados por un cambio verificado.
- Editá este índice solo cuando cambie el mapa de temas.
- Creá un módulo cuando el tema tenga identidad propia y vaya a reutilizarse; evitá archivos
  por cada conversación o ticket.
- Sustituí hechos obsoletos. La historia detallada pertenece a Git, no a esta memoria.
- No almacenes secretos, credenciales, cookies, tokens, transcripciones, razonamiento ni logs.
