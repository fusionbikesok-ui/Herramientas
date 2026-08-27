# Plan: Consolidar `master` y `conteo-confiable` en una sola línea

Trabajo grande, bien mapeado en una investigación anterior, sin empezar. Índice general en
`plan-maestro-v2.md`. Confirmar antes de arrancar que las condiciones del Paso 0 siguen
vigentes (puede haber cambiado desde que se mapeó esto).

**Relación con la API móvil**: `feature/mobile-api-v1` (ver `plan-api-mobile-v1.md`) se crea
desde el último `conteo-confiable` estable, NO desde `master`. Esta consolidación es un
proyecto independiente y no bloquea el arranque de la API móvil — pero si se ejecuta mientras
`feature/mobile-api-v1` sigue activa sin mergear, hay que decidir explícitamente si esa rama
se rebasa sobre el `master` consolidado o si se espera a que la API móvil cierre primero. No
asumir un orden — decidirlo cuando ambas cosas coincidan en el tiempo.

## Contexto

Las dos ramas divergieron el 2026-08-19 (`merge-base` = `ba04632`). `master`: matcher de
ingreso, asociación de EAN en Preparación (código sin su revisión E2E formal todavía),
Consulta de Precios/GTIN auditada, protección de concurrencia en vínculos de Cobertura.
`conteo-confiable`: todo el módulo de Contador de Inventario más las Fases de Preparación.
Hubo un intento de reconciliación anterior (`aa0b21f`, rama `integracion-master-conteo`) que
resolvió 17 conflictos con criterio explícito por archivo, pero quedó sin fusionar y ambas
ramas siguieron avanzando — sirve de guía de criterio, no de solución aplicable tal cual (han
pasado 30-40+ commits de cada lado desde entonces, y más con las sesiones más recientes,
incluida la API móvil una vez que arranque).

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

## Paso 0 — Confirmar que no hay nadie trabajando en vivo (bloqueante, repetir)

1. `ps aux | grep claude` — sin procesos de terminal real ajenos trabajando sobre el repo.
2. `git log --all --since="15 minutes ago" --oneline` sobre `conteo-confiable` — sin commits
   nuevos recientes que no sean de esta sesión.
3. Releer `docs/memory/active.md` del propio repo por si hay una nota de "PAUSA" de otra
   sesión — confirmar que no hay, o que ya se cerró.
4. Confirmar el estado de `feature/mobile-api-v1` (ver nota de arriba) si ya existe.

## Paso 1 — Preparar el terreno

- `git tag pre-consolidacion-conteo-confiable conteo-confiable` y
  `git tag pre-consolidacion-master master` (red de seguridad, no depender de memoria de
  hashes).
- Worktree nuevo para la integración (no reusar `.claude/worktrees/integracion`, construido
  sobre un punto viejo): `git worktree add .claude/worktrees/consolidacion-master master`.

## Paso 2 — Mergear `conteo-confiable` dentro de `master`

`git merge conteo-confiable` en el worktree de consolidación. Resolución esperada por archivo
(releer el contenido actual antes de aplicar, no confiar ciegamente en que sigue igual a como
se mapeó):

| Archivo | Criterio |
|---|---|
| `routes/inventario.js` | Base **conteo-confiable** (todo el módulo de Contador de Inventario vive acá, incluido el fix de `ad_hoc` en `/asociar`). |
| `routes/preparacion.js` | Base **master** (asociación EAN, `persistirGtinConfirmado`, `subirGtinAWoo`), reaplicando el fix de preparaciones huérfanas de `conteo-confiable`. **Ojo**: este archivo tiene además todo lo nuevo de sync en tiempo real (A.1) — coordinar el orden real cuando se llegue acá. |
| `routes/sync.js` | Base **conteo-confiable** (`syncSkuPuntual` de A.2, `syncPedidoWebPuntual` de A.1, y lo de A.3 si ya está). No existe en `master` con este contenido. |
| `routes/consultaPrecios.js`, `lib/gtinWoo.js`, `public/consulta-precios/index.html`, `docs/api-contrato.md` (sección GTIN) | Base **master** (versión auditada, `parsearIdWoo()` estricto). |
| `server.js` | Base **conteo-confiable** (refactor grande, incluye el webhook HMAC y los cambios de sync en tiempo real). Reaplicar el cambio puntual de `master` si sigue vigente. |
| `lib/wooStock.js` | Base **conteo-confiable** (ajuste por delta anti-sobreventa, código de negocio crítico — no perder ni una línea). |
| `public/inventario/index.html` | Base **conteo-confiable** (evolucionó ahí: cierre seguro, buscador, ubicaciones). Confirmar que no se pierde nada de `master`, no asumir que es historia superada. |
| `public/matcher/index.html` | Base **master** (accesibilidad `:focus-visible`). |
| `agents/model-routing.md`, `scripts/orchestrate-claude.mjs` | Base **conteo-confiable** (más nuevo). |
| `routes/codigos.js` | Sin criterio previo — evaluar caso por caso. |
| `docs/memory/active.md`, `agents/skill-routing.md`, `package.json`, `CLAUDE.md`, docs de agentes | Combinar aditivamente, no descartar contenido de ningún lado sin leerlo. |
| Archivos de test compartidos | Combinar aditivamente. **Ojo**: el auto-merge puede fusionar dos declaraciones de la misma variable sin marcar conflicto y dejar un `SyntaxError` que solo se ve corriendo los tests, no en el diff (ya pasó una vez con `skuPorEan`/`skusPorGtin` en `aa0b21f`). |
| Archivos exclusivos de `conteo-confiable` (`db/index.js`, `lib/permisos.js`, `lib/criticidad.js`, `routes/criticidad.js`, `routes/etiquetas.js`, `routes/auditoria.js`, `routes/notificacionesMl.js`, `public/auditoria/index.html`, `public/etiquetas/index.html`, `public/stock/index.html`, `public/recepcion/index.html`) | Se traen enteros. |
| Archivos exclusivos de `master` (`lib/ingresoMatcher.js`, `lib/matcherEngine.js`, migraciones de `pack_id`, `public/login/index.html`) | Se traen enteros. |
| `routes/cobertura.js` | Traer la protección de concurrencia optimista de `master` (`expected_sku`, 409 con `ya_resuelto`) — `conteo-confiable` no la tiene, es pérdida real de protección si se descarta. Verificar que el frontend de Cobertura mande `expected_sku`. Nota: es el mismo patrón de optimistic locking que se necesita para `POST /api/v1/stock/adjustments` en la API móvil — mirar ambos juntos si coinciden en el tiempo. |

## Paso 3 — Verificar que no se perdió nada de negocio crítico

Confirmar con grep/lectura, antes de commitear el merge: el gate fail-closed de `/confirmar`
(inventario), el ajuste por delta, `cerrarEnCero` sin `todos:true` para `con_stock`, la subida
de GTIN a Woo con `parsearIdWoo` estricto, el fix del webhook WC (HMAC antes de
`express.json()`), el auto-confirmar de publicaciones ML huérfanas, el matcher de ingreso y
sus tests, y todo lo nuevo de sync en tiempo real (A.1-A.4) y de la API móvil si ya están
mergeados para cuando se llegue a este paso.

## Paso 4 — Suite completa, una sola vez, sin nada más corriendo

`pgrep -af "vitest|node.*server"` limpio antes de correr. `npx vitest run` completo. Meta:
verde total, salvo los fallos ya documentados y confirmados ajenos (`test/auditoria.test.js`
— fallo FUNCIONAL, no de timing, ver `plan-maestro-v2.md`; timeout intermitente de
`matcherPush.test.js` bajo carga). Commitear el merge recién con la suite en verde.

## Paso 5 — Rescatar del matcher unificado v2 solo lo que sirve

En worktree aparte, revisar los 10 commits de `worktree-matcher-unificado-v2`
(`6ce2de0`..`cdadb01`) para separar la lógica de negocio rescatable (motor espejo ML→Woo,
atado de token a `client_id`, revalidación cruzada del 409) de lo que NO se toca (borrado de
scripts de orquestación, reescritura de la suite de tests). Portar manualmente, como cambio
nuevo con sus propios tests — no `cherry-pick` directo.

## Paso 6 — Prueba manual antes de cortar tráfico

Servidor con copia de la base (`DB_PATH=<copia> DISABLE_CRONS=true PORT=<libre, nunca 3001>`,
`ml_oauth_token` vaciado). Probar: conteo completo (escanear, cerrar en cero, confirmar con el
gate), asociar EAN desconocido en Preparación (dejando constancia de que sigue sin su revisión
E2E formal), Consulta de Precios (enseñar EAN y subir a Woo), que Auditoría de publicaciones
cargue y tenga link desde Home, y — si la API móvil ya está integrada — un smoke test contra
`/api/v1` con la app real o Postman/curl.

## Paso 7 — Cortar tráfico: `master` pasa a servir el VPS

Push del resultado consolidado a `master` real. Reapuntar PM2: parar el proceso actual,
actualizar el working directory a `master`, `pm2 restart herramientas`. Confirmar salud
post-restart. Dejar `conteo-confiable` intacta un tiempo prudencial como red de seguridad, con
nota en memoria de que quedó congelada en favor de `master`.
