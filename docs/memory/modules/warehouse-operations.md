# Operaciones de depósito, preparación y stock

## Fuente canónica

La hoja de ruta vigente está en `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`.
Este módulo conserva decisiones aprobadas para entregas futuras y el estado actual explícito;
la historia de cambios pertenece a Git. Las reglas bajo “Modelo objetivo” todavía no están
implementadas como un único libro de stock.

## Preparación y despacho

- Los pedidos ingresan continuamente durante el día y se notifican al área de preparación.
- Desde el 2026-09-08, preparación usa una cola continua sin olas: MercadoLibre primero y antigüedad después. Los pedidos nuevos aparecen en la próxima actualización.
- La pantalla primero consolida todos los productos pendientes por SKU y muestra imagen, cantidad total y cantidad de pedidos. Después el operario abre un pedido, adquiere su claim y completa una checklist escaneando cada unidad. La línea muestra cantidad escaneada/esperada; excedentes y códigos ajenos o desconocidos no modifican cantidades.
- Las olas nunca tuvieron adopción operativa y se retiraron de la UI, del contrato de pendientes y del montaje de `/api/jornada`. Sus tablas y eventos históricos se conservan como auditoría, sin trabajo nuevo.
- El operario encuentra unidades, las asigna al pedido, escanea, toma evidencia y aprueba la
  preparación antes del despacho.
- La evidencia incluye requisitos por ítem y fotos del paquete cuando corresponda. Un error de
  red conserva el borrador/previsualización y ofrece reintento idempotente.
- Objetivo E3: al aprobar evidencia, generar una única etiqueta interna 50×25 y enviarla a una
  computadora Windows del depósito con impresora USB y agente local.
- Objetivo E3: si la impresión falla, conservar la aprobación, dejar alerta persistente y permitir
  reimpresión manual autorizada sin repetir fotos.
- Objetivo E4: generar/reconciliar lotes de transporte después de que los paquetes aprobados estén listos.
- ML Full queda fuera. El transporte único retira ML, Andreani y Flex. Para MercadoEnvíos la hora máxima no es fija y puede variar por paquete; se usa la hora máxima de entrega en el centro de acopio. ML y Andreani requieren 30 minutos de margen. Flex debe salir como máximo a las 17:00 para permitir el regreso del transporte antes del cierre de las 19:00. Web mantiene máximo normal de preparación a las 15:00.
- Un Flex fuera de margen se prepara igualmente y queda para el día siguiente; no se descarta ni se fuerza un despacho tardío.
- E1 se redefine como cola continua, checklist por pedido y escaneo unitario. Continúa sin aceptación hasta completar pruebas focalizadas, recorrido responsive y validación operativa real.
- Cancelaciones o cambios que afectan un pedido preparado invalidan evidencia y etiquetas; una
  unidad reasignada a un ML urgente puede exigir rehacer la preparación web desplazada.
- Un faltante es incidente urgente y dispara búsqueda/conteo escalonado; no se oculta como pedido
  simplemente pendiente.
- E1 documenta fallos operativos y técnicos relevantes, reintentos agrupados y correcciones inmutables con actor, hora, antes/después y motivo.

## Modelo físico y comercial: objetivo E8–E18

La validación histórica de jornada/olas queda obsoleta para aceptación funcional. Los archivos y migraciones históricos pueden servir para auditoría, pero no forman parte del runtime ni de los gates focalizados de la checklist.

- Fusion mantiene físico por ubicación y libro inmutable de movimientos.
- WooCommerce es autoridad de disponible comercial; Fusion separa físico, disponible,
  comprometido, no disponible y entrante.
- La creación del pedido o reducción de Woo no vuelve a descontar físicamente la unidad. El físico
  baja al entregar al transportista.
- Hay múltiples depósitos, ubicación base y overflow; las transferencias se confirman al llegar.
- Las ubicaciones se seleccionan manualmente de forma jerárquica; no se requieren QR.
- Las correcciones se hacen con movimientos inversos, nunca editando historia o un saldo absoluto.
- El rollout del modelo nuevo es por familia o SKU y no mezcla escrituras legacy y nuevas.
- Productos no publicados pueden tener físico interno, pero el canal comercial permanece bloqueado.
- No se elimina/desvincula un producto con físico, compromiso o entrante.

## Recepción, devoluciones y conteos: objetivo E14–E18

Corrección operativa 2026-09-05: la sesión de conteo 31 (Santini) quedó confirmada después de
ajustar únicamente sus fallidos. `FB-62881` se fijó en Woo a 2 unidades (dos filas del mismo
SKU); `FB-65097`, `FB-65098` y `FB-65099` eran variaciones eliminadas y se descartaron como no
aplicables, conservando sus diferencias históricas. La sesión quedó sin filas pendientes.

- E18 tiene integrado el núcleo durable y una segunda fase: `/api/stock-exceptions` y
  `lib/stockExceptions.js` persisten incidentes físicos, tareas, versiones, `operation_id` y
  auditoría append-only mediante `migrations/066_stock_exceptions.sql`; `migrations/067_stock_exception_returns.sql`
  agrega recepción idempotente de devoluciones, clasificación disponible/no disponible/condicionado
  y daño urgente con tarea de inspección. La migración `migrations/068_stock_exception_woo_outbox.sql`
  agrega una cola durable para deltas comerciales y `procesarWooOutbox` implementa claim,
  reintento y confirmación/fallo con adaptador inyectable. `crearSenderWooExcepciones` usa el
  cliente Woo existente con stock live, delta y verificación posterior, actualizando cache solo
  tras PUT exitoso; falta resolver concurrencia previa al PUT. `migrations/069_supplier_returns_disposals.sql` y su API registran
  devoluciones a proveedor y descartes irreversibles con idempotencia/auditoría; falta completar
  estados de seguimiento versionados hasta recibida/cancelada y eventos propios de proveedor;
  falta completar recepción/inspección, permisos finos y E2E; `/excepciones/` ofrece consulta y
  acciones básicas protegidas, por lo que E18 continúa en desarrollo.

- La recepción se procesa por línea; documentos pueden llegar antes, durante o después de la
  mercadería.
- Cada línea confirma identidad, cantidad y condición visible, con modo directo, acumulado o unitario.
- SKU desconocido en Woo queda como físico provisional no vendible hasta catalogación.
- Devoluciones entran a inspección/no disponible y solo pasan a vendible tras aprobación.
- Daño interno mueve a no disponible, reduce Woo y abre revisión con foto.
- El primer conteo es ciego. Movimientos posteriores al snapshot se reconcilian, no se pierden.
- Diferencias de alto riesgo requieren reconteo, motivo y confirmación reforzada; se prefiere otro operario, pero la misma persona puede repetir si no hay reemplazo y queda marcado.
- No se lleva a cero lo no contado sin confirmación explícita.
- Objetivo E17: el conteo offline conservará eventos cifrados hasta siete días, reproducirá en orden
  y se detendrá ante conflictos incompatibles; no usará last-write-wins.

## Integraciones y excepciones: objetivo E11–E22

- E20 inició el núcleo de taller en `workshop_jobs`, `workshop_events` y `workshop_parts`:
  trabajos, diagnóstico/presupuesto y repuestos con estados versionados. La bandeja `/taller/`
  permite consultar, cargar diagnóstico/presupuesto y avanzar estados con `expected_version` e
  idempotencia. E20 registra consumo instalado como salida contable y devolución como entrada
  inversa desde ubicación, enlazados al repuesto e idempotentes. La venta del service ya tiene
  outbox durable idempotente y worker con recuperación/reintento para Woo, pero aún falta el
  payload/adaptador de creación remota, tarifas, checklists y piloto.

- E19 inició su núcleo durable en `warranty_cases`/`warranty_events`: alta idempotente,
  estados versionados y timeline mediante `/api/warranties`. Continúa en desarrollo; faltan
  inspección, carga de evidencia bajo `uploads/warranty` y compromisos de reemplazo separados del stock; faltan
  consumo/liberación en el ledger, carga real de adjuntos, Woo, UI y E2E; consumir un compromiso
  ya crea un outbox Woo durable con delta negativo, sin llamada remota dentro de la transacción;
  `procesarWooOutboxGarantia` lo reclama, reintenta y confirma/falla con un adaptador aislable.

- Si Woo está caído, los cambios pendientes son durables e idempotentes; no se publican aumentos
  hasta reconciliar.
- Divergencias o negativos bloquean selectivamente el SKU y abren incidente; no se sobreescribe
  automáticamente el modelo interno.
- No se presupone una reserva fija de canal ML. Mientras publicaciones independientes anuncien stock completo no se garantiza cero sobreventa; una sobreventa real bloquea ventas en ambos canales y abre incidente urgente.
- MercadoLibre Full, lotes, vencimientos, serialización, consignación, kits y órdenes de compra
  automáticas quedan fuera del primer programa.

## Retención y alertas

- En preparación, volver a la cola conserva el claim del operador. La tarjeta queda como `Continuar` y el reingreso usa `/tomar` de forma idempotente para renovar el claim; otro operador sigue bloqueado hasta liberación o vencimiento.
- Las etiquetas Web/Andreani se generan fuera del VPS: durante el embalaje el preparador escanea código interno y tracking, confirma la asociación y el sistema bloquea duplicados/conflictos. Despacho solo reconcilia el código interno al retirar; la notificación a Woo ocurre después de confirmar salida. MercadoLibre no carga tracking en este sistema.

- Movimientos y auditoría se conservan indefinidamente.
- Fotos operativas se conservan 180 días; reclamos, incidentes, garantías o auditorías activas suspenden la purga.
- Las alertas se muestran en App, panel y sonido, distinguen reconocimiento de resolución y
  pueden transferirse a otro usuario autorizado.
