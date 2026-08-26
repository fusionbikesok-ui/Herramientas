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
| Fase 4 — Planificador de ciclos | ✅ **Desplegado** | `fase4-planificador-ciclos` → mergeado a `conteo-confiable` (5fba5fb) | 2026-08-25. `sku_ultimo_conteo` sembrado automáticamente al confirmar (Ruptura 9). GET /api/inventario/plan-hoy (propone la sesión del día: ubicación mapeada más urgente o bootstrap por categoría) + GET /api/inventario/dirigido (lista SKUs más urgentes, solo informativo). Revisor: filtrar `producto_ubicacion` contra catálogo contable (SKU descontinuado no infla urgencia). 10/10 tests + 38/38 tests de Fases 1-3 sin regresiones. PM2 reiniciado, health OK. Sin frontend propio: los datos que expone son la base para un tablero futuro. |
| Fase 5 — Auditoría de calidad de publicación | ✅ **Desplegado** | `fase5-auditoria-calidad` → mergeado a `conteo-confiable` | 2026-08-26. `auditoria_publicacion` (health, fotos, video). Barrido automático cada 15 min via ML multiget (chunks de 20). Cola priorizada por problemas + frontend en /auditoria/. PATCH estado-clip por publicación. 13/13 tests verdes. PM2 reiniciado, health OK. Ver pendientes abajo. |


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


## Sobreventa FB-67289 (2026-08-26) — incidente resuelto + medidas

**Causa raíz:** `ml_publicaciones_cache` tenía `MLA1957482833` con `seller_sku=FB-67289` desde el 2026-08-19, pero `sku_matcher_decisiones` no tenía entrada → `syncWcToMl` nunca controló su stock → ML vendió con WC stock=0.

**Medidas tomadas:**
1. Script `fix_huerfanas.mjs` corrido manualmente → 55 publicaciones huérfanas activas incorporadas al matcher con `accion='confirmar'`.
2. **Cron cada 30 min** en `server.js` que auto-confirma publicaciones huérfanas nuevas (activas, con seller_sku válido en catálogo, sin entrada en matcher) — cierra el agujero permanentemente.
3. **Webhook WC → sync inmediato a ML** (`POST /api/woo/webhook/order`): cuando WC registra una venta (processing/completed/on-hold), dispara `syncWcToMl` en segundos en lugar de esperar hasta 10 min del cron. Configurado en WooCommerce apuntando a `herramientas.fusionbikes.com.ar/api/woo/webhook/order`.
4. **Endpoint ML notifications** (`POST /api/ml/notificacion`): cuando ML registra una orden, dispara `syncMlToWc` inmediatamente. Endpoint deployado y operativo.

## Pendiente de configurar (no bloqueante para operación diaria)

| Ítem | Responsable | Detalle |
|---|---|---|
| Configurar notificaciones ML en ML Developers | José | App ID 4179977906546572 → Notificaciones → URL: `https://herramientas.fusionbikes.com.ar/api/ml/notificacion`, topic: `orders`. Endpoint ya deployado y operativo — solo falta activarlo en el panel. |
| Completar `WOO_WEBHOOK_SECRET` en `.env` del VPS | José | Obtener el secreto desde WooCommerce → Ajustes → Avanzado → Webhooks → editar el webhook → copiar el secreto. Luego en VPS: `echo 'WOO_WEBHOOK_SECRET=<valor>' >> /opt/fusionbikes/herramientas/.env && pm2 restart herramientas`. Sin esto el webhook acepta cualquier payload (no valida firma HMAC). |
| Switch `conteo-confiable` → `master` en producción | José + dev | Una vez todas las fases terminadas y validadas, mover el PM2 a servir desde `master`. |
| Fase 5: fixes menores del revisor | Dev (próxima sesión) | (1) Métrica `sin_clip` en `/resumen` es semánticamente ambigua — renombrar a `sin_video_en_ml` o filtrar por `estado_clip`. (2) Loguear errores en `ensureAuditoriaTable` en vez de suprimirlos. (3) Test de rotación de cursor no aserta el valor correcto. |
| Chequeo visual Fase 1 en navegador | José | Fase 1 (etiquetas) está integrada pero no se verificó visualmente con Playwright — hacer una prueba manual en `herramientas.fusionbikes.com.ar` antes de confirmar como lista. |
