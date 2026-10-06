# UM1 urgente — Identidad de productos

**Estado:** desarrollo. **Subentrega activa:** UM1.1. **Superficie:** VPS/web/App.
**La ficha no autoriza nuevas mutaciones; la operación productiva existente se registra como evidencia histórica y cada ampliación conserva sus gates.**

## Objetivo

Reemplazar Matcher, Cobertura y Guardia por un núcleo bilateral de Producto Fusion. UM1.1 es bloqueante: debe cerrar primero el universo actual de claves ML activas con stock y `SELLER_SKU` ausente, vacío, inexistente, ambiguo o contradictorio.

## Orden de entregas

1. `UM1.1`: núcleo mínimo y cierre inmediato de SKU ML.
2. `UM1.2`: eventos, scans, salud, alertas, claims y recuperación.
3. `UM1.3`: Producto Fusion completo, familias y bootstrap.
4. `UM1.4`: matching bilateral y tareas de publicación.
5. `UM1.5`: experiencia completa web/App y offline.
6. `UM1.6`: SKU canónico, corte estricto y retiro legacy.

No se avanza al modo estricto por existencia de código: cada ficha conserva sus propios gates y evidencia.

## Base heredada evaluada

La implementación anterior de Guardia aporta piezas reutilizables, pero no es la arquitectura objetivo:

- Casos, eventos, claims, excepciones, versiones optimistas y retenciones.
- Operaciones remotas persistidas antes del efecto, lease y backoff.
- Bloqueo de mutaciones legacy y E2E responsive existente.
- Auditoría anterior que observó 82 claves activas sin `seller_sku`, 4 decisiones con SKU inexistente, 20 stocks negativos y 511 SKU compartidos. Estas cifras son históricas y deben recalcularse.

La cobertura anterior dependía de `sku_matcher_decisiones` y no modelaba Producto Fusion, GTIN, evidencia versionada, stock verificado, saga completa ni paridad App. Los resultados anteriores se conservan como evidencia histórica, no como aceptación del nuevo UM1.

## Arquitectura objetivo

- Producto Fusion es la identidad canónica; Woo es autoridad de stock.
- Una clave ML solo queda cubierta con identidad y stock verificados remotamente en menos de 60 minutos o excepción explícita `solo_ml`.
- `fusion_sku = FB-{id_woo}`; provisional sin Woo no tiene SKU y no sincroniza.
- Auto-vínculo sólo por `SELLER_SKU` textual exacto único o identificador EAN/UPC/GTIN activo y único.
- La escritura de SKU es una sobrescritura directa durable, con stock Woo fresco y verificación remota; un fallo pasa a intervención sin fallback con stock cero.
- `solo_ml` es una exclusión administrativa de sincronización; publicación y stock quedan bajo operación manual en ML.
- Web y App comparten servicio de negocio, no autenticación ni adapters HTTP.
- Las transiciones de modo requieren canario y gates operativos; rollback significa `shadow/read-only` sin reactivar legacy.

## Base, rama y worktree

- Base documental de este cierre: `43cae13`, rama `conteo-confiable`, checkout `/opt/fusionbikes/herramientas`.
- Trabajo paralelo de Claude todavía no incorporado: rama `feature/um1-identidad-continuacion`, worktree `/opt/fusionbikes/worktrees/um1-identidad`, rango `43cae13..1d5b2c8`.
- Ese rango toca código, UI, tests y documentación; debe revisarse y reconciliarse antes de atribuir evidencia o gates.

## Gates de programa

- Revisión independiente sin críticos/altos.
- Tests dirigidos, contrato y suite global serial verdes.
- E2E 390/768/1440 y accesibilidad si cambia web.
- Prueba en iPhone real antes de aceptar App.
- Migración aditiva/idempotente, backup/rollback y auditoría de despliegue.
- Canario designado, piloto y jornada observada antes de habilitar acciones.

## Evidencia actual

- Especificación aprobada: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-04-identidad-productos.md`.
- Diseño UX/UI desde cero contrastado después contra Matcher, Cobertura y Guardia.
- Implementación UM1.1 y UM1.2: en curso; las fichas individuales conservan evidencia productiva e incidentes.
- Este cierre documental no ejecuta escrituras, despliegues ni gates operativos.

## Próxima acción reproducible

Revisar y reconciliar `43cae13..1d5b2c8` antes de integrarlo. Luego ejecutar los gates todavía pendientes en las fichas: suite global serial, jornada comercial observada y rollback en copia sanitaria más prueba productiva `shadow/read-only`. Sólo el usuario puede aceptar una subentrega.
