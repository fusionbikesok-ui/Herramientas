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
de código**, seguí este pipeline sin esperar un comando.

### Calibrá el tamaño antes de despachar

El pipeline completo son 7-9 despachos y cada subagente arranca en frío. Correrlo entero
para un cambio chico quema la cuota sin agregar señal. Antes de arrancar, clasificá:

- **Cambio chico** — un archivo o dos, sin contrato de API nuevo, sin cambio de esquema
  sqlite, sin pantalla ni flujo nuevo (ej.: ajustar una condición, un mensaje de error,
  un fix de una función existente). → **Sin documento de plan** en `docs/superpowers/plans/`
  y **sin `disenador-ux`/`disenador-ui`**. Despachá: hard-worker que corresponda → `revisor`
  → `tester` → `auditor-despliegue`.
- **Cambio normal/grande** — herramienta nueva, pantalla nueva, cambio de esquema, cambio
  de contrato entre back y front, o cualquier cosa que toque el sync ML↔Woo. → **pipeline
  completo, sin atajos.**

**Lo que NO se recorta nunca, sea del tamaño que sea:** preguntarle al usuario lo que no
está definido (quién ejecuta cada paso, qué dispara el flujo, qué pasa en cada error/borde,
de dónde sale cada dato). Esas preguntas cuestan casi cero tokens y son justamente lo que
evita el rework, que es lo verdaderamente caro. Recortá ceremonia y despachos, nunca
entendimiento. Tampoco se recortan `revisor`, `tester` ni `auditor-despliegue`.

Si dudás entre chico y normal, es normal.

### Pasale contexto a los subagentes (no los hagas redescubrir)

Cada subagente arranca sin tu contexto y, si no le decís nada, vuelve a explorar el repo
desde cero — eso multiplica el costo por la cantidad de agentes del pipeline. En el prompt
de despacho incluí siempre lo que ya sabés resuelto:

- **rutas de archivo concretas** que tiene que tocar o leer (no "buscá dónde está el
  handler de precios", sino `routes/precios.js:120`);
- **la convención que aplica**, si ya la verificaste;
- **el output del agente anterior** de la cadena (los hallazgos del `revisor` al
  hard-worker, el reporte de `probador-e2e` al auditor, la spec de `disenador-ui` al
  hard-worker-frontend). Los subagentes no se hablan entre sí: ese traspaso es tuyo.

Si necesitás ubicar algo vos, usá **`explorador`** una vez y reutilizá su respuesta en
todos los despachos siguientes, en vez de que cada agente repita la búsqueda.

### El pipeline

1. **Planear de verdad.** Invocá `superpowers:brainstorming` (que termina en
   `superpowers:writing-plans`) para producir un plan escrito en
   `docs/superpowers/plans/YYYY-MM-DD-<tema>.md`, con pasos numerados, archivos por paso y
   criterio de aceptación verificable. **No asumas nada, ni lo obvio**: antes de cerrar el
   plan, confirmá con el usuario quién ejecuta cada paso (manual a mano, o automático del
   sistema), qué dispara el flujo, qué pasa en cada caso de error/borde, y de dónde sale
   cada dato (ML, Woo, local). En **cambios chicos** (ver calibración arriba) salteá el
   documento escrito, pero **no las preguntas**: resolvelas en la conversación y arrancá.
2. Si el cambio toca UX/UI **y es normal/grande**, despachar **`disenador-ux`** (flujo, con
   el documento de contexto de uso que le corresponde) y después **`disenador-ui`** (sistema
   visual) antes de que se escriba código. Si solo hay flujo nuevo sin estética nueva (o al
   revés), despachá **solo el que corresponda**: encadenar los dos por costumbre es gasto
   al pedo. En cambios chicos sobre pantallas ya diseñadas, ninguno de los dos — los tokens
   de `public/lib/theme.css` ya fijan la estética y el auditor verifica que se respeten.
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
   presupuesto de peso frontend). Devuelve 🟢/🔴. **El auditor no abre el navegador ni
   re-revisa el código**: pegale en el prompt de despacho el **veredicto final del
   `revisor`** (paso 5) y, si corriste el paso 7, el **reporte de `probador-e2e`**. De ahí
   saca la auditoría de código y la evidencia de responsive/peso; él verifica que sean del
   diff final y agrega lo que solo hace él (seguridad, `npm test`, migraciones, tokens,
   peso). Si falta alguno de los dos insumos, es 🔴 automático — no los suple él.
9. Reportar al usuario. **El deploy a prod lo hace el usuario a mano.**

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
