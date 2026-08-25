# Estado activo

Actualizado: 2026-08-24.

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

1. **`pm2 restart herramientas`**: hasta que ocurra, el fix de preparaciones huérfanas no está
   activo (vive en el cron, en memoria) y los 13 pedidos siguen invisibles en la cola. Es lo único
   pendiente que afecta a producción hoy.
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
