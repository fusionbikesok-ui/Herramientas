# Estado activo

Actualizado: 2026-08-25.

## PRIORIDAD — producción sirve una rama que divergió de `master`

**Nada de lo integrado en `master` está en producción, y no alcanza con `pm2 restart`.**
pm2 corre desde `/opt/fusionbikes/herramientas`, que está en la rama **`conteo-confiable`**.
El restart del 2026-08-25 reinició el proceso con el mismo código de siempre: el fix de
preparaciones huérfanas **no se activó** y los 13 pedidos siguen invisibles.

Las ramas divergieron:

| | |
|---|---|
| `master` tiene y `conteo-confiable` no | **76 commits** (C2/C3 GTIN, nombre en mobile, huérfanas, matcher de ingreso) |
| `conteo-confiable` tiene y `master` no | **42 commits** — no son docs: cierre seguro del conteo, asociación GTIN en inventario, serialización de escrituras, el incidente de sobreventa |

El WIP que estaba sin commitear en ese checkout (y por lo tanto **vivo en producción sin figurar
en ninguna rama**) quedó registrado en **`e1896ad`**, sin cambiar lo que produccion sirve. Era una
iteración anterior del trabajo de GTIN que `master` ya integró mejor (`master` extrajo la
validación a `parsearIdWoo()`; el WIP la tiene escrita a mano y duplicada). No pasó por ningún gate.

### ⚠️ El riesgo del despliegue NO es el merge — son los 76 commits sin desplegar

Reencuadre del revisor, verificado: `git diff master aa0b21f` da **5 archivos, 52 inserciones**.
Los 43 commits de `conteo-confiable` aportaron **solo** dos comentarios, el fix del `catch` de
`reactivarItems` y dos alias en `orchestrate-claude.mjs`. `master` ya había reimplementado todo lo
demás por su cuenta: `routes/inventario.js` es **byte-idéntico** a producción salvo un comentario.

Entonces: **el merge es casi inocuo; lo que se despliega es `master` entero contra una producción
que corre otra rama.** `routes/consultaPrecios.js` difiere **208 líneas** de lo que corre hoy y
`routes/preparacion.js` **372**. El gate del tester y el E2E deben dimensionarse por eso — cubrir
Consulta de Precios y Preparación **completas**, no el delta del merge.

**Las greps de supervivencia (`cerrarEnCero`, `pendientesConStock`, etc.) NO son evidencia**: dan
el mismo resultado en las dos ramas y en el merge. Habrían pasado igual con una rama descartada
entera. No usarlas como prueba de que no se perdió trabajo.

**Cómo comparar contra producción sin engañarse**: la forma correcta de dimensionar el riesgo es
correr la suite en el merge y en la rama que sirve producción, y contrastar. Pero **las dos suites
no pueden correr en paralelo**: el repo ya documenta que la suite completa no convive con otra
corrida y que bajo carga produce fallos con forma de aserción real, indistinguibles de una
regresión. Correrlas juntas invalida la comparación. Van **secuenciales**, y todo archivo en rojo
se re-corre aislado en ambas ramas antes de creerle.

**Migraciones** (verificado contra la base real): producción está en 014, el merge trae 019-022.
`pack_id` ya está aplicada; `woo_paso1_incierto` falta pero `routes/preparacion.js:224-228` hace el
`ALTER TABLE` idempotente en `ensureTables` y se autorepara al arrancar; el backfill 022 es no-op
(0 filas afectadas). **Sin pasos manuales pendientes.**

### Gate del tester — CERRADO

Suite completa sobre el merge (`aa0b21f`): **1397/1400 verdes**, 2 rojos. Ambos re-corridos
aislados: `reactivar-automatico` pasa solo; `matcherPush` también, 28/28 en la primera corrida.

Al comparar contra la rama de producción (`conteo-confiable`, worktree de control en
`/tmp/control-conteo-confiable`), `matcherPush` aislado **falló 3 corridas seguidas ahí, un test
distinto cada vez**. Antes de leerlo como regresión: `load average` de la máquina en 4.05, con dos
sesiones remotas de Claude, un Chromium de Playwright y un servidor Ollama corriendo en paralelo
sin relación con esta tarea. Son tests con timeout atado a reloj real
(`TIEMPO_MAX_CORRIDA_MS`) — bajo esta carga, cualquiera se pasa de su ventana. Mismo patrón que ya
documenta este archivo más abajo (2026-08-21: "un archivo en rojo, distinto cada vez"). Afecta a
las dos ramas por igual; no es señal de regresión del merge.

**Conclusión del gate**: sin regresión real detectada. Los flaky son de infraestructura de la VPS,
no del contenido del merge.

### Gate del probador-e2e — CERRADO, 🟢🟢

Consulta de Precios y Preparación (las dos que más difieren de lo desplegado): 0 errores JS reales,
mensajes claros ante los fallos esperados de Woo, responsive limpio en 1440/768/390. Único ⚪:
`en_curso` no verificable con Playwright de un solo hilo (ya sabido, no bloqueante). Instancia
aislada apagada y limpiada; producción real (`:3001`) sin tocar.

### Gate del auditor-despliegue — EN CURSO

Sin autorización de merge en este despacho: dado que se activan 76 commits nunca antes en
producción, el merge y el `pm2 restart` los autoriza Matías explícitamente, no el pipeline solo.

### Estado: conflictos RESUELTOS, gate del tester cerrado

Merge hecho en `aa0b21f`, worktree `.claude/worktrees/integracion`, rama
`integracion-master-conteo`. **Todavía no mergeado a `master`** — esperando los gates.

Verificado que sobrevivió el trabajo de **ambos** lados: cierre seguro del conteo y gate de
sobreventa (`pendientesConStock`) de `conteo-confiable`; fix de huérfanas, GTIN y matcher de
ingreso de `master`. Tests dirigidos: **356/356** en `consultaPrecios`, `inventario`,
`preparacion` e `ingreso-matcher`.

**Defecto del automerge que hay que conocer:** git fusionó sin marcar conflicto dos declaraciones
idénticas de `skuPorEan`/`skusPorGtin` (una por rama) y `routes/preparacion.js` dejaba de cargar
(`SyntaxError: Identifier 'skuPorEan' has already been declared`). **Lo detectaron los tests, no
el merge.** Corregido a mano. Es el recordatorio de que en un merge de este tamaño el "sin
conflictos" de git no significa que el resultado funcione.

### Plan de integración (referencia de cómo se resolvió)

Worktree `.claude/worktrees/integracion`, rama `integracion-master-conteo`, base `master`.
El simulacro de merge (`git merge --no-commit --no-ff conteo-confiable`, luego abortado) dio
**17 bloques de conflicto en 9 archivos**:

| Archivo | Bloques | Criterio de resolución |
|---|---:|---|
| `routes/consultaPrecios.js` | 6 | **Tomar `master`**: misma función de GTIN, versión auditada |
| `public/consulta-precios/index.html` | 4 | **Tomar `master`**: ídem |
| `docs/api-contrato.md` | 1 | **Tomar `master`**: refleja la API auditada |
| `test/consultaPrecios.test.js` | 1 | **Tomar `master`** |
| `routes/inventario.js` | 1 | ⚠️ **CUIDADO** — `conteo-confiable` tiene trabajo que `master` NO |
| `routes/preparacion.js` | 1 | ⚠️ **CUIDADO** — ídem, más el fix de huérfanas del lado `master` |
| `public/matcher/index.html` | 1 | Revisar caso por caso |
| `scripts/orchestrate-claude.mjs` | 1 | Revisar caso por caso |
| `docs/memory/active.md` | 1 | Este archivo; resolver a mano al final |

**El riesgo real está en los dos ⚠️**: `conteo-confiable` tiene ahí el cierre seguro del conteo y
la corrección del incidente de sobreventa (`docs/incidentes/2026-08-21-sobreventa-por-no-contado.md`),
que `master` no tiene; y `master` tiene encima el fix de huérfanas y el de GTIN en Preparación.
Hay que conservar **ambos lados**, no elegir uno. Resolver esto a las apuradas es exactamente cómo
se reintroduce un bug de la familia de la sobreventa.

Según `docs/agent-coordination.md`, **los conflictos los resuelve el coordinador**, no un agente
de entrega. Después de resolver: pipeline completo (revisor → tester → auditor) antes de mover pm2.

### Al terminar la integración

Recién ahí mover pm2 a `master` y reiniciar. Ese restart sí cambia lo que sirve producción, así
que conviene hacerlo con la app a mano para verificar (`/login/` HTTP 200, y las pantallas de
Preparación, Conteo y Consulta de Precios).

## En curso

- **Ingreso de Mercadería — Entrega B** (lo próximo a implementar). Plan aprobado: matching
  primero (hecho, ver abajo), después unificación. Falta:
  - Migración `proveedor_alias` con PK compuesta `(proveedor_norm, codigo_norm)` — el mismo código
    significa cosas distintas según el proveedor, y `mapeo_fusion.clave_normalizada` es PK global.
  - `lib/ingresoResolver.js` con la jerarquía: EAN (validado con `looksLikeGtin`) → alias aprendido
    → SKU exacto → `mapeo_fusion` → motor. Contar homónimos en cada nivel: `catalogo_cache.sku`
    **no es único** (21 duplicados verificados sobre 5112 filas).
  - Endpoints `POST /api/recepciones/resolver-items` (stateless, lo reusa la absorción de `/stock/`)
    y `POST /:id/items/:itemId/resolver` (con aprendizaje). Guardarraíl: dos ítems de la misma
    recepción apuntando al mismo `id_woo` → 409, y bloqueo en `confirmar` antes de tocar Woo.
  - UI de candidatos en `/recepcion/`, borrando `matchItem`/`fuzzyMatchItem` del frontend.
    Confirmación del 100% de las líneas al principio (decisión del usuario), midiendo correcciones.
  - **REQUISITO CRÍTICO (hallazgo N1 del revisor):** la query que arma el índice **DEBE traer
    `id_woo`**. La regla de empate se apoya en él; si viene `null`, la comparación da `false` y la
    protección contra elegir por orden de array **se apaga en silencio**. Anotado en el código.

- Plan aprobado de Ingreso de Mercadería (matching primero, unificación después). Entregas B/C/D
  pendientes: UI de candidatos + aprendizaje por proveedor (`proveedor_alias`, PK compuesta por
  proveedor porque el mismo código significa cosas distintas según quién lo emite); absorber
  `/stock/`, que hoy aplica stock a Woo **sin dejar ningún rastro**; unificar las 3 cards del menú.

## Integrado en `master` local (sin push, sin restart)

- `711319d` — C2/C3 GTIN: subir GTIN a Woo desde Consulta de Precios y asociar EAN desconocido en
  Preparación. Incluye `c0c6b84`, que corrigió 2 HIGH + 4 MEDIUM del revisor (mutex `eanEnCurso` en
  el closure del router, liberación en `try/finally`, estado `en_curso` en vez de valor mágico).
- `32dd5e6` — Contador de inventario: nombre completo del producto visible en mobile (las 3 reglas
  `.nombre` truncaban a una línea con ellipsis). CSS puro, no requiere restart.
- `e8ce5bb` — preparaciones huérfanas: `syncPedidosCache` cierra la preparación local cuando el
  pedido pasa a `enviado` en Woo por fuera del flujo de Seguimientos. Excluye
  `woo_paso2_pendiente=1` para no pisar el flujo `a_medias`. **Autosana los 13 casos reales**
  (14/08–22/08) en la primera corrida del cron post-restart.
- `0181d02` — **Entrega A del matcher de ingreso** (auditada 🟢). `lib/ingresoMatcher.js` +
  `construirWCIndex`/`contradiccionAtributo` en el motor. Corrige la corrupción de stock por
  colapso de variantes (remito con talles 41/43/45 → los tres a la variación "42"). Dos reglas
  propias del ingreso: la contradicción de atributo fuerza confianza baja (antes era solo
  desempate, por eso el motor tal cual también colapsaba), y el empate marca ambiguo → nunca
  elige solo. El revisor hizo dos pasadas y cerró 2 hallazgos 🔴: contradicciones falsas en
  productos sin `atributos_json` (rompía el caso mayoritario) y empate entre productos distintos
  con título idéntico. **Es lógica pura todavía sin conectar**: el único consumidor es su test,
  así que el merge no cambia producción ni requiere restart.

## Próximo paso

1. **Integrar `conteo-confiable` en `master`** (ver el bloque de PRIORIDAD arriba). Es lo que
   bloquea que cualquier cosa mergeada llegue a producción. Un `pm2 restart` solo NO alcanza.
2. Decidir push de `master` (**28 commits** por delante de `origin/master`).
3. Implementar Entrega B (ver arriba), en worktree nuevo desde `master`.

## Evidencia reciente

- Suite completa sobre `e8ce5bb`: 1379/1382 pasados, 1 skip. Los 2 fallos (`matcherPush`,
  `reactivar-automatico`) son **timeouts preexistentes**, reproducidos idénticos en `master` limpio
  sin el diff — no son regresión.
- `test/preparacion.test.js` aislado: 169/169. `test/ingreso-matcher.test.js`: 13/13.
  `matcher-engine` + `matcher-inverso`: 71/71 (motor compartido intacto).
- E2E de C2/C3 en instancia aislada (puerto 3199, DB temporal sin token ML, `DISABLE_CRONS=true`):
  🟢🟢 Consulta de Precios y Preparación, 0 errores de consola/red, responsive 1440/768/390.
- Validación directa de `looksLikeGtin`: EAN-8, UPC-A(12), EAN-13 y GTIN-14 con checksum real;
  códigos con dígito verificador alterado se rechazan.

## Bloqueos conocidos

- **La skill `security-review` está rota en los worktrees de este repo**: su preámbulo corre
  `git diff origin/HEAD...` y falla con `fatal: ambiguous argument 'origin/HEAD...'`. El auditor la
  suple con revisión manual, pero conviene arreglarla.
- Los 2 tests flaky por timeout (`matcherPush`, `reactivar-automatico`) merecen un `testTimeout`
  más alto: hoy obligan a re-verificar en cada auditoría para descartar regresión.
- El checkout principal `/opt/fusionbikes/herramientas` está en la rama `conteo-confiable` con WIP
  sin commitear. **Todo worktree nuevo debe crearse desde `master`**, no desde el checkout.

## Deuda anotada (no bloqueante)

- 11 hallazgos LOW del revisor sobre el trabajo de GTIN (cosméticos/documentales).
- `df` cuenta cada variación como documento, así que un producto con muchas variaciones infla la
  df de sus propias palabras. Con el catálogo real no molesta; sí importa si alguien construye el
  índice sobre un subconjunto filtrado.
- `routes/index.html`: 911 líneas huérfanas (copia vieja de la pantalla de recepción), no montada
  en ningún `express.static`. Limpiar cuando se toque esa área.

Este archivo debe permanecer breve. Reemplazá estados cerrados u obsoletos; no acumules una
cronología de sesiones.
