# Plan maestro canónico de FusionBikes

**Vigente desde:** 2026-09-13

**Secuencia:** E0–E26

**Estado del programa:** E0 aceptada; E1 en desarrollo por tramos (T1–T4 implementados y **desplegados en producción**, campaña de aceptación en curso); E2 con el tramo 1 desplegado en producción el 2026-09-20 y los tramos siguientes sin especificar; E3–E26 en borrador

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
| E1 | Fundación PostgreSQL en sombra | E0 | desarrollo |
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

La ejecución vigente de E1 se divide según PM-174. Los tramos 1 y 2 están implementados y verificados
sólo en infraestructura efímera: el 2026-09-16 `E1_TRAMO=2 npm run test:e1` terminó en verde con el
worker real contra el simulador y la revisión independiente quedó aprobada en `52f6805`. El
[diseño de T3](specs/2026-09-16-e1-tramo3-sombra-viva-design.md) y su
[plan](plans/2026-09-16-e1-tramo3-sombra-viva.md) fijan recibos mínimos, señales separadas de
observaciones, gateway GET tipado, multi-cuenta, `missed_feeds`, prueba de latencia y soak de 24 h.
T3 está implementado (C1–C10, commits hasta `3a17af0`): C9 verde el 2026-09-17 (`evidence/e1/2026-09-17-E1-LAT-PGDOWN-20260917T030620Z.md`), plataforma en producción y copia de sombra de Woo al 100 % desde el 2026-09-17 10:48 UTC, canario Woo cerrado por José y E1-SOAK-01 dispensado por José (`evidence/e1/2026-09-17-E1-C10-canario-woo.md`). Rollback ensayado el 2026-09-17 15:18–15:38 UTC. El canario de ML se encendió el 2026-09-17 16:38 UTC pero descartó todo 5 h por una cuenta sin configurar y el monitor abortó a las 21:40 UTC; corregido y reencendido el 2026-09-18 03:48:30 UTC (`evidence/e1/2026-09-18-E1-C10-incidente-canario-ml.md`), con el tope pendiente de ajuste con la medición de 7 días (23/09). T4 implementado en código (tareas 0–15 del plan del tramo 4, rama `feature/e1-t4-continuacion`, 2026-09-18): firma Ed25519 sobre JCS, manifiesto de auditoría y reporte de sombra diarios, depósito en B2 con Object Lock COMPLIANCE que no duplica ante caídas, email con el sobre adjunto, vigilante del legado a las 09:00 ART, verificador `npm run verificar-informe`, y passkeys con recuperación, todo detrás de la doble llave. Revisado por Codex en dos tandas (A: 3 críticos corregidos; B: sin críticos). `E1_TRAMO=4` del gate de escenarios cubre los 43 escenarios. **La tarea 16 (puesta en producción) se hizo el 2026-09-18**: informes firmados encendidos a las 12:29 UTC, manifiesto y reporte subidos a B2 en modo `compliance`, firma verificada con `npm run verificar-informe` sobre los objetos bajados de B2, email enviado y vigilante del legado encendido (`evidence/e1/2026-09-18-E1-T4-tarea16-avance.md`). Confirmado en producción el 2026-09-20: `audit.audit_daily_manifests` tiene los manifiestos del 17, 18 y 19 firmados con `e1-2026-09`, con `retention_mode = compliance` y retención a 2027, y el scheduler cerró la vuelta del día 19 a las 10:00 UTC sin fallos. **Para aceptar E1 falta**: la campaña de 7 días verdes seguidos con ML en canario, el ajuste del tope de ML con la medición de 7 días (23/09) y la revisión de José. E1 no está aceptada.

**E2 tramo 1 (modelos y variantes) desplegado en producción el 2026-09-20.** Las 14 tareas del [plan](plans/2026-09-18-e2-tramo1-modelos-variantes.md) están hechas, incluida la tarea 14 (puesta en producción) con sus 9 pasos: migración `0013_catalogo.sql`, outbox del legado (migración 108) con captura y despachador, copia inicial, proyector con canario de 100, bootstrap de las dos cuentas y conciliación diaria a las 03:30 ART. Estado al cierre: **4.053 modelos, 6.946 variantes, 12.849 representaciones, 10.699 mensajes procesados y 1 solo en DLQ** (un producto en la papelera de Woo, rechazo correcto). La conciliación automática corrió sola el 2026-09-20 a las 06:30 UTC con el matcher en `sinCambios: 5207` — cero deriva entre legado y plataforma. **Los tramos de E2 posteriores al 1 no están especificados**: sólo existe el diseño del tramo 1. El trabajo que el despliegue destapó y todavía nadie atendió son **~4.700 casos de identidad abiertos** (2.227 `omitida_revisar`, 1.991 `sku_pendiente`, 422 `user_product_divergente`, 49 `woo_sku_no_canonico`, 17 `sku_inexistente_en_woo`, 14 `identidad_legado`), que son decisiones de negocio pendientes, no fallas — y son el territorio natural de E3.

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
