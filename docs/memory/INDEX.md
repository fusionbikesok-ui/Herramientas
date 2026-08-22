# Índice de memoria

Este archivo es un router, no una enciclopedia. Leelo junto con `active.md` y abrí solo los
módulos cuyo disparador coincida con la tarea.

| Tema o disparador | Módulo a leer |
| --- | --- |
| Arquitectura, estructura, contratos internos, decisiones transversales | `modules/architecture.md` |
| MercadoLibre, WooCommerce, ventas, publicaciones, sincronización, precios | `modules/integrations-ml-woo.md` |
| VPS, staging, dependencias del sistema, procesos, despliegue | `modules/operations-vps.md` |
| Pantallas, navegación, responsive, accesibilidad, pruebas en navegador | `modules/ui-ux.md` |
| Coordinación entre agentes, worktrees, handoffs y gates | `../agent-coordination.md` |

Los planes y especificaciones históricas están en `docs/superpowers/`; consultalos solo si
un módulo o la tarea remite a uno concreto.

## Reglas de mantenimiento

- Actualizá únicamente los módulos afectados por un cambio verificado.
- Editá este índice solo cuando cambie el mapa de temas.
- Creá un módulo cuando el tema tenga identidad propia y vaya a reutilizarse; evitá archivos
  por cada conversación o ticket.
- Sustituí hechos obsoletos. La historia detallada pertenece a Git, no a esta memoria.
- No almacenes secretos, credenciales, cookies, tokens, transcripciones, razonamiento ni logs.
