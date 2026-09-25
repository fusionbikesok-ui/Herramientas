# Plan maestro canónico de FusionBikes

**Vigente desde:** 2026-09-13

**Secuencia:** E0–E26

**Estado del programa:** E0 aceptada; E1 en desarrollo por tramos (T1–T4 implementados y **desplegados en producción**, campaña de aceptación en curso; **no aceptada**); E2 **observada** (T1–T3 desplegados en producción el 2026-09-20 según la ficha; ventana de 7 días de sólo lectura en curso, 4 de 7 al 2026-09-23; **no aceptada**); E3 en **desarrollo** (motor en sombra y bandeja de identidad con primeras corridas en producción el 2026-09-24 según la evidencia; corte 3 en construcción); E4–E26 en borrador. **Actualizado el 2026-09-25**; producción no verificada por esta actualización, ver «Pendientes sin registro».

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
| E2 | Modelo e importación del catálogo | E1 | observada |
| E3 | Identidad y matcher único en sombra | E2 | desarrollo |
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
T3 está implementado (C1–C10, commits hasta `3a17af0`): C9 verde el 2026-09-17 (`evidence/e1/2026-09-17-E1-LAT-PGDOWN-20260917T030620Z.md`), plataforma en producción y copia de sombra de Woo al 100 % desde el 2026-09-17 10:48 UTC, canario Woo cerrado por José y E1-SOAK-01 dispensado por José (`evidence/e1/2026-09-17-E1-C10-canario-woo.md`). Rollback ensayado el 2026-09-17 15:18–15:38 UTC. El canario de ML se encendió el 2026-09-17 16:38 UTC pero descartó todo 5 h por una cuenta sin configurar y el monitor abortó a las 21:40 UTC; corregido y reencendido el 2026-09-18 03:48:30 UTC (`evidence/e1/2026-09-18-E1-C10-incidente-canario-ml.md`), con el tope pendiente de ajuste con la medición de 7 días (23/09). T4 implementado en código (tareas 0–15 del plan del tramo 4, rama `feature/e1-t4-continuacion`, 2026-09-18): firma Ed25519 sobre JCS, manifiesto de auditoría y reporte de sombra diarios, depósito en B2 con Object Lock COMPLIANCE que no duplica ante caídas, email con el sobre adjunto, vigilante del legado a las 09:00 ART, verificador `npm run verificar-informe`, y passkeys con recuperación, todo detrás de la doble llave. Revisado por Codex en dos tandas (A: 3 críticos corregidos; B: sin críticos). `E1_TRAMO=4` del gate de escenarios cubre los 43 escenarios. **La tarea 16 (puesta en producción) se hizo el 2026-09-18**: informes firmados encendidos a las 12:29 UTC, manifiesto y reporte subidos a B2 en modo `compliance`, firma verificada con `npm run verificar-informe` sobre los objetos bajados de B2, email enviado y vigilante del legado encendido (`evidence/e1/2026-09-18-E1-T4-tarea16-avance.md`). Confirmado en producción el 2026-09-20: `audit.audit_daily_manifests` tiene los manifiestos del 17, 18 y 19 firmados con `e1-2026-09`, con `retention_mode = compliance` y retención a 2027, y el scheduler cerró la vuelta del día 19 a las 10:00 UTC sin fallos. **Para aceptar E1 falta**: el **tramo 5** (PM-188, 2026-09-25: cupo sombra de ML por corriente, 429 sintético etiquetado `CUPO_SOMBRA_AGOTADO` y ajuste del tope con medición registrada; diseño en `specs/2026-09-25-e1-tramo5-cupo-por-corriente-design.md`), después la campaña de 7 días verdes seguidos (PM-186) contada desde el despliegue de T5, y la revisión de José. E1 no está aceptada. **E2 y E3 avanzan en sombra sin E1 aceptada por PM-187**: no se aceptan ni encienden nada hasta que E1 cierre.

**E2 tramo 1 (modelos y variantes) desplegado en producción el 2026-09-20.** Las 14 tareas del [plan](plans/2026-09-18-e2-tramo1-modelos-variantes.md) están hechas, incluida la tarea 14 (puesta en producción) con sus 9 pasos: migración `0013_catalogo.sql`, outbox del legado (migración 108) con captura y despachador, copia inicial, proyector con canario de 100, bootstrap de las dos cuentas y conciliación diaria a las 03:30 ART. Estado al cierre: **4.053 modelos, 6.946 variantes, 12.849 representaciones, 10.699 mensajes procesados y 1 solo en DLQ** (un producto en la papelera de Woo, rechazo correcto). La conciliación automática corrió sola el 2026-09-20 a las 06:30 UTC con el matcher en `sinCambios: 5207` — cero deriva entre legado y plataforma. **E2 T2 (atributos, imágenes y datos comerciales) y T3 (taxonomía propia, marcas, colecciones, packs y kits) figuran como desplegados en producción el 2026-09-20** (migraciones `0014` y `0015`, backfill de 12.850 representaciones (12.849 al cierre de T1) y 86.632 atributos; fuente: `deliveries/E2-catalogo-modelo-importacion.md:3` y `evidence/e3/2026-09-24-E3-medicion-motor.md`; esta actualización no lo verificó contra producción). La partición de E2 la redefinió José el 2026-09-20: T2 captura lo que el canal ya manda y el proyector descartaba (atributos, imágenes, precio, stock, GTIN, marca) y T3 es taxonomía propia, colecciones y packs/kits, con diseño en
`specs/2026-09-20-e2-tramo2-atributos-imagenes-design.md` y plan del T3 en `plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md`. **E2 no está aceptada.** La evidencia de aceptación (`evidence/e2/2026-09-23-E2-aceptacion.md`, que estaba sin commitear en el árbol principal y se incorpora en esta rama sin cambios) no es un acta: cierra el universo de Woo (5.300 vistos = 5.300 con representación) y de ML (4.217 = 4.217) con diferencia 0, y la conciliación del matcher lleva 4 días seguidos sin deriva (20–23/09, 4 de 7 contractuales; se cumplirían el 2026-09-27 si sigue igual), pero deja abiertos: 7 discrepancias de crosswalk (decisiones del matcher sobre publicaciones de ML que el bootstrap nunca vio), 313 casos de clasificación para decisión en bloque, y un defecto de E1 T4: el `last_hash` de los manifiestos firmados del 19 al 22/09 era el de `chain_seq = 9999` en vez del último evento del día (orden por texto en `plataforma/src/informes/manifiesto.ts`). Ese defecto está corregido en el commit `58a611d1` (2026-09-24); si los manifiestos ya subidos a B2 con Object Lock COMPLIANCE se re-emiten o se documentan como erróneos no está registrado. **Casos de identidad abiertos:** 5.361 al 2026-09-23 (2.227 `omitida_revisar`, 2.098 `sku_pendiente`, 500 `user_product_divergente`, 276 `categoria_sin_mapeo`, 129 `atributo_divergente`, 48 `woo_sku_no_canonico`, 37 `categoria_en_desacuerdo`, 29 `identidad_legado`, 17 `sku_inexistente_en_woo`; `evidence/e2/2026-09-23-E2-aceptacion.md` §6). La cifra anterior de ~4.700 era del 2026-09-20 y ya no vale; son decisiones de negocio pendientes, no fallas, y el territorio de E3.

**E3 (identidad y matcher único en sombra) en desarrollo desde el 2026-09-24.** Spec aprobada por José el 2026-09-24 (`specs/2026-09-24-e3-identidad-design.md`). **Corte 1** (bandeja con autoridad humana y motor en sombra; plan `plans/2026-09-24-e3-corte1-bandeja.md`): migración `0020`, `decisionVigente` única (humana E3 → legado → pendiente), pantalla en el legado (`public/bandeja-identidad/`) con proxy HMAC; verificación previa del 2026-09-24 con plataforma 847 tests verdes y legado 3.086 (`evidence/e3/2026-09-24-e3-corte1-puesta-en-produccion.md`). La evidencia registra la primera corrida del motor en producción el 2026-09-24 18:42Z (500 casos, 0 candidatos por un modelo de título ML mal supuesto, corregido después) y una cobertura medida de 89 % (3.843/4.335); quedan **492 casos `omitida_revisar` sin fuente de título de ML** (misma fuente, y `evidence/e3/2026-09-24-E3-medicion-motor.md`, incorporada en esta rama sin cambios). Con datos ya capturados sólo 163 de 4.325 casos (3,8 %) tendrían auto-vínculo por SKU exacto. **Rediseño de la bandeja, escritorio primero** (`plans/2026-09-25-bandeja-rediseno-escritorio.md`): tareas T1–T4 en el tronco (apartar/«No estoy seguro», teclas, fila «Por qué»). **Corte 3 (canario del auto-SKU)** (`plans/2026-09-25-e3-corte3-canario-auto-sku.md`): tareas 1 y 2 de 8 hechas según los commits `dc7424c6` y `1d382ab3` (los checkboxes del plan siguen sin marcar); todo detrás de los flags `E3_CANARIO`, `E3_AUTO_SKU` y `E3_INTERVENTION` apagados y **nada se enciende sin José**; el canario real exige la ventana de 7 días cerrada, el replay en verde y su OK. E3 no está aceptada.

**Pendientes sin registro (no resueltos por esta actualización):**
- **Ajuste del tope de ML previsto para el 2026-09-23** con la medición de 7 días: no hay commit, decisión PM ni evidencia que lo registre; se ignora si se hizo. El único tope documentado es el de 60 rpm del 2026-09-17 (`evidence/e1/2026-09-18-E1-C10-incidente-canario-ml.md`).
- **Campaña de 7 días verdes de E1** (PM-186, canario de ML reencendido el 2026-09-18 03:48 UTC): no hay reporte de campaña ni revisión de José registrados; E1 sigue sin aceptar.
- **Estado en producción** (versión desplegada, migraciones aplicadas, flags): no fue verificado por esta actualización; las cifras salen de la evidencia y las fichas citadas.
- **Migración a `/items/bulk?ids=`**: `/items?ids=` de Mercado Libre entra en deprecación y deja de estar disponible el **2026-10-25** (`specs/ml-api-guia.md` §1); verificar antes de esa fecha que ningún llamador siga usando el endpoint viejo.
- **Diagnóstico de alertas de E1 (2026-09-25)**: los 429 sintéticos del gateway sombra (`GATEWAY_ML_SHADOW_RPM` como bucket único compartido por las 6 corrientes ML) dejaron `ml.shipments` y `ml.messages` con 0 barridos OK en 24 h y señales de `ml.items` en dead letter; esto bloquea la campaña de 7 días verdes de E1. Ver `specs/ml-api-guia.md` §4 y su backlog §7 para la corrección definitiva (cupo por corriente, etc.), convertido en E1 T5 por PM-188 (puntos 1 y 3 de la guía §7; los puntos 2 y 4 siguen en backlog).

## Arquitectura e invariantes acumulativos

- Toda entrega, tramo o cambio que llame a Mercado Libre o procese sus webhooks debe cumplir
  `specs/ml-api-guia.md` y citarla en su diseño (regla del 2026-09-25).
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
