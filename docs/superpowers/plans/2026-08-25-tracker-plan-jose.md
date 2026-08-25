# Tracker: plan de control de stock de José

Plan completo: `docs/superpowers/plans/2026-08-plan-jose-control-stock-ciclos.md` ("Control
de stock por ciclos + etiquetas + auditoría de calidad", 5 fases + 11 rupturas; Ruptura 1 ya
resuelta). Este archivo trackea
el estado de ejecución fase por fase para no perder contexto entre sesiones.

## Estado

| Ítem | Estado | Rama/commit | Nota |
|---|---|---|---|
| Ruptura 1 — ajuste por delta anti-fantasma | ✅ **Desplegado** | `fix-delta-stock-inventario` → mergeado a `conteo-confiable` (5a7867f) | 2026-08-25. 3 rondas de revisor, 1371 tests verdes, auditor 🟢. Backlog: botón "descartar" en UI de historial (solo backend hoy). |
| Fase 0 — resto (no_contable, inventario_diferencias, freno $100k, negativos, ritmo) | ✅ **Desplegado** | `fase0-higiene-inventario` → mergeado a `conteo-confiable` (be7fc31) | 2026-08-25. 3 rondas de revisor (una con sonda real de bug dual-EAN), 1392 tests verdes, auditor 🟢. Endpoints nuevos verificados en vivo post-deploy (401 correcto, no 404). Backlog no bloqueante: `/aprobar` en caso dual-EAN marca `ajustado_en` de más (contracara del bug ya arreglado en `/rechazar`); reintento de `/confirmar` puede duplicar fila de alerta para un faltante que falló en Woo; `FB-1419` no lo captura la heurística de sugerencias de `no_contable` (marcar a mano); hallazgo pre-existente no relacionado: `test/matcherPush.test.js` tiene un timeout roto de antes, confirmado en `conteo-confiable` limpio. |
| Fase 1 — Etiquetas persistentes | 🟡 Integrada, PM2 sin reiniciar | `fase1-etiquetas-persistentes` → mergeada a `conteo-confiable` (`198d1ff`) | 2026-08-25. Cola persistente `etiquetas_cola` + `routes/etiquetas.js` + botón "Necesita etiqueta" en el conteo + pestaña "Cola de conteo" en Etiquetas. Revisor: 1 hallazgo importante (DELETE borraba ítems ya impresos) corregido en `29847e3`. 11/11 tests dirigidos + suite completa verde (matcherPush.test.js timeout intermitente ya documentado, no relacionado). **Falta un chequeo manual en navegador antes de reiniciar PM2** — no hubo Playwright disponible en el despacho, así que no se verificó visualmente. |
| Fase 2 — Ubicaciones | ✅ **Desplegado** | `fase2-ubicaciones` → mergeada a `conteo-confiable` (merge commit) | 2026-08-25. Tablas `ubicaciones` + `producto_ubicacion`, alcance de sesión por ubicación (mutuamente excluyente con categoría/marca), captura automática al escanear/asociar, cierre en cero seguro (Rupturas 3 y 6: exige ubicación mapeada, excluye SKUs con overflow o sin ubicación registrada). Revisor: 2 hallazgos importantes corregidos (colisión entre sesiones sobre la misma ubicación vacía; banner de alcance grande pegado al cambiar de categoría a ubicación). 169/169 tests + suite completa verde (matcherPush.test.js timeout intermitente ya documentado). PM2 reiniciado, health OK. Pendiente: alguien pruebe una vez en el navegador el flujo real (crear ubicación, escanear, mapear, cerrar en cero) — sin Playwright disponible en el despacho. |
| Fase 3 — Rotación y criticidad | ✅ **Desplegado** | `fase3-rotacion-criticidad` → mergeada a `conteo-confiable` (merge commit) | 2026-08-25. `ventas_historial` (backfill diario WC+ML, cron `0 5 * * *`) + `calcularCriticidad()` (score 0..1: ventas 12m 40%, diferencias 30%, categoría crítica 20%, valor de stock 10%, calculado on-demand sin tabla cacheada). Revisor: 2 hallazgos corregidos (subconteo por SKU repetido en un mismo pedido de Woo, `.trim()` faltante en fallback `seller_sku` de ML). Sin pantalla propia — infraestructura para el planificador de Fase 4. 15/15 tests + suite completa verde. |
| Fase 4 — Planificador de ciclos | ⬜ Pendiente | — | Depende de Fases 2 y 3. Incluye el aviso de Home (plan aparte: `2026-08-24-aviso-control-stock-home.md`, en cola). |
| Fase 5 — Auditoría de calidad de publicación | ⬜ Pendiente | — | Depende de Fase 4. |


## Bug crítico corregido fuera de plan (2026-08-25)

- **Duplicado de fila de conteo por SKU con dos códigos** (`fix-duplicado-conteo-sku` → mergeado a `conteo-confiable`). `/escanear` deduplicaba por el código literal escaneado, no por el SKU resuelto: un producto con GTIN de fábrica Y etiqueta de SKU generaba dos filas de conteo, y al confirmar cada una disparaba su propio ajuste de stock contra el mismo `stock_inicial` congelado — la segunda escritura podía pisar el ajuste real de la primera y dejar el stock en Woo más bajo de lo que correspondía, en silencio. Ahora dedupea por SKU cuando ya se conoce. 158/158 tests. Desplegado.


## Pedido de José (2026-08-25) — pendiente de encarar

- **Buscador en el Contador de inventario.** ✅ **Desplegado** (`buscador-contador` → mergeado a `conteo-confiable`). Filtro de texto en cliente por SKU/nombre sobre la lista ya cargada, sin ida y vuelta al servidor. Revisor: 1 hallazgo importante corregido (la búsqueda no se limpiaba al cambiar de sesión). Los contadores de arriba (Contados/Pendientes/Con diferencia) siguen mostrando el total real, nunca lo filtrado. Sin cambios de backend, archivo estático — no requirió reiniciar PM2.

## Regla operativa para retomar

- **Un solo hard-worker activo a la vez** (`agents/model-routing.md`). No despachar la fase
  siguiente hasta que la actual llegue a veredicto 🟢 del auditor o quede explícitamente
  pausada.
- Cada fase se trabaja en su propio worktree/rama, pasa por el pipeline completo
  (hard-worker → revisor → tester → auditor) antes de mergear a `conteo-confiable` (la rama
  que sirve este VPS — **no** `master`, que es otra línea de trabajo).
- Verificar siempre con datos reales de la base antes de asumir números del plan original
  (fueron medidos el 2026-08-24/25, pueden haber cambiado).

## Fase 0 — resto, alcance de este despacho

De la Fase 0 original del plan, lo que falta (Ruptura 1 ya está hecha):

1. `catalogo_cache.no_contable INTEGER NOT NULL DEFAULT 0` + endpoint de sugerencias
   (stock absurdo >500, sin marca) + confirmación manual. Excluir de entrada conocida:
   Service Completo (FB-2618), Service Control (FB-2617), Tubelizado (FB-13813), GIFT CARD
   (FB-4903), Parte de pago (FB-1419) — verificar que esos SKUs sigan siendo los mismos
   antes de hardcodear nada como sugerencia inicial.
2. Tabla `inventario_diferencias` (histórico por SKU) + la regla de freno real que pidió
   José: **faltantes se aplican siempre** (ya lo hace el ajuste por delta, esto es solo el
   registro histórico), **sobrantes por encima de $100.000 o más del 50% esperado frenan
   para revisión antes de escribir**. Esto es DISTINTO del fail-closed de
   `setStockWcDelta` (que ya está desplegado) — acá el número sí llega a calcularse, se
   registra, y si supera el umbral se guarda como "pendiente de confirmar" en vez de
   ajustarse de una, con un endpoint para que José lo apruebe o corrija.
3. `stock_negativo_alertas` — enganchar al `refrescarCatalogo` de `routes/woo.js` que ya
   detecta y loguea negativos (hoy 19). Banner en Home listando los negativos actuales.
4. Medición de ritmo: `iniciado_en`, `segundos_activos`, `items_contados` en
   `inventario_sesiones`. Cálculo de percentil 25 por usuario (no promedio — ver Ruptura 8
   del plan grande, José y Joaco difieren 5x).

FUERA de este despacho: FB-65576 (duplicado, corrección en WooCommerce, no es código de la
app — avisar a José aparte); Fases 1-5.
