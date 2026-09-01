# Plan maestro por entregas verticales: VPS y App

**Estado:** plan único vigente
**Actualizado:** 2026-09-01
**Backend canónico:** `/opt/fusionbikes/herramientas`, rama productiva `conteo-confiable`
**Base verificada al redactar:** `334d48d`
**App:** repositorio privado `fusionbikesok-ui/FusionBikes-App`, base `feature/stock-flow-ui`
**Despliegue:** siempre manual, después de revisión, pruebas, E2E y auditoría

## 1. Cómo leer este plan

Este documento distingue cuatro estados y no los mezcla:

- **Integrado:** el cambio es ancestro de la rama indicada y está disponible en su código.
- **Terminado sin integrar:** existe en una rama o worktree, pero todavía debe rebasarse, revisarse
  e integrarse.
- **Programado:** decisión aprobada para una entrega futura; no describe comportamiento actual.
- **Pendiente de decisión:** no debe ser resuelto por un implementador sin volver al responsable
  operativo.

Cada entrega dura idealmente 3–5 días, deja un resultado demostrable y reversible, y actualiza
este plan y `/opt/fusionbikes/herramientas/docs/memory/`. Una entrega que afecte un flujo ya usado
se observa durante al menos una jornada operativa antes de ampliar ese mismo flujo.

## 2. Estado real de partida

### 2.1 Backend integrado en `conteo-confiable`

- Preparación tiene cola continua, toma exclusiva mediante claim técnico, escaneo, requisitos de
  evidencia, fotos por ítem y paquete, estados auditados y control de despacho idempotente.
- El control de despacho ya puede crear una tarea interna de etiqueta 50×25 en
  `etiquetas_cola`, pero la impresión sigue requiriendo el flujo manual del navegador y el
  disparador actual ocurre demasiado tarde, durante la confirmación de despacho.
- Existe configuración de horarios de corte, notificaciones, autenticación móvil, inbox,
  dispositivos, preferencias y entrega push bajo `/api/v1`.
- Inventario dispone de sesiones de conteo, alcance por categorías, marcas o ubicación,
  asociación de códigos y cierre seguro. No es todavía el libro de movimientos definido en
  este plan.
- Recepción, pedidos, sincronización Woo/ML y etiquetas existen como herramientas separadas.
  Todavía no comparten el modelo físico/comprometido/no disponible/entrante de las entregas de
  stock.

### 2.2 Trabajo terminado pero no integrado

Antes de E1 se debe comprobar nuevamente ancestry y diff real. Al 2026-09-01 existen:

| Tema | Rama / worktree | Punta observada | Estado |
| --- | --- | --- | --- |
| Carga idempotente y timeouts de fotos | `fix-fotos-upload-timeout` / `/tmp/fusion-fotos-upload-20260831` | `3fe7437` | Terminado sin integrar |
| Hoja diaria operativa de despachos | `hoja-despachos-u0` / `/tmp/fusion-hoja-despachos-20260831` | `6b68902` | Terminado sin integrar |
| SLA y fecha de despacho por modalidad | `prep-horarios-corte` / `/tmp/fusion-prep-horarios-fix-20260831` | `8fd920d` | Terminado sin integrar |

No se hará merge ciego de estas ramas: cada una se rebasa sobre la base vigente, se inspeccionan
los conflictos semánticos y se repiten sus gates.

### 2.3 Estado real de la App

- `main` es un scaffold inicial; `feature/app-foundation` y `feature/stock-flow-ui` divergieron.
- `feature/stock-flow-ui` es la base elegida. Contiene prototipos, mocks, auth/biometría/push
  parcial y una UI monolítica de stock con edición absoluta que no representa el modelo final.
- El trabajo exclusivo útil de `feature/app-foundation` se porta selectivamente; no se mezcla la
  rama completa.
- La copia del OpenAPI de la App estaba desactualizada respecto de
  `/opt/fusionbikes/herramientas/openapi/mobile-v1.yaml`.
- La App consume únicamente `/api/v1`; nunca habla directamente con WooCommerce,
  MercadoLibre ni servicios internos del VPS.
- Se valida iPhone y Android desde los primeros verticales. No existe una etapa “iPhone primero,
  Android después”.

## 3. Estrategia de entregas

| Entrega | Superficie | Resultado tangible |
| --- | --- | --- |
| E0 | Ambos repos | Plan, memoria y contrato documental alineados |
| E1 | VPS | Preparación y hoja de despachos confiables |
| E2 | VPS + PC depósito | Etiqueta interna 50×25 automática |
| E3 | VPS + App | App conectada con autenticación y contrato vigente |
| E4 | App | Bandeja operativa y alertas reales |
| E5 | VPS | Vista rápida unificada de stock |
| E6 | VPS | Movimientos, ubicaciones y transferencias |
| E7 | VPS + App | Compromisos, picking y faltantes urgentes |
| E8 | App | Tareas de depósito y consulta móvil de stock |
| E9 | VPS | Recepción de mercadería por movimientos |
| E10 | App | Recepción móvil asistida |
| E11 | VPS | Conteos ciegos y ajustes controlados |
| E12 | App | Conteo móvil offline |
| E13 | VPS + App | Cancelaciones, devoluciones y daños |
| E14 | VPS + App | Métricas, reposición sugerida y cierre operativo |
| E15 | VPS | Reconciliación periódica ML/Woo y deuda operativa heredada |
| E16 | VPS + App | Consolidación controlada de `master` y `conteo-confiable` |

## 4. Entregas detalladas

### E0: Contexto canónico de ambos repositorios

**Resultado:** cualquier persona o agente distingue el estado real y las decisiones sin depender
de chats ni copias históricas.

- Reestructurar este plan y crear memoria durable específica para operaciones de depósito y App.
- Corregir toda referencia que trate el VPS como staging: `/opt/fusionbikes/herramientas` es
  producción real y sirve `conteo-confiable`.
- Depurar las copias históricas de planes en la App. Conservar un índice breve, la decisión de
  arquitectura y un OpenAPI fijado a un commit de origen.
- La memoria local en `/opt/fusionbikes/herramientas/docs/memory/` es la fuente canónica de
  contexto. Si se conecta un Codebase Memory MCP, deberá espejar estos hechos y no reemplazarlos.

### E1: Preparación confiable en VPS

**Resultado:** el depósito prepara pedidos durante toda la jornada sin perder fotos ni ocultar
estados.

- Preservar y validar la cola continua ya integrada; rebasar e integrar únicamente lo que falte de
  fotos, hoja diaria y SLA/horarios.
- Mantener pedidos nuevos continuamente, con aviso visual y sonoro al área correspondiente.
- Ordenar primero MercadoLibre y después por antigüedad dentro de la misma prioridad.
- Mostrar carga, procesamiento, error recuperable, reintento y evidencia faltante sin borrar la
  previsualización local durante una falla de red.
- Validar: pedido → picking → fotos → evidencia completa → aprobado → pendiente de despacho.
- La mañana puede empezar con picking consolidado; los pedidos que entren después forman parte de
  la misma jornada y no esperan una segunda tanda fija.

### E2: Impresión automática 50×25

**Resultado:** cuando el servidor acepta toda la evidencia, la etiqueta interna sale sola en la
impresora del depósito.

- Mover el disparador de la etiqueta interna desde confirmación de despacho a evidencia completa.
- Encolar exactamente un trabajo por preparación/paquete mediante clave idempotente durable.
- Instalar un agente local en la computadora Windows del depósito, conectado a la impresora USB.
- El agente inicia con Windows, reclama trabajos atómicamente, imprime sin diálogo, confirma éxito
  o fallo y recupera pendientes luego de reinicio o pérdida de red.
- Una falla no revierte la aprobación ni obliga a repetir fotos: deja alerta persistente y permite
  reimpresión manual autorizada.
- La etiqueta interna y las etiquetas masivas de transporte son colas y momentos distintos.

### E3: App conectada y contrato estable

**Resultado:** la App deja de depender de mocks para autenticación y CI detecta divergencias.

- Portar selectivamente el trabajo útil de `feature/app-foundation` a `feature/stock-flow-ui`.
- Publicar desde backend un artefacto OpenAPI/cliente por commit; la App fija una versión y CI
  verifica compatibilidad. La copia manual deja de ser el proceso definitivo.
- Conectar login, refresh, logout, asociación/revocación de dispositivo y permisos reales.
- Secretos y refresh tokens viven en SecureStore. TanStack Query posee el estado remoto; Zustand
  queda limitado a estado local transversal.
- Probar un iPhone y un Android reales antes de cerrar la entrega.

### E4: Bandeja operativa móvil

**Resultado:** el responsable atiende excepciones desde el teléfono sin recorrer varias pantallas.

- Conectar notificaciones, inbox, lectura, toma exclusiva, resolución, reasignación y deep links.
- Mostrar pedidos nuevos, fallos de integración, etiquetas no impresas y tareas urgentes.
- Repetir y escalar alertas hasta reconocimiento o resolución.
- Preparación muta solamente online; esta entrega no promete carga offline de evidencia.

### E5: Vista rápida unificada de stock

**Resultado:** una búsqueda global muestra la situación completa de un producto.

- Buscar por SKU, EAN equivalente o nombre.
- Mostrar físico por ubicación, disponible, comprometido, no disponible, entrante, Woo, ML,
  incidentes, historial y frescura.
- No inventar la distribución inicial. Una ubicación sin conteo base se muestra como “sin línea
  base”, no como cero.
- Woo sigue siendo la autoridad de lo comercialmente disponible; Fusion modela y explica sus
  componentes operativos.

### E6: Libro de movimientos y ubicaciones

**Resultado:** el equipo mueve unidades entre ubicaciones con trazabilidad completa.

- Derivar saldos físicos de movimientos inmutables con cantidades enteras.
- Mantener depósitos físicos múltiples, ubicación base por SKU y overflow.
- Confirmar transferencias locales al llegar al destino; por la cercanía actual no se modela
  tránsito intermedio.
- Corregir errores mediante movimiento inverso, nunca reescribiendo historia.
- Habilitar el modelo nuevo por familia o SKU; un SKU no puede mezclar escrituras legacy y nuevas.
- La familia operativa pertenece a Fusion y cada SKU tiene una familia principal.

### E7: Compromisos, picking y faltantes

**Resultado:** pedido, preparación y stock comparten una reserva operativa auditable.

- Reflejar el compromiso cuando Woo reduce stock, sin aplicar una segunda reducción.
- Los pendientes de pago se reflejan mientras Woo retenga stock y se liberan cuando Woo lo restaura.
- Al encontrar el producto, moverlo a una ubicación lógica de preparación vinculada al pedido.
- Un faltante permite compromiso parcial, abre incidente urgente y dispara conteo escalonado:
  SKU en todas las ubicaciones y luego ubicación/familia si no se resuelve.
- Un cambio de línea invalida la preparación y evidencia afectadas.
- Una cancelación antes del despacho libera Woo y crea tarea urgente de desempaque/reposición.
- Admin o Ventas puede reasignar la última unidad a un ML urgente, incluso desde un paquete web,
  invalidando aprobación, evidencia y etiquetas del pedido desplazado.
- Meta operativa: reconocer un faltante urgente en menos de cinco minutos.

### E8: Stock y tareas en la App

**Resultado:** el operario consulta y ejecuta tareas de stock desde el celular.

- Reemplazar el ajuste absoluto del prototipo por consulta, movimientos autorizados,
  transferencias, faltantes, tareas, historial y frescura.
- Proteger escaneos contra rebote y bloquear códigos asignados a más de un SKU.
- Usar selección manual jerárquica de ubicación; no se requieren etiquetas QR en ubicaciones.

### E9: Recepción trazable en VPS

**Resultado:** una recepción de 20–100 líneas puede procesarse parcialmente sin perder contexto.

- Aceptar documentos antes, durante o después de la mercadería y confirmar por línea.
- Exigir identidad, cantidad y condición visible.
- Permitir cantidad directa, escaneo acumulado o escaneo unitario, sugerido según riesgo pero
  modificable por el operario.
- Enviar líneas a disponible, no disponible o pendiente.
- Un SKU inexistente en Woo crea existencia física provisional no vendible hasta catalogación.
- Una corrección posterior usa movimiento inverso.

### E10: Recepción móvil

**Resultado:** la mercadería se controla desde el punto de descarga.

- Elegir recepción, escanear, contar, registrar condición, tomar fotos y elegir destino.
- Soportar uno o dos operadores concurrentes con versión esperada y conflicto explícito.
- Nunca confirmar silenciosamente una línea que otro operador modificó.

### E11: Conteos y ajustes controlados

**Resultado:** conteos parciales y generales ajustan Woo con control de riesgo.

- Primer conteo ciego y reconciliación de movimientos posteriores al snapshot.
- Riesgo combinado por unidades, porcentaje, costo de reposición, historial y criticidad.
- Usar último costo de compra; si falta, usar precio de venta como fallback visible.
- Diferencias de bajo riesgo dentro de tolerancia configurable pueden autoajustarse.
- Alto riesgo exige foto, motivo estructurado y segunda aprobación; nadie se autoaprueba.
- Confirmación explícita antes de llevar a cero SKUs esperados pero no contados.
- Plan diario por riesgo/incidentes con presupuesto en minutos y conteo general mensual, aunque
  abarque varios días.
- CSV masivo solo con preview y doble aprobación.

### E12: Conteo móvil offline

**Resultado:** una conexión inestable no pierde ni duplica el conteo.

- Cola cifrada con vigencia máxima de siete días.
- Reproducir deltas en orden; detener conflictos incompatibles y pedir recuento.
- No usar last-write-wins.
- Invalidar pendientes de un teléfono perdido o revocado y reconstruir mediante recuento.
- Si una foto falla, conservar cantidad, motivo y archivo local, pero bloquear aprobación hasta
  subir la evidencia.

### E13: Cancelaciones, devoluciones y daños

**Resultado:** los casos excepcionales dejan de resolverse con ediciones manuales.

- Cancelación antes del despacho: Woo recupera disponibilidad y se crea tarea urgente para
  devolver físicamente la unidad.
- Cancelación después del despacho: reponer solo después de devolución, inspección y aprobación.
- Identificar devoluciones por pedido y escaneo; entran a inspección/no disponible.
- Un daño interno mueve inmediatamente a no disponible, reduce Woo y abre revisión con foto.
- No disponible es un saldo agregado con motivo y nota, no subinventarios rígidos.
- Fotos se conservan dos años; movimientos y auditoría, indefinidamente.

### E14: Métricas y reposición

**Resultado:** compras y control se basan en demanda y riesgo medidos.

- Medir exactitud, diferencias repetidas, recepción, faltantes y tiempos de reconocimiento.
- Construir un mes de línea base antes de fijar objetivos de exactitud o velocidad no medidos.
- Sugerir reposición, sin crear órdenes de compra, mediante demanda ponderada de 12 meses,
  estacionalidad, días sin stock, cobertura y lead time manual.
- Productos nuevos usan referencia de familia e indicador de baja confianza.
- Entrante comienza con aviso/pedido manual, cantidad y ETA; una recepción parcial decide si
  conserva o cierra el remanente.
- La preventa autorizada solo publica en Woo, limitada al entrante neto de compromisos y seguridad.
  No se habilita preventa en ML inicialmente.
- Informes móviles: excepciones diarias, reposición semanal y cierre/cobertura/valor mensual.

### E15: Reconciliación ML/Woo y deuda heredada

**Resultado:** los estados derivados de webhooks se comparan periódicamente y los pendientes
heredados dejan de depender de una única notificación.

- Reconciliar preguntas, mensajes, reclamos ML y pedidos con sus recursos autoritativos.
- Mantener los webhooks como vía rápida, pero usar reconciliación periódica como respaldo.
- Resolver la deuda conocida de recepción, SKU vigente antes del push, estados fail-open y
  documentación de respuestas de `/opt/fusionbikes/herramientas/docs/api-contrato.md`.
- Mantener rate limiting y backlog de reclamos como deuda explícita hasta resolverlos con tests.

### E16: Consolidación controlada de ramas

**Resultado:** queda una línea permanente de desarrollo y producción sin perder trabajo exclusivo.

- Comparar `master` y `conteo-confiable` con ancestry y diff completo antes de integrar.
- Congelar agentes, worktrees, migraciones y despliegues activos.
- Resolver contratos, migraciones, permisos, crons y funciones exclusivas explícitamente.
- Ejecutar suite global serial, E2E aislado de login, Home, inventario, preparación, matcher,
  auditoría y API móvil.
- Auditar rollback; el merge local no implica push, deploy ni reinicio de PM2.

## 5. Invariantes de stock e integraciones

- Conceptos separados: físico, disponible, comprometido, no disponible y entrante.
- El físico baja al entregar al transportista, no al crear el pedido.
- Todas las ventas de productos publicados terminan registradas en Woo.
- El stock de un producto no publicado puede estar físicamente disponible, pero el canal queda
  bloqueado.
- No se elimina ni desvincula un producto con saldo físico, comprometido o entrante.
- SKU duplicado en Woo o código compartido entre SKUs bloquea movimientos y abre incidente.
- Bicicletas registran presentación física: caja, armada o exhibición. Exhibición sigue vendible;
  la preparación refleja el trabajo adicional.
- ML conserva una reserva de canal configurable separada del físico.
- La sincronización objetivo tiene dos velocidades: SKU tocado en menos de un minuto y
  reconciliación global más lenta.
- Si Woo cae, los decrementos se guardan como pendientes urgentes e idempotentes; no se publican
  aumentos hasta recuperar y reconciliar.
- Ante negativo o divergencia se bloquea selectivamente el SKU, se publica cero cuando corresponda
  y se abre reconciliación; no se sobreescribe automáticamente el modelo interno.
- Decisión comercial explícita: cada publicación independiente de ML anuncia el stock completo.
  Esto acepta riesgo de sobreventa; una colisión abre incidente urgente, bloquea SKU/canales,
  obliga a buscar en todas las ubicaciones y Admin/Ventas decide qué pedido cumplir.

## 6. Interfaces y contrato

- E0 no modifica interfaces de ejecución.
- E2 amplía la cola de etiquetas con toma exclusiva, confirmación, fallo, reintento y autenticación del
  agente Windows.
- E3 establece el artefacto OpenAPI versionado como contrato obligatorio entre repositorios.
- E5–E13 incorporan gradualmente `StockBalance`, `StockMovement`, `WarehouseLocation`,
  `InventoryTask`, `StockCommitment`, `Receipt`, `CountSession` y `StockIncident`.
- Un endpoint móvil entra primero en `/opt/fusionbikes/herramientas/openapi/mobile-v1.yaml`, luego
  en el backend y finalmente en la App.
- Mutaciones reintentables usan idempotencia; escrituras concurrentes usan versión esperada y
  conflicto `409`, nunca sobrescritura silenciosa.

## 7. Escenarios obligatorios de aceptación

- Preparación: pedido nuevo durante el picking, prioridad ML, foto lenta, timeout, respuesta tardía,
  doble toque, recarga, evidencia faltante, cancelación, cambio de línea, faltante y reasignación.
- Impresión: impresora apagada, sin papel, Windows reiniciado, USB desconectado, red caída,
  confirmación perdida, trabajo repetido y reimpresión autorizada sin duplicar.
- App: token vencido, refresh revocado, dispositivo perdido, permisos insuficientes, deep link,
  push fallido, estado vacío, error recuperable y contrato incompatible.
- Stock: dos ubicaciones, última unidad, SKU duplicado, código duplicado, Woo caído, saldo negativo,
  divergencia selectiva, publicación ML independiente y decisión de sobreventa.
- Recepción: documento tardío, recepción parcial, dos operadores, modo de conteo cambiado, SKU
  provisional, condición dañada y foto fallida.
- Conteo: conteo ciego, movimiento posterior al snapshot, diferencia de bajo y alto riesgo,
  cero explícito, doble aprobación, offline de siete días, conflicto y dispositivo revocado.
- Excepciones: cancelación antes/después del despacho, devolución aprobada, devolución dañada,
  daño interno y reposición bloqueada hasta inspección.

## 8. Gates comunes

- Cada entrega usa rama y worktree propios.
- Revisar diff final, incluida memoria, con un revisor independiente.
- Ejecutar pruebas dirigidas y una única suite completa sin otros Vitest o servidores aislados.
- Todo cambio de `/opt/fusionbikes/herramientas/public/` requiere E2E real y validación responsive.
- Probar fallos proporcionales a la entrega: red, timeout, reintento, doble acción, recarga,
  concurrencia, permisos y recuperación.
- Auditoría final obligatoria antes de declarar `PUBLICABLE_LOCAL`.
- Publicar, desplegar, reiniciar PM2, instalar el agente Windows o distribuir builds móviles son
  acciones manuales y requieren autorización separada.

## 9. Fuera de estas entregas

- MercadoLibre Full o depósitos externos.
- Lotes y vencimientos.
- Serialización por unidad.
- Consignación.
- Kits.
- Órdenes de compra automáticas.
- Garantía de cero sobreventa mientras siga vigente la decisión de anunciar stock completo en
  publicaciones ML independientes.
