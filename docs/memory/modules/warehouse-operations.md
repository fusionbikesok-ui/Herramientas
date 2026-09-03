# Operaciones de depósito, preparación y stock

## Fuente canónica

La hoja de ruta vigente está en `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`.
Este módulo conserva decisiones aprobadas para entregas futuras y el estado actual explícito;
la historia de cambios pertenece a Git. Las reglas bajo “Modelo objetivo” todavía no están
implementadas como un único libro de stock.

## Preparación y despacho

- Los pedidos ingresan continuamente durante el día y se notifican al área de preparación.
- La jornada comienza con una ola de todos los elegibles actuales; pedidos normales posteriores forman mini-olas y ML urgente se incorpora a la ola activa. La prioridad es MercadoLibre y luego límite/antigüedad.
- E1 separa estados de ola y pedido: la ola pasa por disponible, búsqueda, mesa y cierre; un pedido se vuelve individual al recibir la primera unidad escaneada en mesa.
- La búsqueda no escanea unidad por unidad. En picos, el responsable puede pedir ayuda por zona manual; el ayudante ve solo la zona/lista, entrega en mesa y queda identificado, pero no modifica cantidades ni estados.
- E1 usa tablero PC y celular web; una tablet futura será tablero compartido sin PII y la App iPhone futura tendrá el flujo completo de piso.
- La confirmación final escanea cada unidad en mesa, sugiere asignación prioritaria y exige confirmación del responsable. Faltantes bloquean solo el pedido afectado y se resuelven por supervisor, con resguardo físico.
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
- E1 tiene implementación local para apertura, olas, ML urgente incorporado con retorno, claims vigentes, estados búsqueda/mesa/cierre, zonas no verificadas, ayuda física consultable, asignación de mesa con cámara/fallback auditado, faltantes, necesidades SKU/cantidad y auditoría (`routes/jornada.js`, `lib/jornada.js`, `migrations/048_jornada_picking_operativo.sql`, `public/preparacion/index.html`). Continúa sin aceptación: la revisión dejó pendientes ayuda operativa completa, permisos finos, resolución comercial y replay idempotente integral; faltan demo aislada y jornada observada.
- La ayuda por zona solo incluye SKU con ubicación activa mapeada a esa zona; los SKU sin ubicación no se asignan artificialmente y quedan para la tarea de ubicar.
- Cancelaciones o cambios que afectan un pedido preparado invalidan evidencia y etiquetas; una
  unidad reasignada a un ML urgente puede exigir rehacer la preparación web desplazada.
- Un faltante es incidente urgente y dispara búsqueda/conteo escalonado; no se oculta como pedido
  simplemente pendiente.
- E1 documenta fallos operativos y técnicos relevantes, reintentos agrupados y correcciones inmutables con actor, hora, antes/después y motivo.

## Modelo físico y comercial: objetivo E8–E18

> Corrección de evidencia 2026-09-03: la suite vigente de jornada es **53/53**; cualquier conteo anterior en este módulo es histórico.

Gate técnico E1 2026-09-03: se corrigieron los cuatro P1 de replay/autorización/snapshot identificados por revisión independiente; la demo y la observación real siguen pendientes.

La suite E1 vigente queda en **54/54** tras cubrir pausa/reanudación persistentes.

La pausa de ola queda disponible mediante `/api/jornada/ola/:id/pausar` y `/api/jornada/ola/:id/reanudar`, con migración `migrations/058_jornada_pausa.sql`; requiere motivo, conserva el claim y registra auditoría.

Validación E1 del 2026-09-03: 48/48 pruebas de jornada y smoke autenticado responsive con axe sin violaciones. E1 continúa en desarrollo; no se publicó ni se observó una jornada real.

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

- E18 tiene integrado el núcleo durable y una segunda fase: `/api/stock-exceptions` y
  `lib/stockExceptions.js` persisten incidentes físicos, tareas, versiones, `operation_id` y
  auditoría append-only mediante `migrations/066_stock_exceptions.sql`; `migrations/067_stock_exception_returns.sql`
  agrega recepción idempotente de devoluciones, clasificación disponible/no disponible/condicionado
  y daño urgente con tarea de inspección. E18 sigue en desarrollo: sync de Woo, proveedor y descarte
  todavía no están implementados.

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

- Si Woo está caído, los cambios pendientes son durables e idempotentes; no se publican aumentos
  hasta reconciliar.
- Divergencias o negativos bloquean selectivamente el SKU y abren incidente; no se sobreescribe
  automáticamente el modelo interno.
- No se presupone una reserva fija de canal ML. Mientras publicaciones independientes anuncien stock completo no se garantiza cero sobreventa; una sobreventa real bloquea ventas en ambos canales y abre incidente urgente.
- MercadoLibre Full, lotes, vencimientos, serialización, consignación, kits y órdenes de compra
  automáticas quedan fuera del primer programa.

## Retención y alertas

- Movimientos y auditoría se conservan indefinidamente.
- Fotos operativas se conservan 180 días; reclamos, incidentes, garantías o auditorías activas suspenden la purga.
- Las alertas se muestran en App, panel y sonido, distinguen reconocimiento de resolución y
  pueden transferirse a otro usuario autorizado.
