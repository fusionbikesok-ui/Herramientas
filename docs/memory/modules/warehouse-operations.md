# Operaciones de depósito, preparación y stock

## Fuente canónica

La hoja de ruta vigente está en `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`.
Este módulo conserva decisiones aprobadas para entregas futuras y el estado actual explícito;
la historia de cambios pertenece a Git. Las reglas bajo “Modelo objetivo” todavía no están
implementadas como un único libro de stock.

## Preparación y despacho

- Los pedidos ingresan continuamente durante el día y se notifican al área de preparación.
- La jornada puede comenzar con picking consolidado; la prioridad es MercadoLibre y luego antigüedad.
- El operario encuentra unidades, las asigna al pedido, escanea, toma evidencia y aprueba la
  preparación antes del despacho.
- La evidencia incluye requisitos por ítem y fotos del paquete cuando corresponda. Un error de
  red conserva el borrador/previsualización y ofrece reintento idempotente.
- Objetivo E3: al aprobar evidencia, generar una única etiqueta interna 50×25 y enviarla a una
  computadora Windows del depósito con impresora USB y agente local.
- Objetivo E3: si la impresión falla, conservar la aprobación, dejar alerta persistente y permitir
  reimpresión manual autorizada sin repetir fotos.
- Objetivo E4: generar/reconciliar lotes de transporte después de que los paquetes aprobados estén listos.
- El horario de MercadoLibre es máximo de despacho; el horario interno es máximo de preparación.
- Cancelaciones o cambios que afectan un pedido preparado invalidan evidencia y etiquetas; una
  unidad reasignada a un ML urgente puede exigir rehacer la preparación web desplazada.
- Un faltante es incidente urgente y dispara búsqueda/conteo escalonado; no se oculta como pedido
  simplemente pendiente.

## Modelo físico y comercial: objetivo E8–E18

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
