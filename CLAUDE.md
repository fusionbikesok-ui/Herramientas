# Proyecto FusionBikes — herramientas

App Node/Express (ESM, better-sqlite3, vitest) en VPS de **producción real**. La operación vigente
continúa manual hasta que E23 implemente el pipeline objetivo; luego backend/web podrán publicarse
automáticamente con gates y rollback. Windows, hardware y App Store siempre requieren autorización. Remoto en GitHub (`git@github.com:fusionbikesok-ui/Herramientas.git`, privado, vía
deploy key con acceso de escritura). Integración MercadoLibre ↔ WooCommerce. Responder en
español.

El pipeline de scripts (`scripts/agent-pipeline-policy.mjs`, `npm run agent:*`) queda fuera de
uso: no hay handoffs formales ni evidencia congelada por `diff_fingerprint`. Los subagentes se
invocan sueltos y el traspaso de evidencia entre ellos lo hace el orquestador, pegando el output
de uno en el prompt del siguiente.

## Memoria durable y carga selectiva

La memoria compartida del proyecto vive en `docs/memory/`. Antes de explorar el repositorio:

1. Leé completos `docs/memory/INDEX.md` y `docs/memory/active.md`.
2. Usá la tabla de rutas del índice para abrir **solo** los módulos relacionados con la tarea.
3. No cargues todos los módulos ni planes históricos por defecto.

El programa canónico E0–E24 vive en `docs/superpowers/plans/plan-maestro-v2.md`; su índice,
decisiones, archivo y fichas están en `docs/superpowers/INDEX.md`. El maestro especifica el
objetivo y las fichas prueban el progreso: no inferir una entrega terminada por commits o numeración.

En cualquier cambio del repositorio o del VPS, actualizá la memoria afectada después de
actuar y antes de revisar o reportar el resultado. En cambios de código, repetí esa
actualización después de cada corrección y antes de la siguiente revisión. Guardá únicamente
hechos durables y verificados: decisiones, contratos, invariantes, rutas canónicas y estado
operativo útil. No copies conversaciones, logs,
resultados transitorios, secretos ni credenciales. Modificá solo los módulos afectados;
creá uno nuevo únicamente cuando ningún módulo existente represente bien el tema.

## Equipo de subagentes — uso opt-in

Los agentes de `.claude/agents/` son especialistas disponibles, no un pipeline. La sesión
principal resuelve por defecto y los invoca solo cuando su especialidad aporta evidencia o una
perspectiva que no se obtiene mejor de forma directa. No tienen modelo, nivel de razonamiento,
orden, gate ni encadenamiento prescrito.

| Si la tarea necesita… | Podés invocar |
|---|---|
| investigación separable para ubicar una parte incierta del repo | `explorador` |
| diseñar o cambiar un flujo, sus estados, arquitectura de información o copy | `disenador-ux` |
| diseñar o cambiar la presentación visual, tokens, componentes o responsive | `disenador-ui` |
| delegar una implementación backend claramente acotada | `hard-worker-backend` |
| delegar una implementación frontend claramente acotada | `hard-worker-frontend` |
| una segunda revisión independiente ante complejidad o riesgo | `revisor` |
| cobertura dedicada, reproducción de una regresión o pruebas que justifiquen especialización | `tester` |
| interacción real, responsive o un recorrido completo en navegador | `probador-e2e` |
| una decisión independiente antes de desplegar un cambio de riesgo relevante | `auditor-despliegue` |

Un agente no se invoca solo porque exista. Un botón mal ubicado, una condición local o una
corrección con ruta y prueba evidentes se resuelven directamente. Diseño se usa al diseñar;
revisión, testing, E2E y auditoría se usan individualmente cuando su riesgo o incertidumbre lo
ameritan. Nunca se encadenan por costumbre.

### Calibrá el tamaño antes de invocar

- **Cambio chico:** resolver y verificar directamente; no usar agentes por defecto.
- **Cambio normal/grande:** escribir un plan cuando haga falta y sumar solo los especialistas
  cuyo aporte concreto sea necesario.

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
desde cero — eso multiplica el costo por cada agente que invoques. En el prompt
de despacho incluí siempre lo que ya sabés resuelto:

- **rutas de archivo concretas** que tiene que tocar o leer (no "buscá dónde está el
  handler de precios", sino `routes/precios.js:120`);
- **la convención que aplica**, si ya la verificaste;
- **el output del agente anterior** de la cadena (los hallazgos del `revisor` al
  hard-worker, el reporte de `probador-e2e` al auditor, la spec de `disenador-ui` al
  hard-worker-frontend). Los subagentes no se hablan entre sí: ese traspaso es tuyo.

Si necesitás ubicar algo vos, usá **`explorador`** una vez y reutilizá su respuesta en
todos los despachos siguientes, en vez de que cada agente repita la búsqueda.

### Planear antes de escribir código

En cambios normales/grandes, invocá `superpowers:brainstorming` (que termina en
`superpowers:writing-plans`) para producir un plan escrito en
`docs/superpowers/plans/YYYY-MM-DD-<tema>.md`, con pasos numerados, archivos por paso y criterio
de aceptación verificable. **No asumas nada, ni lo obvio**: antes de cerrar el plan, confirmá con
el usuario quién ejecuta cada paso (manual a mano, o automático del sistema), qué dispara el
flujo, qué pasa en cada caso de error/borde, y de dónde sale cada dato (ML, Woo, local). En
cambios chicos salteá el documento escrito, pero **no las preguntas**: resolvelas en la
conversación y arrancá.

Al terminar, reportá al usuario. La política vigente de publicación se consulta en
`docs/memory/modules/operations-vps.md`: hasta E23 es manual; el objetivo posterior permite
backend/web automático solo con gates verdes y rollback. Windows/App Store siguen manuales.

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
clave `Auditor2026!` (sembrada en `data/fusion.sqlite`). Es solo para testing automatizado — no
usarla para operar el negocio real. **No es admin** (verificado 2026-09-13): tiene sólo lectura en
13 herramientas (codigos, config-ml, consulta-precios, etiquetas, inventario, matcher,
notificaciones-ml, pedidos, precios, preparacion, recepcion, stock, sync-ml). Las rutas de
escritura le responden 403; para probarlas usar el entorno QA (`scripts/qa/qa.sh`) con un usuario
admin y la clave de QA.

Para probar permisos limitados/rutas protegidas: usuario `auditor_limitado` / clave
`AuditorLtd2026!` (no-admin, solo lectura en Consulta de Precios; ver `routes/usuarios.js`
para reasignarle permisos si hace falta cubrir otra herramienta). También solo para testing.

## La suite completa tampoco convive con un servidor de prueba

La regla conocida era "dos `npm test` simultáneos se pisan los `.sqlite` temporales de `test/`".
Es más amplia: el 2026-08-20, con `npm test` corriendo mientras un agente de `probador-e2e`
tenía su servidor levantado, la suite dio **35 fallos en 3 archivos que nadie había tocado**
(`recepciones`, `reconciliacionStockMl`, `woo`), y con forma de aserción real
(`expected 2 to be 0`), no de `SqliteError` — o sea que **no se distingue a simple vista de una
regresión de verdad**. Los mismos 3 archivos, corridos solos, dieron 81/81.

Antes de correr la suite completa: `pgrep -af "vitest|node.*server"` y que no quede nada de
ningún agente. Y ante un fallo en un archivo ajeno al cambio, **re-correr ese archivo solo**
antes de creerle.
