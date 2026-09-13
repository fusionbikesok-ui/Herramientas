# Crosswalk de líneas históricas a E0–E26

Este archivo es el único lugar vigente donde los identificadores P, UM y GP determinan procedencia.
No expresan orden operativo ni estado actual.

## Programas y fichas

| Material histórico | Destino vigente | Tratamiento |
|---|---|---|
| P0; E23 recuperación/staging | E0 | Infraestructura y DR; robustez final también se verifica en E26 |
| P1 | E1 | Fundación en sombra |
| P2.1–P2.2; UM1.3 modelo; E9 familias | E2 | Modelo/importación de catálogo |
| P2.3–P2.6; UM1.1–UM1.5; Matcher/Cobertura/Guardia/vigía | E3 | Dominio/UI/sombra de identidad |
| P2.7–P2.8; UM1.6 | E4 | Campaña y corte |
| P3.1–P3.3; E8–E11 dominio | E5 | Libro y reservas |
| P3.4; E14; E16 | E6 | Recepción/conteos |
| P3.5–P3.8; E8–E11 corte | E7 | Autoridad de stock |
| P4.1–P4.2; GP2–GP3 | E8 | Modelo/importación de pedidos |
| P4.3; GP4–GP8; GP13–GP15 | E9 | Dominio y efectos |
| P4.4–P4.7; E1/E2/E4/E12; GP1–GP12 | E10 | UI/preparación/sombra |
| P4.8; GP9–GP12 corte | E11 | Corte de pedidos |
| P5.1–P5.3 | E12 | Propuestas de catálogo |
| P5.4–P5.5 | E13 | Publicación por categorías |
| P6.1–P6.4 | E14 | Inventario/archivo/apagado |
| P6.5–P6.6; E24 retiro | E15 | Compatibilidad/retiro |
| E18 antiguo | E16 | Excepciones reconstruidas |
| E19 antiguo | E17 | Garantías reconstruidas |
| E20 antiguo | E18 | Taller web reconstruido |
| E5 antiguo; PM-162 | E19 | Base App/OTA |
| E6–E7 antiguos | E20 | Bandeja/turnos App |
| E13 antiguo | E21 | Offline común |
| E15 y E17 antiguos | E22 | Recepción/conteos App |
| E21 antiguo | E23 | Taller App |
| E3 antiguo | E24 | Impresión |
| E22 antiguo | E25 | Métricas/reposición |
| E24 antiguo y resto de E23 | E26 | Consolidación final |

## Planes archivados

| Plan | Destino principal |
|---|---|
| apertura de ola/mini-ola; preparación rediseño; devolución canceladas | E10 |
| identidad de productos; arquitectura UM1; vigía de formato; guardia ventas | E2–E4 |
| historial de despachos; gestión de pedidos | E8–E11 |
| ubicaciones y ronda | E5–E7 |
| precio ML objetivo | Fuera de alcance; requiere decisión nueva |
| QA bajo demanda | E0 y gate acumulativo E1–E26 |
| plataforma auditable 2026-09-13 | E0–E15 |
| plan-maestro-v2 | E0–E26, con decisiones preservadas |

## Código, rutas, tablas, migraciones y pruebas

La asignación detallada se determina por dominio y se verifica al iniciar cada ficha:

| Dominio técnico | Destino |
|---|---|
| matcher, cobertura, identidadProductos, guardiaMl; tablas `identidad_*`, `ml_*`; migraciones 003, 005, 007–008, 012–014, 059–061, 081–092 y 103 | E2–E4 |
| inventario, sync stock, recepciones; `stock_movements`, `stock_rollout_skus`, `inventario_*`, `producto_ubicacion`; migraciones 001–002, 018, 040–041 | E5–E7 |
| gestión de pedidos, preparación, jornada y despacho; `gestion_*`, `preparacion_*`, `pick_*`, `despacho_*`; migraciones 006, 009–011, 015–016, 031–035, 038, 042–048, 050–058, 062–065 y 095–102 | E8–E11 |
| webhooks de producto/catálogo y auditoría; `catalogo_cache`; consume los modelos de 092 y 103, cuya migración tiene dueño E3 | E12–E13 |
| routers, crons, workers, pantallas y tablas legacy | E14–E15 |
| stockExceptions; migraciones 066–071; tests `stockExceptions` | E16 |
| warranties; migraciones 072–075; tests `warranties` | E17 |
| workshop; migraciones 076–080; tests `workshop` | E18/E23 |
| `/api/v1`, mobile auth/devices/meta y contrato App; migraciones 022, 026 y 030 | E19 |
| questions/messages, notifications, inbox, claims, push y asignaciones; migraciones 017, 023–029, 036–037 y 093–094 | E20 |
| colas/leases/replay offline App | E21–E23 |
| etiquetas y agente Windows; migraciones 039 y 049 | E24 |
| incidentes, métricas, reposición y proyecciones; migraciones 019–021 | E25 |
| suite completa, migraciones acumuladas, contratos y restore | E26 |

La migración 004 (precios ML) queda excluida de E0–E26 por el límite explícito del maestro. Así,
cada migración 001–103 tiene un único destino primario o una exclusión expresa; una entrega que
consume una tabla ajena no adquiere autoridad sobre su migración.

Cada ficha nueva contiene el contrato aplicable. Si un archivo mezcla dominios, se registra por
comportamiento y no se duplica la autoridad.

## Decisiones PM

`decision-crosswalk.json` asigna las 164 decisiones PM a un único dueño vigente. Una decisión puede
tener consumidores adicionales en fichas posteriores, pero sólo el dueño controla su cambio. Las
PM superadas conservan dueño como evidencia y su texto indica cuál decisión las reemplazó.
