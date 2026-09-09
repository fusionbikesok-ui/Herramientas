# Plan Maestro de FusionBikes: operación, VPS y App

**Estado:** especificación canónica vigente
**Versión documental:** 2026-09-08 / programa E0–E24 + programa urgente UM1
**Backend canónico:** `/opt/fusionbikes/herramientas`
**Rama productiva observada:** `conteo-confiable`
**Base verificada de esta reconstrucción:** `bc13898f9faeffcde00f49616ce6cb858eff03a3`
**App:** `fusionbikesok-ui/FusionBikes-App`, base aprobada `feature/stock-flow-ui`
**Zona operativa:** `America/Argentina/Buenos_Aires`

## 1. Propósito, alcance y reglas de lectura

Este documento reúne la especificación funcional acumulativa para Herramientas y App. No es un changelog ni prueba por sí mismo que exista una función. Recupera el contenido útil del plan histórico, incorpora las decisiones del descubrimiento operativo y separa con precisión presente, brecha y objetivo.

La copia literal de `ce5c3cb` está en `/opt/fusionbikes/herramientas/docs/superpowers/archive/plan-maestro-v2-ce5c3cb.md`. El registro de decisiones está en `/opt/fusionbikes/herramientas/docs/superpowers/decisions/plan-maestro-decisions.md`; progreso y evidencia viven en `/opt/fusionbikes/herramientas/docs/superpowers/deliveries/README.md` y fichas E0–E24/UM1.

### 1.1 Vocabulario de estado

- **Verificado actual:** observado en código, contrato, pruebas o infraestructura identificable en la base indicada.
- **Brecha:** comportamiento faltante, parcial o todavía no aceptado.
- **Modelo objetivo:** decisión funcional aprobada que una entrega debe implementar.
- **Histórico:** evidencia de una fecha; no instrucción vigente.
- **Candidato:** código o commit existente que aún debe revisar ancestry, diff y gates.
- **Aceptado:** entrega publicada, observada una jornada y firmada por el responsable operativo.

Una numeración antigua, un commit o una prueba focalizada no convierten una entrega en aceptada. Las fichas usan exclusivamente `planificada → desarrollo → candidata → publicada → observada → aceptada`.

### 1.2 Precedencia y continuidad

Ante contradicciones, el código y contrato ejecutable verifican el presente; este maestro fija el objetivo; decisiones explican por qué; fichas demuestran avance; memoria resume; Git preserva historia. La documentación local es fuente canónica. Un Codebase Memory MCP puede espejarla, nunca reemplazarla ni contener decisiones que no estén aquí.

Todo agente inicia leyendo `/opt/fusionbikes/herramientas/CLAUDE.md`, `/opt/fusionbikes/herramientas/docs/memory/INDEX.md`, `/opt/fusionbikes/herramientas/docs/memory/active.md`, módulos pertinentes, este maestro y la ficha de entrega. Termina dejando checkpoint reproducible, sin secretos ni PII.

## 2. Contexto operativo y jornada

### 2.1 Escala, canales y personas

- Volumen normal: 31–100 pedidos diarios, mayormente de una línea.
- Canales iniciales: MercadoLibre y Woo/web. Las ventas presenciales también se registran en Woo.
- Una persona normalmente busca, prepara, fotografía y aprueba. Otra realiza despacho físico.
- Roles base: Admin, supervisor, operario, despacho y ventas, más excepciones explícitas por usuario.
- Dispositivos personales y compartidos son válidos; los compartidos sincronizan y purgan caché sensible al cerrar.

### 2.2 Apertura, horarios y cierre

El primer operario ve un preflight automático y reintentable de ML/Woo, frescura de datos y pendientes, confirma los horarios importados y abre la jornada. La impresora figura como capacidad pendiente de E3 hasta que exista el agente Windows. Una falla bloquea solo las operaciones afectadas y explica la acción de recuperación. La web tiene máximo normal de preparación 15:00 con excepciones por calendario. ML Full queda fuera. El mismo transporte retira MercadoEnvíos, Andreani y Flex: ML/Andreani deben estar listos con 30 minutos de margen y Flex debe salir como máximo a las 17:00 para que el transporte regrese antes del cierre de las 19:00. MercadoEnvíos no tiene una hora fija: puede variar por paquete y se usa la hora máxima de entrega al centro de acopio.

Un diferido registra fecha, motivo, nota, origen de instrucción y auditoría. Supervisor o despacho cierra la jornada. Pendientes se arrastran con alerta; no se exige reconciliación física completa de staging al cierre.

## 3. Modelo de dominio y lenguaje común


| Tipo | Responsabilidad |
| --- | --- |
| `OperationalDay` | fecha local, horarios confirmados, salud, pendientes y cierre |
| `Preparation` | asignación de producto/pedido y estado de preparación |
| `Package` | contenido físico y ciclo evidencia→despacho |
| `PhotoEvidence` | archivo, requisito, perfil/versionado y procesamiento |
| `InternalLabelJob` | impresión 50×25 idempotente por paquete |
| `ShippingBatch` | miembros congelados y reconciliación de transporte |
| `DispatchConfirmation` | salida física y actualización comercial durable |
| `DispatchOrder` | pedido externo normalizado para historial y cruce operativo |
| `DispatchShipment` | envío, tracking, estado, devolución y eventos del canal |
| `DispatchCustomer` | cliente normalizado por canal para consulta histórica |
| `DispatchItem` | snapshot de líneas del pedido relacionado con el catálogo |
| `StockBalance` | proyección de cantidades por ubicación/condición |
| `StockMovement` | hecho inmutable que explica el balance |
| `WarehouseLocation` | depósito→zona→estante y sectores operativos |
| `StockCommitment` | reserva operativa derivada de Woo |
| `InventoryTask` | trabajo reclamable, versionado y sincronizable |
| `Receipt` | documento, líneas, entrada y putaway |
| `CountSession` | snapshot, captura ciega, riesgo y ajuste |
| `StockIncident` | faltante, divergencia, daño o sobreventa |
| `WarrantyCase` | caso, timeline, producto y resolución |
| `WorkshopJob` | equipo, servicio, repuestos, aprobación y entrega |
| `ShiftPlan` | horarios, áreas y reemplazos informativos |

### 3.1 Reglas técnicas transversales

- Un único servicio de negocio por proceso; web legacy y `/api/v1` no duplican reglas.
- Cada vertical reemplaza consumidor y endpoint juntos. App Store admite una ventana corta de compatibilidad y actualización obligatoria.
- Toda mutación reintentable usa clave idempotente; concurrencia usa `expected_version`.
- Envelope offline: `operation_id`, dispositivo, usuario, lease, versión base, hora real y payload. Respuesta: aceptado, repetición idempotente o conflicto explícito.
- Auditoría legacy se conserva y proyecta. Movimientos/auditoría tienen retención indefinida.
- La PC puede abrir la ficha completa, pero el tablero común y las notificaciones no muestran PII. El celular respeta permisos de evidencia e historial; las capturas de pantalla reciben advertencia y capacitación.

## 4. Preparación, picking y paquetes

### Propósito y resultado esperado

Convertir pedidos elegibles en paquetes correctos, identificables y listos para evidencia, sin ocultar pedidos entrantes ni perder trabajo confirmado.

### Actores, permisos y dispositivos

Operario de depósito prepara y puede aprobar; supervisor resuelve reaperturas y salidas parciales; Ventas mantiene instrucciones comerciales; despacho recibe paquetes aprobados. Web móvil es el dispositivo actual y la App iPhone será el principal dispositivo de piso.

### Disparadores y fuentes de datos

Todos los pedidos ML y Woo del último mes, cambios, cancelaciones, horarios de la jornada, compromisos Woo, ubicaciones activas y alertas de integración. La elegibilidad para envío se decide después en Gestión de pedidos; no durante la importación.

### Estado actual verificado

La preparación integrada posee cola continua priorizada, claims por preparación, escaneo unitario, requisitos de evidencia, fotos por ítem/paquete, auditoría y confirmación de despacho idempotente. Las olas de recolección no tuvieron adopción operativa y fueron retiradas del flujo vigente por decisión del 2026-09-08; sus registros históricos se conservan sin generar trabajo nuevo.

### Brecha existente

Falta validación operativa real de la checklist, tratamiento integrado de faltantes y recuperación explícita ante códigos desconocidos o cambios concurrentes. La reasignación automática de última unidad pertenece a E12.

### Separación de herramientas

**Gestión de pedidos** será la vista principal del Home para importar y administrar todos los pedidos de WooCommerce y MercadoLibre del último mes, incluyendo ventas físicas registradas en Woo. Permitirá consultar clientes, productos, estados, incidencias y fotos de preparación, además de marcar manualmente un pedido como “requiere envío”.

Su navegación se limitará a tres pills: **Requieren atención**, **Recuperar ventas** y **Todos los pedidos**, en ese orden. “Requieren atención” será la vista inicial; los cancelados permanecerán en “Todos” y aparecerán temporalmente en “Recuperar ventas”. Las etapas de preparación, despacho y agrupación pertenecen exclusivamente a Gestión de envíos.

“Requieren atención” mostrará todos los pedidos activos sin cierre confirmado, incluidos los confirmados sin problemas y los retiros en tienda pendientes de marcar como retirados. Un retiro solo deja esta vista cuando se registra como retirado/completado; los pedidos cancelados, carritos abandonados y pedidos ya cerrados se consultan en sus vistas correspondientes. Los contadores **En preparación** y **Despachos** serán vistas internas filtradas de esta misma pantalla, conservando lista, buscador y vista rápida; no redirigirán automáticamente a Gestión de envíos.

En Recuperar ventas, la oportunidad estará vigente hasta el cierre del día hábil siguiente a la cancelación o abandono. La interfaz distinguirá expresamente **cierre hoy** de **cierre mañana** según la fecha del pedido/abandono y el calendario de la tienda. Los intentos se consolidarán por cliente mediante identificador, email o teléfono: varios fallidos se muestran como una sola oportunidad. Si el cliente concreta un pedido exitoso, la oportunidad y sus intentos fallidos dejan de mostrarse en Recuperar ventas, aunque permanecen en el historial. Los únicos canales de contacto serán WhatsApp y Email, cada uno con su botón. Otro botón permitirá marcar el contacto como realizado. Se registrará el estado nunca contactado/contactado, usuario, fecha, hora y canal; seleccionar un canal por sí solo registra el intento, no confirma el contacto.

WhatsApp solo validará y copiará el teléfono argentino sin `+54`; no enviará automáticamente. Email mostrará un recuadro copiable con destinatario, asunto y cuerpo personalizado con el carrito, preguntando si hubo problemas o arrepentimiento. Se comenzará con plantillas rotativas revisables; Gemini podrá evaluarse después como generador opcional, nunca como envío automático.

El buscador global de esta pantalla buscará por número de pedido, identificadores externos Woo/MercadoLibre, cliente, email, teléfono, SKU, **EAN** y nombre de producto. Mostrará el motivo de coincidencia y no cambiará de pill automáticamente; para un resultado fuera de la vista actual permitirá abrirlo desde **Todos los pedidos**.

La primera acción masiva de la lista será **Enviar a preparación**. El botón de asignación queda fuera por ahora. La confirmación validará la elegibilidad de los pedidos seleccionados, creará un lote de preparación y mostrará cualquier pedido excluido antes de confirmar.

La vista rápida lateral será una ficha completa de consulta con datos del pedido, cliente, entrega o retiro, estados, pago, importe, productos y cantidades, notas, tracking, fotos de preparación y timeline resumido. Tendrá pocas acciones seguras y un acceso claro a la pantalla específica. La pantalla específica del pedido concentrará las modificaciones y acciones operativas autorizadas, evitando que la vista rápida se convierta en un segundo formulario incompleto.

El listado vivirá en `/gestion-pedidos/` y cada pedido tendrá una URL persistente `/gestion-pedidos/pedidos/{id}`. Abrir el detalle completo conservará navegación, recarga, permisos y auditoría del pedido.

Los cambios de productos deberán conciliar reservas y stock sin doble descuento: retirar una línea libera la reserva, reemplazarla libera el producto original y descuenta el nuevo, y un faltante físico confirmado genera un ajuste negativo auditado. En el detalle, los productos se mostrarán con imágenes grandes, además de SKU, EAN, cantidad y precio.

El botón genérico “Editar pedido” se reemplaza por **Editar datos** —cliente y entrega juntos— y **Añadir productos**. Esta última acción abrirá una ventana de búsqueda por nombre, SKU o EAN con fotos grandes, miniaturas, stock, precio y cantidad, para agregar productos con confirmación de impacto.

Cada línea existente tendrá un botón **Remover** y el buscador solo ofrecerá **Agregar producto**. Un reemplazo se modelará explícitamente como remover el producto anterior y agregar el nuevo, con revisión de cantidades, total y stock antes de guardar.

**Gestión de envíos** conserva la herramienta actual y ejecuta únicamente el trabajo logístico: productos a buscar, pedidos a preparar, listos para despachar, grupos de despacho y confirmación de salida. Ambas herramientas comparten el modelo relacional de pedidos, clientes, productos, items, preparaciones, paquetes, envíos y eventos.

La importación no implica despacho. Solo entran a la cola de envíos los pedidos que Woo coloque en “listo para enviar Andreani” o los que un usuario autorizado derive manualmente desde Gestión de pedidos. Una venta física o un pedido que no requiere envío permanece visible en Gestión de pedidos, pero no aparece como tarea logística.

### Flujo normal paso a paso

1. Consolidar todos los pedidos pendientes en una lista de recolección por producto, con imagen, SKU, cantidad total y cantidad de pedidos que lo requieren.
2. Buscar físicamente esas cantidades. La lista se recalcula con la cola continua; un pedido nuevo aparece en la próxima actualización sin esperar apertura, ola o corte.
3. Abrir un pedido priorizado y adquirir su claim técnico para evitar edición simultánea.
4. Mostrar una checklist con producto, SKU, cantidad esperada, cantidad escaneada y estado.
5. Escanear cada unidad. Un código válido incrementa solo su línea; un excedente, código ajeno o desconocido no modifica cantidades y muestra recuperación explícita.
6. Una confirmación sin código requiere motivo y queda auditada. Un faltante bloquea solo el pedido afectado y crea incidencia.
7. Cuando todas las líneas estén verificadas, completar evidencia por ítem/paquete, dividir paquetes si corresponde y aprobar. La preparación aprobada pasa al sector listo para despacho.
8. La navegación móvil se organiza en cuatro espacios: Productos a buscar, Pedidos a preparar, Listos para despachar y Despachos. Historial y configuración quedan secundarios.

### Estados y transiciones

Preparación: pendiente → en preparación → productos verificados → evidencia completa → completada → lista para despacho. Puede derivar a pendiente de depósito, bloqueada por incidencia o cerrada sin evidencia mediante flujos auditados. El claim vence y libera el pedido según el contrato técnico vigente. Un retenido permanece visible con motivo pero no puede prepararse.

### Excepciones, concurrencia e idempotencia

Doble escaneo técnico no duplica una mutación; cada escaneo aceptado confirma una sola unidad dentro del pedido abierto. Toda mutación reintentable usa idempotencia. El claim identifica al responsable de la preparación. Cambios externos bloquean el pedido afectado. Un faltante se clasifica, escala al supervisor y deja los productos separados en resguardo. Sustituciones transitorias requieren constancia de cliente, motivo y reflejo comercial; ML bloquea si no puede actualizarse.

### Comportamiento online y offline

La web actual requiere conexión para mutaciones de E1, pero conserva borrador y fotos mientras la página siga abierta. Recarga o sesión vencida devuelve a la misma tarea. PC y celular sincronizan el mismo estado. La App futura permite el flujo completo y captura provisional offline; aprobación final, sustituciones y reasignaciones esperan servidor. Un lease vencido impide acciones nuevas.

### UX web, App y vista rápida

PC y celular inician con la lista consolidada de recolección y la cola priorizada debajo. Cada producto muestra imagen o un fallback explícito, SKU y cantidad total. Al abrir un pedido, la checklist mantiene foco de escaneo, muestra progreso por línea y total, y da feedback visual, sonoro y háptico. Los límites tienen hora, tiempo restante y severidad. Búsqueda incluye pedido, SKU, nombre y tracking; historial filtra por estado, fecha e incidencias.

### Auditoría y retención

Guardar actor, dispositivo, operación, pedido, producto, cantidad, origen/destino, versión esperada, fecha real y fecha del servidor. Registrar fallos operativos y técnicos relevantes, reintentos agrupados, antes/después y motivo. No borrar eventos: una corrección enlaza un nuevo evento. Movimientos y auditoría indefinidos; fotos 180 días según E2; borradores locales se purgan después de sincronizar.

### Métricas y objetivos

Tiempo activo por preparación, unidades verificadas, confirmaciones manuales, códigos rechazados, faltantes, reaperturas y pedidos tardíos. Primer mes crea línea base; no se publican rankings personales.

### Escenarios de aceptación

Consolidación del mismo SKU entre pedidos y canales; imagen disponible o ausente; pedido nuevo que actualiza cantidades; prioridad ML; escaneo unitario; múltiples unidades; excedente; código ajeno o desconocido; confirmación manual auditada; faltante; cambio/cancelación concurrente; sustitución; diferimiento; recarga; claim vencido; sesión vencida; evidencia incompleta e histórico sin evidencia.

### Entregas que lo implementan

E1 define cola continua, checklist y escaneo; E2 evidencia/paquetes; E12 integra compromisos, faltantes y reasignación; E13 incorpora captura móvil/offline.

### Decisiones pendientes, responsable e impacto

Definir si la ubicación sugerida se muestra desde el catálogo actual o espera al modelo de ubicaciones de E9. Responsable: depósito. Afecta la guía de búsqueda, no bloquea la checklist.

## 5. Evidencia fotográfica y aprobación

### Propósito y resultado esperado

Probar que producto, cantidad, condición y paquete fueron preparados correctamente, con una experiencia recuperable ante redes lentas.

### Actores, permisos y dispositivos

Operario captura, sustituye y aprueba; supervisor reabre; posventa/auditoría puede aplicar hold. Web móvil es actual; iPhone será futuro.

### Disparadores y fuentes de datos

Contenido de paquete confirmado, perfil versionado por SKU/categoría/paquete, incidentes y reaperturas.

### Estado actual verificado

Hay captura web, requisitos de evidencia, fotos por ítem y paquete y procesamiento de servidor. Se integraron correcciones idempotentes parciales, pero no existe evidencia de una jornada aceptada contra todos los escenarios ni perfiles completos versionados por catálogo.

### Brecha existente

Faltan catálogo de perfiles seguro, congelamiento de versión, recuperación explícita, retención automatizada con holds y flujo móvil offline.

### Flujo normal paso a paso

1. Al iniciar preparación se fija la versión del perfil aplicable. Si falta, se usa perfil seguro y se crea tarea de clasificación.
2. La cámara muestra preview inmediata; comprime sin impedir inspección y conserva original local hasta confirmación.
3. Cliente sube con operation_id. Servidor guarda, valida tipo/tamaño, procesa y responde identidad/estado.
4. Solo una respuesta confirmada cuenta para completar el requisito. La UI distingue subiendo, procesando, confirmado y error recuperable.
5. El operario puede sustituir antes de aprobar. Aprobar preparación valida contenido y requisitos en servidor.
6. Después de aprobar, cualquier cambio exige reapertura auditada y vuelve a evaluar evidencia/etiquetas.

### Estados y transiciones

local → subiendo → recibido → procesando → válido|rechazado. Preparación: evidencia pendiente → lista para aprobar → aprobada → reabierta. Una respuesta tardía se reconcilia por operation_id.

### Excepciones, concurrencia e idempotencia

Timeout consulta estado antes de repetir; doble toque produce una sola evidencia lógica; pérdida de respuesta no duplica; recarga avisa si hay archivo solo local; fallo parcial preserva previews. Archivo corrupto, tipo inválido o procesamiento fallido ofrecen acción concreta y código de incidente.

### Comportamiento online y offline

Web conserva archivos/previews solo mientras la página siga abierta y debe advertir antes de recargar. App guarda cifrado hasta siete días para tarea válida y sincroniza ordenadamente. La aprobación final requiere aceptación del servidor.

### UX web, App y vista rápida

Progreso inmediato, objetivo de confirmación menor a 10 segundos, miniaturas con requisito asociado, recaptura clara, resumen previo a “Aprobar preparación” y estado persistente. Controles de una mano y mínimo 44 px.

### Auditoría y retención

Retención normal 180 días desde cierre. Reclamo, incidente, garantía o auditoría activa suspende purga. Registrar hash, perfil/version, requisito, actor, paquete y sustituciones; limitar PII.

### Métricas y objetivos

Tiempo preview→confirmación, reintentos, rechazos, fotos sustituidas, preparaciones reabiertas y purgas retenidas.

### Escenarios de aceptación

Foto lenta, timeout, respuesta tardía, doble toque, red caída, recarga, archivo inválido, una de varias fotos fallida, perfil ausente, reapertura y hold.

### Entregas que lo implementan

E2 web/servidor; E13 infraestructura offline; E15/E17/E21 reutilizan el patrón móvil.

### Decisiones pendientes, responsable e impacto

Definir perfiles iniciales por categorías reales y calidad mínima sin elevar tiempos innecesarios. Responsable: depósito/Administración.

## 6. Impresión interna, transporte y despacho

### Propósito y resultado esperado

Identificar cada paquete, generar lotes de transporte reconciliables y confirmar salida física sin confundir aprobación con despacho.

### Actores, permisos y dispositivos

Operario aprueba/reimprime con motivo; agente Windows imprime; despacho crea y reconcilia lotes; supervisor autoriza excepciones. ML y Andreani generan etiquetas externas.

### Disparadores y fuentes de datos

Aprobación atómica de paquete, inicio de lote, tracking escaneado, retiro físico y errores de impresora/integración.

### Estado actual verificado

Existe `etiquetas_cola`, encolado interno y endpoints de claim/lease/resultado/reintento; hay un agente configurable en `tools/windows-label-agent/`. Su hardware real no fue relevado ni aceptado. Control de despacho y tabla Andreani existen, pero no conforman aún el lote congelado objetivo.

### Brecha existente

Faltan validación física del agente, semántica completa de paquete, lotes congelados, reconciliación de tracking/salida y contingencia offline autorizada.

### Flujo normal paso a paso

1. Al aprobar evidencia, una transacción registra aprobación/auditoría y crea exactamente un InternalLabelJob por paquete.
2. Agente autenticado reclama atómicamente, imprime 50×25 sin diálogo y confirma éxito/fallo. El paquete sigue aprobado aunque falle.
3. Paquetes aprobados se acumulan. Despacho inicia lote y congela miembros.
4. ML se etiqueta en MercadoLibre. Andreani recibe tabla/TSV actual; operador confirma por lote que allí se generaron etiquetas.
5. En Web/Andreani, al embalar, el preparador escanea código interno y tracking de la etiqueta externa. Como las etiquetas se generan fuera del VPS, el sistema valida formato, duplicado y conflicto, y registra la asociación con confirmación del operador; no afirma una pertenencia que no puede conocer automáticamente. Despacho solo reconcilia el código interno al retirar. MercadoLibre no carga tracking en este sistema.
6. En retiro, despacho escanea internos y compara esperados, escaneados, faltantes, duplicados y ajenos.
7. Confirmación física cambia Woo a enviado mediante operación durable/idempotente y guarda actor, hora, lote y adjunto opcional.

### Estados y transiciones

label queued → claimed → printed|failed → retry. Package approved → batched → carrier-labelled → reconciled → dispatched. Batch draft → frozen → reconciled → closed|exception.

### Excepciones, concurrencia e idempotencia

PC apagada, Windows reiniciado, impresora sin papel, USB/red caídos, confirmación perdida y reimpresión. Elemento erróneo se anula con motivo y pasa a nuevo lote. Tracking incorrecto o paquete ajeno bloquean. Woo caído conserva evento y reintenta. Envío sin tracking exige permiso, motivo y tarea urgente.

### Comportamiento online y offline

Agente recupera cola al volver. Despacho offline solo con permiso específico y lote previamente descargado; guarda escaneos cifrados y salida queda provisional hasta servidor.

### UX web, App y vista rápida

Panel separa etiqueta interna, transporte y salida; muestra cola, último error y acción autorizada. Conciliación presenta esperados/escaneados/faltantes/duplicados/ajenos en una sola vista rápida.

### Auditoría y retención

Jobs, intentos, reimpresiones, lotes, anulaciones, tracking y salidas se conservan indefinidamente. QR interno usa identificador opaco sin PII; código corto permite entrada manual con motivo.

### Métricas y objetivos

Tiempo aprobación→impresión, fallas/reimpresiones, lotes con diferencia, tracking incorrecto, tiempo de cierre y actualizaciones Woo demoradas.

### Escenarios de aceptación

Impresora apagada/sin papel; USB, Windows o red caídos; respuesta perdida; reimpresión; lote congelado; paquete tardío; anulación; tracking incorrecto; duplicado/ajeno; Woo caído; contingencia offline.

### Entregas que lo implementan

E3 impresión; E4 lotes/tracking/despacho; E23 robustez y recuperación.

### Decisiones pendientes, responsable e impacto

Modelo, driver, lenguaje y puerto físicos bloquean publicación E3. SLA/modalidad ML bloquea aceptación E4.

### Historial relacional de despachos

El historial de despachos es independiente de la cola operativa. Se modela con pedidos, clientes, items, shipments, eventos, grupos y cruces con preparaciones; no se usa `pedidos_cache` como fuente histórica. La importación cubre todos los pedidos de WooCommerce y MercadoLibre del último mes. Un despacho sin preparación local se muestra como “despachado sin registro local”, nunca como verificado. Desde Gestión de pedidos se pueden consultar las fotos de preparación en modo lectura. Las buenas prácticas de diseño y flujo están consolidadas en `docs/superpowers/research/2026-09-08-buenas-practicas-gestion-pedidos-envios.md`; la migración y sus criterios de aceptación están en `docs/superpowers/plans/2026-09-08-historial-despachos-relacional.md`.

## 7. Stock, identidad, familias, ubicaciones y movimientos

### Propósito y resultado esperado

Explicar y controlar stock físico y comercial sin inventar líneas base ni producir doble descuento.

### Actores, permisos y dispositivos

Operario consulta/mueve; supervisor ajusta y activa rollout; Administración versiona familias/tolerancias; Ventas gestiona disponibilidad; integraciones reflejan Woo/ML.

### Disparadores y fuentes de datos

Venta/reserva Woo, recepción ubicada, picking, despacho, transferencia, daño, devolución, conteo, ajuste y sincronización.

### Estado actual verificado

Existe consulta rápida de solo lectura, ubicaciones heredadas, inventario/conteos y un libro/transferencias inicial en commits locales. No se considera aceptado ni desplegado bajo E8–E12; campos físicos pueden estar sin línea base.

### Brecha existente

Faltan identidad rígida, familias, activación por SKU, saldos derivados completos, compatibilidad con todos los consumidores y política operativa ML.

### Flujo normal paso a paso

1. Buscar SKU/EAN/nombre y mostrar físico, disponible comercial, comprometido, no disponible, condicionado, entrante, Woo, ML, frescura e incidentes.
2. Clasificar SKU en una familia principal Fusion; confirmar ubicación base y overflow.
3. Ejecutar conteo base aprobado y reconciliar Woo. Activar SKU por flag; desde entonces todas sus mutaciones pasan por movimientos.
4. Registrar movimientos inmutables por evento. Derivar balances por SKU/ubicación/condición.
5. Picking mueve a preparación por pedido; aprobación a listo para despacho; salida física reduce físico.
6. Transferencia cercana registra salida/entrada inmediata y versión esperada. Reposición interna se sugiere por umbral.
7. Ajuste por saldo final calcula delta; si supera tolerancia bloquea y abre conteo.

### Estados y transiciones

SKU legacy → preparado para rollout → activo → archivado. Identidad provisional → revisada → fusionada/archivada. Balance separado por ubicación y condición; nunca negativo.

### Excepciones, concurrencia e idempotencia

EAN asociado a varios SKU bloquea. SKU inexistente en Woo puede recibirse provisional no vendible. SKU eliminado con saldo se archiva y conserva historia. “Solo local” permanece. Divergencia ordinaria alerta/reconcilia, no publica cero. Sobreventa confirmada bloquea ventas en ambos canales. Condicionado puede vender Woo/web/local pero se excluye ML con autorización y fotos.

### Comportamiento online y offline

Consulta puede usar snapshot con frescura visible. Movimientos offline son provisionales, solo para tareas descargadas y sin permitir confirmar saldo negativo. Conflicto detiene replay y exige verificación.

### UX web, App y vista rápida

Vista rápida global sin entrar a recepción/inventario/sync. “Sin línea base” es distinto de cero. Escaneo duplicado de identidad bloquea con opciones seguras. Historial explica por qué cambió cada saldo.

### Auditoría y retención

Movimientos, identidades, activaciones y ajustes indefinidos. Todo cambio registra motivo, referencia, idempotencia, expected_version y actor/dispositivo.

### Métricas y objetivos

Exactitud, divergencia Woo/Fusion/ML, stock sin ubicación/familia, negativos bloqueados, ajustes, faltantes y frescura.

### Escenarios de aceptación

Múltiples ubicaciones; último artículo; EAN duplicado; provisional; SKU eliminado; solo local; condicionado; Woo caído; transferencia concurrente; ajuste alto; no ubicación; activación/rollback por flag.

### Entregas que lo implementan

E8 consulta; E9 identidad/familias/ubicaciones/línea base; E10 libro/transferencias/ajustes; E11 compromisos/sync; E12 picking/faltantes.

### Decisiones pendientes, responsable e impacto

Relevar familias y ubicaciones físicas, tolerancias iniciales y política exacta de publicación ML. Responsables: depósito, Administración e integración.

## 8. Recepción y putaway

### Propósito y resultado esperado

Registrar mercadería parcial y ubicarla con condición conocida antes de aumentar disponibilidad comercial.

### Actores, permisos y dispositivos

Hasta dos operarios reciben; supervisor resuelve conflictos/diferencias; Catálogo revisa provisionales; Administración conserva documentos.

### Disparadores y fuentes de datos

Aviso manual de entrante, documento de proveedor antes/durante/después, llegada física, línea esperada o SKU desconocido.

### Estado actual verificado

Existe una herramienta de recepción separada, pero no está verificada contra el libro objetivo, dos pasos, documentos múltiples, concurrencia ni offline.

### Brecha existente

Falta modelo Receipt/line versions, OCR asistido, entrada→putaway, movimientos/condiciones, documentos y clientes web/iPhone.

### Flujo normal paso a paso

1. Crear recepción desde aviso o llegada, adjuntar imagen/PDF/CSV/XLSX/XML cuando esté disponible.
2. OCR/IA propone cabecera y líneas con confianza; ninguna sugerencia impacta stock sin confirmación.
3. Operario elige cantidad directa, escaneo acumulado o unitario y confirma identidad, cantidad y condición por línea.
4. Daño, diferencia o identidad dudosa exige foto. Documento original no se reescribe.
5. Entrada confirmada queda en zona de recepción como disponible/no disponible/pendiente, todavía sin aumentar Woo.
6. Sistema sugiere base/overflow; operario confirma o cambia y ejecuta putaway.
7. Solo putaway disponible aumenta Woo. En cierre parcial se decide si remanente sigue esperado, cancelado o en disputa.

### Estados y transiciones

draft → receiving → partially received → awaiting putaway → put away → closed|disputed. Línea usa expected_version y condición available|unavailable|pending.

### Excepciones, concurrencia e idempotencia

Documento tardío, baja confianza, línea cambiada por segundo operador, SKU provisional, exceso/faltante, unidad dañada, carga de foto fallida y corrección posterior inversa.

### Comportamiento online y offline

iPhone guarda tarea reclamada, líneas, escaneos, notas y fotos cifrados; toda confirmación es provisional. Conflicto de versión detiene la línea y no confirma silenciosamente.

### UX web, App y vista rápida

Web controla documentos/resumen; iPhone trabaja en descarga con pasos claros. Mostrar recibido, ubicado, remanente y conflicto por línea. Claim avisa a 20 minutos y libera a 30 online.

### Auditoría y retención

Documentos de proveedor indefinidos. Fotos 180 días salvo hold. Guardar sugerencia original, decisión humana, versiones, condición, movimiento y correcciones.

### Métricas y objetivos

Tiempo llegada→entrada→ubicación, líneas por hora, diferencias, provisionales, conflictos y recepción parcial.

### Escenarios de aceptación

20–100 líneas; documento antes/después; parcial; dos operadores; baja confianza; provisional; foto fallida; remanente esperado/cancelado/disputa; corrección.

### Entregas que lo implementan

E14 VPS; E15 iPhone/offline; E9–E11 proveen identidad, ubicación y movimientos.

### Decisiones pendientes, responsable e impacto

Definir documentos reales por proveedor, zona física de entrada y reglas iniciales de sugerencia. Responsable: depósito/Administración.

## 9. Conteos y ajustes

### Propósito y resultado esperado

Medir stock ciegamente, reconciliar movimientos concurrentes y ajustar con control proporcional al riesgo.

### Actores, permisos y dispositivos

Operario cuenta; segundo operario preferido reconfirma; supervisor autoriza alto riesgo; Administración versiona tolerancias.

### Disparadores y fuentes de datos

Ciclo diario por riesgo/incidente, conteo general mensual, faltante, ajuste alto, divergencia o activación de SKU.

### Estado actual verificado

Inventario posee sesiones, alcance y cierre seguro. No está probado como snapshot + ledger, riesgo compuesto, autoajuste versionado ni offline ordenado.

### Brecha existente

Falta separar asignación/captura/revisión, reconciliar posteriores al snapshot y migrar ajustes a movimientos idempotentes.

### Flujo normal paso a paso

1. Crear sesión con alcance y snapshot lógico del ledger.
2. Asignar tarea ciega sin cantidad esperada; claim avisa a 20 y libera a 30.
3. Capturar cantidades enteras por ubicación/SKU, notas y evidencia cuando corresponda.
4. Reconciliar movimientos ocurridos después del snapshot antes de calcular diferencia.
5. Calcular riesgo por unidades, porcentaje, precio de venta, historial y criticidad de familia.
6. Autoajustar bajo riesgo dentro de tolerancia versionada. Alto riesgo exige reconteo, motivo y confirmación reforzada.
7. Antes de llevar un esperado no contado a cero, pedir confirmación explícita. Aplicar deltas idempotentes.

### Estados y transiciones

planned → claimed → counting → submitted → reconciling → review|required recount → adjusted → closed. Mismo operario reconfirma solo si no hay otro y queda marcado.

### Excepciones, concurrencia e idempotencia

Movimiento posterior, escaneo repetido, ubicación omitida, dispositivo perdido, offline prolongado, tolerancia cambiada, producto no encontrado y conflicto de replay.

### Comportamiento online y offline

Cola cifrada siete días, ordenada por operation_id. Lease máximo 12 horas; vencido bloquea nuevas capturas. Dispositivo revocado invalida pendientes y crea tarea física.

### UX web, App y vista rápida

Conteo verdaderamente ciego; feedback de escaneo menor a 500 ms; diferencia aparece recién en revisión. Vista de alto riesgo explica factores y autoridad necesaria.

### Auditoría y retención

Sesiones, snapshots, capturas, reconciliación, aprobaciones y movimientos indefinidos; fotos 180 días salvo hold.

### Métricas y objetivos

Exactitud, diferencia valorizada a precio venta, reconteos, autoajustes, tiempo activo/bloqueado y diferencias repetidas.

### Escenarios de aceptación

Movimiento posterior; bajo/alto riesgo; cero explícito; mismo/otro operador; offline siete días; lease vencido; dispositivo perdido; doble aprobación.

### Entregas que lo implementan

E16 VPS; E17 iPhone/offline; E23 recuperación.

### Decisiones pendientes, responsable e impacto

Tolerancias por familia se fijan tras línea base y deben tener dueño/versión. Responsable: Administración.

## 10. Cancelaciones, devoluciones, daños y proveedor

### Propósito y resultado esperado

Resolver excepciones físicas y comerciales sin ediciones manuales opacas ni reposición prematura.

### Actores, permisos y dispositivos

Ventas/posventa inicia; depósito ejecuta; supervisor aprueba excepciones; despacho informa salida; Administración autoriza descarte.

### Disparadores y fuentes de datos

Cambio/cancelación, devolución recibida, daño interno, rechazo proveedor, descarte y estado de transporte.

### Estado actual verificado

Hay auditoría y herramientas separadas, pero no un flujo unificado con tareas, condiciones, movimientos y retención objetivo.

### Brecha existente

Faltan estados, permisos, inspección, retorno a ubicación, outbound proveedor y baja irreversible.

### Flujo normal paso a paso

1. Antes de despacho, cancelación libera disponibilidad según Woo y crea tarea física para desempaquetar/devolver.
2. Después de despacho no repone: crea retorno esperado. Al recibir se identifica pedido/producto por escaneo y queda no disponible.
3. Inspección decide disponible, condicionado, reparación, proveedor o descarte y genera movimiento.
4. Daño interno mueve inmediatamente a no disponible, reduce Woo, exige motivo/foto y abre revisión.
5. Devolución a proveedor registra documento, preparación, salida, tracking, espera y resolución.
6. Descarte requiere permiso elevado, motivo/evidencia y movimiento irreversible de baja.

### Estados y transiciones

case open → awaiting item|physical task → received/unavailable → inspecting → disposition → resolved. Proveedor: prepared → shipped → awaiting supplier → returned|credited|closed.

### Excepciones, concurrencia e idempotencia

Cambio de una línea invalida solo paquete afectado; devolución sin pedido; cantidad diferente; tracking perdido; artículo condicionado; proveedor rechaza; descarte equivocado no se borra y requiere movimiento compensatorio autorizado.

### Comportamiento online y offline

Captura física puede ser provisional en tarea descargada; liberación comercial, disposición final y descarte esperan servidor.

### UX web, App y vista rápida

Timeline único vincula pedido, paquete, producto, fotos, tareas y movimientos. Acciones peligrosas muestran efecto comercial/físico antes de confirmar.

### Auditoría y retención

Movimientos y decisiones indefinidos; fotos 180 días salvo hold; documentos proveedor indefinidos.

### Métricas y objetivos

Tiempo cancelación→reposición física, retornos sin inspeccionar, daños, recuperación proveedor y descartes valorizados.

### Escenarios de aceptación

Cancelación antes/después; cambio parcial; devolución dañada; sin pedido; proveedor; condicionado; descarte; Woo caído.

### Entregas que lo implementan

E18, apoyada en E10–E13.

### Decisiones pendientes, responsable e impacto

Definir motivos normalizados y quién puede autorizar saldo condicionado/descarte. Responsable: Administración/operación.

## 11. Garantías y posventa

### Propósito y resultado esperado

Dar seguimiento completo al reclamo desde apertura hasta resolución, incluso antes de recibir el producto.

### Actores, permisos y dispositivos

Posventa/Ventas es dueño; depósito inspecciona; taller repara; supervisor aprueba reemplazo; proveedor puede ser contraparte.

### Disparadores y fuentes de datos

Pedido/producto/evidencia, comunicación del cliente, recepción, dictamen, reemplazo, reembolso o proveedor.

### Estado actual verificado

No existe un módulo integral verificado. Hay datos de pedidos y herramientas de comunicación que deben integrarse sin duplicar reglas.

### Brecha existente

Falta WarrantyCase, timeline, tareas físicas/comerciales, relación con taller/proveedor y política de retención.

### Flujo normal paso a paso

1. Abrir por pedido y producto con evidencia; permitir estado esperando producto.
2. Registrar comunicaciones con canal, fecha, actor y próxima acción manual.
3. Al recibir, mover a no disponible e inspeccionar.
4. Resolver como reparar, reemplazar, reembolso o rechazar. Reemplazo compromete stock al aprobarse.
5. Si va a proveedor, registrar salida/tracking/espera/retorno. Reparado vuelve a inspección.
6. Reembolso se registra y deriva a Woo/proceso humano; Fusion no mueve dinero.

### Estados y transiciones

open → waiting product → received → diagnosing → waiting customer|supplier → approved repair|replacement|refund|rejected → resolved.

### Excepciones, concurrencia e idempotencia

Caso sin recepción, evidencia incompleta, reemplazo sin stock, producto no coincide, proveedor demora, reapertura y comunicaciones concurrentes.

### Comportamiento online y offline

Notas, fotos y eventos de tarea descargada pueden capturarse provisionalmente; decisión final, compromiso y cierre requieren servidor.

### UX web, App y vista rápida

Orden por antigüedad y próxima acción, no SLA inventado. Timeline muestra cliente, movimiento físico y decisiones sin exponer PII innecesaria.

### Auditoría y retención

Ficha/timeline indefinidos; fotos 180 días desde cierre con hold. Guardar versión de decisión y autoridad.

### Métricas y objetivos

Antigüedad, espera por producto/cliente/proveedor, resultado y reaperturas; sin SLA automático hasta decisión futura.

### Escenarios de aceptación

Apertura previa a recepción; reparar; reemplazar sin stock; reembolso; rechazo; proveedor; retorno reparado; hold.

### Entregas que lo implementan

E19; integra E18 y E20.

### Decisiones pendientes, responsable e impacto

Motivos de rechazo, plantillas de comunicación y autoridades por resultado. Responsable: Posventa/Administración.

## 12. Taller

### Propósito y resultado esperado

Gestionar trabajos de cliente, armado interno y garantías con trazabilidad de equipo, mano de obra, repuestos, aprobación y entrega.

### Actores, permisos y dispositivos

Ventas registra; técnico diagnostica/ejecuta; cliente aprueba por canal registrado; supervisor autoriza saldo; depósito mueve repuestos.

### Disparadores y fuentes de datos

Turno o ingreso espontáneo, armado interno, garantía, diagnóstico, presupuesto, repuesto, finalización y entrega.

### Estado actual verificado

No existe flujo integral verificado bajo este plan. Woo ya es el sistema de venta/pago que deberá recibir cada service.

### Brecha existente

Faltan WorkshopJob, ficha/timeline, integración Woo de mano de obra/repuestos, checklist, App y offline.

### Flujo normal paso a paso

1. Registrar bicicleta/equipo, estado, fotos y código de trabajo; no inventariar accesorios entregados.
2. Crear/aceptar venta Woo con mano de obra estándar o diagnóstico/presupuesto complejo.
3. Registrar aprobación del cliente con canal, fecha y versión. Técnico puede agregar trabajo por criterio, documentándolo.
4. Repuesto Woo se compromete, picking lo mueve a mesa/orden y la instalación consume físico.
5. Repuesto no usado se quita de Woo y retorna mediante inverso. Repuesto del cliente queda fuera de inventario.
6. Completar checklist según servicio, avisar al cliente y registrar resultado del aviso.
7. Entregar con código, estado Woo, entregador/receptor; saldo pendiente exige autorización.

### Estados y transiciones

pendiente → en trabajo → listo → entregado/cerrado. Bloqueos secundarios: diagnóstico, aprobación, repuesto, proveedor. No hay límite automático de capacidad; técnico elige siguiente.

### Excepciones, concurrencia e idempotencia

Sin turno, presupuesto rechazado/cambiado, repuesto no usado, repuesto cliente, garantía, offline, saldo pendiente, trabajo adicional y reapertura.

### Comportamiento online y offline

App permite tarea descargada, notas, fotos y eventos provisionales. Venta Woo, compromisos, cambios comerciales y entrega final esperan servidor.

### UX web, App y vista rápida

Web para control/configuración; iPhone para piso. Código de trabajo visible, timeline, bloqueos y próxima acción. Sin portal de cliente inicial.

### Auditoría y retención

Ficha y timeline indefinidos; fotos 180 días desde cierre salvo hold. Woo conserva pago; señas son nota, Fusion no procesa dinero.

### Métricas y objetivos

Tiempo activo, espera por aprobación/repuesto/proveedor, trabajos reabiertos, repuestos usados/no usados y tiempo listo→entrega.

### Escenarios de aceptación

Servicio estándar; diagnóstico/presupuesto; aprobación por canal; repuesto usado/no usado; garantía; offline; saldo; checklist fallido.

### Entregas que lo implementan

E20 web/Woo; E21 iPhone/offline.

### Decisiones pendientes, responsable e impacto

Catálogo inicial de servicios/tarifas, checklists y permisos de saldo. Responsable: Taller/Ventas/Administración.

## 13. App iPhone, dispositivos y offline

### Propósito y resultado esperado

Dar una herramienta de piso rápida, segura y recuperable, manteniendo web para control y contingencia.

### Actores, permisos y dispositivos

Operarios con dispositivos personales/compartidos; supervisor administra tareas; Admin revoca; CI fija contrato. iPhone primero.

### Disparadores y fuentes de datos

Login, registro/revocación de dispositivo, tarea reclamada, pérdida de red, push/deep link, actualización obligatoria.

### Estado actual verificado

Backend `/api/v1` dispone de auth, refresh/logout, dispositivos, permisos, notificaciones e inbox con tests focalizados. La rama remota `feature/stock-flow-ui` consume parte real y eliminó fallback silencioso, pero no hay validación física final ni base offline común aceptada.

### Brecha existente

Falta contrato generado/fijado por commit de punta a punta, iPhone real, deep links, almacenamiento cifrado y replay común.

### Flujo normal paso a paso

1. Autenticar, registrar dispositivo y descargar permisos/compatibilidad.
2. Inicio muestra trabajo urgente de hoy; usuario reclama y descarga datos mínimos de tarea.
3. Cada mutación online usa idempotencia y expected_version.
4. Sin red, guardar envelope cifrado con operation_id, dispositivo, usuario, lease, base_version, occurred_at y payload.
5. Al recuperar, reproducir en orden. Servidor responde aceptado, repetición idempotente o conflicto explícito.
6. Conflicto incompatible detiene dependencia y pide revisión; jamás sobrescribe por última escritura.
7. En equipo compartido, sincronizar antes de cerrar y purgar caché sensible.

### Estados y transiciones

device pending → active → revoked/lost. Operation local pending → syncing → accepted|duplicate|conflict|invalidated. Lease máximo 12 horas; cola siete días.

### Excepciones, concurrencia e idempotencia

Token vencido, refresh revocado, contrato incompatible, actualización obligatoria, dispositivo perdido, lease vencido, cola dependiente y almacenamiento lleno.

### Comportamiento online y offline

Toda operación de depósito puede capturarse provisionalmente solo sobre tareas reclamadas/descargadas. Aprobaciones comerciales/finales esperan servidor; despacho exige contingencia autorizada.

### UX web, App y vista rápida

Cámara como escáner principal, feedback <500 ms, controles de una mano, estados de sincronización comprensibles y acción de recuperación. No depender solo de color/sonido.

### Auditoría y retención

Registrar dispositivo/usuario/versión app, operación y resultado sin secretos. Advertir capturas de pantalla; no prometer bloqueo técnico.

### Métricas y objetivos

Éxito login/refresh, sesiones revocadas, tiempo de sync, duplicados, conflictos, leases vencidos, crashes y versión instalada.

### Escenarios de aceptación

iPhone real; token vencido; revocación; push/deep link; pérdida de red; siete días; conflicto; lease; dispositivo perdido; actualización obligatoria.

### Entregas que lo implementan

E5 base; E6 bandeja; E13 offline común; E15/E17/E21 verticales.

### Decisiones pendientes, responsable e impacto

Modelo/iOS exactos y canal de distribución de pruebas. Responsable: equipo móvil; publicación App Store requiere autorización.

## 14. Bandeja, alertas, reclamos ML y turnos

### Propósito y resultado esperado

Concentrar excepciones y trabajo urgente, con responsabilidad clara, escalamiento durable y contexto de turno.

### Actores, permisos y dispositivos

Admin, supervisor, operario, despacho y ventas con excepciones por usuario; turnos asignan áreas/reemplazos, no asistencia.

### Disparadores y fuentes de datos

Pedido nuevo, integración caída, etiqueta fallida, faltante, sobreventa, reclamo/pregunta ML, tarea vencida o ausencia.

### Estado actual verificado

Backend y App remota implementan lectura/marcado de algunas notificaciones; no están verificados claims/resolución/deep links/escalamiento completo ni turnos.

### Brecha existente

Faltan severidades, routing, take/reassign/resolve, durable fallback, reclamos ML completos y ShiftPlan.

### Flujo normal paso a paso

1. Crear alerta durable con severidad, área, entidad, acción requerida y dedupe key.
2. Entregar por App, panel y sonido; inbox sigue disponible si push falla.
3. Usuario reconoce o toma. Reconocer no resuelve.
4. Urgente repite cada 2 minutos, escala supervisor a los 5 y repite cada 5 hasta reconocimiento.
5. Alta tiene objetivo de reconocimiento de 15 minutos. Normal sigue orden de trabajo.
6. Permisos permiten reasignar y resolver con evidencia. Turno/ausencia propone reemplazo.
7. Preguntas, mensajes y reclamos ML usan el mismo inbox con deep link al contexto.

### Estados y transiciones

open → acknowledged/claimed → in progress → resolved|dismissed autorizado. Reassignment conserva historia. Turno planned → active → covered/absent.

### Excepciones, concurrencia e idempotencia

Push perdido, sonido deshabilitado, dos usuarios toman, área sin persona, turno ausente, reclamo duplicado e integración ML caída.

### Comportamiento online y offline

Inbox descargado se consulta; reconocer/resolver queda provisional y se reconcilia. Una acción comercial ML no se asume enviada hasta confirmación servidor.

### UX web, App y vista rápida

Vista rápida por urgencia/área, contador durable, acción primaria clara, tiempo desde creación y diferencia visual/textual entre reconocido y resuelto.

### Auditoría y retención

Historial de entrega, reconocimiento, claims, reasignación, resolución y payload sanitizado. No guardar credenciales ni PII innecesaria.

### Métricas y objetivos

Tiempo de reconocimiento/resolución por severidad/proceso, escaladas, alertas repetidas y push fallido; no ranking público.

### Escenarios de aceptación

Push fallido; doble claim; urgente sin respuesta; ausencia; deep link; permiso insuficiente; ML caído; replay offline.

### Entregas que lo implementan

E6 bandeja/ML; E7 turnos; verticales posteriores producen tareas.

### Decisiones pendientes, responsable e impacto

Áreas, calendario y reemplazos reales. Responsable: supervisión.

## 15. Integraciones WooCommerce, MercadoLibre y Andreani

> **Antes de escribir código contra Mercado Libre se lee
> `docs/superpowers/specs/api-mercadolibre-especificacion.md`.** Es la fuente única de la
> integración: combina la documentación oficial con lo observado en vivo contra la cuenta, y
> registra las trampas que la documentación no hace evidentes. Si algo no está ahí, se releva
> primero y se agrega; no se implementa contra memoria.

### Propósito y resultado esperado

Mantener contratos externos observables, idempotentes y reconciliables sin esconder caídas ni mezclar autoridades.

### Actores, permisos y dispositivos

Servicios backend; Ventas/Admin resuelve conflictos; depósito consume elegibilidad; despacho usa ML/Andreani.

### Disparadores y fuentes de datos

Pedidos/webhooks/polling, stock/precio, preguntas/reclamos, etiquetas, tracking, salida y reconciliación.

### Estado actual verificado

Existen integraciones Woo/ML, sincronizaciones, herramientas Andreani y módulos de atención. El comportamiento está fragmentado y no todo usa el modelo de compromisos/movimientos.

### Brecha existente

Falta servicio de negocio compartido por proceso, política ML, cola durable uniforme, frescura, staging aislado y reconciliación integral.

#### Incidente abierto: auditoría y sincronización de todos los webhooks

El sistema tiene dos entradas públicas: WooCommerce `POST /api/woo/webhook/order` y
MercadoLibre `POST /api/ml/notificacion`. Su comportamiento no es uniforme. Woo valida HMAC
cuando está configurado y dispara sincronizaciones puntuales/en segundo plano, pero responde
el ACK antes de persistir una intención durable. MercadoLibre persiste evento y job antes del
ACK, con deduplicación, pero mezcla proyecciones reales con topics `audit-only`.

La matriz verificada queda así:

| Origen/topic | Estado actual | Brecha a corregir |
| --- | --- | --- |
| Woo `order.created`/`order.updated` | Sync puntual a pedidos/preparación; stock ML por sync de fondo | Persistencia durable antes del ACK, idempotencia por webhook, reintentos y reconciliación de pedidos/stock |
| ML `orders` | Sync puntual ML→Woo y preparación | Unificar job durable, estado/frescura y recuperación de timeout o caída |
| ML `orders_v2` | Sync puntual de preparación; no actualiza el flujo ML→Woo | Definir autoridad y paridad funcional con `orders` |
| ML `questions`/`messages` | Proyección a tablas locales/inbox | Reconciliar contra ML aunque no llegue otro webhook; retirar avisos obsoletos |
| ML `claims`/`post_purchase:claims` | Job durable y proyección de reclamos/inbox | Reconciliación, reapertura vigente y separación de no confirmado vs cerrado |
| ML `items` | **RESUELTO (2026-09-05, PM-136)**: proyecta. Relee el ítem por multiget acotado, con coalescencia de ráfagas de 2 min y el limitador de cupo existente | Ninguna. Costo medido: entre +0,06% y +1,1% sobre las ~34.000 llamadas diarias del scan |
| ML `messages` | **ROTO Y NO ARREGLABLE DESDE EL CÓDIGO (PM-137)**: 39 jobs `dead_lettered`, 0 completados, `ml_mensajes` en 0 filas. El webhook manda el `resource` como id pelado y el único endpoint que lo resuelve, `/marketplace/messages/{id}`, responde 403 `Invalid caller.id`: es del flujo de aplicaciones *marketplace*, no del de un vendedor común | Decidir entre descartar el topic explícitamente o alcanzar los mensajes por `/messages/packs/{pack}/sellers/{id}` desde el contexto de una orden |
| ML `shipments`, `invoices`, `orders_feedback` y topics futuros | `audit-only`: se recibe y registra, sin proyección | Decidir por topic si requiere sincronización, descartarlo explícitamente o mantenerlo auditado con alarma de cobertura |

La corrección queda incorporada a E6/E11 y debe incluir:

- contrato común para validar, persistir, deduplicar, hacer ACK, procesar, reintentar y
  reconciliar todos los webhooks;
- cola durable también para Woo, con idempotencia por evento/pedido y recuperación si el
  proceso cae después del ACK;
- reconciliación incremental y periódica contra Woo/ML, con cursor, límite, backoff, último
  éxito, frescura y estado visible por integración y entidad;
- estados idempotentes de preguntas, mensajes, reclamos, pedidos, envíos y stock, sin marcar
  como resuelto un dato solo porque el proveedor no respondió;
- inventario explícito de topics `audit-only`, alerta por cobertura desconocida y decisión
  documentada antes de activar una nueva proyección;
- pruebas de duplicado, fuera de orden, timeout con respuesta tardía, caída, credencial
  revocada, payload inválido, cuenta ML ajena, ACK seguido de crash y datos locales obsoletos.

### Flujo normal paso a paso

1. Woo mantiene catálogo, ventas, pagos y disponible comercial; ventas presenciales también se registran allí.
2. Fusion ingiere cambios idempotentemente y crea compromisos según la reserva/reducción que Woo mantenga.
3. ML aporta pedidos, ventanas, publicaciones, preguntas/reclamos y etiquetas en su herramienta.
4. Andreani conserva tabla editable/TSV; Fusion congela lote y audita confirmación/tracking.
5. Toda falla externa conserva intención durable, reintenta con idempotencia y expone frescura/incidente.
6. Reconciliación puntual y global compara autoridades sin publicar cero por divergencia ordinaria.
7. Sobreventa real confirmada bloquea nuevas ventas en ambos canales y escala.

### Estados y transiciones

sync pending → processing → applied|retryable|conflict|manual review. Freshness healthy → delayed → stale → incident.

### Excepciones, concurrencia e idempotencia

Webhook duplicado/fuera de orden, timeout con respuesta tardía, Woo/ML caído, token revocado, stock divergente, tracking inválido y publicación sin vínculo.

### Comportamiento online y offline

Usuarios pueden ver último snapshot con frescura; operaciones comerciales finales no se confirman offline.

### UX web, App y vista rápida

Estado por integración y entidad, último éxito, siguiente reintento, impacto y acción. Evitar mensajes genéricos.

### Auditoría y retención

Eventos externos, payload mínimo sanitizado, correlación, intentos, resultado y decisiones indefinidas según operación; secretos nunca en docs/logs.

### Métricas y objetivos

Latencia/frescura, reintentos, conflictos, pedidos demorados, sobreventas y tiempo de recuperación.

### Escenarios de aceptación

Woo/ML caídos; duplicado; fuera de orden; timeout tardío; ACK seguido de crash; reconciliación;
aviso con pregunta respondida o reclamo cerrado en ML; pedido ausente; recurso inexistente;
topic audit-only; sobreventa; Andreani sin tracking; credencial revocada.

### Entregas que lo implementan

E1/E4 horarios/transporte; E6 reclamos; E11 compromisos/sync; E22 entrante/preventa; E23 staging.

### Decisiones pendientes, responsable e impacto

Campo SLA ML y garantía comercial posible con política actual de stock completo publicado. Responsable: integración/operación.

## 16. Métricas, reposición, entrante y preventa

### Propósito y resultado esperado

Decidir control y compra con datos explicables, evitando metas inventadas y automatización prematura.

### Actores, permisos y dispositivos

Administración/Ventas analiza; depósito confirma entrantes; supervisores revisan procesos; App/panel/exportación distribuyen.

### Disparadores y fuentes de datos

Movimientos, tareas, tiempos, ventas 12 meses, estacionalidad, días sin stock, lead time, entrantes y compromisos.

### Estado actual verificado

Hay datos parciales de ventas, stock y operación, pero no línea base unificada ni sugerencia objetivo.

### Brecha existente

Falta instrumentación consistente, separación de tiempos, calidad de datos y reportes.

### Flujo normal paso a paso

1. Instrumentar desde entregas previas tiempo activo, pausa, dependencia y bloqueo.
2. Construir un mes de línea base antes de fijar metas.
3. Emitir excepciones diarias, reposición semanal y exactitud/cobertura/valor mensual.
4. Calcular reposición sugerida con 12 meses, estacionalidad, días sin stock, cobertura, lead time, entrante y compromisos.
5. Registrar entrante mediante aviso manual y recepciones parciales.
6. Permitir preventa solo en Woo y con autorización; no automatizar órdenes de compra.
7. Distribuir en App, panel y exportación según permisos.

### Estados y transiciones

metric provisional → baseline → comparable. Suggestion draft → reviewed → accepted/rejected manual. Incoming announced → partial → received/closed.

### Excepciones, concurrencia e idempotencia

Datos incompletos, días sin stock, producto nuevo, estacionalidad anómala, entrante demorado, preventa sin autorización y exportación sensible.

### Comportamiento online y offline

Snapshots de informes pueden consultarse; decisiones de preventa/entrante requieren servidor.

### UX web, App y vista rápida

Explicar fórmula, período, frescura y faltantes de datos. No exhibir ranking público de personas.

### Auditoría y retención

Parámetros, versiones, aceptación/rechazo y exportaciones. Movimientos fuente indefinidos.

### Métricas y objetivos

Exactitud, cobertura, faltantes, lead time observado, recepción parcial y calidad de sugerencia.

### Escenarios de aceptación

Producto nuevo; 12 meses incompletos; OOS; estacional; entrante parcial; preventa; exportación por rol.

### Entregas que lo implementan

E22, alimentada por E8–E21.

### Decisiones pendientes, responsable e impacto

Metas se deciden tras línea base; lead times iniciales y responsables de revisión. Responsable: Administración.

## 17. Operación, diagnóstico, seguridad y recuperación

### Propósito y resultado esperado

Publicar cambios reversibles, diagnosticar incidentes y recuperar servicio/datos sin comprometer producción.

### Actores, permisos y dispositivos

Agente implementador, revisor, tester, auditor de despliegue, operaciones y responsable funcional.

### Disparadores y fuentes de datos

Entrega candidata, migración, incidente, health/smoke fallido, backup/restore y cambio de infraestructura.

### Estado actual verificado

El VPS `/opt/fusionbikes/herramientas` es producción real y sirve `conteo-confiable`; hay PM2, health, tests y reglas de coordinación. No existe staging integral sanitizado ni RTO/RPO medidos.

### Brecha existente

Faltan pipeline automático completo, entorno aislado reproducible, restore probado periódico, runbooks y métricas DR.

### Flujo normal paso a paso

1. Desarrollar en worktree aislado, con migraciones aditivas/idempotentes y flag.
2. Revisión independiente; resolver críticos/altos y aceptar medios con responsable/fecha.
3. Ejecutar tests focalizados, integración/contrato y suite global serial una vez sobre diff final.
4. Probar E2E/hardware/dispositivo según superficie; preparar backup y rollback que conserve eventos posteriores.
5. Pipeline verde puede publicar backend/web, migrar compatible, verificar PM2/health/smoke.
6. Health/smoke fallido ejecuta rollback automático. Windows/App Store esperan autorización.
7. Observar piloto acotado una jornada; aceptar con responsable o apagar flag y documentar.

### Estados y transiciones

planificada → desarrollo → candidata → publicada → observada → aceptada. Fallo vuelve a desarrollo o rollback; código existente no equivale a entrega terminada.

### Excepciones, concurrencia e idempotencia

Worktree sucio, suite concurrente, migración parcial, health falso positivo, eventos nuevos tras deploy, rollback incompatible, backup corrupto y falta de autoridad.

### Comportamiento online y offline

Runbooks y SOP imprimibles deben permitir contingencia. Staging usa snapshot sanitizado bajo demanda y jamás credenciales reales de escritura.

### UX web, App y vista rápida

Errores indican acción, qué se preservó y código de incidente. Reportar problema adjunta contexto seguro y correlación; soporte puede rastrear sin PII innecesaria.

### Auditoría y retención

Commits, gates, migraciones, despliegue, rollback, observación y aceptación. Backups cifrados; acceso mínimo; auditoría/movimientos indefinidos.

### Métricas y objetivos

Lead time de entrega, fallos, rollback, MTTR, backup/restore, RTO/RPO medidos y defectos escapados.

### Escenarios de aceptación

Migración repetida; backup/restore; health fallido; rollback con eventos nuevos; staging sin credenciales; incidente trazable; permisos/PII.

### Entregas que lo implementan

E23 robustez; E24 consolidación; gates aplican E0–E24.

### Decisiones pendientes, responsable e impacto

Infraestructura/sanitización de staging y RTO/RPO tras medición. Responsable: operaciones.

## 18. Módulos existentes fuera del rediseño actual

Precios, catálogo, consulta de precios, códigos universales, variaciones muertas y herramientas auxiliares siguen dentro del producto, pero no se rediseñan sin descubrimiento equivalente. Matcher/vínculos ML salió de esta lista por decisión explícita y pasa al programa urgente UM1. E0 debe inventariar los demás módulos antes de modificarlos.

| Módulo | Estado documental | Riesgo/pregunta antes de modificar |
| --- | --- | --- |
| Precios | Existente, integración Woo/ML relevante | Autoridad, redondeo, permisos y efectos de sincronización |
| Catálogo/EAN | Existente; identidad impacta stock | Duplicados, SKU eliminado, provisional y solo local |
| Consulta de precios | Existente con diseño histórico | Frescura, fuente y UX móvil |
| Herramientas auxiliares | Inventario pendiente por tarea | Dueño operativo, uso real y deuda antes de rediseñar |

## 18.1 Programa urgente UM1 — Identidad de productos

### Propósito, prioridad e invariante

UM1 reemplaza Matcher, Cobertura y Guardia por una identidad bilateral ML↔Woo basada en `Producto Fusion`. Es transversal y no renumera E0–E24. Su primera subentrega, **UM1.1**, es bloqueante y tiene prioridad máxima: cerrar el universo actual de claves ML activas con stock cuyo `SELLER_SKU` esté ausente, vacío, no exista de forma única en Woo o contradiga un GTIN válido.

La unidad ML es siempre `item_id + variation_id`. Una clave solo está cubierta cuando su identidad y stock fueron verificados remotamente con observaciones confiables **dentro de la ventana de frescura vigente**, o cuando posee una excepción explícita `solo_ml`. Esa ventana **no es un parámetro suelto**: vale 60 minutos mientras el scan corre cada 15 nominales —20 reales, ver PM-152—, y sólo llega a 120 cuando el ramp lleva el scan a 60 —los dos valores se mueven juntos y sólo con cobertura de webhook demostrada (PM-138)—. Relajarla es aceptar dar por verificada una clave observada hace más tiempo: se sostiene únicamente porque, con el webhook cubriendo, una observación vieja significa «nada cambió» y no «no miramos». Una decisión histórica, similitud textual, `seller_custom_field` o una variación hermana nunca cubren la clave.

Woo continúa como autoridad de stock. Producto Fusion es la identidad canónica: una unidad vendible, una identidad Woo activa como máximo y cero o más claves ML. Su SKU no es editable y cumple `FB-{id_woo}`; un producto provisional sin Woo no tiene SKU ni puede sincronizarse.

Son unidades Woo activas los productos simples y variaciones `publish|private`; los padres `variable` quedan fuera y el stock cero no archiva identidad. Producto Fusion administra identificadores tipados `ean_8`, `ean_13`, `upc_a` y `gtin_14`, únicos globalmente mientras estén activos. UPC-A y EAN-13 con cero inicial son equivalentes para matching mediante el canónico GS1 de 14 dígitos (PM-150). Woo recibe sólo el identificador principal y ML conserva todos los observados; el principal es **el primero de una lista de prioridad reordenable por producto** (PM-151, 2026-09-06), no una regla fija por fuente, y una unidad admite N identificadores activos —el límite de «un EAN y un UPC» quedó superado por ser falso contra los datos.

### Subentregas ordenadas por valor operativo

| Entrega | Resultado tangible | Gate dominante |
| --- | --- | --- |
| **UM1.1 bloqueante** | Núcleo mínimo, auditoría fresca y cierre durable de toda clave ML activa con stock sin SKU válido | Universo conciliado; cero resolución sin verificar SKU y stock; canario y rollback |
| UM1.2 | Eventos ML/Woo durables, scan de seguridad, salud, alertas, claims y recuperación | Eventos perdidos/duplicados/fuera de orden convergen tras reinicio |
| UM1.3 | Producto Fusion completo, familias, atributos, archivo, reservas y bootstrap Woo | Bootstrap idempotente sin duplicar identidades |
| UM1.4 | Colas ML→Fusion y Woo→ML, tareas de publicación y matching explicable | Calibración de 200 casos: ≥90% global y familias elegibles ≥80% |
| UM1.5 | Herramienta unificada web/App, deep links y decisiones offline seguras | Paridad, accesibilidad, responsive e iPhone real |
| UM1.6 | Migración de SKU canónico, corte estricto y retiro legacy | Canario, lotes de diez, 30 días de compatibilidad GET y rollback |

### UM1.1: corrección segura

Toda corrección persiste caso, decisión y operación antes de efectos externos. Cuando existe un
`FB-{id_woo}` objetivo válido, la operación relee Woo para tomar stock fresco, sobrescribe
directamente `SELLER_SKU`, relee ML, verifica SKU y stock remoto, activa localmente y reprocesa
ventas retenidas. Nunca pone stock en cero ni limpia el campo como fallback: si ML rechaza o no
permite verificar la escritura, conserva el stock y pasa a intervención. Si la API puede afectar
variaciones hermanas, la operación muestra el impacto y espera confirmación hasta contar con
evidencia real de aislamiento. El ejecutor corre cada minuto; scans y webhooks son procesos separados.

Los casos no vinculables deben recibir una excepción explícita `solo_ml` o permanecer urgentes. `solo_ml` excluye sincronización de stock Fusion y deja la cantidad bajo administración manual en ML; sólo Administración la aprueba, con motivo y vigencia fechada o indefinida. Nunca se cierran por `omitir`. Si una operación `shadow` cambia de identidad antes de su primer intento remoto, queda inmovilizada como obsoleta y el caso vuelve a urgente para una decisión nueva; una operación que ya pudo tener efectos permanece en intervención. El canario admite como máximo dos claves explícitas y dos operaciones por corrida.

### Detección, estados y recuperación

- Los webhooks ML `items` y Woo de producto crean trabajo durable y releen el origen; scans completos separados reparan eventos perdidos. **La cadencia del scan ML y su ventana de frescura son adaptativas y se mueven JUNTAS** (PM-138): arrancan en 15 min / 60 min y escalan por escalones —15/60, 20/60, 30/60 y 60/120— **sólo cuando el webhook demuestra que cubre**. Esos intervalos son NOMINALES: por la condición de borde documentada en `tocaScan` la cadencia real es un tick del cron más larga —15 corre cada 20, 20 cada 25, 30 cada 35, 60 cada 65— y se dejó así a propósito porque corregirla sube las llamadas a ML un 33% (PM-152, 2026-09-06). Un scan de 60 minutos con frescura de 60 es la combinación rota: justo antes de cada corrida toda observación tendría ~60 minutos y nada verificaría. Un cambio descubierto sin webhook baja un escalón de inmediato; una proyección de `items` fallando congela el ramp y además lo baja. Woo degrada salud a los 30 minutos.
- Una baja o cambio crítico Woo confirmado protege en cero todas las claves ML vinculadas y retiene pedidos. La recuperación válida verifica ambos canales, restaura stock y libera pedidos.
- Una publicación ML pausada inválida conserva deuda no urgente; cerrada se archiva; reactivada con stock e identidad inválida se protege en cero y pasa a urgencia máxima.
- Caso: `detectado → disponible → tomado → operación_pendiente → resuelto|intervención`; claim opcional, relevo por cualquier decisor con motivo y concurrencia por `expected_version`.
- Operación: `queued → writing → verifying → completed`; tres fallos o quince minutos sin progreso llevan a intervención. Administración puede reintentar o dejar bloqueado.

### Matching y cobertura bilateral

- Auto-vínculo sólo por `SELLER_SKU` textualmente exacto y único o EAN/UPC/GTIN activo, canónico, único y con dígito verificador válido.
- Un conflicto entre SKU/EAN/UPC no se automatiza: la persona elige la identidad válida, el identificador descartado queda marcado incorrecto y genera tarea de catálogo. Desde 2026-09-06 el conflicto **se registra** en estado `conflicto` en vez de descartarse en silencio (PM-150). Excepción medida: las variaciones que heredaron el GTIN de su padre Woo se absorben sin generar trabajo humano —no confunden dos productos distintos— por decisión del usuario del 2026-09-06.
- Matching aproximado determinista por familia, con un candidato, razones visibles y confirmación individual. Precio y fotos son contexto, no puntaje.
- Mostrar porcentaje solo si existe calibración suficiente y es ≥60%; de lo contrario indicar evidencia insuficiente.
- Woo→ML incluye unidades activas con stock y termina en vínculo, tarea de publicación con SLA de siete días o exclusión administrativa explícita. Una tarea vencida escala sin cerrarse.

### Superficies, permisos y alertas

- Web: `/herramientas/identidad-productos/` y `/api/identidad-productos`.
- App: `/api/v1/identidad-productos`; deep link `fusionbikes://identidad-productos/casos/{id}`.
- Navegación: Pendientes, Productos Fusion, Operaciones e Historial, con salud/alertas persistentes.
- Administradores y usuarios con `matcher:write` deciden; lectura puede consultar y agregar notas/evidencia. Excepciones, exclusiones, transferencias, familias y modo operativo son sólo administrativos.
- “Pendientes” cuenta acciones humanas; ejecución en espera tiene contador separado. `bloqueada_impacto` aparece también en Operaciones. Contradicciones posteriores a una verificación generan tarea de catálogo sin reabrir identidad.
- La App permite offline hasta 12 horas sólo para vínculos y notas. Versión/evidencia divergente bloquea esa operación, no las independientes; una decisión válida entra al flujo remoto normal.
- Alertas críticas llegan a Administración y usuarios activos con `matcher:write` por App, pantalla y push; recordatorio a los 15 minutos y nueva escalada a los 30. La bandeja persiste si push falla.

### Rollout y retiro legacy

Bootstrap en sombra desde productos simples y variaciones Woo `publish|private`; sólo relaciones heredadas exactas, únicas y nuevamente verificadas migran automáticamente. Identidades verificadas sin familia/atributos siguen operando con deuda de catálogo de siete días; vínculos nuevos incompletos se bloquean y un cambio de reglas revalida todos los vínculos afectados. Los SKU fuera de `FB-{id_woo}` se corrigen con un canario y lotes de diez. Las mutaciones legacy se deshabilitan al corte; GET permanecen 30 días con deprecación y métricas. El rollback vuelve el núcleo a sombra/read-only, conserva casos/evidencia y nunca reactiva motores anteriores ni deshace automáticamente efectos remotos confirmados.

Una línea insegura retiene el pedido completo. Se revisan pedidos abiertos/no conciliados desde la última evidencia confiable y se liberan cronológica e idempotentemente hasta agotar stock. “Observada” exige una jornada comercial completa; el auditor recomienda y sólo el usuario declara una subentrega `aceptada`.

La especificación completa es `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-04-identidad-productos.md`; la arquitectura de sistemas, estados, blueprint y handoff está en `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-05-arquitectura-um1.md`; la ficha matriz es `/opt/fusionbikes/herramientas/docs/superpowers/deliveries/UM1-guardia-ml.md` y UM1.1–UM1.6 conservan evidencia independiente.

Cada avance sobre UM1, aunque sea parcial o quede a medias, actualiza en el mismo commit el estado de la ficha, la evidencia con ubicación exacta y comando/resultado copiado literalmente, y el handoff para el próximo agente. La regla completa está en la sección «Estado, handoff y evidencia en cada avance» de esa especificación. Un avance sin esos tres elementos se trata como trabajo no entregado y se re-verifica desde cero.

## 19. Secuencia de entregas E0–E24

| Entrega | Superficie | Resultado tangible | Dependencia dominante |
| --- | --- | --- | --- |
| UM1.1 urgente | VPS + web móvil | Cierre de publicaciones ML activas con stock sin SKU válido | Bloqueante; protege E1/E11/E12 |
| UM1.2–UM1.6 | VPS + web + App | Cobertura durable, Producto Fusion, matching bilateral, UX completa y retiro legacy | UM1.1 y gates progresivos |
| E0 | Ambos | Maestro, memoria, archivo, decisiones, patrones, fichas y handoffs reconstruidos | Ninguna |
| E1 | VPS | Cola continua, checklist y escaneo unitario | Entrega operativa anterior |
| E2 | VPS/web móvil | Evidencia, perfiles, paquetes y aprobación confiable | Entrega operativa anterior |
| E3 | VPS/Windows | Etiqueta interna automática 50×25 y agente validado | Entrega operativa anterior |
| E4 | VPS | Lotes ML/Andreani, tracking y despacho reconciliado | Entrega operativa anterior |
| E5 | VPS/App | App iPhone base, autenticación, dispositivos y contrato | E0 y backend `/api/v1` existente |
| E6 | VPS/App | Bandeja ML/operativa, alertas, escalamiento y deep links | E5 |
| E7 | VPS/App | Turnos, áreas y reemplazos | E6 |
| E8 | VPS | Consulta rápida unificada de stock | E0 y fuentes Woo/ML existentes |
| E9 | VPS | Familias, identidad, ubicaciones, línea base y rollout | E8 |
| E10 | VPS | Libro inmutable, transferencias, ajustes y reposición interna | E9 |
| E11 | VPS | Compromisos Woo, sync puntual/global y política ML | E10 |
| E12 | VPS/App | Picking integrado, faltantes y reasignación automática | E1–E2 y E11 |
| E13 | App/VPS | Infraestructura común de piso y offline | E5 y tipos/tareas de E12 |
| E14 | VPS | Recepción trazable | E9–E11 |
| E15 | App | Recepción iPhone y offline | E13–E14 |
| E16 | VPS | Conteos ciegos y ajustes controlados | E9–E11 |
| E17 | App | Conteos iPhone y offline | E13 y E16 |
| E18 | Ambos | Cancelaciones, devoluciones, daños, proveedor y descarte | Stock/tareas previas |
| E19 | Ambos | Garantías y posventa | Stock/tareas previas |
| E20 | VPS | Taller web y venta Woo de services | Stock/tareas previas |
| E21 | App | Taller iPhone y offline | Stock/tareas previas |
| E22 | Ambos | Métricas, reposición, entrante y preventa | Datos E1–E21 |
| E23 | VPS | Staging, diagnóstico, backups, restauración y robustez | Todas las superficies |
| E24 | Repositorios | Consolidación final de ramas hacia master | E0–E23 aceptadas |

Cada entrega dura idealmente 3–5 días, es reversible/apagable por flag, actualiza maestro/memoria/ficha/SOP, se demuestra, pilota acotadamente y observa al menos una jornada. La ficha individual es la única fuente de progreso.

## 20. Gates de calidad, pruebas y publicación

### Gate técnico obligatorio

- Revisión independiente; críticos y altos resueltos; medios aceptados con responsable y fecha.
- Unitarios, integración y contrato; suite global serial una vez sobre diff final.
- E2E web en 390/768/1440 cuando cambia UI; iPhone real para móvil; hardware real para impresora.
- Axe/accesibilidad, operación a una mano, listas/filtros ≤2 s, feedback escaneo <500 ms y progreso de foto inmediato con objetivo 10 s.
- Fallas externas con dobles y staging aislado; no usar producción para inducirlas.
- Backup íntegro, restauración probada, migraciones aditivas/idempotentes/compatibles y rollback que conserve eventos nuevos.

### Gate operativo obligatorio

- SOP digital e imprimible, demo y práctica guiada.
- Piloto con pedidos reales acotados por flag.
- Una jornada observada y aceptación del responsable del proceso.
- Ficha actualizada con comandos/resultados exactos, incidentes y próxima acción reproducible.

### Política de despliegue

Pipeline verde puede publicar automáticamente backend/web VPS: push, migración compatible, deploy, PM2/health y smoke. Fallo de health/smoke dispara rollback automático. Instalar agente Windows, tocar hardware y enviar App Store requieren autorización explícita. La App pública agrupa hitos estables.

## 21. Matriz maestra de escenarios

| Área | Escenarios mínimos | Entregas |
| --- | --- | --- |
| Preparación/picking | Pedido nuevo durante preparación; prioridad ML; reasignación última unidad; hold; multipaquete | E1,E12 |
| Fotos | Lenta; timeout; tardía; doble toque; recarga; parcial; perfil faltante | E2 |
| Impresión | Apagada; sin papel; USB/red/Windows; confirmación perdida; reimpresión | E3 |
| Despacho | Lote congelado; anulado; tardío; tracking incorrecto; duplicado/ajeno; offline | E4 |
| App | Token vencido; dispositivo revocado/perdido; deep link; contrato incompatible; update | E5,E6,E13 |
| Stock | Ubicaciones; último artículo; SKU/EAN duplicado; Woo caído; condicionado; sobreventa | E8–E12 |
| Recepción | Parcial; documento tardío; dos operadores; provisional; foto fallida; disputa | E14,E15 |
| Conteo | Ciego; movimiento posterior; autoajuste; alto riesgo; zero; offline; lease | E16,E17 |
| Excepciones | Cancelación pre/post; devolución dañada; proveedor; descarte; garantía | E18,E19 |
| Taller | Repuesto usado/no usado; presupuesto; offline; saldo; garantía | E20,E21 |
| Operación | Migración repetida; restore; health fallido; rollback con eventos nuevos | E23,E24 |

## 22. Cobertura documental

La cobertura se controla por decisiones, procesos, estados, errores, permisos, interfaces, pruebas, entrega y evidencia; nunca por cantidad de líneas.

| Proceso | Especificación | Decisiones | Patrón/referencia | Ficha de progreso | SOP previsto |
| --- | --- | --- | --- | --- | --- |
| Preparación, picking y paquetes | §4 | registro PM | WMS aplicable | E0–E24 | índice SOP |
| Evidencia fotográfica y aprobación | §5 | registro PM | reglas propias | E0–E24 | índice SOP |
| Impresión interna, transporte y despacho | §6 | registro PM | reglas propias | E0–E24 | índice SOP |
| Stock, identidad, familias, ubicaciones y movimientos | §7 | registro PM | WMS aplicable | E0–E24 | índice SOP |
| Recepción y putaway | §8 | registro PM | WMS aplicable | E0–E24 | índice SOP |
| Conteos y ajustes | §9 | registro PM | WMS aplicable | E0–E24 | índice SOP |
| Cancelaciones, devoluciones, daños y proveedor | §10 | registro PM | reglas propias | E0–E24 | índice SOP |
| Garantías y posventa | §11 | registro PM | reglas propias | E0–E24 | índice SOP |
| Taller | §12 | registro PM | reglas propias | E0–E24 | índice SOP |
| App iPhone, dispositivos y offline | §13 | registro PM | WMS aplicable | E0–E24 | índice SOP |
| Bandeja, alertas, reclamos ML y turnos | §14 | registro PM | reglas propias | E0–E24 | índice SOP |
| Integraciones WooCommerce, MercadoLibre y Andreani | §15 | registro PM | reglas propias | E0–E24 | índice SOP |
| Métricas, reposición, entrante y preventa | §16 | registro PM | reglas propias | E0–E24 | índice SOP |
| Operación, diagnóstico, seguridad y recuperación | §17 | registro PM | reglas propias | E0–E24 | índice SOP |

## 23. Pendientes explícitos y límites de alcance

### Bloqueos concretos

- Impresora: modelo, driver, lenguaje y puerto — depósito — bloquea publicación E3.
- iPhone: modelo/iOS exactos — equipo móvil — bloquea matriz final E5.
- SLA ML por modalidad — integración/operación — bloquea aceptación E1/E4.
- Staging y sanitización — operaciones — bloquea fallos integrales y despliegue automático.
- RTO/RPO — operaciones — se fijan tras medir backup/restauración en E23.

### Fuera de esta etapa

- MercadoLibre Full; Android hasta demanda concreta; serialización; lotes y vencimientos; kits/combos; consignación.
- Órdenes de compra automáticas; inventario de embalaje; peso/dimensiones/balanza en Fusion.
- Retiros web/locales dentro de despacho; portal cliente de taller; asistencia/liquidación; ranking público.
- Reembolsos automáticos y garantía de cero sobreventa mientras cada publicación ML anuncie stock completo.

## 24. Definición de cierre del programa

E24 solo puede aceptarse cuando E0–E23 tienen evidencia o exclusión explícita aprobada, ramas y migraciones están consolidadas sin perder historia, contratos App/backend están fijados, recuperación fue probada y los responsables operativos aceptaron sus procesos. El cierre no elimina fichas ni archivos: deja un producto operable y una cadena de evidencia reproducible.
