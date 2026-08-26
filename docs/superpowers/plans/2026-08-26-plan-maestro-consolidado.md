# Plan maestro — FusionBikes Herramientas (consolidado 2026-08-26)

## Contexto

Este es el plan único que reemplaza los fragmentos anteriores de esta sesión (reprioridad de
sync, notificaciones ML, Preparación, consolidación de ramas) más el backlog pendiente del
plan de José (conteo programado / control de stock por ciclos), que vivía separado en
`docs/superpowers/plans/2026-08-25-tracker-plan-jose.md`. El pedido explícito del usuario fue
un solo plan grande para que la próxima sesión "trabaje completo" sin tener que reconstruir
el estado desde varios archivos.

**Repo**: `/opt/fusionbikes/herramientas` (Node/Express ESM, better-sqlite3, vitest).
**Rama de producción real**: `conteo-confiable` (no `master` — son líneas distintas, ver
Bloque D). PM2 sirve desde ese checkout; el deploy a producción lo hace el usuario a mano
tras luz verde del `auditor-despliegue`.

**Regla operativa no negociable** (pedido explícito del usuario, reforzado varias veces esta
sesión): todo cambio de código pasa por el pipeline `hard-worker → revisor →
tester/probador-e2e → auditor-despliegue` antes de mergear a `conteo-confiable`. Los agentes
de rol están definidos en `.claude/agents/*.md` de este mismo repo — invocarlos con el tool
Agent (`subagent_type: general-purpose` o el nombre que corresponda), dándoles el prompt
"actuá como el rol de `.claude/agents/<rol>.md`, leelo primero".

**Incidente a tener en cuenta**: un `hard-worker-backend` despachado el 2026-08-26 no
respetó el worktree que se le asignó y comiteó directo sobre `conteo-confiable` (commit
`ffbac11`, contenido de la Fase 4 de Preparación abajo). Quedó ahí, sin revisar, con decisión
explícita del usuario de dejarlo así hasta retomarlo. **Verificar SIEMPRE**, después de cada
despacho de hard-worker, que el commit quedó en la rama del worktree asignado (`git -C
<worktree> rev-parse --abbrev-ref HEAD` y comparar con `conteo-confiable` real) — no asumir
que el reporte del agente es correcto.

**Hábito pedido por el usuario**: `git push origin <rama>` después de cada commit verificado,
no acumular horas sin sincronizar.

---

## Cola de prioridad (orden de trabajo)

1. **[Sync] Venta confirmada → cola de Preparación al instante.** Único gap de tiempo real
   verificado en el código (hoy 10 min de demora vía cron, sin disparo inmediato). Ver
   Bloque A.1. **Worktree ya creado, vacío**: `.claude/worktrees/prep-cola-instantanea`
   (rama `prep-cola-instantanea`, desde `conteo-confiable` en `f1c113d`).
2. **[Sync] Stock desde las herramientas → push inmediato con feedback visual.** Ya
   sincroniza rápido (webhook), falta que el usuario vea el estado. Ver Bloque A.2.
3. **[Sync] Cambio de stock por venta → sync puntual por orden, no barrido completo.**
   Optimización (ya es idempotente e inmediato). Ver Bloque A.3.
4. **[Notificaciones ML] Reclamos sumados a "Novedades ML".** Extiende lo ya desplegado. Ver
   Bloque A.4.
5. **[Conteo programado] Fase 5 — 3 fixes menores del revisor, sin desplegar todavía.** Ver
   Bloque B.1. Barato, cerrarlo rápido.
6. **[Conteo programado] Chequeo visual de Fase 1 (etiquetas) en navegador.** Nunca se hizo
   con Playwright — despachar `probador-e2e` acotado. Ver Bloque B.2.
7. **[Preparación] Fase 4 — retomar el commit sin revisar (`ffbac11`).** Pasarlo por el
   pipeline completo antes de decidir si se queda. Ver Bloque C.1.
8. **[Preparación] Fases 5 y 6 — horarios de corte, etiqueta interna, control de despacho.**
   Ver Bloques C.2 y C.3.
9. **[Consolidación] Unificar `master` y `conteo-confiable`.** Trabajo grande, bien mapeado,
   sin empezar. Ver Bloque D.
10. **Backlog disperso, no bloqueante** (hacer cuando haya un hueco, no bloquean nada). Ver
    Bloque E.

No hay que completar todo en orden estricto — es la prioridad relativa. Un ítem puede
adelantarse si el usuario lo pide, como ya pasó esta sesión.

---

## Bloque A — Sync ML↔Woo (reprioridad de notificaciones, 2026-08-26 tarde)

### Contexto técnico (verificado en código antes de priorizar, no asumido)

- `syncMlToWc` (`routes/sync.js:245`, venta ML → ajusta stock en Woo) — **ya es idempotente**
  (tabla `ordenes_ml_procesadas`) y **ya se dispara por webhook** (`topic:'orders'` en
  `server.js`, no solo cron). Pero hace un barrido completo (`/orders/search` paginado) en
  vez de traer solo la orden puntual del `resource` de la notificación.
- `syncWcToMl` (`routes/sync.js:924`, nuestro stock → ML) — **ya se dispara por webhook** de
  Woo (`server.js` línea ~77, inmediato). Pero recalcula TODOS los diffs pendientes de la
  tabla `computed` (CTE), no solo el SKU que cambió, y no hay ningún feedback visual de
  "sincronizando/sincronizado/error" en el panel para quien edita a mano.
- `syncPedidosCache` (`routes/preparacion.js:2049`, llena `pedidos_cache`/la cola de
  Preparación) — **es SOLO cron cada 10 min**, sin ningún disparo inmediato por webhook. Hace
  3 llamadas secuenciales a Woo por estado (`lpaandreani`, `completed`, enviado) y arma cada
  fila con `filaWebDesdeOrder`/`upsertPedidoCache`.
- Notificaciones ML: la app tiene (o va a tener) TODOS los topics seleccionados en el panel
  de developers — el filtro de qué procesar vive en el código
  (`POST /api/ml/notificacion`, `server.js`), no en el panel. Ya implementado: `orders`
  (preexistente), `questions` y `messages` (desplegado hoy, ver Bloque A.4 para sumar
  `claims`). El resto (`orders_v2`, `shipments`, `orders_feedback`, `items`, `invoices`) se
  reciben y se descartan en silencio hasta que se sume su función.

### A.1 — Venta confirmada → cola de Preparación al instante (PRIORIDAD 1)

**Worktree**: `.claude/worktrees/prep-cola-instantanea` (rama `prep-cola-instantanea`), ya
creado desde `conteo-confiable`, vacío — usar ese, no crear otro.

- Función nueva puntual (ej. `syncPedidoWebPuntual(db, wooCfg, wcOrderId)` en
  `routes/preparacion.js`, o donde el `hard-worker-backend` decida que encaja mejor con el
  patrón existente) que traiga SOLO la orden dada (`wooFetch(wooCfg, /orders/${id})`) y haga
  upsert inmediato en `pedidos_cache` reusando `filaWebDesdeOrder`/`upsertPedidoCache` ya
  existentes — no reimplementar esa lógica.
- Para el lado ML (topic `orders`/`orders_v2`), función equivalente puntual que traiga solo
  la orden del `resource` y haga upsert en `pedidos_cache` con canal `ml`.
- Disparar ambas desde los webhooks ya existentes: el de Woo (`server.js` línea ~77, junto a
  `syncWcToMl`) y el de ML (`server.js`, handler de `POST /api/ml/notificacion`, junto a
  `syncMlToWc`) — agregar la llamada, no reemplazar lo que ya dispara.
- El cron de 10 min (`syncPedidosCache`) queda como respaldo — si el webhook falla o no
  llega, el cron lo termina agarrando. No quitar el cron.
- Marcar visualmente como "nuevo" en la pantalla de Preparación, con el tiempo transcurrido
  (reusar el patrón `haceMin()` ya usado en `public/preparacion/index.html`).
- Tests: llegada de webhook → aparece en `pedidos_cache` sin esperar al cron; llegada
  duplicada → no duplica fila (usar el mismo upsert `ON CONFLICT` ya existente); webhook
  falla → el pedido igual aparece en la corrida de cron siguiente (no se pierde).

### A.2 — Stock desde las herramientas → push inmediato con feedback visual (PRIORIDAD 2)

- Ubicar dónde el usuario edita stock a mano en el panel (buscar en `public/stock/`,
  `routes/woo.js`, o donde corresponda — no asumido todavía, investigar primero).
- Al guardar una edición de stock, disparar un push puntual a ML por ese SKU específico (no
  esperar el recálculo general de `syncWcToMl`) y mostrar un estado visible en la UI:
  `sincronizando` → `sincronizado` / `error` (con detalle si falla, para que el usuario sepa
  que tiene que revisar).
- Decidir con el `hard-worker-backend`/`hard-worker-frontend` si conviene una función puntual
  nueva (`syncSkuPuntual`) o alcanza con acotar `syncWcToMl` a un solo SKU vía parámetro.

### A.3 — Cambio de stock por venta → sync puntual por orden (PRIORIDAD 3, optimización)

- Cambiar `syncMlToWc` para que, cuando lo dispare una notificación con `resource` puntual,
  procese solo esa orden (`mlFetch(db, mlCfg, 'get', resource)` en vez de la búsqueda
  paginada completa `/orders/search`). La búsqueda paginada completa queda como respaldo del
  cron (mismo criterio que A.1: no quitar el barrido, solo dejar de depender de él para el
  camino rápido).
- Idempotencia y demás lógica de `_procesarOrden` no cambian — solo la fuente de la lista de
  órdenes a procesar.

### A.4 — Reclamos sumados a "Novedades ML" (PRIORIDAD 4)

- Extender `routes/notificacionesMl.js` (ya existe, desplegado) con el topic `claims` —
  mismo patrón que `questions`/`messages`: tabla nueva (`ml_reclamos` o similar), función
  `ingerirReclamo(db, mlCfg, resource)` fail-open, sumar al conteo de `/count` y a la lista de
  `/pendientes`, sumar al aviso del Home.
- Agregar el `if (topic === 'claims')` en el handler de `server.js`.
- Migración `.sql` nueva (018, siguiente número libre — confirmar cuál es el último antes de
  numerar).

---

## Bloque B — Conteo programado (plan de José): backlog pendiente

Plan completo original: `docs/superpowers/plans/2026-08-plan-jose-control-stock-ciclos.md`.
Tracker con el detalle fase por fase: `docs/superpowers/plans/2026-08-25-tracker-plan-jose.md`
(no reescribir ese archivo, solo consultarlo — este plan maestro resume lo que falta).

**Ya desplegado, no tocar salvo bug nuevo**: Ruptura 1 (ajuste por delta), Fase 0 completa,
Fases 1-5 completas (etiquetas persistentes, ubicaciones, rotación/criticidad, planificador
de ciclos, auditoría de calidad de publicación). Buscador del contador. Fix de duplicado de
fila de conteo por SKU con dos códigos.

### B.1 — Fase 5: 3 fixes menores del revisor, sin aplicar todavía

En `lib/auditoria.js`/`routes/auditoria.js` (Fase 5, auditoría de calidad de publicaciones):
1. Métrica `sin_clip` en `/resumen` es semánticamente ambigua — renombrar a
   `sin_video_en_ml` o filtrar por `estado_clip` (a decidir cuál es más preciso mirando el
   código real).
2. `ensureAuditoriaTable` suprime errores en silencio — loguearlos.
3. El test de rotación de cursor no aserta el valor correcto — corregir el assert.

Worktree nuevo desde `conteo-confiable`, pipeline completo (chico, debería ser rápido).

### B.2 — Chequeo visual de Fase 1 (etiquetas) en navegador

Fase 1 (cola de etiquetas persistente, `routes/etiquetas.js` + pestaña "Cola de conteo") está
integrada y desplegada, pero nunca se verificó visualmente con Playwright (no había
disponible en el despacho original). Despachar `probador-e2e` acotado al flujo: marcar
"Necesita etiqueta" desde el conteo → aparece en la pestaña "Cola de conteo" de Etiquetas →
imprimir → desaparece de la cola.

### B.3 — Backlog no bloqueante (hacer cuando haya hueco, no bloquea nada)

- Botón "descartar" en la UI de historial de ajuste por delta (hoy solo existe en backend).
- Caso dual-EAN en `/aprobar` marca `ajustado_en` de más (contracara de un bug ya arreglado
  en `/rechazar`).
- Reintento de `/confirmar` puede duplicar fila de alerta para un faltante que falló en Woo.
- `FB-1419` no lo captura la heurística de sugerencias de `no_contable` — marcar a mano por
  ahora, o mejorar la heurística.
- `test/matcherPush.test.js` tiene un timeout intermitente bajo suite completa, documentado y
  confirmado no relacionado con ningún cambio — no es urgente, pero si molesta seguido
  conviene aumentar el timeout o aislar mejor el test.
- Completar `WOO_WEBHOOK_SECRET` en `.env` del VPS (tarea operativa del usuario, no de
  código: sin esto el webhook de Woo acepta cualquier payload sin validar firma HMAC —
  obtenerlo desde WooCommerce → Ajustes → Avanzado → Webhooks → editar → copiar secreto).
- Corregir el resultado de `/confirmar` (pantalla de Inventario): los sobrantes pendientes se
  muestran en rojo como si fueran errores. Deben verse en naranja (distinguirlos de un fallo
  real) y el mensaje debe aclarar explícitamente qué falta hacer para aplicarlos.
- `routes/inventario.js` — dos filas de `inventario_conteos` pueden compartir el mismo `sku`
  (la unicidad es por `sesion_id+ean`, no por sku): si eso pasa (ej. se escanea el GTIN de
  fábrica de un producto fuera de alcance y después se asocia una etiqueta desconocida
  distinta al mismo SKU) y se borra una de las dos filas, el `DELETE` de limpieza de
  `inventario_sesion_alcance` (agregado en el fix de `f765068`) puede borrar el alcance de la
  fila que sigue viva, dejándola sin `stock_inicial` y rompiendo `/confirmar` con
  "stockInicial requerido". Preexistente, pero ahora alcanzable desde `/asociar`. Fix
  sugerido por el revisor: condicionar el DELETE a `AND NOT EXISTS (SELECT 1 FROM
  inventario_conteos WHERE sesion_id=? AND sku=?)`.

---

## Bloque C — Preparación de envíos (provincia, direcciones, notas, despacho)

**Ya desplegado y pusheado** (rama `conteo-confiable`, hasta commit `f1c113d`):
- **Fase 1** — Provincia y armado de dirección: `nombreProvincia()` mapea código corto →
  nombre completo; `splitDireccion()` no pierde/mezcla el número de calle. Verificado contra
  40 pedidos reales.
- **Fase 2** — Confirmar envío vs. facturación: `direccionesDifieren()` + gate 409 en
  `POST /iniciar` + modal de elección + persistencia en `preparaciones.direccion_confirmada_*`.
  Verificado contra 100 pedidos reales (1% con diferencia real, sin falsos positivos).
- **Fase 3** — Nota del pedido visible: `customer_note` cacheado en `pedidos_cache`,
  persistido en `preparaciones.notas`, visible en lista y detalle.
- Las tres pasaron pipeline completo (revisor, probador-e2e, auditor-despliegue 🟢).

### C.1 — Fase 4: retomar el commit sin revisar (`ffbac11`)

**Estado real**: implementada pero **sin pasar por ningún gate** — el hard-worker que la
hizo comiteó directo sobre `conteo-confiable` en vez del worktree asignado
(`.claude/worktrees/prep-vinculos`, rama `prep-vinculos-comprador`, sigue vacía). El commit
`ffbac11` ya está en `conteo-confiable` local y pusheado a `origin` (como respaldo, no como
código en producción — no se desplegó, PM2 no se reinició con este cambio).

Contenido de `ffbac11` (solo backend, sin frontend): tabla `preparacion_vinculos`
(`migrations/016_preparacion_vinculos.sql`), `detectarVinculoEntrePedidos()` en
`lib/preparacion.js` (prioridad DNI/CUIT → email → teléfono → nombre+dirección, normalizado),
detección disparada en `POST /iniciar` (O(n), no O(n²)), endpoints
`GET /api/preparacion/vinculos/:clave` y `POST /api/preparacion/vinculos/:id/decidir`. 13
tests dirigidos, corridos aislados por el propio hard-worker (verdes, no la suite completa).

**Qué hacer**: mover el trabajo a una rama propia limpia (`git branch
prep-vinculos-comprador-real ffbac11`, o extraer el diff y aplicarlo en el worktree correcto
— decidir la forma más limpia sin perder el trabajo), pasarlo por `revisor` (con foco en si
el diseño de detección O(n) en `POST /iniciar` es realmente correcto, y si la ausencia de
frontend deja el backend inútil o es aceptable como entrega parcial), decidir si hace falta
frontend (modal para decidir "un solo paquete" / "separados pero vinculados" / "no es la
misma persona" — el diseño original preveía esto, ver historial de la sesión si hace falta
más detalle) antes de dar la fase por completa, `probador-e2e` y `auditor-despliegue` antes
de considerarla desplegable.

### C.2 — Fase 5: Horarios de corte y cola de despacho

Sin empezar. Diseño (de la sesión original, no cambiar sin avisar):
- Tabla `despacho_horarios`: una fila por día de la semana (`dia` 1-7, PK), `habilitado`
  (booleano), `hora_corte` (`HH:MM` local). Semilla: lunes a viernes habilitados, corte
  16:00; sábado y domingo deshabilitados. Editable desde una pantalla simple (patrón
  fetch+upsert como `config-ml`).
- Columna `fecha_despacho` calculada al detectar el pedido: si ya pasó el corte del día, o el
  día no está habilitado, es el próximo día habilitado; si no, hoy.
- El operario puede igual despachar el mismo día aunque `fecha_despacho` diga otra cosa (cola
  sugerida, no bloqueo duro). Al despachar, el `estado` existente ya evita que reaparezca.
- Para ML: no se configura nada — `fecha_despacho` de un pedido ML sale directo de la fecha
  estimada de envío que ya trae el shipment de ML (`ml_shipment_estado`).

### C.3 — Fase 6: Etiqueta interna 50×25mm + Pantalla de control de despacho

Sin empezar. Depende de C.2 (fecha_despacho) y C.1 (vínculos entre pedidos). Diseño:
- Al completar una preparación, generar un código interno corto e imprimir una etiqueta
  50×25mm con ese código (reusar el generador CODE128/JsBarcode de `public/etiquetas/`),
  para ambos canales (web y ML) — no depender del tracking de Andreani/ML, que no siempre
  existe todavía en ese momento.
- Nuevo paso posterior al armado: al cargar el paquete para despacho, escanear esa etiqueta
  con `public/lib/scanner.js` — valida que corresponda a una preparación completada y no
  cargada todavía, marca `cargado_en`/`cargado_por`.
- Pantalla nueva de control de despacho: permiso binario nuevo (`despacho`, como
  `etiquetas`), agrupa por canal y por `fecha_despacho` de hoy, muestra cuántos deberían
  salir vs. cuántos ya se escanearon, con los vínculos de C.1 visibles.

**Verificación de C.2/C.3**: prueba manual en navegador con copia de la base
(`DB_PATH=<copia> DISABLE_CRONS=true PORT=<libre>`, `ml_oauth_token` vaciado), desktop y
390px — el aviso bloqueante de direcciones y de vínculos de pedidos no deben sentirse como
fricción para el caso común (la mayoría de los pedidos no van a tener domicilios distintos ni
compradores duplicados).

---

## Bloque D — Consolidar `master` y `conteo-confiable` en una sola línea

Trabajo grande, bien mapeado en una investigación anterior de esta sesión, sin empezar.
Confirmar antes de arrancar que las condiciones del Paso 0 siguen vigentes (puede haber
cambiado desde que se mapeó esto).

### Contexto

Las dos ramas divergieron el 2026-08-19 (`merge-base` = `ba04632`). `master`: matcher de
ingreso, asociación de EAN en Preparación (código sin su revisión E2E formal todavía),
Consulta de Precios/GTIN auditada, protección de concurrencia en vínculos de Cobertura.
`conteo-confiable`: todo el módulo de Contador de Inventario (Bloque B de este plan) más las
Fases de Preparación (Bloque C). Hubo un intento de reconciliación anterior (`aa0b21f`, rama
`integracion-master-conteo`) que resolvió 17 conflictos con criterio explícito por archivo,
pero quedó sin fusionar y ambas ramas siguieron avanzando — sirve de guía de criterio, no de
solución aplicable tal cual (han pasado 30-40+ commits de cada lado desde entonces, y ahora
más con el trabajo de esta sesión).

**Objetivo**: una sola rama (`master`) con todo lo real de ambas líneas, sin duplicados, con
la suite verde, que termine reemplazando a `conteo-confiable` como rama de PM2.

**Decisiones ya tomadas con el usuario**:
- Ejecutar recién después de confirmar que no hay nadie más trabajando en vivo sobre
  `conteo-confiable` (repetir la verificación del Paso 0, la situación puede haber cambiado).
- De `worktree-matcher-unificado-v2` (motor ML↔Woo alternativo, nunca mergeado, 10 commits)
  solo rescatar la lógica útil (el motor espejo ML→Woo, atado de token a `client_id`,
  revalidación cruzada del 409), no un merge completo — su diff borra scripts de orquestación
  que el equipo usa hoy y reescribe media suite de tests.
- El plan de "asociar EAN en Preparación" (solo en `master`) se consolida igual, pero queda
  marcado como no apto para producción hasta cerrar su revisión E2E pendiente.
- Al final, `master` reemplaza a `conteo-confiable` en PM2.

### Paso 0 — Confirmar que no hay nadie trabajando en vivo (bloqueante, repetir)

1. `ps aux | grep claude` — sin procesos de terminal real ajenos trabajando sobre el repo.
2. `git log --all --since="15 minutes ago" --oneline` sobre `conteo-confiable` — sin commits
   nuevos recientes que no sean de esta sesión.
3. Releer `docs/memory/active.md` del propio repo por si hay una nota de "PAUSA" de otra
   sesión — confirmar que no hay, o que ya se cerró.

### Paso 1 — Preparar el terreno

- `git tag pre-consolidacion-conteo-confiable conteo-confiable` y
  `git tag pre-consolidacion-master master` (red de seguridad, no depender de memoria de
  hashes).
- Worktree nuevo para la integración (no reusar `.claude/worktrees/integracion`, construido
  sobre un punto viejo): `git worktree add .claude/worktrees/consolidacion-master master`.

### Paso 2 — Mergear `conteo-confiable` dentro de `master`

`git merge conteo-confiable` en el worktree de consolidación. Resolución esperada por
archivo (releer el contenido actual antes de aplicar, no confiar ciegamente en que sigue
igual a como se mapeó):

| Archivo | Criterio |
|---|---|
| `routes/inventario.js` | Base **conteo-confiable** (todo el módulo del Bloque B vive acá). |
| `routes/preparacion.js` | Base **master** (asociación EAN, `persistirGtinConfirmado`, `subirGtinAWoo`), reaplicando el fix de preparaciones huérfanas de `conteo-confiable`. **Ojo**: este archivo tiene además todo lo nuevo del Bloque C y del Bloque A (sync puntual) — coordinar el orden real cuando se llegue acá. |
| `routes/consultaPrecios.js`, `lib/gtinWoo.js`, `public/consulta-precios/index.html`, `docs/api-contrato.md` (sección GTIN) | Base **master** (versión auditada, `parsearIdWoo()` estricto). |
| `server.js` | Base **conteo-confiable** (refactor grande, incluye el webhook HMAC y ahora los cambios del Bloque A). Reaplicar el cambio puntual de `master` si sigue vigente. |
| `lib/wooStock.js` | Base **conteo-confiable** (ajuste por delta anti-sobreventa, código de negocio crítico — no perder ni una línea). |
| `public/inventario/index.html` | Base **conteo-confiable** (evolucionó ahí: cierre seguro, buscador, ubicaciones). Confirmar que no se pierde nada de `master`, no asumir que es historia superada. |
| `public/matcher/index.html` | Base **master** (accesibilidad `:focus-visible`). |
| `agents/model-routing.md`, `scripts/orchestrate-claude.mjs` | Base **conteo-confiable** (más nuevo). |
| `routes/codigos.js` | Sin criterio previo — evaluar caso por caso. |
| `docs/memory/active.md`, `agents/skill-routing.md`, `package.json`, `CLAUDE.md`, docs de agentes | Combinar aditivamente, no descartar contenido de ningún lado sin leerlo. |
| Archivos de test compartidos | Combinar aditivamente. **Ojo**: el auto-merge puede fusionar dos declaraciones de la misma variable sin marcar conflicto y dejar un `SyntaxError` que solo se ve corriendo los tests, no en el diff (ya pasó una vez con `skuPorEan`/`skusPorGtin` en `aa0b21f`). |
| Archivos exclusivos de `conteo-confiable` (`db/index.js`, `lib/permisos.js`, `lib/criticidad.js`, `routes/criticidad.js`, `routes/etiquetas.js`, `routes/auditoria.js`, `routes/notificacionesMl.js`, `public/auditoria/index.html`, `public/etiquetas/index.html`) | Se traen enteros. |
| Archivos exclusivos de `master` (`lib/ingresoMatcher.js`, `lib/matcherEngine.js`, migraciones de `pack_id`, `public/login/index.html`) | Se traen enteros. |
| `routes/cobertura.js` | Traer la protección de concurrencia optimista de `master` (`expected_sku`, 409 con `ya_resuelto`) — `conteo-confiable` no la tiene, es pérdida real de protección si se descarta. Verificar que el frontend de Cobertura mande `expected_sku`. |

### Paso 3 — Verificar que no se perdió nada de negocio crítico

Confirmar con grep/lectura, antes de commitear el merge: el gate fail-closed de
`/confirmar` (inventario), el ajuste por delta, `cerrarEnCero` sin `todos:true` para
`con_stock`, la subida de GTIN a Woo con `parsearIdWoo` estricto, el fix del webhook WC
(HMAC antes de `express.json()`), el auto-confirmar de publicaciones ML huérfanas, el matcher
de ingreso y sus tests, y todo lo nuevo del Bloque A (sync puntual) y Bloque B/C si ya están
mergeados para cuando se llegue a este paso.

### Paso 4 — Suite completa, una sola vez, sin nada más corriendo

`pgrep -af "vitest|node.*server"` limpio antes de correr. `npx vitest run` completo. Meta:
verde total, salvo los fallos ya documentados y confirmados ajenos (`test/auditoria.test.js`,
timeout intermitente de `matcherPush.test.js` bajo carga). Commitear el merge recién con la
suite en verde.

### Paso 5 — Rescatar del matcher unificado v2 solo lo que sirve

En worktree aparte, revisar los 10 commits de `worktree-matcher-unificado-v2`
(`6ce2de0`..`cdadb01`) para separar la lógica de negocio rescatable (motor espejo ML→Woo,
atado de token a `client_id`, revalidación cruzada del 409) de lo que NO se toca (borrado de
scripts de orquestación, reescritura de la suite de tests). Portar manualmente, como cambio
nuevo con sus propios tests — no `cherry-pick` directo.

### Paso 6 — Prueba manual antes de cortar tráfico

Servidor con copia de la base (`DB_PATH=<copia> DISABLE_CRONS=true PORT=<libre, nunca
3001>`, `ml_oauth_token` vaciado). Probar: conteo completo (escanear, cerrar en cero,
confirmar con el gate), asociar EAN desconocido en Preparación (dejando constancia de que
sigue sin su revisión E2E formal), Consulta de Precios (enseñar EAN y subir a Woo), que
Auditoría de publicaciones cargue y tenga link desde Home.

### Paso 7 — Cortar tráfico: `master` pasa a servir el VPS

Push del resultado consolidado a `master` real. Reapuntar PM2: parar el proceso actual,
actualizar el working directory a `master`, `pm2 restart herramientas`. Confirmar salud
post-restart. Dejar `conteo-confiable` intacta un tiempo prudencial como red de seguridad,
con nota en memoria de que quedó congelada en favor de `master`.

---

## Bloque E — Deuda operativa dispersa (no bloqueante, hacer cuando haya hueco)

- Rotar `WOO_CS` (quedó expuesto en `/tmp` el 2026-08-10).
- Completar `WOO_WEBHOOK_SECRET` en el `.env` del VPS (ver Bloque B.3, es tarea del usuario).
- Timeout intermitente de `matcherPush.test.js` bajo suite completa — aumentar timeout o
  aislar mejor si sigue molestando.
- Asignar el permiso `notificaciones-ml` a quien corresponda desde la pantalla de Usuarios
  (nadie lo tiene todavía, el aviso del Home no se le muestra a nadie hasta asignarlo).
- Confirmar la URL real del link "Ver en MercadoLibre" en el aviso del Home
  (`https://myaccount.mercadolibre.com.ar/questions/list` — no se pudo verificar en vivo
  contra el panel real, es solo un link de conveniencia, bajo impacto si está mal).
