# Proyecto FusionBikes — herramientas

App Node/Express (ESM, better-sqlite3, vitest) en VPS **staging**; a producción se pasa **a
mano**. Remoto en GitHub (`git@github.com:fusionbikesok-ui/Herramientas.git`, privado, vía
deploy key con acceso de escritura). Integración MercadoLibre ↔ WooCommerce. Responder en
español.

## Equipo de subagentes — flujo de trabajo

Hay un equipo de subagentes en `.claude/agents/`. **La sesión principal es el orquestador**:
planea con el usuario, despacha a los subagentes y los encadena (los subagentes no se llaman
entre sí).

**Disparador automático:** cuando el usuario pide **crear o cambiar una función/feature/fix
de código**, seguí este pipeline sin esperar un comando:

1. **Planear de verdad.** Invocá `superpowers:brainstorming` (que termina en
   `superpowers:writing-plans`) para producir un plan escrito en
   `docs/superpowers/plans/YYYY-MM-DD-<tema>.md`, con pasos numerados, archivos por paso y
   criterio de aceptación verificable. **No asumas nada, ni lo obvio**: antes de cerrar el
   plan, confirmá con el usuario quién ejecuta cada paso (manual a mano, o automático del
   sistema), qué dispara el flujo, qué pasa en cada caso de error/borde, y de dónde sale
   cada dato (ML, Woo, local). Para fixes triviales (una línea, typo) podés saltear este
   paso a tu criterio — no es un gate duro.
2. Si el cambio toca UX/UI, despachar **`disenador-ux`** (flujo, con el documento de
   contexto de uso que le corresponde) y después **`disenador-ui`** (sistema visual) antes
   de que se escriba código.
3. Despachar **`hard-worker-backend`** y/o **`hard-worker-frontend`** (según qué toque el
   plan; en paralelo si son independientes) con el plan concreto → hacen el desarrollo.
4. Despachar **`revisor`** sobre el diff → hallazgos priorizados (no escribe código).
5. Si hay hallazgos, volver al agente de desarrollo correspondiente a corregir; repetir
   hasta que el revisor dé OK.
6. Despachar **`tester`** → asegura vitest verde y cobertura del cambio (incluye axe-core
   si tocó frontend).
7. Si el cambio toca UI (`public/`), despachar **`probador-e2e`** sobre la(s) página(s)
   tocadas → prueba interactiva real en navegador (clicks, inputs, responsive), no solo
   lectura de código. Ver credenciales de prueba abajo.
8. Despachar **`auditor-despliegue`** → gate obligatorio (auditoría + seguridad + tests
   verdes + UI responsive + conformidad de sistema visual + migración pendiente +
   presupuesto de peso frontend). Devuelve 🟢/🔴. **El auditor no abre el navegador**: si
   corriste el paso 7, pegale el reporte de `probador-e2e` en el prompt de despacho — de
   ahí saca la evidencia de responsive y peso. Sin ese reporte, un cambio que toca
   `public/` es 🔴 automático (no lo suple navegando él).
9. Reportar al usuario. **El deploy a prod lo hace el usuario a mano.**

Usá **`explorador`** como apoyo cuando necesites ubicar o entender código sin ensuciar tu
contexto.

**Inicio forzado:** el comando `/feature` dispara este mismo pipeline explícitamente.

**Regla de despliegue OBLIGATORIA** (la aplica el auditor, pero vale siempre): antes de
desplegar o dar por completo un cambio → auditoría de código + seguridad + todos los tests
verdes (`npm test`) + UI responsive sin nada oculto + conformidad de sistema visual +
migración de esquema aplicada si corresponde + presupuesto de peso frontend.

## Cuentas de prueba para agentes de UI

Para que `probador-e2e` / `auditor-despliegue` puedan loguearse solos: usuario `auditor` /
clave `Auditor2026!` (cuenta admin, sembrada en `data/fusion.sqlite`). Es solo para testing
automatizado — no usarla para operar el negocio real.

Para probar permisos limitados/rutas protegidas: usuario `auditor_limitado` / clave
`AuditorLtd2026!` (no-admin, solo lectura en Consulta de Precios; ver `routes/usuarios.js`
para reasignarle permisos si hace falta cubrir otra herramienta). También solo para testing.
