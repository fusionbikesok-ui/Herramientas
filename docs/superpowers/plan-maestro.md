# Plan maestro canónico de FusionBikes

**Vigente desde:** 2026-09-13

**Secuencia:** E0–E26

**Estado del programa:** E0 aceptada; E1 planificada por tramos; E2–E26 en borrador

**Fuente estructurada:** `delivery-program.json`

El contrato que debe satisfacer cada ficha está en `delivery-contract.md`.
La arquitectura transversal está en `atlas-arquitectura.md`; E0–E4 agregan contratos específicos
generados desde `delivery-details.json`.

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

- Cada número representa una identidad estable y un resultado verificable, aceptable y reversible.
- Las dependencias forman un DAG explícito. La numeración facilita referencia y no crea por sí sola
  una dependencia con la entrega anterior.
- Una ficha debe ser autocontenida y no puede pasar a `desarrollo` si conserva decisiones abiertas,
  cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- El código existente es evidencia reutilizable, no aceptación automática.
- Los IDs E0–E26 quedan congelados por decisión de José del 2026-09-13. Cambiar dependencias no
  cambia identidad; una entrega nueva recibe un número posterior a E26 y una decisión documental.
- Ninguna entrega comienza hasta que todas sus dependencias explícitas estén `aceptada`.
- El legado sólo recibe correcciones que eviten pérdida económica o bloqueo operativo mientras su
  vertical tenga reemplazo planificado.
- No se instalan servicios, migran datos, habilitan escritores ni cambian canales por autoridad de
  este documento: cada ficha y su aprobación gobiernan su propia ejecución.

## Secuencia vigente

| Entrega | Resultado verificable | Dependencia | Estado |
|---|---|---|---|
| E0 | Infraestructura, DR y PITR | — | aceptada |
| E1 | Fundación PostgreSQL en sombra | E0 | planificada |
| E2 | Modelo e importación del catálogo | E1 | borrador |
| E3 | Identidad y matcher único en sombra | E2 | borrador |
| E4 | Campaña SKU y corte de identidad | E3 | borrador |
| E5 | Libro de stock, apertura y reservas | E4 | borrador |
| E6 | Recepción y conteos sobre el libro | E5 | borrador |
| E7 | Corte de autoridad de stock | E6 | borrador |
| E8 | Orden canónica e importación | E1 | borrador |
| E9 | Dominio de pedidos y efectos remotos | E5, E8 | borrador |
| E10 | UI, preparación y simulación | E9 | borrador |
| E11 | Corte de pedidos y despacho | E7, E10 | borrador |
| E12 | Plantillas y propuestas de catálogo | E2 | borrador |
| E13 | Publicación verificada por categorías | E4, E12 | borrador |
| E14 | Inventario, archivo y apagado reversible | E11, E13 | borrador |
| E15 | Compatibilidad y retiro físico autorizado | E14, E23, E24 | borrador |
| E16 | Excepciones físicas y proveedor | E7 | borrador |
| E17 | Garantías y posventa | E8, E16 | borrador |
| E18 | Taller web y Woo | E17 | borrador |
| E19 | Base App, contrato y migración OTA | E1 | borrador |
| E20 | Bandeja, alertas y turnos App | E9, E19 | borrador |
| E21 | Infraestructura móvil offline | E19 | borrador |
| E22 | Recepción y conteos iPhone | E6, E21 | borrador |
| E23 | Taller iPhone | E18, E21 | borrador |
| E24 | Impresión y agente Windows | E10 | borrador |
| E25 | Métricas, reposición y preventa | E7, E11 | borrador |
| E26 | Consolidación y cierre | terminales del DAG | borrador |

La ruta de cada ficha está en `deliveries/README.md`.

La ejecución vigente de E1 se divide según PM-174. El tramo 1 está implementado y revisado sólo en
aislamiento; el [diseño del tramo 2](specs/2026-09-15-e1-tramo2-barridos-design.md) y su
[plan de implementación](plans/2026-09-15-e1-tramo2-barridos.md) están aprobados únicamente contra
infraestructura efímera. Los tramos 3 y 4 y cualquier cambio en el VPS requieren aprobación propia.

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
con un número nuevo posterior al último ID congelado.
