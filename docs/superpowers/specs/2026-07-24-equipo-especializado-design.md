# Equipo de subagentes especializado — diseño

**Fecha:** 2026-07-24
**Estado:** aprobado, pendiente de plan de implementación

## Contexto y problema

El equipo de subagentes actual (`.claude/agents/`) tiene un `hard-worker` único que hace
todo el desarrollo (backend, frontend, UX, UI, base de datos) con skills genéricas. Además,
el paso 1 del pipeline ("Planear") descrito en `CLAUDE.md` y en el skill `/feature` es solo
charla informal en la sesión — no invoca `superpowers:brainstorming`/`superpowers:writing-plans`
ni genera un artefacto escrito. El resultado: se planea poco, y cuando se planea, el plan que
llega al `hard-worker` queda ambiguo y termina interpretando huecos en vez de seguir algo
preciso.

Con la app a punto de ser usada por al menos 20 personas, el objetivo es que:
1. La planeación sea exhaustiva y no asuma nada, ni lo más obvio (quién hace qué, manual vs.
   automático, casos de error, origen de cada dato).
2. El desarrollo se reparta en agentes especializados (backend, frontend, UX, UI) en vez de
   un generalista único, cada uno con metodologías probadas globalmente y con debilidades
   conocidas mitigadas explícitamente para el tamaño real de este proyecto (no aplicar
   metodologías de libro sin ajustar al contexto: sin ORM, sin tráfico externo, un solo
   desarrollador real detrás de los agentes).
3. Los agentes de control existentes (`revisor`, `tester`, `auditor-despliegue`) se ajusten
   para cubrir el trabajo de los 4 agentes de desarrollo, no solo de uno.

## Pipeline nuevo

```
Planear (brainstorming → writing-plans, con contexto de uso obligatorio)
  → disenador-ux
  → disenador-ui
  → hard-worker-backend + hard-worker-frontend (paralelo si son independientes)
  → revisor (loop hasta OK)
  → tester
  → probador-e2e (si el cambio toca UI)
  → auditor-despliegue (gate final, incluye security-review)
  → reporte al usuario
```

El orquestador (sesión principal) sigue siendo quien despacha y encadena — los subagentes no
se llaman entre sí. El deploy a producción lo sigue haciendo el usuario a mano.

## 1. Planeación (CLAUDE.md paso 1 + `/feature` paso 1)

Invocar `superpowers:brainstorming` → termina en `superpowers:writing-plans`, que produce
`docs/superpowers/plans/YYYY-MM-DD-<tema>.md` con pasos numerados, archivos por paso y
criterio de aceptación verificable por paso.

**Regla explícita: no asumir nada, ni lo obvio.** Antes de cerrar el plan, el orquestador
confirma con el usuario:
- Quién ejecuta cada paso (¿manual, a mano del usuario, o automático del sistema?).
- Qué dispara el flujo.
- Comportamiento en cada caso de error/borde.
- De dónde sale cada dato (ML, Woo, local).

Se mantiene el atajo para fixes triviales (una línea, typo) a criterio del orquestador — no
es un gate duro obligatorio, sino un hábito reforzado.

Skills de superpowers sumadas al pipeline (evaluadas contra las ~38 skills locales de
`.agents/skills/` para no duplicar):
- `writing-plans` — plan escrito, no charla.
- `executing-plans` — el `hard-worker-*` que corresponda sigue el plan como fuente de verdad.
- `verification-before-completion` — nadie reporta éxito sin correr verificación real
  (aplica a `hard-worker-backend`, `hard-worker-frontend`, `tester`, `auditor-despliegue`).
- `requesting-code-review` / `receiving-code-review` — formaliza el par
  `hard-worker-* ↔ revisor` que ya existía de forma informal.

Descartadas por redundantes o no aplicables: `systematic-debugging` y
`test-driven-development` (solapan con `.agents/skills/diagnosing-bugs` y `.agents/skills/tdd`
ya usados), `finishing-a-development-branch` y `using-git-worktrees` (no aplican: git local
sin remoto, worktrees ya manejados por la sesión vía `EnterWorktree`).

## 2. `disenador-ux` (nuevo)

**Rol:** diseña flujos de usuario e información ANTES de que exista pantalla. No escribe
código ni define estética visual.

**Metodologías:**
- Human-Centered Design (ISO 9241-210) — 4 fases: contexto de uso, requisitos, soluciones,
  evaluación.
- Heurísticas de Nielsen + leyes de UX (Fitts, Hick, Miller, Jakob's Law).
- Jobs-to-be-Done, como complemento para pensar el flujo desde la intención del usuario.

**Debilidades conocidas y mitigación:**
- Estas metodologías asumen investigación con usuarios reales; acá no la hay. Mitigación:
  el agente **requiere** un documento de contexto de uso (quiénes son los ~20 usuarios, en
  qué rol, en qué dispositivo) entregado por el orquestador/usuario antes de arrancar — no
  investiga solo, no infiere.
- Las heurísticas son genéricas y no conocen el dominio (venta de bicicletas, sync ML↔Woo,
  logística de depósito). Mitigación: el documento de contexto de uso arriba cubre esto; la
  metodología ordena el pensamiento, no reemplaza el conocimiento de dominio.
- Validación contra uso real: el agente recorre con Playwright el flujo *actual* de la app
  antes de proponer cambios, no diseña en el vacío.
- Loop de post-lanzamiento: a la semana de un cambio de UX importante, se revisa si generó
  fricción real de uso y esa observación alimenta el próximo ciclo.

**Skills de referencia (adaptar, no copiar tal cual):**
- `thomaspraun/ux-flow-designer` (GitHub) — diagramas Mermaid, mapa de pantallas, wireframes
  HTML clicables mobile-first a partir de un PRD.
- `szilu/ux-designer-skill` (GitHub) — heurísticas, leyes de Gestalt, árboles de decisión,
  antipatrones, WCAG 2.2 AA.

**Tools:** `Read, Grep, Glob, WebFetch, WebSearch, browser_navigate, browser_snapshot,
browser_click, browser_resize` — sin `Edit`/`Write` de código.

**Entregable:** mapa de pantallas/flujo (Mermaid o wireframe HTML clicable), casos borde de
navegación, validación contra heurísticas de Nielsen.

## 3. `disenador-ui` (nuevo)

**Rol:** sube el nivel visual de la interfaz — tipografía, color, espaciado, jerarquía. No
escribe lógica de negocio ni JS de comportamiento.

**Metodologías:**
- Atomic Design (Brad Frost) — **versión liviana**: solo tokens + componentes que de verdad
  se repiten (botones, tablas, alertas, formularios), sin forzar jerarquía completa en
  pantallas que no la necesitan.
- Design Tokens / Design System, apoyado en `public/lib/theme.css` ya existente.
- WCAG 2.2 AA como piso no negociable de contraste/tamaño/foco.

**Debilidades conocidas y mitigación:**
- Atomic Design completo es sobre-ingeniería para una app chica con pantallas muy distintas
  entre sí. Mitigación: versión liviana, ya incorporada arriba.
- Un design system solo rinde si se mantiene con disciplina; si `hard-worker-frontend` lo
  ignora, se degrada en silencio. Mitigación: `auditor-despliegue` rechaza en el gate
  colores/tipografía/espaciado nuevos que no vengan de los tokens — no depende de que
  alguien se acuerde de llamar a `disenador-ui`.
- WCAG es un piso técnico, no garantiza que la interfaz sea más linda o simple de usar.
  Mitigación: `disenador-ui` entrega capturas antes/después en mobile y desktop y se somete
  a aprobación explícita del usuario, no solo a checklist de accesibilidad.

**Skills de referencia:**
- `frontend-design` — ya instalada en este entorno (skill oficial de Anthropic), se usa
  directo.
- `Dammyjay93/interface-design` (GitHub) — persiste decisiones de sistema visual en un
  archivo (adaptar a algo como `public/lib/design-system.md`) que se recarga entre sesiones,
  para que las pantallas no queden inconsistentes entre sí.

**Tools:** `Read, Grep, Glob, Edit, Write, WebFetch, browser_navigate, browser_resize,
browser_take_screenshot` — escritura limitada a `theme.css`/sistema visual, no a JS de
páginas.

**Entregable:** tokens actualizados + doc de sistema visual persistente, aplicado o
especificado componente por componente, con capturas antes/después en mobile y desktop.

## 4. `hard-worker-frontend` (nuevo, reemplaza parte del `hard-worker` genérico)

**Rol:** implementa en código lo que definen `disenador-ux` (flujo) y `disenador-ui`
(sistema visual). No decide flujo ni estética — las sigue. Dueño de todo `public/`,
incluidas las llamadas fetch al backend (el contrato con `hard-worker-backend` es el JSON
de la API, no el código del otro lado).

**Metodologías:**
- Mobile-first, con presupuesto de peso explícito y numérico (JS/imágenes por página),
  calibrado para conexión de depósito, no para tráfico público — **no** persigue Core Web
  Vitals completos (LCP/INP/SEO no aplican a una app interna de 20 usuarios logueados).
- Accesibilidad técnica automatizada: axe-core vía Playwright `browser_evaluate`, como piso
  obligatorio — no como criterio de "terminado" (eso sigue siendo `probador-e2e`
  interactuando de verdad).
- Component-Driven Development adaptado (sin Storybook/entorno aislado real): captura de
  Playwright del componente nuevo antes de integrarlo, comparada contra la spec de
  `disenador-ui`. BEM **solo** en `public/lib/` (componentes compartidos), nunca inventado
  en una página suelta.

**Debilidades conocidas y mitigación:** ya incorporadas arriba (presupuesto medible en vez
de "liviano" genérico, axe-core como piso no como cierre, BEM acotado a `public/lib/`,
CDD reducido a lo verificable en este stack sin build tools). Además: throttling de red real
(no solo viewport) antes de aprobar pantallas con carga pesada, simulando la conexión del
depósito.

**Tools:** `Read, Edit, Write, Grep, Glob, Bash, browser_navigate, browser_resize,
browser_snapshot, browser_click, browser_type, browser_console_messages,
browser_network_requests, browser_evaluate`.

**Entregable:** componente/página implementado, axe-core corrido y reportado, verificado en
al menos 2 anchos de viewport, dentro del presupuesto de peso definido.

## 5. `hard-worker-backend` (nuevo, reemplaza el resto del `hard-worker` genérico)

**Rol:** dueño de rutas Express, `lib/` y esquema sqlite. No toca `public/`.

**Metodologías:**
- Contrato de API liviano documentado en `docs/api-contrato.md` (no OpenAPI formal — un
  solo consumidor real, el propio frontend interno).
- Retry con backoff simple + fail-closed/fail-open decidido explícitamente por endpoint (no
  circuit breaker completo — tráfico bajo, un solo proceso). Coherente con lo ya documentado
  en la memoria del proyecto sobre errores de sync.
- Migraciones `.sql` numeradas + `PRAGMA user_version` (no herramienta externa tipo Knex).
- TDD dirigido: test antes del código para lógica de negocio pura (cálculo de precios,
  matching SKU); exploración libre primero cuando el contrato de una API externa (ML/Woo) es
  desconocido, test después.

**Debilidades conocidas y mitigación:** ya incorporadas arriba en cada metodología (todas
son ya la versión "ajustada al tamaño real del proyecto", no la versión de libro).

**Skills de referencia (adaptar, no copiar):** `davila7/claude-code-templates`
(`senior-backend`), `affaan-m/everything-claude-code` (`backend-patterns`) — genéricas para
Node/Express, útiles como referencia de patrones (retry, separación repository/service), no
plug-and-play. No existe skill pública específica de integración ML/Woo.

**Tools:** `Read, Edit, Write, Grep, Glob, Bash, WebFetch, WebSearch` — sin acceso a
`public/`.

**Entregable:** código + migración si aplica + `docs/api-contrato.md` actualizado si cambió
un endpoint, tests de la lógica de negocio, `npm test` verde.

## 6. Ajustes a agentes existentes

### `revisor`
Suma checklist específico por área además de lo que ya hacía (correctitud, convenciones,
diseño, tests):
- Backend: fail-closed/fail-open explícito por endpoint, backoff no inmediato, migración
  presente si tocó esquema.
- Frontend: BEM solo en `public/lib/`, tokens de `theme.css` usados (no colores sueltos),
  axe-core corrido y reportado.
- UI: sistema visual persistente actualizado y coherente con decisiones previas.
- UX: flujo consistente con el contexto de uso real entregado (no inventado).

Suma `superpowers:requesting-code-review` como marco de la salida priorizada que ya
entregaba. Sin cambios de tools ni de que no escribe código.

### `tester`
Divide cobertura por agente de desarrollo:
- Backend: tests de lógica de negocio pura, TDD dirigido como en `hard-worker-backend`.
- Frontend: además de vitest, corre axe-core vía Playwright como parte de "cobertura del
  cambio" (complementa, no reemplaza, a `probador-e2e`).

Suma `superpowers:verification-before-completion` antes de reportar suite verde — corre los
comandos reales, no repite lo que el agente de desarrollo dijo.

Suma tools mínimas de Playwright: `browser_navigate, browser_evaluate` (solo para inyectar
axe-core, no interacción completa — eso es de `probador-e2e`).

### `auditor-despliegue`
Suma a la regla OBLIGATORIA existente (código + tests verdes + UI responsive):
4. **Seguridad**: invoca la skill `security-review` sobre el diff.
5. **Conformidad de sistema visual**: rechaza colores/tipografía/espaciado nuevos en
   `public/` que no vengan de los tokens de `theme.css`.
6. **Migración pendiente**: si el diff toca el esquema sqlite, verifica que exista la
   migración `.sql` numerada correspondiente.
7. **Presupuesto de peso frontend**: mide JS/imágenes vía `browser_network_requests` contra
   el presupuesto definido para `hard-worker-frontend`.

Invoca `superpowers:verification-before-completion` antes de emitir veredicto — corre él
mismo `npm test` y las verificaciones de arriba, no confía en lo reportado por los agentes de
desarrollo.

Sin cambios: sigue siendo el único que hace el merge local tras luz verde; sin cambios de
tools (los chequeos nuevos se hacen con Read/Grep/Bash + Playwright que ya tenía).

### `probador-e2e` y `explorador`
Sin cambios — ya son agnósticos a qué agente de desarrollo produjo el diff.

## Fuera de alcance

- Agente separado de base de datos: descartado — el esquema sqlite es chico y está acoplado
  a la lógica de negocio, no amerita agente propio (cubierto por `hard-worker-backend`).
- Gate duro que bloquee código sin plan.md: descartado — se mantiene a criterio del
  orquestador para no trabar fixes triviales.
- Circuit breaker, OpenAPI formal, migraciones con herramienta externa, Core Web Vitals
  completos: descartados explícitamente por sobre-ingeniería para el tamaño real de este
  proyecto (ver debilidades de cada metodología arriba).

## Siguiente paso

Invocar `superpowers:writing-plans` para el plan de implementación: crear los 4 archivos de
agente nuevos (`disenador-ux.md`, `disenador-ui.md`, `hard-worker-frontend.md`,
`hard-worker-backend.md`), actualizar `revisor.md`, `tester.md`, `auditor-despliegue.md`,
actualizar `CLAUDE.md` y `.claude/skills/feature/SKILL.md` con el pipeline nuevo, y retirar
el `hard-worker.md` genérico.
