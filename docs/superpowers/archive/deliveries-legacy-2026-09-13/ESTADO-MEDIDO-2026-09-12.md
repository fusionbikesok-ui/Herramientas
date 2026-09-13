# Estado medido de E0–E24 — 2026-09-12

Este documento no repite lo que cada entrega dice de sí misma. **Mide contra la base de
producción y contra el código montado**, que es la única evidencia que el índice acepta.

Método: conteo de filas de las tablas que cada entrega escribiría si se estuviera usando,
routers efectivamente montados en `server.js`, y enlaces desde el home.

## El hallazgo principal

El sistema no está frenado por falta de construcción. Está frenado por **puertas que no se
abrieron y datos que no se cargaron**.

Cinco entregas tienen backend completo, tablas creadas, rutas montadas, pantalla escrita — y
**cero filas**. En tres de esos cinco casos la causa es literalmente que **la pantalla no está
enlazada desde el home**.

| Herramienta | Tablas | Filas | Ruta montada | Enlazada en el home |
|---|---|---|---|---|
| Taller | 5 (`workshop_*`) | **0** | sí (`/api/v1/workshop`) | **no** |
| Garantías | 5 (`warranty_*`) | **0** | sí (`/api/warranties`) | **no** |
| Excepciones físicas | 3 (`stock_*`) | **0** | sí (`/api/stock-exceptions`) | **no** |
| Auditoría de publicaciones | 1 | 2.730 | sí (`/api/auditoria`) | **no** |
| Lotes de despacho | 2 (`despacho_*`) | **0** | sí | sin botón que cree el lote |
| Libro de stock | `stock_movements` | **0** | sí | sin SKU habilitado en el rollout |

Antes de planificar nada nuevo conviene mirar esta tabla: construir más encima de esto agranda
el problema en vez de resolverlo.

## En uso real, con evidencia

| Entrega | Medición | Estado real |
|---|---|---|
| E1/E2/E12 · Preparación | 294 preparaciones, 304 ítems, **540 fotos**, 3 perfiles, 1 devolución | **En producción.** Es la herramienta más usada después del conteo. |
| E16 · Conteos | 38 sesiones, **18 confirmadas**, 1.006 conteos ajustados contra Woo | **En producción y activa.** Rediseñada el 2026-09-11. |
| E9 · Identidad (UM1) | modo **`enforced`**, escrituras remotas habilitadas, 6.340 identidades de canal, 1.242 casos: **1.128 verificados**, 109 resueltos, **5 pendientes** | **Prácticamente terminada.** Ver abajo. |
| E6 · Bandeja | 81 ítems en `inbox_items` | **En uso**, pero `inbox_assignments` en 0: nadie se asigna nada. |
| E5 · App iPhone | 11 `device_tokens`, 228 notificaciones enviadas, 211 leídas | **Instalada y recibiendo push.** El proyecto vive en `/opt/fusionbikes/FusionBikes-App`. |
| E14 · Recepción | 16 recepciones, 111 ítems | **En uso, bajo volumen.** |
| E3 · Etiquetas | 62 en cola, **las 62 pendientes** | Construida y alimentada, pero **nadie imprime**: la cola sólo crece. |
| E22/E23 · Incidentes | 28 incidentes, todos resueltos; outbox de email con 28 salidas | **Funciona**, pero ninguna pantalla los lista. |
| (sin número) Gestión de pedidos | 2.124+ pedidos importados, cron cada 10 min | **En producción.** No figura en la tabla E0–E24 del maestro. |

## Construido y sin usar

| Entrega | Medición | Qué falta, concretamente |
|---|---|---|
| E4 · Lotes y despacho | `despacho_lotes` **0** | Ninguna pantalla llama al endpoint que crea el lote (`routes/preparacion.js:1128`). |
| E10 · Libro de stock | `stock_movements` **0**, `stock_rollout_skus` **0** | El endpoint de transferencia exige que el SKU esté habilitado en el rollout, y no hay ninguno habilitado. |
| E9 · Ubicaciones | **13 ubicaciones** cargadas (eran 1 el 2026-09-10), `producto_ubicacion` **0** | Los estantes ya están. Falta mapear productos: sin eso, la ronda sugerida y la devolución de canceladas no tienen a dónde apuntar. |
| E18 · Excepciones físicas | 3 tablas en 0 | Pantalla sin enlace desde el home. |
| E19 · Garantías | 5 tablas en 0 | Pantalla sin enlace desde el home. |
| E20 · Taller | 5 tablas en 0 | Pantalla sin enlace desde el home. |
| E7 · Turnos | `inbox_assignments` **0** | Construido, nunca usado. |
| Jornada / olas | router **no montado** en `server.js` | Decidido: vuelve o se archiva. Sigue sin decidir. |

## E9 · Identidad de productos — lo que falta para cerrarla

Es la entrega más cerca de terminar y la que el usuario quiere cerrar. Al 2026-09-12 quedan
**5 casos abiertos**, todos urgentes y todos asignados a Jose:

| Caso | Clasificación | Publicación |
|---|---|---|
| 659 | `gtin_contradictorio` | `MLA2013471629` |
| 662 | `gtin_contradictorio` | `MLA2014047723` |
| 860 | `gtin_contradictorio` | `MLA2815578228` |
| 1217 | `stock_no_verificado` | `MLA2076334159` |
| 1220 | `sku_ausente` | `MLA1446723717` |

Los tres `gtin_contradictorio` necesitan una decisión humana —cuál de los dos códigos es el
correcto— que ninguna automatización puede tomar. Lo que sí se puede hacer desde acá es dejar la
evidencia de los tres junta y comparable para que se resuelvan en una sola pasada.

`identidad_familias` tiene **1 sola familia**: la parte de "familias" de E9 está apenas empezada
y es independiente de los casos.

## Corolario

El 2026-09-11 el índice anotó que "el estado que un plan declara de sí mismo no es evidencia".
Esta medición lo confirma y lo amplía: **de las 25 entregas, las que están frenadas no lo están
por falta de código**. Están frenadas por un enlace que falta en el home, un botón que nadie
cableó, una lista de SKUs que nadie habilitó o un mapeo que nadie cargó.

La consecuencia para planificar: la siguiente unidad de trabajo con más valor por hora no es una
entrega nueva, es **abrir las puertas de lo que ya está construido y probado**.
