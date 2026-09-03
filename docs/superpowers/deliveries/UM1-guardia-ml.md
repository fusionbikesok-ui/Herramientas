# UM1 urgente — Guardia ML y corrección de cobertura

**Estado:** desarrollo. **Superficie:** VPS/web móvil. **No autoriza despliegue ni escrituras en ML.**

**Auditoría de despliegue:** 🔴 pendiente. El checkout actual contiene cambios acumulados de E1–E4 y UM1 sin congelar, y la rama está desfasada respecto de `master`; no se permite mezclar ni desplegar hasta aislar/rebasar el diff y repetir los gates sobre esa base.

## Objetivo

Evitar que una variación activa sin SKU exacto venda y llegue a preparación sin identidad. La fase inicial es de lectura: detecta, prioriza y audita; las acciones remotas quedan bloqueadas hasta autorización explícita de Administrador designado.

## Requisitos cubiertos

- Cobertura exacta por publicación+variación contra SKU existente en Woo.
- Cola Guardia, Corrección y Consulta; legado no puede ocultar casos activos.
- Retención Fusion de pedidos ML inválidos, sin modificar estado ni nota de Woo.
- Confirmación de stock compartido, detección de exceso y prioridad ML por plazo/antigüedad.
- Incidencias, claim/relevo, excepción hasta cierre, tarea de catálogo y auditoría append-only.

## Gates para candidata

1. Migración compatible y repetible; pruebas de API/lógica verdes.
2. Escaneo de lectura contrastado por Administrador designado: total, urgentes y muestra por categoría.
3. Acciones remotas deshabilitadas por defecto y verificadas por permisos antes de habilitarlas.
4. E2E responsive 390/768/1440 aprobado; revisión independiente y auditoría de despliegue aún pendientes.
5. Piloto y jornada observada con backlog, reconocimientos y excepciones.

## Evidencia actual

- Migración, escaneo exacto, estado degradado, cola de operaciones y API/UI inicial implementados localmente.
- Prueba aislada: `npx vitest run test/guardia-ml.test.js test/db.test.js test/server.test.js` — 24/24 aprobadas en el worktree aislado `/opt/fusionbikes/herramientas-um1-audit`.
- Con esquema: `npx vitest run test/guardia-ml.test.js test/db.test.js` — 19/19 aprobadas.
- Regresión de servidor: `npx vitest run test/server.test.js` — 15/15 aprobadas.
- Sintaxis backend y frontend verificada; no se ejecutó E2E ni escaneo contra producción.
- Las acciones remotas siguen en modo `lectura` por defecto.
- El ingreso ML ya no usa `seller_sku` remoto como sustituto de un vínculo: si falta cobertura exacta, registra la venta en retención durable y no crea ni modifica un pedido en Woo.
- El escaneo manual sobre cache no declara frescura ML; solo un refresh completo confirmado por la integración actualiza el último escaneo sano.
- Las autocorrecciones legacy por `seller_sku` quedaron suspendidas: solo Guardia, en modo `acciones`, puede auto-confirmar un SKU exacto, único y no compartido, dejando auditoría.
- La corrección de un vínculo existente aplica desvinculación confirmada antes de intentar el nuevo vínculo; si falla, el caso queda abierto y no se sobrescribe la decisión local.
- Las vinculaciones simples y las correcciones compuestas se persisten antes del efecto remoto; el worker es el único ejecutor de la operación ML y renueva su lease mientras espera.
- Cada operación durable conserva operador y versión del caso; el worker rechaza operaciones cuyo responsable o `expected_version` cambió antes de ejecutarlas.
- Un segundo vínculo activo para el mismo SKU queda bloqueado hasta confirmar stock compartido con motivo y auditoría; la API no realiza la escritura remota antes de esa confirmación.
- Auditoría local del matcher ejecutada: detectó 4 decisiones con SKU inexistente, 82 publicaciones activas sin `seller_sku`, 20 saldos negativos y 511 SKUs en múltiples publicaciones; quedan pendientes de corrección humana.
- Demo aislado: `npm run um1:demo` — `ok:true`; caso descubierto, excepción vencida reabierta, pedido liberado y 3 eventos auditados.
- E2E browser aislado: `for width in 390 768 1440; do UM1_VIEWPORT_WIDTH=$width node scripts/um1-browser-smoke.mjs; done` — `ok:true` en los tres tamaños; login, cola de Guardia, pedido retenido e historial consultados.
- Comando equivalente registrado en el proyecto: `npm run e2e:um1:responsive`.
- La recuperación del tracking de despachos quedó corregida en el commit `5743341`; no se promueve E1 mientras el contrato completo de preparación siga sin una corrida reproducible y verde.

## Próxima acción reproducible

Completar la vista de lectura de excepciones, stock compartido y retenciones, agregar pruebas de API/cola y ejecutar el escaneo solo en entorno aislado para la revisión del Administrador designado.

## Riesgos observados en la auditoría local

`npm run audit` (sin escrituras externas) informó 4 decisiones activas con SKU inexistente en Woo, 82 publicaciones activas sin `seller_sku`, 20 saldos negativos en catálogo y 511 SKUs presentes en más de una publicación. Son hallazgos para Guardia/Corrección; no constituyen confirmación ni deben corregirse masivamente sin revisión humana.

## Matriz de alcance del worktree aislado

El worktree de validación contiene un corte vertical de integración. La revisión debe
clasificar sus archivos para no confundir soporte compartido con resultado UM1:

| Grupo | Alcance | Motivo | Gate |
| --- | --- | --- | --- |
| Núcleo UM1 | `lib/guardiaMl.js`, `routes/guardiaMl.js`, migraciones 059–061 | Cobertura, retención, claims y operaciones ML | UM1 |
| Integración necesaria | `db/index.js`, `server.js`, `lib/mlClient.js`, `lib/mlMapeo.js`, `routes/matcher.js`, `routes/sync.js` | Bootstrap, contratos ML/Woo y bloqueo de sync | UM1 + E11 |
| Aceptación UM1 | `public/guardia-ml/index.html`, `scripts/um1-*`, `test/guardia-ml.test.js` | UI y pruebas reproducibles | UM1 |
| Fuera de aceptación | E1–E4, móvil, etiquetas y notificaciones | Dependencias preexistentes del checkout | Entregas respectivas |

La existencia de este corte no autoriza merge: primero debe congelarse la base común y
verificarse que los grupos fuera de aceptación no cambien contratos accidentalmente.

## Checkpoint para el próximo agente

Base: checkout `/opt/fusionbikes/herramientas`, sin despliegue. Reproducir con `npm run um1:demo`, `npm run e2e:um1:responsive` y `npx vitest run test/guardia-ml.test.js`. Próximos pasos: probar autorización con usuarios reales del modelo `user_permisos`, completar la revisión de los 4/82/20/511 hallazgos, y solicitar autorización del Administrador designado antes de cambiar `guardia_ml_config.modo` a `acciones`. No usar la base `data/fusion.sqlite` para demos ni ejecutar escrituras hacia ML durante el gate.

## Revisión independiente

Los tres bloqueantes P0 informados (liberación de retención, asociación pedido-caso y claim concurrente del worker) fueron corregidos y verificados con demos/tests. Permanecen abiertos: autorización/roles del negocio a validar con usuarios reales, prioridad contra SLA real de ML, corrección humana de hallazgos del catálogo y auditoría/piloto operativo.
