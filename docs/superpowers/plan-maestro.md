# Plan maestro canónico de FusionBikes

**Vigente desde:** 2026-09-13

**Secuencia:** E0–E26

**Estado del programa:** E0 en desarrollo; E1–E26 planificadas

**Fuente estructurada:** `delivery-program.json`

El contrato que debe satisfacer cada ficha está en `delivery-contract.md`.

## Propósito y autoridad

Este documento es la única fuente vigente para el orden, alcance, dependencias y gates del programa.
Las antiguas líneas E0–E24, UM1, GP y P0–P6 están archivadas y sólo aportan evidencia mediante el
`crosswalk-entregas.md`. Una afirmación histórica no autoriza implementación ni prueba aceptación.

La verdad del estado actual se obtiene combinando:

1. código y ancestry de Git en backend y App;
2. código/procesos efectivamente desplegados;
3. esquema y métricas de producción consultados en modo lectura;
4. decisiones PM vigentes;
5. documentación oficial actual de integraciones y sondas autenticadas de sólo lectura.

Una divergencia entre estas fuentes se registra como hallazgo bloqueante. No se resuelve suponiendo
que una de ellas está actualizada.

## Reglas del programa

- Cada número representa un resultado verificable, aceptable y reversible.
- Una ficha debe ser autocontenida y no puede pasar a `desarrollo` si conserva decisiones abiertas,
  cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- El código existente es evidencia reutilizable, no aceptación automática.
- Los IDs en `desarrollo` o posteriores son inmutables. Sólo fichas `planificada|borrador` pueden
  renumerarse; el cambio exige actualizar programa, crosswalk, dependencias y registro de decisiones.
- Ninguna entrega comienza hasta que todas sus dependencias estén `aceptada`.
- El legado sólo recibe correcciones que eviten pérdida económica o bloqueo operativo mientras su
  vertical tenga reemplazo planificado.
- No se instalan servicios, migran datos, habilitan escritores ni cambian canales por autoridad de
  este documento: cada ficha y su aprobación gobiernan su propia ejecución.

## Secuencia vigente

| Entrega | Resultado verificable | Dependencia | Estado |
|---|---|---|---|
| E0 | Infraestructura, DR y PITR | — | desarrollo |
| E1 | Fundación PostgreSQL en sombra | E0 | planificada |
| E2 | Modelo e importación del catálogo | E1 | planificada |
| E3 | Identidad y matcher único en sombra | E2 | planificada |
| E4 | Campaña SKU y corte de identidad | E3 | planificada |
| E5 | Libro de stock, apertura y reservas | E4 | planificada |
| E6 | Recepción y conteos sobre el libro | E5 | planificada |
| E7 | Corte de autoridad de stock | E6 | planificada |
| E8 | Orden canónica e importación | E7 | planificada |
| E9 | Dominio de pedidos y efectos remotos | E8 | planificada |
| E10 | UI, preparación y simulación | E9 | planificada |
| E11 | Corte de pedidos y despacho | E10 | planificada |
| E12 | Plantillas y propuestas de catálogo | E11 | planificada |
| E13 | Publicación verificada por categorías | E12 | planificada |
| E14 | Inventario, archivo y apagado legacy | E13 | planificada |
| E15 | Compatibilidad y retiro autorizado | E14 | planificada |
| E16 | Excepciones físicas y proveedor | E15 | planificada |
| E17 | Garantías y posventa | E16 | planificada |
| E18 | Taller web y Woo | E17 | planificada |
| E19 | Base App, contrato y migración OTA | E18 | planificada |
| E20 | Bandeja, alertas y turnos App | E19 | planificada |
| E21 | Infraestructura móvil offline | E20 | planificada |
| E22 | Recepción y conteos iPhone | E21 | planificada |
| E23 | Taller iPhone | E22 | planificada |
| E24 | Impresión y agente Windows | E23 | planificada |
| E25 | Métricas, reposición y preventa | E24 | planificada |
| E26 | Consolidación y cierre | E25 | planificada |

La ruta de cada ficha está en `deliveries/README.md`.

## Arquitectura e invariantes acumulativos

- PostgreSQL 18 es el destino canónico. SQLite se conserva como archivo histórico verificable.
- Cambios de negocio son transaccionales, auditados, atribuibles y corregidos mediante nuevos eventos.
- Catálogo separa modelo de variante vendible; SKU `FB-{ID_WOO}` es obligatorio, inmutable y no
  reutilizable; GTIN es evidencia y nunca autoridad automática.
- Stock es un libro append-only. `disponible = existencia - reservas - retenciones`; se reserva sólo
  con pago aprobado y se proyecta un único recurso por bolsa remota compartida.
- Fusion conserva la orden canónica. El espejo ML→Woo no crea una segunda reserva; empaque verificado
  y despacho confirmado son eventos distintos.
- Todo efecto ML/Woo usa comando durable, idempotencia, relectura posterior y estado incierto explícito.
- API nueva bajo `/api/v2`; `/api/v1` puede sobrevivir como fachada delgada mientras la App la use.
- API, worker y scheduler son servicios separados. Ningún pendiente queda fuera del scheduler y la
  DLQ siempre es visible.
- PII cifrada por aplicación; autorización por capacidad, reautenticación para riesgo y auditoría
  encadenada con manifiesto diario firmado.

## Gates acumulativos

Toda entrega debe demostrar, cuando aplique:

- restricciones de base, concurrencia, idempotencia, leases y máquinas de estado;
- fallos 403/408/429/5xx, timeout, respuesta incierta y caída entre efecto y confirmación;
- migración repetible, crosswalk, hashes, delta final y restauración;
- un solo escritor remoto y corte de autoridad inferior a 15 minutos;
- suite contractual de la entrega y suite global serial sin regresiones no clasificadas;
- E2E web 390/768/1440 y WCAG 2.2 AA; iPhone/hardware real donde corresponda;
- QA/simulador, sombra, canario, criterio de aborto y rollback ensayado;
- SOP, práctica guiada, jornada observada, métricas antes/después y aceptación de José.

`publicada` significa desplegada; `observada`, usada en una jornada; `aceptada`, cierre explícito de
los gates. Ningún estado implica automáticamente el siguiente.

## Límites explícitos

Precios y contenido ML, sincronización de precios ML y storefront público quedan fuera. Un módulo
nuevo sin descubrimiento equivalente requiere decisión de José y, si entra al programa, una ficha
planificada renumerable o un número nuevo posterior al último ID congelado.
