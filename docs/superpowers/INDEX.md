# Índice canónico de planificación y operación

Actualizado: 2026-09-13. Los estados de esta tabla se verificaron contra el código y la base de
producción, no contra lo que decían los propios documentos.

## Plan maestro y referencias

- Plan maestro: `plans/plan-maestro-v2.md` — especificación canónica vigente.
- Decisiones consolidadas: `decisions/plan-maestro-decisions.md`.
- Patrones WMS evaluados: `references/wms-patterns.md`.
- Progreso y evidencia E0–E24: `deliveries/README.md`.
- Checkpoint reproducible: `deliveries/CHECKPOINT-TEMPLATE.md`.
- SOP operativos: `/opt/fusionbikes/herramientas/docs/operations/sops/README.md`.
- Estado breve del día a día: `/opt/fusionbikes/herramientas/docs/memory/active.md`.

## Planes específicos y su estado real

| Plan | Estado verificado al 2026-09-13 |
|---|---|
| `2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` | **Arquitectura y orden de ejecución vigentes del maestro desde 2026-09-13 (PM-159).** Integrado: §9 del plan y §19.0 del maestro. Verticales P0–P6 en `deliveries/PLAT-*`, todas planificadas. Gate 0 no se cumple hoy (disco 91%). Cada ejecución sigue requiriendo autorización explícita. |
| `2026-09-09-gestion-pedidos-utilizable.md` | **GP11 y GP12 entregados.** La pantalla es real, el cron importa cada 10 min (2.120 pedidos), el gate de preview ya no existe. **Faltan GP13 (editar datos), GP14 (editar productos) y GP15 (cuotas y reintegros).** |
| `2026-09-10-preparacion-rediseno.md` | **Navegación de 4 pestañas y pantalla del pedido hechas.** Faltan: marcado unidad por unidad en "Productos a buscar", cola por reloj de corte, cierre automático de preparaciones despachadas. |
| `2026-09-10-devolucion-preparaciones-canceladas.md` | **Implementado y desplegado.** Bloqueado por un dato: faltan cargar los estantes reales (hay 1). |
| `2026-09-11-precio-ml-objetivo.md` | **Tramos 1 y 2 desplegados el 2026-09-12.** El precio objetivo (neto = contado) se calcula contra ML y se aplica a mano desde el reactivador y desde la auditoría. |
| `2026-09-11-conteo-rediseno-design.md` (specs/) | **Implementado el 2026-09-11.** Lista única con foto, conteo a ciegas, fusión de filas partidas, buscador de asociación compartido, acciones en el historial y etiquetas en lote. |
| `2026-09-12-vigia-formato-publicaciones-design.md` (specs/) | **Diseño aprobado el 2026-09-12, sin implementar.** Detecta cuándo una publicación cambia de formato o de producto de catálogo, la pausa y avisa. |
| `2026-09-11-correccion-de-conteos-design.md` (specs/) | **Diseño aprobado el 2026-09-11, sin implementar.** Corregir un conteo ya confirmado crea una sesión de corrección propia; la original nunca se reescribe. |
| `2026-09-10-ubicaciones-y-ronda.md` | **Ronda sugerida, foto de ubicación, autorización y auditoría de diferencias desplegadas.** Falta el mapeo real: 0 productos mapeados. |
| `2026-09-04-identidad-productos.md` | **Sustituido como guía futura el 2026-09-13 por el programa de plataforma (PM-159); queda como evidencia.** Legado vigente hasta el corte P2: modo `enforced`, 5 casos abiertos asignados a Jose. |
| `2026-09-05-arquitectura-um1.md` | **Histórico desde 2026-09-13.** Explica el porqué del legado UM1, no instrucción vigente. |
| `2026-09-08-historial-despachos-relacional.md` | **Modelo sustituido, decisiones vigentes.** Sus seis tablas `*_despacho` nunca se crearon; se construyó `gestion_*`. Su parte física sigue sin puerta: `despacho_lotes` en 0. |
| `2026-09-01-apertura-ola-mini-ola.md` | **Construido y desconectado.** El router `jornada` no está montado y la pantalla retiró el flujo. Hay que decidir si vuelve o se archiva. |

## Lo que está construido y nadie usa

Un patrón que ya apareció tres veces y conviene mirar antes de planificar cosas nuevas:
backend completo, probado y desplegado, **sin la puerta que lo hace alcanzable**.

- **Lotes de despacho**: crear, escanear, cerrar, salida y auditoría existen; ninguna pantalla
  llama al endpoint que crea el lote (`routes/preparacion.js:1128`). 0 filas.
- **Ubicaciones del conteo**: el mapeo SKU→ubicación estaba cableado desde siempre y nunca se
  disparó porque una regla de exclusividad hacía inservible la opción. Corregido el 2026-09-10.
- **Autorización de diferencias**: `/diferencias/pendientes`, `/aprobar` y `/rechazar` existían
  desde el 2026-08-27 sin ninguna pantalla que los llamara. Corregido el 2026-09-10.
- **Olas de preparación**: construidas, testeadas y desmontadas.

## Históricos y sustituidos

- La copia literal del plan en `ce5c3cb` está en `archive/plan-maestro-v2-ce5c3cb.md`. Es
  evidencia histórica, no instrucción vigente.
- `/opt/fusionbikes/herramientas/docs/ESTADO-2026-08-21.md` es una fotografía histórica fechada.
- `/opt/fusionbikes/herramientas/docs/traspaso-a-claude-plan-consolidado.md` es un handoff
  histórico sustituido por el checkpoint por entrega.
- Los documentos de `specs/` conservan decisiones de su fecha. Una spec solo es vigente cuando
  el maestro o una ficha de entrega la enlaza expresamente.

## Regla de precedencia

Ante contradicciones: contrato ejecutable y código verificado describen el presente; el plan
maestro describe el objetivo aprobado; las decisiones explican el porqué; las fichas prueban
progreso; memoria resume; Git conserva historia. Ningún chat ni MCP reemplaza estos archivos.

**Corolario aprendido el 2026-09-11:** el estado que un plan declara de sí mismo no es
evidencia. Dos planes decían "planificado" con su entrega en producción, y uno con 52 pasos sin
tildar estaba construido y desconectado. Antes de retomar un plan, medí contra la base.
