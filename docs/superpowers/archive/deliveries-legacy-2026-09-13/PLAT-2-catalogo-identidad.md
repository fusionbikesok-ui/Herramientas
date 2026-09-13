# P2 — Catálogo e identidad

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` (§3.1–§3.3, §6, §7). Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada — ficha de orientación, no especificación decision-complete.** Requiere plan propio aprobado antes de iniciar.
- Objetivo: catálogo completo y única identidad de producto en el núcleo, con un solo motor de matcher y un solo ejecutor remoto. Reemplaza UM1.1–UM1.6, E9 (familias e identidad), Matcher, Cobertura, Guardia ML y el vigía de formato.
- Alcance que el plan de P2 debe cubrir explícitamente:
  - **Catálogo completo:** `product_models` y `sellable_variants`; padre Woo `variable` nunca vendible; SKU `FB-{ID_WOO}` obligatorio, inmutable y no reutilizable.
  - **Taxonomía y contenido:** categorías jerárquicas, marcas, colecciones, atributos, unidades, vocabularios, imágenes, textos `es-AR` y procedencia (el diseño de plantillas y la estandarización masiva son P5).
  - **Cuentas de canal:** empresa, cuentas ML/Woo, clave externa por (empresa, cuenta, canal, tipo, ID, variación).
  - **Overlays por canal:** estructura reservada para contenido y precios ML, **sin escritores activos** en este programa.
  - **GTIN:** sólo evidencia; conflicto → caso de catálogo con tres resoluciones auditadas. Por **PM-153** los GTIN conflictivos (incluidos los Venzo marcados `incorrecto`) **no bloquean el desarrollo**: migran como **casos abiertos auditados** y sólo bloquean el corte los que tengan riesgo comercial concreto (publicación activa con stock vendiendo contra ese código).
  - **Packs y kits:** composición versionada; cada venta conserva el snapshot aplicado.
  - **Matcher único:** auto-vínculo sólo con `seller_sku` exacto y único; lo demás es sugerencia.
  - **Vigía de formato — dos reglas distintas que no se mezclan:**
    - cambio de `seller_sku` en un vínculo humano confirmado → **sólo alerta**, no reasigna ni detiene stock;
    - cambio de producto de catálogo, formato o unidades por pack → **pausa durable y revalidación**.
  - **Reglas de migración:** importar sólo vínculos con SKU exacto único o decisión humana unívoca; duplicados, contradicciones y objetivos cambiantes vuelven a revisión; campaña coordinada para los 39 SKU vendibles fuera de `FB-{ID}` (pausar, cambiar Woo/ML, verificar, reanudar).
  - **Passkeys:** activación para catálogo/administración condicionada a la prueba en dispositivos reales con `qa-herramientas` en HTTPS (decisión de José 2026-09-13).
- Responsable operativo: José. Técnico: asistente.
- Base, rama y worktree: `plataforma/` en este repo, rama por subentrega; se fija en el plan de P2.
- Feature flags y piloto: se fijan en el plan de P2 (canario por cuenta de canal).

## Subentregas (un único corte final de la vertical)

1. **P2.1 Esquema:** tablas, restricciones, estados y tests de invariantes (unicidad, FK, archivo, decisión vigente única).
2. **P2.2 Importación:** crosswalk desde SQLite/Woo/ML con hashes; reporte de lo que no entra y por qué.
3. **P2.3 Dominio:** matcher único, casos, resoluciones y comandos durables (sin ejecutarlos remoto).
4. **P2.4 UI:** pantallas de catálogo, identidad y casos sobre API v2 (responsive, WCAG 2.2 AA).
5. **P2.5 Sombra:** el núcleo decide en paralelo al legado y se comparan decisiones; 0 escrituras remotas.
6. **P2.6 Simulación:** comandos contra el simulador de canales en QA, incluidos fallos 403/408/429/5xx.
7. **P2.7 Campaña correctiva:** 39 SKU irregulares, duplicados y decisiones contradictorias. Los GTIN conflictivos **no** son requisito de la campaña (PM-153): migran como casos abiertos y sólo entran si tienen riesgo comercial concreto.
8. **P2.8 Cutover:** congelar escritores legacy de la vertical, delta final, conciliación exacta, único ejecutor remoto, canario y ampliación.

## Gates y aceptación propios

- Gates del programa (corte < 15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Conciliación exacta de modelos, variantes, vínculos y casos contra el crosswalk; 0 decisiones contradictorias vigentes.
- Sombra: ≥ 7 días con decisiones del núcleo iguales al legado o diferencias explicadas una por una.
- Vigía de formato probado con las dos reglas (alerta vs. pausa) contra fixtures reales.
- Ningún escritor de Matcher, Guardia o Identidad legacy activo después del corte.

## Métricas, SOP y riesgos

- Métricas: casos abiertos por tipo y antigüedad, auto-vínculos por día, pausas por formato, comandos en DLQ.
- SOP a escribir: resolución de GTIN conflictivo, campaña de SKU irregular, reversión del corte a shadow/read-only.
- Riesgos: pausar publicaciones vendiendo durante la campaña (mitigar con ventanas y canario); falsos positivos del vigía de formato (fixtures de packs reales).

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: no ejecutado
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: No iniciado. Medido 2026-09-13 con `conciliacionIdentidad()`: 1.055 verificadas, 11 esperando operación y 0 urgentes; 0 conflictos de bolsa `user_product` compartida.
- Consultas para refrescar cifras (solo lectura sobre `data/fusion.sqlite`):
  - `conciliacionIdentidad(db)` de `lib/identidadProductos.js` (universo conciliado: publicaciones ML activas con stock del marketplace; un `GROUP BY estado` sobre `identidad_casos` incluye históricos y da otra cifra)
  - `SELECT COUNT(*) FROM catalogo_cache WHERE coalesce(tipo,'') <> 'variable' AND sku <> 'FB-' || id_woo;` (vendibles fuera de `FB-{ID_WOO}`; 39 al 2026-09-13: 5 simples y 34 variaciones)
  - `conflictosDeBolsaCompartida(db)` de `lib/identidadProductos.js`
- Próxima acción exacta y reproducible: con P1 aceptado, escribir `docs/superpowers/plans/AAAA-MM-DD-p2-catalogo-identidad.md` cubriendo cada punto de "Alcance" y las subentregas P2.1–P2.8, y pedir aprobación a José.
- Confirmación: sin secretos ni datos personales.
