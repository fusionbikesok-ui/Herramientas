# P5 — Estandarización de catálogo

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` (§3.2, §6 punto 6). Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada — ficha de orientación, no especificación decision-complete.** Requiere plan propio aprobado antes de iniciar.
- Objetivo: catálogo normalizado y publicado en Woo por lotes revisables, que después alimente búsqueda facetada, navegación, SEO y accesibilidad del storefront (esos cambios del storefront son un plan posterior).
- Alcance que el plan de P5 debe cubrir:
  - **Categoría primaria, marca y colecciones comerciales** (p. ej. Hotsale) separadas.
  - **Plantillas versionadas por categoría/familia:** atributos requeridos y recomendados, tipo, unidad, vocabulario y uso como faceta.
  - **Vocabularios y unidades** controlados; normalización de valores existentes.
  - **Atributos obligatorios** por plantilla con validación antes de publicar.
  - **Preparación para facetas, SEO y accesibilidad:** datos listos (atributos facetables, textos, imágenes con descripción), sin cambiar el storefront en este programa.
  - **Revisión por lote con vista previa:** propuesta, diff por producto, aprobación humana.
  - **Publicación verificada y compensación:** comando auditado a Woo, verificación posterior y comando compensatorio si un lote sale mal.
- Responsable operativo: José. Técnico: asistente.
- Base, rama y worktree: `plataforma/`; se fija en el plan de P5.
- Feature flags y piloto: primer lote en una categoría acotada; se fija en el plan de P5.

## Subentregas

1. **P5.1 Modelo:** plantillas, vocabularios, unidades y reglas de validación.
2. **P5.2 Propuestas:** generación de propuestas por categoría con evidencia y confianza.
3. **P5.3 Revisión:** UI de lote con vista previa, diff y aprobación.
4. **P5.4 Publicación:** comandos a Woo con verificación y compensación, primero en QA con simulador.
5. **P5.5 Campaña:** lotes por categoría con canario y ampliación.

## Gates y aceptación propios

- Gates del programa más §20 del maestro.
- Ningún lote publicado sin aprobación humana registrada.
- Verificación posterior del 100 % de lo publicado; compensación probada en QA.
- Porcentaje de productos con atributos obligatorios completos por categoría medido antes y después.

## Métricas, SOP y riesgos

- Métricas: productos por plantilla, cobertura de atributos obligatorios, lotes aprobados/rechazados/compensados.
- SOP: revisión de lote, compensación de lote, alta de plantilla nueva.
- Riesgos: cambios masivos visibles para clientes (mitigar con lotes chicos, vista previa y compensación).

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: no ejecutado
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: No iniciado.
- Consultas para refrescar cifras (solo lectura):
  - `SELECT COUNT(*) FROM catalogo_cache WHERE coalesce(atributos_json,'[]')='[]';` (productos sin atributos)
  - `SELECT COUNT(DISTINCT marca) FROM catalogo_cache;`
- Próxima acción exacta y reproducible: con P4 aceptado, escribir `docs/superpowers/plans/AAAA-MM-DD-p5-estandarizacion.md` con el alcance y las subentregas P5.1–P5.5, y pedir aprobación a José.
- Confirmación: sin secretos ni datos personales.
