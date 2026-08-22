# Proyecto FusionBikes — herramientas

App Node/Express (ESM, better-sqlite3, vitest) en VPS **staging**; a producción se pasa **a
mano**. Remoto en GitHub (`git@github.com:fusionbikesok-ui/Herramientas.git`, privado, vía
deploy key con acceso de escritura). Integración MercadoLibre ↔ WooCommerce. Responder en
español.

## Memoria durable y carga selectiva

La memoria compartida del proyecto vive en `docs/memory/`. Antes de explorar el repositorio:

1. Leé completos `docs/memory/INDEX.md` y `docs/memory/active.md`.
2. Usá la tabla de rutas del índice para abrir **solo** los módulos relacionados con la tarea.
3. No cargues todos los módulos ni planes históricos por defecto.

En cualquier cambio del repositorio o del VPS, actualizá la memoria afectada después de
actuar y antes de revisar o reportar el resultado. En cambios de código, repetí esa
actualización después de cada corrección y antes de la siguiente revisión. Guardá únicamente
hechos durables y verificados: decisiones, contratos, invariantes, rutas canónicas y estado
operativo útil. No copies conversaciones, logs,
resultados transitorios, secretos ni credenciales. Modificá solo los módulos afectados;
creá uno nuevo únicamente cuando ningún módulo existente represente bien el tema.

## Equipo de subagentes — flujo de trabajo

Hay un equipo de subagentes en `.claude/agents/`. En Claude Code autónomo, **la sesión
principal es el orquestador**: planea con el usuario, despacha a los subagentes y los encadena
(los subagentes no se llaman entre sí). Cuando participa Codex, Codex es el orquestador externo
único y la sesión de Claude ejecuta únicamente las tareas que reciba en un handoff.

La coordinación Codex ↔ Claude usa `docs/agent-coordination.md` como contrato compartido.
Codex es el orquestador externo: asigna worktrees, rutas y gates; Claude ejecuta tareas
delimitadas y devuelve handoffs. La matriz de modelos está en `agents/model-routing.md` y el
router de skills en `agents/skill-routing.md`; ambos deben leerse antes de despachar un rol.
Los agentes de diseño deben informar qué skills aplicaron y cuáles quedaron fuera por riesgo.
Para E2E, Codex prepara y verifica siempre el entorno aislado (URL, puerto, rama, base,
`DISABLE_CRONS`, PID y sesión de Playwright) antes de despachar a `probador-e2e`. Si falta
algún dato, el agente devuelve `BLOQUEADO (FALTA_ENTORNO)` y no elige staging ni otro puerto.

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

Si dudás entre chico y normal, es normal — **pero un arreglo de una o dos líneas que sale
directo de un hallazgo ya diagnosticado lo hace el orquestador**, sin despachar a nadie.
Arrancar un agente en frío para cambiar un color o agregar un guard cuesta más que el
arreglo.

### Cortá las entregas por valor, no por capa

Cada entrega tiene que ser **una mejora real y usable en sí misma**. Cortar por capa técnica
(motor / backend / pantalla) produce tajadas que no le sirven a nadie sola: un motor mejorado
que no se ve, o una pantalla nueva sobre un motor que todavía no llega a la vara. Antes de
partir un trabajo grande, preguntate de cada tajada: *"¿esto, solo, mejora algo para quien lo
usa?"*. Si la respuesta es no, no es una entrega — es un paso intermedio que va adentro de
otra.

Y cuando una medición fija un piso, **ese piso no se negocia**: se itera hasta alcanzarlo, no
se busca un plan B que lo esquive.

### Presupuesto de la sesión

El gasto real está en los subagentes, no en las herramientas. Reglas aprendidas a los golpes:

- **La suite completa (`npm test`) la corre el orquestador**, una sola vez, al final, sin
  nadie más trabajando. Dos corridas simultáneas se pisan los `.sqlite` temporales de `test/`
  y producen fallos falsos en archivos que nadie tocó. Los subagentes corren archivos sueltos.
- **No reanudes un agente trabado.** Si no reporta, verificá vos y dalo por perdido: uno que
  quedó en bucle esperando un proceso quemó 169.000 tokens sin producir nada.
- **Pasale contexto, no lo mandes a redescubrir** (ver la sección de abajo). Es la diferencia
  más grande entre un despacho barato y uno caro.
- **Si una tanda se cortó por cuota, verificá qué quedó hecho** antes de relanzar: puede haber
  ediciones parciales en disco.

**Lo que NO se recorta nunca, sea del tamaño que sea:** preguntarle al usuario lo que no
está definido (quién ejecuta cada paso, qué dispara el flujo, qué pasa en cada error/borde,
de dónde sale cada dato). Esas preguntas cuestan casi cero tokens y son justamente lo que
evita el rework, que es lo verdaderamente caro. Recortá ceremonia y despachos, nunca
entendimiento. Tampoco se recortan `revisor`, `tester` ni `auditor-despliegue`.

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

## Reglas de negocio que no se rompen

- **Precio de un pedido WC creado desde una venta de ML:** nunca se graba el precio de venta de
  ML. Se registran los productos y el precio de la línea es el **precio de contado de la web**
  (`precioContado()` de `lib/mlPrecios.js`). Ojo con la columna: se calcula sobre
  `catalogo_cache.regular_price` (precio de **LISTA**), NO sobre `catalogo_cache.precio`, que
  guarda el precio **VIGENTE** de Woo y ya trae el `sale_price` si el producto está en oferta.
  Una venta de ML nunca hereda un descuento de oferta de la web. Si no hay precio de lista
  disponible, la línea se crea igual sin `subtotal`/`total` y Woo aplica el suyo: nunca se
  pierde la venta y nunca se cae al precio de ML, que solo puede quedar como dato informativo
  (meta/nota).
- **Un pedido WC creado desde ML no se modifica después.** Únicas dos excepciones: la
  cancelación de la compra, y el alta de una nota privada (`POST /orders/{id}/notes` con
  `customer_note:false`), que es un sub-recurso y no una modificación del pedido. Todos los
  datos de la venta (destinatario, dirección, método de envío, Nº y link de la orden ML) se
  escriben en el POST de creación.

## Cuentas de prueba para agentes de UI

Para que `probador-e2e` / `auditor-despliegue` puedan loguearse solos: usuario `auditor` /
clave `Auditor2026!` (cuenta admin, sembrada en `data/fusion.sqlite`). Es solo para testing
automatizado — no usarla para operar el negocio real.

Para probar permisos limitados/rutas protegidas: usuario `auditor_limitado` / clave
`AuditorLtd2026!` (no-admin, solo lectura en Consulta de Precios; ver `routes/usuarios.js`
para reasignarle permisos si hace falta cubrir otra herramienta). También solo para testing.
