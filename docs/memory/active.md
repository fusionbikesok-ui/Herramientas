# Estado activo

Actualizado: 2026-08-24.

## En curso

- **Entrega A — matcher de ingreso de mercadería** (lo único abierto). Worktree
  `.claude/worktrees/ingreso-matcher`, rama `entrega-a-ingreso-matcher`, base `master` (`e8ce5bb`),
  HEAD `20b89da`. Estado: `CONGELADO_PARA_REVISION` → el `revisor` devolvió **NO aprobado** con
  2 hallazgos 🔴 y 3 🟡; la corrección está en curso con `hard-worker-backend`.
  - 🔴 1: para productos **sin `atributos_json`**, `construirWC` cae al fallback
    `extraerAtributosWC(nombre)` que mete *todos* los tokens del título en `talles`
    (`'Cadena Shimano Hg500 Eslabones'` → `talleToks:['cadena','shimano','hg500','eslabones']`).
    Genera contradicciones falsas masivas y descarta el match correcto. Rompe el caso mayoritario
    (accesorios/repuestos son la mayor parte de un remito).
  - 🔴 2: dos productos **distintos** con título idéntico empatan sin marcar `ambiguo` → se aplica
    el primero del array. Misma clase de bug que la entrega viene a cerrar.
  - Gate no negociable: test de 4 líneas S/M/L/XL → 4 `id_woo` distintos (hoy pasa, no debe romperse).
  - `construirWC`, `diffTokens` y `confianzaDesdeScore` **no cambian de comportamiento** — solo se
    agregan funciones. Los usan `routes/matcher.js`, `lib/matcherResolver.js`, `lib/coberturaCola.js`.

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

## Próximo paso

1. Cerrar Entrega A: corrección de los 🔴 → re-revisión → tester → auditor.
2. **`pm2 restart herramientas`**: hasta que ocurra, el fix de preparaciones huérfanas no está
   activo (vive en el cron, en memoria) y los 13 pedidos siguen invisibles en la cola.
3. Decidir push de `master` (21 commits por delante de `origin/master`).

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
